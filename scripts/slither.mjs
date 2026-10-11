import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { foundryTool } from "./foundry-dependencies.mjs";

const binary = process.env.SLITHER_BIN || path.resolve(".tools/slither/Scripts/slither.exe");
if (!existsSync(binary) && !process.env.SLITHER_BIN) {
  throw new Error("Install the pinned Slither environment from infra/tools/slither-requirements.txt or set SLITHER_BIN.");
}
const environment = { ...process.env, PATH: path.dirname(foundryTool("forge")) + path.delimiter + process.env.PATH };
const userArgs = process.argv.slice(2);
let exitCode = 0;
const phase = process.env.FAIRWORK_PHASE || "1";
if (!/^[1-5]$/.test(phase)) throw new Error("FAIRWORK_PHASE must be 1 through 5.");
const targets = [["escrow", "src/FairworkEscrow.sol"], ["mocks", "src/mocks/LocalDemoTokens.sol"]];
if (Number(phase) >= 3) targets.push(["arbitration", "src/FairworkArbitration.sol"], ["randomness", "src/mocks/MockRandomness.sol"]);
const scopeArgs = Number(phase) >= 3 ? ["--exclude-dependencies"] : [];
// Separate source targets avoid duplicate absolute/relative dependency AST IDs in
// Foundry build-info. The local Foundry config supplies the exact compiler pin.
for (const [label, target] of targets) {
  const args = [...userArgs];
  const jsonIndex = args.indexOf("--json");
  if (jsonIndex >= 0 && args[jsonIndex + 1]) {
    const output = path.parse(path.resolve(args[jsonIndex + 1]));
    args[jsonIndex + 1] = path.join(output.dir, `${output.name}.${label}${output.ext || ".json"}`);
  }
  console.log(`Slither target: ${target} (separate ${label} report).`);
  const result = spawnSync(binary, [target, ...scopeArgs, "--compile-force-framework", "solc", "--solc-standard-json", "--solc-remaps", "@openzeppelin/contracts/=../node_modules/@openzeppelin/contracts/", "--solc-args", "--optimize --optimize-runs 200", "--filter-paths", "node_modules", ...args], { cwd: path.resolve("contracts"), stdio: "inherit", env: environment });
  if (result.error) throw result.error;
  console.log(`Slither ${label} exit: ${result.status ?? 2}`);
  if (result.status !== 0) exitCode = result.status ?? 2;
}
process.exit(exitCode);
