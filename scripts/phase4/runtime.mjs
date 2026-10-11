import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foundryTool } from "../foundry-dependencies.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const HOST = "127.0.0.1";
const PORT = 8545;
const RPC_URL = `http://${HOST}:${PORT}`;
const RUNTIME_DIR = checkedPath("infra/local/runtime");
const OWNER_FILE = checkedPath("infra/local/runtime/anvil-owner.json");

function checkedPath(relative) {
  const absolute = path.resolve(ROOT, relative);
  const relation = path.relative(ROOT, absolute);
  if (!relation || relation.startsWith(`..${path.sep}`) || relation === ".." || path.isAbsolute(relation)) {
    throw new Error(`Refusing path outside the repository: ${relative}`);
  }
  return absolute;
}

function ensureRuntimeDirectory() {
  const expected = checkedPath("infra/local/runtime");
  if (expected !== RUNTIME_DIR) throw new Error("Runtime path changed unexpectedly.");
  mkdirSync(RUNTIME_DIR, { recursive: true });
}

export function assertRuntimeParentsSafe() {
  const rootReal = realpathSync(ROOT);
  for (const relative of ["infra", "infra/local", "infra/local/runtime"]) {
    const candidate = checkedPath(relative);
    if (!existsSync(candidate)) continue;
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new Error("Refusing a local demo path that is a symbolic link: " + relative);
    }
    const actual = realpathSync(candidate);
    const relation = path.relative(rootReal, actual);
    if (relation === ".." || relation.startsWith(".." + path.sep) || path.isAbsolute(relation)) {
      throw new Error("Refusing a local demo path outside the repository: " + relative);
    }
  }
}

function resolvedExecutable(command) {
  if (path.isAbsolute(command) && existsSync(command)) return realpathSync(command);
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8", windowsHide: true });
  const candidate = result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean) : undefined;
  if (!candidate) throw new Error(`Could not resolve the installed Anvil executable (${command}).`);
  return realpathSync(candidate.trim());
}

function readOwnerRecord() {
  if (!existsSync(OWNER_FILE)) return undefined;
  let record;
  try {
    record = JSON.parse(readFileSync(OWNER_FILE, "utf8"));
  } catch {
    throw new Error(`Refusing to stop a process because ${path.relative(ROOT, OWNER_FILE)} is not valid JSON.`);
  }
  if (
    record.owner !== "fairwork-phase4" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    record.host !== HOST ||
    record.port !== PORT ||
    record.chainId !== 31337 ||
    typeof record.executable !== "string" ||
    typeof record.createdFileTime !== "string" ||
    !Array.isArray(record.args)
  ) {
    throw new Error(`Refusing to stop a process using an unrecognized ownership record at ${path.relative(ROOT, OWNER_FILE)}.`);
  }
  return record;
}

function processInfoWindows(pid) {
  const command = [
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';`,
    "if($null -eq $p){exit 3};",
    "[pscustomobject]@{pid=$p.ProcessId;path=$p.ExecutablePath;created=[string]$p.CreationDate.ToUniversalTime().ToFileTimeUtc();command=$p.CommandLine}|ConvertTo-Json -Compress",
  ].join(" ");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status === 3) return undefined;
  if (result.error || result.status !== 0) {
    throw new Error(`Could not verify recorded Anvil process ${pid}; refusing to stop it.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Could not read recorded Anvil process ${pid}; refusing to stop it.`);
  }
}

function processInfoUnix(pid) {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm=", "-o", "args="], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    if (!output) return undefined;
    return { output };
  } catch (error) {
    if (error.status === 1) return undefined;
    throw new Error(`Could not verify recorded Anvil process ${pid}; refusing to stop it.`);
  }
}

function verifyOwnedProcess(record, info) {
  if (!info) return false;
  if (process.platform === "win32") {
    const actualPath = info.path ? path.resolve(info.path).toLowerCase() : "";
    const expectedPath = path.resolve(record.executable).toLowerCase();
    const command = String(info.command ?? "");
    const argsMatch = ["--host", HOST, "--port", String(PORT), "--chain-id", "31337", "--accounts", "10"]
      .every((part) => command.toLowerCase().includes(part.toLowerCase()));
    return Number(info.pid) === record.pid &&
      actualPath === expectedPath &&
      String(info.created) === record.createdFileTime &&
      argsMatch;
  }
  const output = info.output;
  const startMarker = String(record.processStart).trim();
  return startMarker !== "" && output.startsWith(startMarker) &&
    output.toLowerCase().includes("anvil") &&
    output.includes(`--host ${HOST}`) &&
    output.includes(`--port ${PORT}`) &&
    output.includes("--chain-id 31337") &&
    output.includes("--accounts 10");
}

async function portIsListening() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: HOST, port: PORT });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "EHOSTUNREACH") resolve(false);
      else reject(error);
    });
  });
}

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Anvil returned HTTP ${response.status} for ${method}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(`Anvil ${method} failed: ${payload.error.message ?? "unknown RPC error"}`);
  return payload.result;
}

function ownerRecordPath() {
  const pathToRecord = checkedPath("infra/local/runtime/anvil-owner.json");
  if (pathToRecord !== OWNER_FILE) throw new Error("Anvil ownership path changed unexpectedly.");
  return pathToRecord;
}

