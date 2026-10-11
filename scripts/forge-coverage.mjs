import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { checkTestDependency, foundryTool } from "./foundry-dependencies.mjs";

checkTestDependency();
mkdirSync("coverage", { recursive: true });
const phase = process.env.FAIRWORK_PHASE || "1";
if (!/^[1-5]$/.test(phase)) throw new Error("FAIRWORK_PHASE must be 1 through 5.");
const result = spawnSync(foundryTool("forge"), ["coverage", "--root", "contracts", "--exclude-tests", "--report", "summary", "--report", "lcov", "--report-file", path.resolve(`coverage/phase${phase}.lcov`), ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 2);
