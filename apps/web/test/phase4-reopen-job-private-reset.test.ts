import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resetPrivateViewForContextChange } from "../lib/client/private-view-policy.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DASHBOARD = path.join(ROOT, "apps", "web", "components", "EscrowDashboard.tsx");

function assertCreationResetsPrivateStateBeforeSnapshot(source: string) {
  const createCall = source.indexOf('runTransaction("Create private agreement"');
  assert.notEqual(createCall, -1, "the production create-agreement transaction exists");

  const refetchCallback = source.indexOf("async (_receipt, contextIsCurrent) => {", createCall);
  assert.notEqual(refetchCallback, -1, "creation supplies its own receipt refetch callback");

  const currentBranch = source.indexOf("if (contextIsCurrent()) {", refetchCallback);
  assert.notEqual(currentBranch, -1, "creation publishes its fresh result only in the current transaction context");

  const snapshotPublication = source.indexOf("setSnapshot(fresh)", currentBranch);
  assert.notEqual(snapshotPublication, -1, "creation publishes the newly read job snapshot");
  const beforePublication = source.slice(currentBranch, snapshotPublication);

  const resetVariable = beforePublication.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*resetPrivateViewForContextChange\s*\(/)?.[1];
  const isCleared = (setter: string, field: string, emptyValue: "null" | "{}" | "[]") => {
    const directClear = new RegExp(`${setter}\\s*\\(\\s*${emptyValue === "{}" ? "\\{\\s*\\}" : emptyValue === "[]" ? "\\[\\s*\\]" : "null"}\\s*\\)`).test(beforePublication);
    if (directClear) return true;
    if (!resetVariable) return false;
    return new RegExp(`${setter}\\s*\\(\\s*${resetVariable}\\.${field}\\s*\\)`).test(beforePublication);
  };

  const requiredClears = [
    ["setTerms", "terms", "null"],
    ["setNotes", "notes", "{}"],
    ["setFiles", "files", "{}"],
    ["setEvidence", "evidence", "{}"],
    ["setAuditEvents", "auditEvents", "[]"],
  ] as const;
  for (const [setter, field, emptyValue] of requiredClears) {
    assert.ok(
      isCleared(setter, field, emptyValue),
      `the createJob transition must clear ${field} before publishing the new snapshot`,
    );
  }
}

test("creating job 32 clears job 31 private view before publishing its snapshot", async () => {
  const job31View = resetPrivateViewForContextChange({
    terms: { title: "job31 private terms" },
    notes: { 0: [{ text: "job31 private note" }] },
    files: { 0: [{ name: "job31-private.pdf" }] },
    evidence: { 29: [{ text: "job31 private evidence" }] },
    auditEvents: [{ actor: "client", detail: "job31 private activity" }],
  });
  assert.deepEqual(job31View.terms, null);
  assert.deepEqual(job31View.notes, {});
  assert.deepEqual(job31View.files, {});
  assert.deepEqual(job31View.evidence, {});
  assert.deepEqual(job31View.auditEvents, []);

  const source = await readFile(DASHBOARD, "utf8");
  assertCreationResetsPrivateStateBeforeSnapshot(source);
});
