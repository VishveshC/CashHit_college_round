const UINT256_MAX = (1n << 256n) - 1n;
const SETTLED_PHASE = 10n;

export type SettlementCreditSource = 0 | 1 | 2;

export type DisputeSettlementCredit = {
  source: SettlementCreditSource;
  account: string;
  amount: bigint;
};

export type DisputeSettlementView = {
  disputeId: bigint;
  rulingBps: number;
  fallbackApplied: boolean;
  clientCredit: bigint;
  freelancerCredit: bigint;
  treasuryCredit: bigint;
  credits: DisputeSettlementCredit[];
};

type UintInput = bigint | number | string;

function parseUint(value: unknown): bigint | null {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    try {
      parsed = BigInt(value);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  return parsed >= 0n && parsed <= UINT256_MAX ? parsed : null;
}

function eventName(event: any): unknown {
  if (typeof event?.name === "string") return event.name;
  return event?.eventName;
}

function argsOf(event: any): Record<string, unknown> | null {
  return event?.args && typeof event.args === "object" ? event.args : null;
}

/**
 * Build a public dispute result only after the on-chain dispute is settled and
 * its matching escrow events are present and internally consistent. Amounts
 * and ruling fields come directly from events; no payout or bps math is done
 * in the client.
 */
export function buildDisputeSettlementView(
  disputeIdInput: UintInput,
  phaseInput: UintInput,
  events: readonly unknown[],
): DisputeSettlementView | null {
  const disputeId = parseUint(disputeIdInput);
  const phase = parseUint(phaseInput);
  if (disputeId === null || disputeId === 0n || phase !== SETTLED_PHASE || !Array.isArray(events)) return null;

  const matchingResolutions = events.flatMap((event) => {
    if (eventName(event) !== "MilestoneResolved") return [];
    const args = argsOf(event);
    return args && parseUint(args.disputeId) === disputeId ? [args] : [];
  });
  if (matchingResolutions.length !== 1) return null;

  const resolved = matchingResolutions[0];
  const bps = parseUint(resolved.bps);
  const clientCredit = parseUint(resolved.clientCredit);
  const freelancerCredit = parseUint(resolved.freelancerCredit);
  const treasuryCredit = parseUint(resolved.treasuryCredit);
  if (
    bps === null || bps > 10_000n ||
    clientCredit === null || freelancerCredit === null || treasuryCredit === null ||
    typeof resolved.fallbackApplied !== "boolean"
  ) return null;

  const credits: DisputeSettlementCredit[] = [];
  let partyCredits = 0n;
  let treasuryCredits = 0n;
  for (const event of events) {
    if (eventName(event) !== "DisputeSettlementCredited") continue;
    const args = argsOf(event);
    if (!args || parseUint(args.disputeId) !== disputeId) continue;

    const amount = parseUint(args.amount);
    const source = parseUint(args.source);
    if (
      amount === null || source === null || source > 2n ||
      typeof args.account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(args.account)
    ) return null;

    const typedSource = Number(source) as SettlementCreditSource;
    credits.push({ source: typedSource, account: args.account, amount });
    if (typedSource === 2) treasuryCredits += amount;
    else partyCredits += amount;
  }

  if (
    partyCredits !== clientCredit + freelancerCredit ||
    treasuryCredits !== treasuryCredit
  ) return null;

  return {
    disputeId,
    rulingBps: Number(bps),
    fallbackApplied: resolved.fallbackApplied,
    clientCredit,
    freelancerCredit,
    treasuryCredit,
    credits,
  };
}
