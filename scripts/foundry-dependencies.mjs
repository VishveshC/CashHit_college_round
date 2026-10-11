import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function sourceDigest(directory) {
  const digest = createHash("sha256");
  function walk(relative = "") {
    for (const item of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const name = path.posix.join(relative, item.name);
      if (item.isDirectory()) walk(name);
      else if (item.isFile()) digest.update(name + "\0" + readFileSync(path.join(directory, name), "utf8").replaceAll("\r\n", "\n") + "\0");
      else throw new Error(`Unexpected dependency entry: ${name}`);
    }
  }
  walk();
  return digest.digest("hex");
}

export function foundryTool(name) {
  const local = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".foundry", "bin", `${name}.exe`) : undefined;
  return process.env[`${name.toUpperCase()}_BIN`] || (local && existsSync(local) ? local : name);
}

export function checkTestDependency({ install = false } = {}) {
  const pin = JSON.parse(readFileSync("contracts/dependencies.json", "utf8")).forgeStd;
  const directory = "contracts/lib/forge-std";
  if (!existsSync(directory)) {
    if (!install) throw new Error("Missing forge-std. Run npm run setup:contracts first.");
    const configuration = readFileSync("contracts/foundry.toml", "utf8");
    const result = spawnSync(foundryTool("forge"), ["install", `${pin.repository}@rev=${pin.commit}`, "--root", "contracts", "--no-git"], { stdio: "inherit" });
    // Foundry install may rewrite libs to an absolute Windows path. Keep the
    // repository's reviewed relative configuration portable.
    writeFileSync("contracts/foundry.toml", configuration);
    if (result.error || result.status !== 0) throw result.error || new Error("Pinned forge-std install failed.");
  }
  const version = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).version;
  if (version !== pin.version || sourceDigest(path.join(directory, "src")) !== pin.sourceSha256) {
    throw new Error("forge-std source differs from the verified pin. Existing files were preserved; inspect the dependency before proceeding.");
  }
  console.log(`forge-std ${version}, commit ${pin.commit}, normalized source SHA-256 verified.`);
}
