import solc from "solc";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

function version(command, args = ["--version"]) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim().split(/\r?\n/, 1)[0];
  } catch (error) {
    return `UNAVAILABLE (${error.code ?? error.message})`;
  }
}

function npmVersion() {
  const npmPackage = process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm", "node_modules", "npm", "package.json")
    : undefined;
  if (npmPackage && existsSync(npmPackage)) {
    return JSON.parse(readFileSync(npmPackage, "utf8")).version;
  }
  try {
    if (process.platform === "win32") {
      const npmCmd = path.join(path.dirname(process.execPath), "npm.cmd");
      return execFileSync("cmd.exe", ["/d", "/s", "/c", `"${npmCmd}" --version`], {
        encoding: "utf8",
      }).trim();
    }
    return execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    return `UNAVAILABLE (${error.code ?? error.message})`;
  }
}

console.log(`Node.js ${process.version}`);
console.log(`npm ${npmVersion()}`);
console.log(`solc-js ${solc.version()}`);
function installedTool(name, directory) {
  const candidate = process.env.USERPROFILE && process.platform === "win32"
    ? path.join(process.env.USERPROFILE, directory, "bin", `${name}.exe`)
    : undefined;
  return candidate && existsSync(candidate) ? candidate : name;
}

console.log(`forge ${version(installedTool("forge", ".foundry"))}`);
console.log(`anvil ${version(installedTool("anvil", ".foundry"))}`);
console.log(`cast ${version(installedTool("cast", ".foundry"))}`);
console.log(`gitleaks ${version(installedTool("gitleaks", ".gitleaks"), ["version"])}`);
