export type EvidenceEntry = { kind: "file" | "text"; hash: string; reference: string };

/** Return only entries that are not already committed for this party and dispute. */
export function pendingEvidenceEntries<T extends EvidenceEntry>(entries: T[], events: any[], disputeId: string, account: string): T[] {
  const normalize = (value: unknown) => typeof value === "string" ? value.toLowerCase() : String(value ?? "");
  const targetDispute = (() => {
    try { return BigInt(disputeId).toString(); } catch { return ""; }
  })();
  const alreadyCommitted = new Set<string>();
  for (const event of events ?? []) {
    const name = event?.name ?? event?.event ?? event?.eventName;
    const args = event?.args ?? event?.returnValues;
    if (name !== "EvidenceCommitted" || !args || targetDispute === "") continue;
    let eventDispute: string;
    try { eventDispute = BigInt(args.disputeId).toString(); } catch { continue; }
    if (eventDispute !== targetDispute || normalize(args.party) !== normalize(account)) continue;
    const hash = normalize(args.evidenceHash);
    const reference = normalize(args.opaqueReference);
    if (hash && reference) alreadyCommitted.add(`${hash}:${reference}`);
  }
  return entries.filter((entry) => !alreadyCommitted.has(`${normalize(entry.hash)}:${normalize(entry.reference)}`));
}
