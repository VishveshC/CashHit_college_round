import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const installedOnWindows = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, ".gitleaks", "bin", "gitleaks.exe")
  : undefined;
const executable = process.env.GITLEAKS_BIN ||
  (installedOnWindows && existsSync(installedOnWindows) ? installedOnWindows : "gitleaks");
const result = spawnSync(executable, ["dir", "--config", ".gitleaks.toml", "--no-banner", "--redact", "."], {
  encoding: "utf8",
  stdio: "inherit",
  shell: process.platform === "win32" && executable.endsWith(".cmd"),
});

if (result.error) {
  console.error(`Could not run gitleaks at ${executable}: ${result.error.message}`);
  console.error("Install the pinned gitleaks version or set GITLEAKS_BIN to its executable.");
  process.exit(2);
}
process.exit(result.status ?? 2);
