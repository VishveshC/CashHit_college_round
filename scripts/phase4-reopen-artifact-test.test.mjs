import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const run = (target) => spawnSync(
  process.execPath,
  ["scripts/web-build.mjs", "--target", target],
  { encoding: "utf8", windowsHide: true, timeout: 240_000, maxBuffer: 12 * 1024 * 1024 },
);

test("isolated artifact-test fails closed on actual local UI markers and leaves public target blocked", { timeout: 270_000 }, () => {
  const publicBuild = run("public");
  assert.notEqual(publicBuild.status, 0, "public must remain blocked while approved production inputs are absent");
  assert.match(`${publicBuild.stdout}\n${publicBuild.stderr}`, /No approved production adapter|Public release blocked/);

  const artifactBuild = run("artifact-test");
  assert.equal(artifactBuild.status, 2, `${artifactBuild.stdout}\n${artifactBuild.stderr}`);
  assert.match(artifactBuild.stdout, /NON-DEPLOYABLE ARTIFACT TEST BLOCKED: actual output failed exclusion scan/);

  const report = JSON.parse(readFileSync("docs/phase4-reopen-artifact-test.json", "utf8"));
  assert.equal(report.kind, "isolated non-deployable artifact-test packaging evidence");
  assert.equal(report.publicTargetRemainsBlocked, true);
  assert.equal(report.build.outputDirectoryIsOutsideWorkspace, true);
  assert.ok(report.exclusions.excludedSourcePaths.includes("apps/web/app/api/dev"));
  assert.ok(report.exclusions.excludedSourcePaths.includes("packages/chain/generated/MockRandomness.json"));
  assert.ok(report.exclusions.excludedSourcePaths.includes("apps/web/lib/dev-wallet.ts"));
  assert.equal(report.build.status, 0, "the isolated fixture must compile before actual output is scanned");
  assert.equal(report.knownTestKeyScan.exactCandidatesScanned, 0);
  assert.equal(report.knownTestKeyScan.exactComparisonApplicable, false);
  assert.equal(report.knownTestKeyScan.valuesWrittenToReport, false);
  assert.equal(report.artifact.routeManifestsContainDevApi, false);
  assert.equal(report.artifact.chunksContainMockRandomness, false);
  assert.equal(report.artifact.knownTestPrivateKeyScanComplete, false);
  assert.equal(report.artifact.knownTestPrivateKeyCandidateCount, 0);
  assert.equal(report.artifact.chunksContainKnownTestPrivateKey, null);
  assert.equal(report.artifact.routeMethodsAreReadOnlyFixtureOnly, true);
  assert.equal(report.artifact.chunksContainSeededDemoControls, true);
  assert.equal(report.artifact.chunksContainLocalRpcOrOrigin, true);
  assert.equal(report.artifact.chunksContainLocalOnlyChainUx, true);
  assert.equal(report.artifact.releaseSafe, false);
  assert.deepEqual(report.artifact.readinessBlockers, ["seededDemoControls", "knownTestKeyCandidatesUnavailable", "localRpcOrOrigin", "localOnlyChainUx"]);
  assert.ok(report.limitations.length > 0, "the report must state what this non-deployable fixture does not prove");
});
