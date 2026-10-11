import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const prefix = "phase4-reopen-registry-artifact";
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
const run = (args, timeout = 300_000) => spawnSync(
  process.execPath,
  ["scripts/web-build.mjs", ...args],
  { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
);

test("registry artifact uses a separate evidence prefix, records its source hash, and remains fail-closed", { timeout: 360_000 }, () => {
  const frozen = JSON.parse(readFileSync("docs/phase4-reopen-artifact-test-frozen.json", "utf8"));
  const originalEvidence = new Map(
    frozen.frozen_files
      .filter(({path: file}) => file === "docs/phase4-reopen-artifact-test.json" || file === "docs/phase4-reopen-artifact-test-build.txt")
      .map(({path: file, sha256}) => [file, sha256.toUpperCase()]),
  );
  assert.equal(originalEvidence.size, 2, "the earlier default report and build log must stay frozen");
  for (const [file, expected] of originalEvidence) assert.equal(digest(file), expected, `${file} changed before the prefixed run`);

  const invalidPrefix = run(["--target", "artifact-test", "--evidence-prefix", "../unsafe", "--dry-run"]);
  assert.notEqual(invalidPrefix.status, 0);
  assert.match(`${invalidPrefix.stdout}\n${invalidPrefix.stderr}`, /Evidence prefix must match/);
  const wrongTarget = run(["--target", "local", "--evidence-prefix", prefix, "--dry-run"]);
  assert.notEqual(wrongTarget.status, 0);
  assert.match(`${wrongTarget.stdout}\n${wrongTarget.stderr}`, /only supported for the isolated artifact-test target/);

  const preview = run(["--target", "artifact-test", "--evidence-prefix", prefix, "--dry-run"]);
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewResult = JSON.parse(preview.stdout);
  assert.equal(previewResult.report, `docs/${prefix}.json`);
  assert.equal(previewResult.buildLog, `docs/${prefix}-build.txt`);
  assert.equal(previewResult.compilationStarted, false);
  assert.equal(previewResult.filesWritten, false);
  for (const [file, expected] of originalEvidence) assert.equal(digest(file), expected, `${file} changed during dry-run`);

  const sourceHash = digest("apps/web/components/EscrowDashboard.tsx");
  const registryHash = digest("apps/web/components/ArbiterRegistry.tsx");
  const build = run(["--target", "artifact-test", "--evidence-prefix", prefix]);
  assert.equal(build.status, 2, `${build.stdout}\n${build.stderr}`);
  assert.match(build.stdout, /NON-DEPLOYABLE ARTIFACT TEST BLOCKED: actual output failed exclusion scan/);

  const report = JSON.parse(readFileSync(`docs/${prefix}.json`, "utf8"));
  assert.equal(report.evidencePrefix, prefix);
  assert.equal(report.target, "artifact-test");
  assert.equal(report.publicTargetRemainsBlocked, true);
  assert.equal(report.exclusions.hasOriginalDeploymentPinVerifier, true);
  assert.ok(report.exclusions.stagedFiles.some(({path: file}) => file.replaceAll("\\", "/") === "apps/web/lib/chain-pins.ts"));
  assert.equal(report.sourceEvidence.dashboardPath, "apps/web/components/EscrowDashboard.tsx");
  assert.equal(report.sourceEvidence.dashboardSha256?.toUpperCase(), sourceHash);
  assert.equal(report.sourceEvidence.registryComponentPath, "apps/web/components/ArbiterRegistry.tsx");
  assert.equal(report.sourceEvidence.registryComponentSha256?.toUpperCase(), registryHash);
  assert.ok(report.exclusions.stagedFiles.some(({path: file}) => file.replaceAll("\\", "/") === "apps/web/components/ArbiterRegistry.tsx"));
  assert.equal(report.build.status, 0, "the staged build must compile before the actual-output scan blocks it");
  assert.equal(report.build.outputDirectoryIsOutsideWorkspace, true);
  assert.equal(report.artifact.releaseSafe, false);
  assert.ok(report.artifact.readinessBlockers.length > 0);
  for (const [file, expected] of originalEvidence) assert.equal(digest(file), expected, `${file} was overwritten by the prefixed run`);
});