function atomicJsonWrite(filePath, value) {
  const exactPath = path.resolve(filePath);
  if (!exactPath.startsWith(`${RUNTIME_DIR}${path.sep}`) && exactPath !== checkedPath("infra/local/deployment.json")) {
    throw new Error(`Refusing to write outside the approved local runtime: ${filePath}`);
  }
  const temporary = `${exactPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  renameSync(temporary, exactPath);
}

export async function stopOwnedAnvil() {
  const record = readOwnerRecord();
  if (!record) return { stopped: false, reason: "no_owned_process" };
  const info = process.platform === "win32" ? processInfoWindows(record.pid) : processInfoUnix(record.pid);
  if (!info) {
    // The PID is gone, so clearing this exact stale ownership record is safe.
    const current = readOwnerRecord();
    if (current?.pid === record.pid && current?.createdFileTime === record.createdFileTime) {
      unlinkSync(ownerRecordPath());
    }
    return { stopped: false, reason: "stale_owned_record" };
  }
  if (!verifyOwnedProcess(record, info)) {
    throw new Error(`Process ${record.pid} no longer matches its recorded Anvil identity; leaving it untouched.`);
  }
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(record.pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) throw new Error(`Could not stop owned Anvil process ${record.pid}.`);
  } else {
    process.kill(record.pid, "SIGTERM");
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const remaining = process.platform === "win32" ? processInfoWindows(record.pid) : processInfoUnix(record.pid);
    if (!remaining) break;
    if (attempt === 39) throw new Error(`Owned Anvil process ${record.pid} did not stop.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  unlinkSync(ownerRecordPath());
  return { stopped: true, pid: record.pid };
}

export async function startFreshOwnedAnvil() {
  ensureRuntimeDirectory();
  const stopped = await stopOwnedAnvil();
  if (await portIsListening()) {
    throw new Error(`Port ${PORT} is already in use by a process this demo does not own; it was left untouched.`);
  }

  const executable = resolvedExecutable(foundryTool("anvil"));
  const args = ["--host", HOST, "--port", String(PORT), "--chain-id", "31337", "--accounts", "10", "--balance", "10000", "--quiet"];
  const child = spawn(executable, args, { detached: true, stdio: "ignore", windowsHide: true });
  if (!child.pid) throw new Error("Anvil did not return a process ID.");
  child.unref();

  let processInfo;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Anvil exited early with code ${child.exitCode}.`);
    processInfo = process.platform === "win32" ? processInfoWindows(child.pid) : processInfoUnix(child.pid);
    if (processInfo) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!processInfo) {
    try {
      child.kill();
    } catch {}
    throw new Error("Could not verify the Anvil process identity after startup.");
  }

  const record = {
    owner: "fairwork-phase4",
    pid: child.pid,
    executable,
    args,
    host: HOST,
    port: PORT,
    chainId: 31337,
    startedAt: new Date().toISOString(),
    ...(process.platform === "win32"
      ? { createdFileTime: String(processInfo.created) }
      : { processStart: processInfo.output.split(/\s+/).slice(0, 5).join(" ") }),
  };
  atomicJsonWrite(ownerRecordPath(), record);

  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const chainId = await rpc("eth_chainId");
        if (BigInt(chainId) !== 31337n) throw new Error(`Owned Anvil reported chain ID ${chainId}, expected 31337.`);
        const accounts = await rpc("eth_accounts");
        if (!Array.isArray(accounts) || accounts.length < 10) throw new Error("Owned Anvil did not expose the ten configured throwaway accounts.");
        return { rpcUrl: RPC_URL, pid: child.pid, accounts, stoppedPrevious: stopped.stopped };
      } catch (error) {
        if (attempt === 59) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  } catch (error) {
    await stopOwnedAnvil().catch(() => undefined);
    throw error;
  }
  throw new Error("Owned Anvil failed to become ready.");
}

export async function verifyOwnedAnvil() {
  const record = readOwnerRecord();
  if (!record) throw new Error("No recorded owned Anvil instance is running.");
  const info = process.platform === "win32" ? processInfoWindows(record.pid) : processInfoUnix(record.pid);
  if (!verifyOwnedProcess(record, info)) throw new Error("Recorded Anvil process identity did not verify.");
  if (BigInt(await rpc("eth_chainId")) !== 31337n) throw new Error("Owned local RPC does not report chain ID 31337.");
  return { pid: record.pid, rpcUrl: RPC_URL };
}

export function writeDeploymentManifest(manifest) {
  const filePath = checkedPath("infra/local/deployment.json");
  const result = atomicJsonWrite(filePath, manifest);
  return result;
}

export function writeDemoResult(result) {
  const filePath = checkedPath("infra/local/runtime/demo-result.json");
  atomicJsonWrite(filePath, result);
  return filePath;
}

export function writeAttackLabResult(result) {
  const filePath = checkedPath("infra/local/runtime/attack-lab-result.json");
  atomicJsonWrite(filePath, result);
  return filePath;
}

export function clearGeneratedDemoResults() {
  for (const relative of [
    "infra/local/runtime/demo-result.json",
    "infra/local/runtime/attack-lab-result.json",
    "infra/local/deployment.json",
  ]) {
    const filePath = checkedPath(relative);
    if (!existsSync(filePath)) continue;
    const relation = path.relative(ROOT, filePath);
    if (relation.startsWith("..") || path.isAbsolute(relation)) {
      throw new Error("Refusing to clear a generated demo result outside the repository.");
    }
    unlinkSync(filePath);
  }
}

export const localRuntime = Object.freeze({ root: ROOT, runtimeDir: RUNTIME_DIR, rpcUrl: RPC_URL, host: HOST, port: PORT });
