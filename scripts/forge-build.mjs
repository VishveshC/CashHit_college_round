import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const installedOnWindows = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, ".foundry", "bin", "forge.exe")
  : undefined;
const executable = process.env.FORGE_BIN ||
  (installedOnWindows && existsSync(installedOnWindows) ? installedOnWindows : "forge");
const result = spawnSync(executable, ["build", "--root", "contracts", ...process.argv.slice(2)], {
  encoding: "utf8",
  stdio: "inherit",
});

if (result.error) {
  console.error(`Could not run forge at ${executable}: ${result.error.message}`);
  console.error("Install the pinned Foundry version or set FORGE_BIN to its executable.");
  process.exit(2);
}
process.exit(result.status ?? 2);
