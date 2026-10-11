export type PrivateCacheOutcome =
  | { status: "fulfilled" }
  | { status: "rejected"; reason?: unknown };

/** Return the next visible value for one private response and its cached state. */
export function resolvePrivateCacheValue<T>(outcome: PrivateCacheOutcome, freshValue: T, emptyValue: T): T {
  return outcome.status === "fulfilled" ? freshValue : emptyValue;
}

/** Decide whether an account event should revoke this view's private state. */
export function shouldClearPrivateForWalletChange(currentAccount: string, nextAccount?: string | null): boolean {
  return !nextAccount || currentAccount.toLowerCase() !== nextAccount.toLowerCase();
}
