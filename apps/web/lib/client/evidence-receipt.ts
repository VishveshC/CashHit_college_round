export type EvidenceReceiptState = { submitted: boolean; receiptConfirmed: boolean };
export type EvidenceReceiptOutcome = "unknown" | "reverted" | "confirmed";

export function applyEvidenceReceiptOutcome(
  current: EvidenceReceiptState,
  outcome: EvidenceReceiptOutcome,
): EvidenceReceiptState {
  if (outcome === "reverted") return { submitted: false, receiptConfirmed: false };
  if (outcome === "confirmed") return { submitted: true, receiptConfirmed: true };
  return current;
}
