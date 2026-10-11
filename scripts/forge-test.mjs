import { spawnSync } from "node:child_process";
import { checkTestDependency, foundryTool } from "./foundry-dependencies.mjs";

checkTestDependency();
const args = process.argv.slice(2);
const result = spawnSync(foundryTool("forge"), ["test", "--root", "contracts", "-vv", ...args], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 2);
