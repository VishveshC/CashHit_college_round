import assert from "node:assert/strict";
import test from "node:test";

import { resolvePrivateCacheValue, shouldClearPrivateForWalletChange } from "../lib/client/private-cache-policy.ts";

test("a rejected private response clears its own cached resource", () => {
  const resources = [
    { name: "terms", stale: { title: "old private terms" }, empty: null },
    { name: "notes", stale: [{ text: "old rejection reason" }], empty: [] },
    { name: "files", stale: { 0: [{ id: "old-file" }] }, empty: {} },
    { name: "evidence", stale: { 7: [{ text: "old evidence" }] }, empty: {} },
    { name: "audit", stale: [{ event: "private.read" }], empty: [] },
  ];

  for (const status of [401, 404, 500]) {
    for (const resource of resources) {
      const outcome = { status: "rejected" as const, reason: { status } };
      assert.deepEqual(
        resolvePrivateCacheValue(outcome, resource.stale, resource.empty),
        resource.empty,
        `${resource.name} should clear after HTTP ${status}`,
      );
    }
  }
});

test("an authorized refresh replaces only its successfully refreshed resource", () => {
  const previousNotes = [{ text: "older note" }];
  const freshNotes = [{ text: "current note" }];
  const authorized = { status: "fulfilled" as const };

  assert.deepEqual(resolvePrivateCacheValue(authorized, freshNotes, []), freshNotes);
  assert.deepEqual(previousNotes, [{ text: "older note" }], "resolving notes must not mutate another cached value");
});

test("disconnecting or switching wallet accounts revokes the current private view", () => {
  const account = "0x1111111111111111111111111111111111111111";
  assert.equal(shouldClearPrivateForWalletChange(account, null), true, "an empty accountsChanged event is a disconnect");
  assert.equal(shouldClearPrivateForWalletChange(account, undefined), true, "a missing next account is a disconnect");
  assert.equal(shouldClearPrivateForWalletChange(account, "0x2222222222222222222222222222222222222222"), true);
});

test("the same account remains authorized across case-only address changes", () => {
  const account = "0xAbCd000000000000000000000000000000000001";
  assert.equal(shouldClearPrivateForWalletChange(account, account.toLowerCase()), false);
});
