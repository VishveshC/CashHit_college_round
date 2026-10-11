import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
function check(args) {
  return spawnSync(process.execPath, ["scripts/public-build-check.mjs", ...args], { encoding: "utf8" });
}
const local = check(["--target", "local"]);
assert.equal(local.status, 0, "local-only build gate must pass");
assert.match(local.stdout, /chain 31337/);
const mockPublic = check(["--target", "public", "--mock-randomness"]);
assert.notEqual(mockPublic.status, 0);
assert.match(mockPublic.stderr, /DEMO ONLY MockRandomness/);
const publicBuild = check(["--target", "public"]);
assert.notEqual(publicBuild.status, 0);
assert.match(publicBuild.stderr, /production adapter/);
const unknown = check(["--target", "unknown"]);
assert.notEqual(unknown.status, 0);
console.log("PASS: local gate, demo-public rejection, missing-production rejection and invalid-target rejection.");
