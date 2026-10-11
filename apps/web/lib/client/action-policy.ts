import type { JobSnapshot, PublicConfig } from "../chain.ts";

export const CONTRACT_ACTION_IDS = [
  "createJob",
  "acceptJob",
  "fundJob",
  "cancelExpiredProposal",
  "cancelUnfundedJob",
  "submitMilestone",
  "approveMilestone",
  "rejectMilestone",
  "resubmitMilestone",
  "releaseAfterSilence",
  "refundAfterMissedDeadline",
  "refundAfterRejectionWindow",
  "openDispute",
  "matchDisputeDeposit",
  "submitEvidence",
  "advanceDispute",
  "commitVote",
  "revealVote",
  "withdraw",
] as const;

export type ContractActionId = (typeof CONTRACT_ACTION_IDS)[number];
export type ActionPolicy = {
  allowedActionIds: ContractActionId[];
  disabledReasons: Partial<Record<ContractActionId, string>>;
};

type PolicyInput = {
  snapshot: JobSnapshot | null;
  account: string | null;
  chainId: number | null;
  config: PublicConfig;
  milestoneIndex?: number;
  chainFresh?: boolean;
};

const WRONG_CHAIN_REASON = "Switch to the configured local chain (31337) before sending a transaction.";
const NOT_AVAILABLE_REASON = "This action is not available for the current job state, deadline, or wallet role.";

