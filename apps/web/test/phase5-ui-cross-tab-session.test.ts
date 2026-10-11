import assert from "node:assert/strict";
import test from "node:test";

import * as privateViewPolicy from "../lib/client/private-view-policy.ts";

type Listener = (event: { data?: unknown }) => void;

function fakeBroadcastChannel() {
  const listeners = new Set<Listener>();
  return {
    channel: {
      addEventListener(type: string, listener: Listener) {
        if (type === "message") listeners.add(listener);
      },
      removeEventListener(type: string, listener: Listener) {
        if (type === "message") listeners.delete(listener);
      },
    },
    dispatch(data: unknown) {
      for (const listener of listeners) listener({ data });
    },
  };
}

test("a session invalidation in another tab clears this tab's private view", () => {
  const subscribe = privateViewPolicy.subscribePrivateSessionInvalidation as unknown as (
    channel: { addEventListener(type: string, listener: Listener): void; removeEventListener(type: string, listener: Listener): void },
    invalidate: () => void,
  ) => () => void;
  assert.equal(typeof subscribe, "function");

  const bus = fakeBroadcastChannel();
  let invalidations = 0;
  const unsubscribe = subscribe(bus.channel, () => { invalidations += 1; });
  bus.dispatch({ type: "private-session-invalidated" });
  assert.equal(invalidations, 1);
  bus.dispatch({ type: "unrelated-message" });
  assert.equal(invalidations, 1, "unrelated channel traffic must not clear private state");
  unsubscribe();
  bus.dispatch({ type: "private-session-invalidated" });
  assert.equal(invalidations, 1, "unmounted views must not receive later invalidations");
});
