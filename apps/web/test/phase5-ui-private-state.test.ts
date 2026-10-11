import assert from "node:assert/strict";
import test from "node:test";

const privateViewPolicy: Record<string, unknown> = await import("../lib/client/private-view-policy.ts").catch(() => ({}));

const client = "0x1111111111111111111111111111111111111111";
const nextWallet = "0x2222222222222222222222222222222222222222";

test("a wallet or role change clears private caches and unsaved proposal UI state", () => {
  assert.equal(typeof privateViewPolicy.resetPrivateViewForContextChange, "function");
  const reset = privateViewPolicy.resetPrivateViewForContextChange as (state: Record<string, unknown>) => Record<string, unknown>;
  const cleared = reset({
    terms: { title: "private title" },
    notes: { 0: [{ text: "private note" }] },
    files: { 0: [{ name: "private.pdf" }] },
    evidence: { 7: [{ text: "private evidence" }] },
    auditEvents: [{ actor: client, detail: "private activity" }],
    voteSecrets: { 7: { bps: "5000", salt: "private salt" } },
    pendingPrivateSave: { label: "private terms", save: async () => undefined },
    agreement: {
      freelancer: nextWallet,
      token: "0x3333333333333333333333333333333333333333",
      title: "private proposal title",
      description: "private proposal description",
      scope: "private proposal scope",
      deliveryRules: "private proposal rules",
      reviewWindow: "3600",
      revisionLimit: "2",
    },
    milestoneDrafts: [{ amount: "12.345678", duration: "86400", criteria: "private acceptance criteria" }],
    showAgreement: true,
    confirmSummary: { action: "private proposal", effects: ["private amount and recipients"] },
  });

  assert.equal(cleared.terms, null);
  assert.deepEqual(cleared.notes, {});
  assert.deepEqual(cleared.files, {});
  assert.deepEqual(cleared.evidence, {});
  assert.deepEqual(cleared.auditEvents, []);
  assert.deepEqual(cleared.voteSecrets, {});
  assert.equal(cleared.pendingPrivateSave, null);
  assert.deepEqual(cleared.agreement, {
    freelancer: "", token: "", title: "", description: "", scope: "", deliveryRules: "", reviewWindow: "3600", revisionLimit: "2",
  });
  assert.deepEqual(cleared.milestoneDrafts, [{ amount: "", duration: "86400", criteria: "" }]);
  assert.equal(cleared.showAgreement, false);
  assert.equal(cleared.confirmSummary, null);
});

test("private session cache is current only for its wallet and before its expiry", () => {
  assert.equal(typeof privateViewPolicy.privateSessionIsCurrent, "function");
  const isCurrent = privateViewPolicy.privateSessionIsCurrent as (
    session: { wallet: string; expiresAt: string } | null,
    wallet: string | null,
    nowMs: number,
  ) => boolean;
  const session = { wallet: client, expiresAt: "2026-01-01T00:30:00.000Z" };
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const expiry = Date.parse(session.expiresAt);

  assert.equal(isCurrent(session, client.toUpperCase(), start), true);
  assert.equal(isCurrent(session, nextWallet, start), false);
  assert.equal(isCurrent(session, client, expiry - 1), true);
  assert.equal(isCurrent(session, client, expiry), false);
  assert.equal(isCurrent(null, client, start), false);
});