function sameAddress(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function time(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function enumValue(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return -1;
}

function roundPanel(milestone: any, round: number): string[] {
  const panels = milestone?.panels;
  const panel = panels?.[round] ?? panels?.[String(round)];
  return Array.isArray(panel) ? panel : [];
}

export function deriveActionPolicy({ snapshot, account, chainId, config, milestoneIndex, chainFresh = true }: PolicyInput): ActionPolicy {
  const allowedActionIds: ContractActionId[] = [];
  const disabledReasons: Partial<Record<ContractActionId, string>> = {};
  const add = (action: ContractActionId, allowed: boolean, reason = NOT_AVAILABLE_REASON) => {
    if (allowed) allowedActionIds.push(action);
    else disabledReasons[action] = reason;
  };

  const connected = typeof account === "string" && account.length > 0;
  const correctChain = connected && chainId === 31337 && config.chainId === 31337;
  if (!connected) {
    for (const action of CONTRACT_ACTION_IDS) add(action, false, "Connect a wallet to see available actions.");
    return { allowedActionIds, disabledReasons };
  }
  if (!correctChain) {
    for (const action of CONTRACT_ACTION_IDS) add(action, false, WRONG_CHAIN_REASON);
    return { allowedActionIds, disabledReasons };
  }
  if (!chainFresh) {
    for (const action of CONTRACT_ACTION_IDS) add(action, false, "Refresh the agreement from chain before sending another transaction.");
    return { allowedActionIds, disabledReasons };
  }

  add("createJob", true);
  if (!snapshot) {
    for (const action of CONTRACT_ACTION_IDS) {
      if (action !== "createJob") add(action, false, "Load one job by its ID to see its available actions.");
    }
    return { allowedActionIds, disabledReasons };
  }

  const job = snapshot.job;
  const now = time(snapshot.now);
  const jobState = enumValue(job.state);
  const isClient = sameAddress(account, job.client);
  const isFreelancer = sameAddress(account, job.freelancer);
  const isParty = isClient || isFreelancer;

  add("acceptJob", jobState === 0 && isFreelancer && now < time(job.proposalEnd));
  add("cancelExpiredProposal", jobState === 0 && now >= time(job.proposalEnd));
  add("fundJob", jobState === 1 && isClient && now < time(job.fundingDeadline));
  add("cancelUnfundedJob", jobState === 1 && now >= time(job.fundingDeadline));
  add("withdraw", time(snapshot.claimable) > 0n);

  const milestones: any[] = Array.isArray(snapshot.milestones) ? snapshot.milestones : [];
  const selected = milestoneIndex === undefined ? milestones : milestones.slice(milestoneIndex, milestoneIndex + 1);
  let canSubmit = false;
  let canApprove = false;
  let canReject = false;
  let canResubmit = false;
  let canReleaseSilence = false;
  let canRefundMissed = false;
  let canRefundRejected = false;
  let canOpenDispute = false;
  let canMatchDeposit = false;
  let canSubmitEvidence = false;
  let canAdvanceDispute = false;
  let canCommitVote = false;
  let canRevealVote = false;

  for (const milestone of selected) {
    const state = enumValue(milestone.state);
    const hasNoDispute = time(milestone.disputeId) === 0n;
    canSubmit ||= jobState === 2 && state === 0 && isFreelancer && now < time(milestone.graceEnd);
    canApprove ||= jobState === 2 && state === 1 && isClient && now < time(milestone.reviewEnd);
    canReject ||= canApprove && Number(milestone.rejectionCount) < Number(job.revisionLimit);
    canResubmit ||= jobState === 2 && state === 2 && isFreelancer && now < time(milestone.responseEnd);
    canReleaseSilence ||= jobState === 2 && state === 1 && now >= time(milestone.reviewEnd);
    canRefundMissed ||= jobState === 2 && state === 0 && now >= time(milestone.graceEnd);
    canRefundRejected ||= jobState === 2 && state === 2 && now >= time(milestone.responseEnd);
    canOpenDispute ||= jobState === 2 && hasNoDispute &&
      ((state === 1 && isClient && now < time(milestone.reviewEnd)) ||
        (state === 2 && isParty && now < time(milestone.responseEnd)));

    const dispute = milestone.dispute;
    if (!dispute || state !== 3 || Number(dispute.phase) === 10) continue;

    const evidenceOpen = now < time(dispute.evidenceDeadline);
    const clientDeposited = Boolean(dispute.clientDeposited);
    const freelancerDeposited = Boolean(dispute.freelancerDeposited);
    const isOpener = sameAddress(account, dispute.opener);
    const alreadyDeposited = isClient ? clientDeposited : isFreelancer && freelancerDeposited;
    canMatchDeposit ||= isParty && !isOpener && !alreadyDeposited && Number(dispute.phase) === 1 && evidenceOpen;
    const ownEvidenceCount = isClient ? Number(dispute.clientEvidenceCount) : Number(dispute.freelancerEvidenceCount);
    canSubmitEvidence ||= isParty && evidenceOpen && ownEvidenceCount < 5;

    const phase = Number(dispute.phase);
    const deadlines: Record<number, unknown> = {
      1: dispute.evidenceDeadline,
      2: dispute.requestEnd,
      3: dispute.commitDeadline,
      4: dispute.requestEnd,
      5: dispute.replacementCommitDeadline,
      6: dispute.revealDeadline,
      7: dispute.requestEnd,
      8: dispute.commitDeadline,
      9: dispute.revealDeadline,
    };
    const randomnessPending = phase === 2 || phase === 4 || phase === 7;
    canAdvanceDispute ||= deadlines[phase] !== undefined &&
      (now >= time(deadlines[phase]) || (randomnessPending && dispute.randomnessReady === true));

    const round = Math.max(1, Number(dispute.round) || 1);
    const currentPanel = roundPanel(milestone, round);
    const assigned = currentPanel.some((member) => sameAddress(member, account));
    const vote = milestone.votes?.[String(account).toLowerCase()] ?? milestone.votes?.[account as string];
    const committed = typeof vote?.commitment === "string" && !/^0x0{64}$/i.test(vote.commitment);
    const commitEnd = phase === 5 ? time(dispute.replacementCommitDeadline) : time(dispute.commitDeadline);
    const commitPhase = phase === 3 || phase === 5 || phase === 8;
    const revealPhase = phase === 6 || phase === 9;
    canCommitVote ||= assigned && commitPhase && now < commitEnd && !committed;
    canRevealVote ||= assigned && revealPhase && now < time(dispute.revealDeadline) && committed && vote?.revealed !== true;
  }

  add("submitMilestone", canSubmit);
  add("approveMilestone", canApprove);
  add("rejectMilestone", canReject, "The client may reject only during review and while a revision remains.");
  add("resubmitMilestone", canResubmit);
  add("releaseAfterSilence", canReleaseSilence);
  add("refundAfterMissedDeadline", canRefundMissed);
  add("refundAfterRejectionWindow", canRefundRejected);
  add("openDispute", canOpenDispute);
  add("matchDisputeDeposit", canMatchDeposit);
  add("submitEvidence", canSubmitEvidence);
  add("advanceDispute", canAdvanceDispute);
  add("commitVote", canCommitVote);
  add("revealVote", canRevealVote);

  return { allowedActionIds, disabledReasons };
}
