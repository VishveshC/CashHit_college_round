export type ContractActionStatus = "pending" | "confirmed" | "failed" | "unknown";

export function transactionBlocksNewSend(status: string): boolean {
  return status === "pending" || status === "unknown";
}

type ActionInput<THash, TReceipt, TSnapshot, TSummary> = {
  expectedChainId: number;
  activeChainId: number;
  confirm: (summary: TSummary) => boolean | Promise<boolean>;
  validateBeforeSend?: () => void | Promise<void>;
  send: () => THash | Promise<THash>;
  waitForReceipt: (hash: THash) => TReceipt | Promise<TReceipt>;
  afterReceipt?: (receipt: TReceipt, hash: THash) => void | Promise<void>;
  onReceiptOutcome?: (outcome: "confirmed" | "reverted") => void;
  refetchFromChain: () => TSnapshot | Promise<TSnapshot>;
  onStatus?: (status: ContractActionStatus) => void;
  summary: TSummary;
};

export async function runContractAction<THash = unknown, TReceipt extends { status: unknown } = { status: unknown }, TSnapshot = unknown, TSummary = unknown>(
  input: ActionInput<THash, TReceipt, TSnapshot, TSummary>,
): Promise<{ hash: THash; receipt: TReceipt; snapshot: TSnapshot }> {
  if (input.activeChainId !== input.expectedChainId) {
    throw new Error(`Unsupported chain ${input.activeChainId}; switch to chain ${input.expectedChainId} before continuing.`);
  }
  const confirmed = await input.confirm(input.summary);
  if (!confirmed) throw new Error("Action cancelled before the wallet signature.");
  await input.validateBeforeSend?.();

  let hash: THash;
  let receipt: TReceipt;
  let broadcast = false;
  let reverted = false;
  try {
    hash = await input.send();
    broadcast = true;
    input.onStatus?.("pending");
    receipt = await input.waitForReceipt(hash);
    const status = receipt.status;
    const successful = status === "success" || status === 1 || status === "0x1";
    const definitivelyReverted = status === "reverted" || status === "failed" || status === 0 || status === "0x0";
    reverted = definitivelyReverted;
    if (successful) input.onReceiptOutcome?.("confirmed");
    else if (definitivelyReverted) input.onReceiptOutcome?.("reverted");
    if (!successful) throw new Error("Transaction receipt reported a failed or reverted transaction.");
  } catch (error) {
    input.onStatus?.(broadcast && !reverted ? "unknown" : "failed");
    const message = error instanceof Error ? error.message : "The transaction failed.";
    throw new Error(message);
  }

  input.onStatus?.("confirmed");
  let followUpError: unknown;
  try {
    await input.afterReceipt?.(receipt, hash);
  } catch (error) {
    // Receipt-dependent data must be preserved before a fallible read. Keep trying
    // to refresh chain state even when an encrypted private follow-up needs retry.
    followUpError = error;
  }

  let snapshot: TSnapshot;
  try {
    snapshot = await input.refetchFromChain();
  } catch (error) {
    const message = error instanceof Error ? error.message : "The fresh chain read failed.";
    throw new Error(`Transaction confirmed, but the chain refresh failed: ${message}`);
  }
  if (followUpError) {
    const message = followUpError instanceof Error ? followUpError.message : "The private follow-up failed.";
    throw new Error(`Transaction confirmed and chain state refreshed, but its post-receipt follow-up failed: ${message}`);
  }
  return { hash, receipt, snapshot };
}
