"use client";

import { SiweMessage } from "siwe";
import {
  createWalletClient,
  custom,
  erc20Abi,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import ArbiterRegistry from "./ArbiterRegistry";
import { readArbiterRegistry, validateArbiterRegistryChange } from "../lib/client/arbiter-registry";
import {
  escrowAbi,
  getPublicConfig,
  localChain,
  publicClient,
  readChainEvents,
  readJobSnapshot,
  type JobSnapshot,
  type PublicConfig,
} from "../lib/chain.ts";
import { deriveActionPolicy, type ContractActionId } from "../lib/client/action-policy.ts";
import { formatTokenAmount, parseTokenAmount } from "../lib/client/amounts.ts";
import { localArbitrationGasLimit } from "../lib/client/local-arbitration-gas.ts";
import { buildDisputeSettlementView } from "../lib/client/dispute-settlement-view.ts";
import { createPrivateCommitment } from "../lib/client/commitments.ts";
import { applyEvidenceReceiptOutcome, type EvidenceReceiptOutcome } from "../lib/client/evidence-receipt.ts";
import { buildEvidenceEntries } from "../lib/client/evidence-plan.ts";
import { pendingEvidenceEntries } from "../lib/client/evidence-resume.ts";
import { markPrivateFileVerified, stagePrivateFile } from "../lib/client/file-drafts.ts";
import { extractCreatedJobIdentifier, parseJobIdentifier } from "../lib/client/job-identifiers.ts";
import { resolvePrivateCacheValue, shouldClearPrivateForWalletChange } from "../lib/client/private-cache-policy.ts";
import { commitPrivateReadIfCurrent, type PrivateReadContext } from "../lib/client/private-read-guard.ts";
import { privateSessionIsCurrent, resetPrivateViewForContextChange, subscribePrivateSessionInvalidation, buildPrivateConfirmationTerms } from "../lib/client/private-view-policy.ts";
import { runContractAction, transactionBlocksNewSend, type ContractActionStatus } from "../lib/client/transactions.ts";

type Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
  on?: (event: string, listener: (...args: any[]) => void) => void;
  removeListener?: (event: string, listener: (...args: any[]) => void) => void;
};
declare global {
  interface Window { ethereum?: Provider; }
}

type Wallet = {
  account: Address;
  chainId: number;
  provider: Provider;
  client: any;
  source: "browser" | "demo";
};
type Session = { wallet: string; csrfToken: string; expiresAt: string };
type ApiFile = { id: string; hash: string; reference: string; kind: string; milestoneIndex: number; disputeId?: string | null; mime: string; size: number; bound?: boolean };
type PrivateTerms = { title: string; description: string; scope: string; deliveryRules: string; criteria: string[]; salts: Record<string, string>; commitments: Record<string, string> };
type ConfirmationSummary = { action: string; chainId: number; contractAddress: string; parties: string[]; token?: { address: string; symbol: string; raw: string; formatted: string }; terms: string[]; effects: string[]; timing?: string[] };
type MilestoneDraft = { amount: string; duration: string; criteria: string };

const localBuild = process.env.NEXT_PUBLIC_FAIRWORK_LOCAL === "1";
const zero32 = `0x${"00".repeat(32)}` as Hex;
const bytes32Pattern = /^0x[0-9a-f]{64}$/i;
const statusNames: Record<number, string> = ["Proposed", "Accepted · awaiting funding", "Funded", "Cancelled", "Closed"];
const milestoneNames: Record<number, string> = ["Ready", "Under review", "Revision requested", "In dispute", "Released", "Refunded", "Resolved"];
const phaseNames: Record<number, string> = ["", "Evidence window", "Random draw · panel 1", "Panel 1 · commit", "Random draw · replacements", "Panel 1 · replacement commit", "Panel 1 · reveal", "Random draw · panel 2", "Panel 2 · commit", "Panel 2 · reveal", "Settled"];

function shortAddress(value?: string | null) {
  if (!value) return "—";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
function asBigInt(value: unknown): bigint {
  try { return typeof value === "bigint" ? value : BigInt(String(value ?? 0)); } catch { return 0n; }
}
function asNumber(value: unknown): number { const number = Number(value ?? 0); return Number.isFinite(number) ? number : 0; }
function utc(value: unknown) {
  const seconds = asNumber(value);
  if (!seconds) return "Not started";
  return new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}
function humanEvent(name: string) {
  return (name || "Activity").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}
function eventKey(event: any, index: number) {
  return `${event.transactionHash ?? event.id ?? "event"}-${event.logIndex ?? index}`;
}
async function attachBlockTimes(events: any[], config: PublicConfig) {
  const pc: any = publicClient(config);
  const blockNumbers = [...new Set(events.map((event) => String(event.blockNumber)).filter((value) => value !== "undefined"))];
  const blocks = await Promise.all(blockNumbers.map(async (value) => {
    try { return [value, await pc.getBlock({ blockNumber: BigInt(value) })] as const; }
    catch { return [value, null] as const; }
  }));
  const timestamps = new Map(blocks.filter((entry) => entry[1] !== null).map(([number, block]) => [number, Number(block!.timestamp)]));
  return events.map((event) => ({ ...event, chainTimestamp: timestamps.get(String(event.blockNumber)) ?? null }));
}
function eventMoment(event: any) {
  if (Number.isFinite(Number(event.chainTimestamp))) return Number(event.chainTimestamp) * 1000;
  const created = event.createdAt ? Date.parse(event.createdAt) : 0;
  if (Number.isFinite(created) && created > 0) return created;
  return Number(event.blockNumber ?? 0);
}
function activityOrder(left: any, right: any) {
  const byTime = eventMoment(right) - eventMoment(left);
  if (byTime) return byTime;
  if (left.source === "chain" && right.source === "chain") {
    const fields = ["blockNumber", "transactionIndex", "logIndex"];
    for (const field of fields) {
      const a = asBigInt(left[field]);
      const b = asBigInt(right[field]);
      if (a !== b) return a > b ? -1 : 1;
    }
  }
  return 0;
}
function newReference(): Hex {
  const bytes = new Uint8Array(32);
  if (!globalThis.crypto?.getRandomValues) throw new Error("A secure browser random-number source is required.");
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}
function randomSalt(): Hex { return newReference(); }
function readableError(error: unknown) {
  const message = error instanceof Error ? error.message : "The request did not complete.";
  return message.length > 280 ? `${message.slice(0, 277)}…` : message;
}

export default function EscrowDashboard() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState("");
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [jobIdText, setJobIdText] = useState("");
  const [jobId, setJobId] = useState<bigint | null>(null);
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [snapshotAccount, setSnapshotAccount] = useState<string | null>(null);
  const [chainReadState, setChainReadState] = useState<"fresh" | "refreshing" | "stale">("fresh");
  const chainReadStateRef = useRef(chainReadState);
  chainReadStateRef.current = chainReadState;
  const setChainReadStatus = (status: "fresh" | "refreshing" | "stale") => { chainReadStateRef.current = status; setChainReadState(status); };
  const [chainEvents, setChainEvents] = useState<any[]>([]);
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const [terms, setTerms] = useState<PrivateTerms | null>(null);
  const [notes, setNotes] = useState<Record<number, any[]>>({});
  const [files, setFiles] = useState<Record<number, ApiFile[]>>({});
  const [evidence, setEvidence] = useState<Record<string, any[]>>({});
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingPrivateSave, setPendingPrivateSave] = useState<{ label: string; save: () => Promise<void> } | null>(null);
  const [txStatus, setTxStatus] = useState<ContractActionStatus | "idle">("idle");
  const [txHash, setTxHash] = useState("");
  const txStatusRef = useRef<string>("idle");
  const sessionChannel = useRef<BroadcastChannel | null>(null);
  const pendingTransaction = useRef<{ hash: Hex; contextIsCurrent: () => boolean; resume: ((receipt: any) => Promise<any>) | null } | null>(null);
  const [freshness, setFreshness] = useState(0);
  const [selectedMilestone, setSelectedMilestone] = useState(0);
  const [showAgreement, setShowAgreement] = useState(false);
  const [confirmSummary, setConfirmSummary] = useState<ConfirmationSummary | null>(null);
  const confirmResolver = useRef<((value: boolean) => void) | null>(null);
  const [demoRole, setDemoRole] = useState("");
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [voteSecrets, setVoteSecrets] = useState<Record<string, { bps: string; salt: string }>>({});
  const [agreement, setAgreement] = useState({
    freelancer: "", token: "", title: "", description: "", scope: "", deliveryRules: "", reviewWindow: "3600", revisionLimit: "2",
  });
  const [milestoneDrafts, setMilestoneDrafts] = useState<MilestoneDraft[]>([{ amount: "", duration: "86400", criteria: "" }]);
  const [devSeconds, setDevSeconds] = useState("60");
  const [devRequestId, setDevRequestId] = useState("");
  const [devMode, setDevMode] = useState("0");
  const [elapsed, setElapsed] = useState(0);
  const [privateViewEpoch, setPrivateViewEpoch] = useState(0);
  const pendingEvidenceUploads = useRef(new Map<string, { key: string; file: ApiFile; submitted: boolean; receiptConfirmed: boolean }>());
  const pendingEvidenceTexts = useRef(new Map<string, { text: string; salt: Hex; commitment: Hex; reference: Hex; submitted: boolean; receiptConfirmed: boolean; privateSaved: boolean }>());
  const walletRef = useRef<Wallet | null>(wallet);
  walletRef.current = wallet;
  const sessionRef = useRef<Session | null>(session);
  sessionRef.current = session;
  const privateReadGenerationRef = useRef(0);
  const jobIdRef = useRef<bigint | null>(jobId);
  jobIdRef.current = jobId;
  const chainEventsRef = useRef<any[]>(chainEvents);
  chainEventsRef.current = chainEvents;

  const sessionIdentity = (value: Session) => `${value.wallet.toLowerCase()}\0${value.csrfToken}\0${value.expiresAt}`;
  const replaceSession = (next: Session | null) => {
    const current = sessionRef.current;
    if (current?.wallet.toLowerCase() !== next?.wallet.toLowerCase() || current?.csrfToken !== next?.csrfToken || current?.expiresAt !== next?.expiresAt) {
      privateReadGenerationRef.current += 1;
    }
    sessionRef.current = next;
    setSession(next);
  };
  const currentPrivateReadContext = (): PrivateReadContext | null => {
    const liveSession = sessionRef.current;
    const liveWallet = walletRef.current;
    const liveJobId = jobIdRef.current;
    if (!liveSession || !liveWallet || liveJobId === null || !privateSessionIsCurrent(liveSession, liveWallet.account, Date.now())) return null;
    return {
      generation: privateReadGenerationRef.current,
      jobId: liveJobId.toString(),
      wallet: liveWallet.account.toLowerCase(),
      session: sessionIdentity(liveSession),
    };
  };

  const activeToken = useMemo(() => {
    if (!config || !snapshot?.job?.token) return config?.tokens[0];
    return config.tokens.find((item) => item.address.toLowerCase() === String(snapshot.job.token).toLowerCase()) ?? config.tokens[0];
  }, [config, snapshot]);
  const clientAccount = snapshot?.job?.client as string | undefined;
  const freelancerAccount = snapshot?.job?.freelancer as string | undefined;
  const accountMatchesSession = privateSessionIsCurrent(session, wallet?.account ?? null, Date.now());
  const ledgerIsCurrent = Boolean(wallet && snapshotAccount === wallet.account.toLowerCase() && chainReadState === "fresh");
  const policy = useMemo(() => {
    if (!config) return { allowedActionIds: [] as ContractActionId[], disabledReasons: {} as Record<string, string> };
    return deriveActionPolicy({ snapshot, account: wallet?.account ?? null, chainId: wallet?.chainId ?? null, config, milestoneIndex: selectedMilestone, chainFresh: chainReadState === "fresh" });
  }, [config, snapshot, wallet, selectedMilestone, chainReadState]);
  const chainTime = asBigInt(snapshot?.now) + BigInt(Math.max(0, elapsed));
  const roleLabel = useMemo(() => {
    if (!wallet || !config) return "Wallet not connected";
    const address = wallet.account.toLowerCase();
    if (address === config.roles.client.toLowerCase() || address === clientAccount?.toLowerCase()) return "Client";
    if (address === config.roles.freelancer.toLowerCase() || address === freelancerAccount?.toLowerCase()) return "Freelancer";
    if (config.roles.treasury.toLowerCase() === address) return "Treasury";
    if (config.roles.arbiters.some((item) => item.toLowerCase() === address)) return "Arbiter";
    return "Connected wallet";
  }, [wallet, config, clientAccount, freelancerAccount]);
  const currentMilestone = snapshot?.milestones?.[selectedMilestone];
  const selectedCriterion = terms?.criteria?.[selectedMilestone];
  const currentDisputeId = currentMilestone && asBigInt(currentMilestone.disputeId) > 0n ? String(currentMilestone.disputeId) : "";

  useEffect(() => {
    let mounted = true;
    getPublicConfig().then((value) => { if (mounted) { setConfig(value); setConfigError(""); } }).catch((error) => { if (mounted) setConfigError(readableError(error)); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { setElapsed((current) => current + 1); }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const requestConfirm = useCallback((summary: ConfirmationSummary) => new Promise<boolean>((resolve) => {
    confirmResolver.current = resolve;
    setConfirmSummary(summary);
  }), []);
  const closeConfirm = (accepted: boolean) => {
    confirmResolver.current?.(accepted);
    confirmResolver.current = null;
    setConfirmSummary(null);
  };

  const clearPrivate = useCallback(() => {
    if (pendingTransaction.current) pendingTransaction.current.resume = null;
    privateReadGenerationRef.current += 1;
    sessionRef.current = null;
    const cleared = resetPrivateViewForContextChange();
    setSession(null); setTerms(cleared.terms); setNotes(cleared.notes); setFiles(cleared.files); setEvidence(cleared.evidence); setAuditEvents(cleared.auditEvents); setVoteSecrets(cleared.voteSecrets); setPendingPrivateSave(cleared.pendingPrivateSave);
    setAgreement(cleared.agreement); setMilestoneDrafts(cleared.milestoneDrafts); setShowAgreement(cleared.showAgreement); setConfirmSummary(cleared.confirmSummary);
    confirmResolver.current?.(false); confirmResolver.current = null;
    setPrivateViewEpoch((current) => current + 1);
    pendingEvidenceUploads.current.clear(); pendingEvidenceTexts.current.clear();
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("fairwork-private-session");
    sessionChannel.current = channel;
    const unsubscribe = subscribePrivateSessionInvalidation(channel, clearPrivate);
    return () => { unsubscribe(); channel.close(); sessionChannel.current = null; };
  }, [clearPrivate]);

  useEffect(() => {
    if (!session) return;
    const expiry = Date.parse(session.expiresAt);
    const delay = expiry - Date.now();
    const expire = () => {
      if (sessionRef.current?.csrfToken !== session.csrfToken) return;
      clearPrivate(); setNotice("Your private session expired. Sign in again to unlock private content.");
    };
    if (!Number.isFinite(delay) || delay <= 0) { expire(); return; }
    const timer = window.setTimeout(expire, Math.min(delay, 30 * 60 * 1000));
    return () => window.clearTimeout(timer);
  }, [session, clearPrivate]);

  const apiFetch = useCallback(async (path: string, init: RequestInit = {}, authenticatedWrite = false) => {
    const requestSession = sessionRef.current;
    const headers = new Headers(init.headers);
    if (authenticatedWrite) {
      if (!session?.csrfToken || !privateSessionIsCurrent(session, walletRef.current?.account ?? null, Date.now()) || requestSession?.csrfToken !== session.csrfToken) throw new Error("Sign in again to authorize this private save.");
      headers.set("X-CSRF-Token", session.csrfToken);
    }
    const response = await fetch(path, { ...init, headers, credentials: "include", cache: "no-store" });
    if (!response.ok) {
      if (response.status === 401 && requestSession && sessionRef.current?.csrfToken === requestSession.csrfToken) {
        sessionChannel.current?.postMessage({ type: "private-session-invalidated" }); clearPrivate();
      }
      let detail = "";
      try {
        const body = await response.json();
        const value = body?.error;
        if (typeof value === "string") detail = value;
        else if (value && typeof value.code === "string") {
          const messages: Record<string, string> = {
            AUTH_UNAVAILABLE: "Private sign-in is temporarily unavailable.",
            UNAUTHENTICATED: "Your private session has expired. Sign in again to continue.",
            INVALID_LOGIN: "The wallet sign-in could not be verified. Start sign-in again.",
            NOT_FOUND: "This private item is unavailable for the current account or agreement state.",
            INVALID_REQUEST: "Check the form and try again.",
            COMMITMENT_MISMATCH: "The private text does not match the confirmed on-chain commitment.",
            TOO_LARGE: "The selected file or text is larger than the private service allows.",
            INVALID_FILE: "Choose a supported PDF, PNG, JPEG, or plain-text file.",
            STORAGE_UNAVAILABLE: "Encrypted private storage is temporarily unavailable.",
          };
          detail = messages[value.code] ?? `The private service rejected the request (${response.status}).`;
        }
      } catch { /* use the generic status message */ }
      const error = new Error(detail || `Request failed (${response.status}).`);
      (error as any).status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }, [session, clearPrivate]);

  const refreshJob = useCallback(async (id: bigint | null = jobId, account: string | undefined = wallet?.account) => {
    if (!config || id === null) return null;
    const expectedAccount = account?.toLowerCase() ?? null;
    const expectedJobId = id;
    const isCurrentRead = () => jobIdRef.current === expectedJobId && (walletRef.current?.account.toLowerCase() ?? null) === expectedAccount;
    if (isCurrentRead()) setChainReadStatus("refreshing");
    try {
      const [freshSnapshot, rawEvents] = await Promise.all([
        readJobSnapshot(id, config, account), readChainEvents(id, config),
      ]);
      const events = await attachBlockTimes(rawEvents, config);
      if (isCurrentRead()) {
        setSnapshot(freshSnapshot); setSnapshotAccount(expectedAccount); setChainEvents(events); chainEventsRef.current = events;
        setFiles((current) => {
          let changed = false;
          const next = { ...current };
          for (const [indexText, milestone] of (freshSnapshot.milestones ?? []).entries()) {
            const index = Number(indexText);
            const filesAtMilestone = current[index] ?? [];
            const updated = filesAtMilestone.map((file) => {
              if (file.bound !== false) return file;
              const submissionMatches = file.kind === "submission" && (milestone.submissions ?? []).some((submission: any) =>
                String(submission.deliverableHash).toLowerCase() === file.hash.toLowerCase() &&
                String(submission.opaqueReference).toLowerCase() === file.reference.toLowerCase());
              const evidenceMatches = file.kind === "evidence" && Boolean(expectedAccount && file.disputeId) && pendingEvidenceEntries(
                [{ kind: "file" as const, hash: file.hash, reference: file.reference }], events, String(file.disputeId), expectedAccount ?? "",
              ).length === 0;
              if (submissionMatches || evidenceMatches) { changed = true; return { ...file, bound: true }; }
              return file;
            });
            if (updated.some((file, fileIndex) => file !== filesAtMilestone[fileIndex])) next[index] = updated;
          }
          return changed ? next : current;
        });
        setFreshness(Date.now()); setElapsed(0); setSelectedMilestone((current) => Math.min(current, Math.max(0, freshSnapshot.milestones.length - 1)));
        setChainReadStatus("fresh");
      }
      return freshSnapshot;
    } catch (error) {
      if (isCurrentRead()) setChainReadStatus("stale");
      throw error;
    }
  }, [config, jobId, wallet?.account]);

  const refreshPrivate = useCallback(async (id: bigint, currentSession = session) => {
    const activeWallet = walletRef.current;
    if (!currentSession || !activeWallet || !privateSessionIsCurrent(currentSession, activeWallet.account, Date.now()) || sessionRef.current?.csrfToken !== currentSession.csrfToken) {
      return;
    }
    const idText = id.toString();
    const milestones = snapshot?.milestones ?? [];
    const captured: PrivateReadContext = {
      generation: ++privateReadGenerationRef.current,
      jobId: idText,
      wallet: activeWallet.account.toLowerCase(),
      session: sessionIdentity(currentSession),
    };
    await commitPrivateReadIfCurrent(captured, currentPrivateReadContext, async () => Promise.allSettled([
      apiFetch(`/api/jobs/${idText}`),
      apiFetch(`/api/jobs/${idText}/timeline`),
      apiFetch(`/api/jobs/${idText}/notes`),
      Promise.allSettled(milestones.map((_: unknown, index: number) => apiFetch(`/api/jobs/${idText}/files?milestoneIndex=${index}`))),
      Promise.allSettled(milestones.map((milestone: any) => asBigInt(milestone.disputeId) > 0n ? apiFetch(`/api/disputes/${milestone.disputeId}/evidence`) : Promise.resolve([]))),
    ]), ([termResult, timelineResult, noteResult, fileCollection, evidenceCollection]) => {
      const freshTerms = termResult.status === "fulfilled" ? termResult.value?.terms ?? termResult.value ?? null : null;
      setTerms(resolvePrivateCacheValue(termResult, freshTerms, null));
      const freshTimeline = timelineResult.status === "fulfilled" ? timelineResult.value?.auditEvents ?? [] : [];
      setAuditEvents(resolvePrivateCacheValue(timelineResult, freshTimeline, []));
      if (noteResult.status === "fulfilled") {
        const raw = noteResult.value?.notes ?? noteResult.value ?? [];
        const grouped: Record<number, any[]> = {};
        for (const note of Array.isArray(raw) ? raw : []) (grouped[Number(note.milestoneIndex)] ??= []).push(note);
        setNotes(resolvePrivateCacheValue(noteResult, grouped, {}));
      } else setNotes(resolvePrivateCacheValue(noteResult, {}, {}));

      const freshFiles: Record<number, ApiFile[]> = {};
      if (fileCollection.status === "fulfilled") fileCollection.value.forEach((result, index) => {
        if (result.status === "fulfilled") freshFiles[index] = result.value?.files ?? result.value ?? [];
      });
      setFiles(resolvePrivateCacheValue(fileCollection, freshFiles, {}));

      const freshEvidence: Record<string, any[]> = {};
      if (evidenceCollection.status === "fulfilled") evidenceCollection.value.forEach((result, index) => {
        const disputeId = String(milestones[index]?.disputeId ?? "");
        if (result.status === "fulfilled" && disputeId && asBigInt(disputeId) > 0n) freshEvidence[disputeId] = result.value?.items ?? [];
      });
      setEvidence(resolvePrivateCacheValue(evidenceCollection, freshEvidence, {}));
      if (timelineResult.status === "rejected" && (timelineResult.reason as any)?.status !== 404) setNotice("Private timeline is unavailable for this role. Chain events remain visible.");
    });
  }, [apiFetch, session, snapshot]);

  useEffect(() => {
    if (jobId === null || !snapshot || !session || !accountMatchesSession) return;
    refreshPrivate(jobId).catch(() => { /* private routes remain fail-closed; chain view is independent */ });
  }, [jobId, snapshot?.milestones?.length, session, accountMatchesSession, refreshPrivate]);

  const setConnectedWallet = useCallback(async (provider: Provider, account: string, source: Wallet["source"]) => {
    const checksummed = account as Address;
    const chainText = await provider.request({ method: "eth_chainId" });
    const chainId = typeof chainText === "string" ? Number(BigInt(chainText)) : Number(chainText);
    const client = createWalletClient({ account: checksummed, chain: localChain, transport: custom(provider as any) });
    const connected = { account: checksummed, chainId, provider, client, source } as Wallet;
    if (jobIdRef.current !== null && walletRef.current?.account.toLowerCase() !== checksummed.toLowerCase()) setChainReadStatus("refreshing");
    walletRef.current = connected;
    setWallet(connected);
    setDemoRole(""); setPageError("");
    return connected;
  }, []);

  const logout = useCallback(async () => {
    sessionChannel.current?.postMessage({ type: "private-session-invalidated" });
    const logoutRequest = session?.csrfToken
      ? fetch("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": session.csrfToken }, credentials: "include", cache: "no-store" })
      : null;
    clearPrivate();
    try { await logoutRequest; } catch { /* clear local data even if the service is offline */ }
  }, [session, clearPrivate]);

  useEffect(() => {
    if (!wallet?.provider.on) return;
    const handleAccounts = (accounts: string[]) => {
      const nextAccount = Array.isArray(accounts) && accounts[0] ? accounts[0] : null;
      if (shouldClearPrivateForWalletChange(wallet.account, nextAccount)) {
        void logout();
        walletRef.current = null;
        setWallet(null);
        setSnapshot(null); setSnapshotAccount(null); setChainEvents([]); chainEventsRef.current = []; setJobId(null); jobIdRef.current = null; setJobIdText(""); setFreshness(0); setElapsed(0); setSelectedMilestone(0); setChainReadStatus("fresh");
      }
    };
    const handleChain = (chain: string) => setWallet((current) => current ? { ...current, chainId: Number(BigInt(chain)) } : current);
    wallet.provider.on("accountsChanged", handleAccounts);
    wallet.provider.on("chainChanged", handleChain);
    return () => {
      wallet.provider.removeListener?.("accountsChanged", handleAccounts);
      wallet.provider.removeListener?.("chainChanged", handleChain);
    };
  }, [wallet, logout]);

  const connectBrowserWallet = async () => {
    setPageError("");
    const provider = window.ethereum;
    if (!provider) { setPageError("No browser wallet was found. Install or unlock a wallet, then try again."); return; }
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!Array.isArray(accounts) || !accounts[0]) throw new Error("The wallet did not return an account.");
      if (wallet && wallet.account.toLowerCase() !== accounts[0].toLowerCase()) { setChainReadStatus("refreshing"); await logout(); }
      const connected = await setConnectedWallet(provider, accounts[0], "browser");
      try {
        const safeSession = await apiFetch("/api/auth/session");
        if (safeSession.wallet?.toLowerCase() === connected.account.toLowerCase()) replaceSession(safeSession);
        else if (safeSession.csrfToken) { sessionChannel.current?.postMessage({ type: "private-session-invalidated" }); await fetch("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": safeSession.csrfToken }, credentials: "include", cache: "no-store" }); }
      } catch { /* sign-in remains available when there is no saved session */ }
      if (jobIdRef.current !== null) await refreshJob(jobIdRef.current, connected.account).catch((error) => { setPageError(readableError(error)); });
    } catch (error) { setPageError(readableError(error)); }
  };

  const connectDemoRole = async (value: string) => {
    if (!localBuild || !config) return;
    setBusy(true); setPageError("");
    if (jobIdRef.current !== null) setChainReadStatus("refreshing");
    try {
      await logout();
      const role = value === "client" ? config.roles.client : value === "freelancer" ? config.roles.freelancer : value === "treasury" ? config.roles.treasury : config.roles.arbiters[Number(value.replace("arbiter-", "")) - 1];
      if (!role) throw new Error("That local demo role is not configured.");
      const { createDemoProvider } = await import("../lib/dev-wallet.ts");
      const provider = createDemoProvider(config, role);
      await setConnectedWallet(provider, role, "demo");
      setDemoRole(value);
      if (jobIdRef.current !== null) await refreshJob(jobIdRef.current, role).catch((error) => { setPageError(readableError(error)); });
    } catch (error) { setPageError(readableError(error)); }
    finally { setBusy(false); }
  };

  const switchToLocalChain = async () => {
    if (!wallet) return;
    try {
      try { await wallet.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7a69" }] }); }
      catch (error: any) {
        if (error?.code !== 4902) throw error;
        await wallet.provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x7a69", chainName: "Fairwork Local", nativeCurrency: { name: "Demo Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["http://127.0.0.1:8545"] }] });
      }
      const chainText = await wallet.provider.request({ method: "eth_chainId" });
      setWallet({ ...wallet, chainId: Number(BigInt(chainText)) });
    } catch (error) { setPageError(readableError(error)); }
  };

  const signIn = async () => {
    if (!wallet) { setPageError("Connect a wallet before signing in."); return; }
    if (wallet.chainId !== 31337) { setPageError("Switch to local chain 31337 before signing in."); return; }
    setBusy(true); setPageError(""); setNotice("");
    try {
      const challenge = await apiFetch("/api/auth/nonce", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const message = new SiweMessage({
        domain: challenge.domain ?? config?.domain ?? "localhost:3000",
        address: wallet.account,
        statement: "Sign in to access your private Fairwork agreement and evidence.",
        uri: challenge.uri ?? config?.uri ?? "http://localhost:3000",
        version: "1",
        chainId: Number(challenge.chainId ?? 31337),
        nonce: challenge.nonce,
        issuedAt: new Date().toISOString(),
      });
      const preparedMessage = message.prepareMessage();
      const summary = buildSummary("Authorize a private-data session", [
        "Sign a one-time SIWE message so the local service can verify this wallet.",
        "The service will apply fresh party or current-arbiter checks to every private request.",
        "This does not send a contract transaction, transfer tokens, or change an allowance.",
      ]);
      summary.chainId = 31337;
      summary.contractAddress = config?.escrow ?? "Unavailable";
      summary.parties = [...new Set([wallet.account, clientAccount, freelancerAccount].filter((value): value is string => Boolean(value)))];
      summary.terms = [
        `Wallet ${wallet.account}`,
        `SIWE domain ${message.domain}`,
        `Origin ${message.uri}`,
        "Authorization is limited by server-side agreement and current-case roles.",
        "The sign-in nonce is private and is not shown here.",
      ];
      summary.timing = ["Nonce: single use, valid for up to 5 minutes", "Private session: 30 minutes, sign out at any time"];
      if (!await requestConfirm(summary)) {
        setNotice("Sign-in cancelled before the wallet signature.");
        return;
      }
      if (walletRef.current?.account.toLowerCase() !== wallet.account.toLowerCase() || Number(BigInt(await wallet.provider.request({ method: "eth_chainId" }))) !== 31337) throw new Error("The wallet or network changed before sign-in. Start sign-in again.");
      const signature = await wallet.client.signMessage({ account: wallet.account, message: preparedMessage });
      if (walletRef.current?.account.toLowerCase() !== wallet.account.toLowerCase() || Number(BigInt(await wallet.provider.request({ method: "eth_chainId" }))) !== 31337) throw new Error("The wallet or network changed while signing. Start sign-in again.");
      const result = await apiFetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: preparedMessage, signature }) });
      if (!privateSessionIsCurrent(result, walletRef.current?.account ?? null, Date.now()) || walletRef.current?.chainId !== 31337) {
        if (result.csrfToken) { sessionChannel.current?.postMessage({ type: "private-session-invalidated" }); await fetch("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": result.csrfToken }, credentials: "include", cache: "no-store" }).catch(() => undefined); }
        throw new Error("The signed session does not match the current wallet or network. Start sign-in again.");
      }
      const signedSession = { wallet: result.wallet, csrfToken: result.csrfToken, expiresAt: result.expiresAt };
      sessionChannel.current?.postMessage({ type: "private-session-invalidated" });
      replaceSession(signedSession);
      setNotice("Private session unlocked for this wallet. Session credentials stay in memory only.");
      if (jobId !== null) await refreshPrivate(jobId, signedSession);
    } catch (error) { setPageError(readableError(error)); }
    finally { setBusy(false); }
  };

  const loadJob = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!config) { setPageError("Local deployment configuration is not ready yet."); return; }
    const value = jobIdText.trim();
    const parsedId = parseJobIdentifier(value);
    if (parsedId === null) { setPageError("Enter one canonical decimal agreement ID from 0 through uint256 max. Jobs are not listed or searched."); return; }
    privateReadGenerationRef.current += 1;
    setBusy(true); setPageError(""); setNotice(""); setTerms(null); setNotes({}); setFiles({}); setEvidence({}); setAuditEvents([]); setSnapshot(null); setSnapshotAccount(null); setChainEvents([]); chainEventsRef.current = []; setJobId(null); jobIdRef.current = null; setChainReadStatus("refreshing");
    try {
      const id = parsedId;
      const [freshSnapshot, rawEvents] = await Promise.all([
        readJobSnapshot(id, config, wallet?.account), readChainEvents(id, config),
      ]);
      const events = await attachBlockTimes(rawEvents, config);
      jobIdRef.current = id;
      setJobId(id); setSnapshot(freshSnapshot); setSnapshotAccount(wallet?.account.toLowerCase() ?? null); setChainEvents(events); chainEventsRef.current = events; setFreshness(Date.now()); setElapsed(0); setSelectedMilestone(0); setChainReadStatus("fresh");
      if (session && wallet && session.wallet.toLowerCase() === wallet.account.toLowerCase()) {
        await refreshPrivate(id, session);
      } else {
        try {
          const safeSession = await apiFetch("/api/auth/session");
          if (safeSession.wallet?.toLowerCase() === wallet?.account.toLowerCase()) {
            replaceSession(safeSession); await refreshPrivate(id, safeSession);
          }
        } catch { /* keep the public chain view available */ }
      }
    } catch (error) { setSnapshot(null); setSnapshotAccount(null); setChainReadStatus("stale"); setPageError(readableError(error)); }
    finally { setBusy(false); }
  };

  const buildSummary = (action: string, effects: string[], token = activeToken, raw?: bigint, timing: string[] = []): ConfirmationSummary => ({
    action,
    chainId: config?.chainId ?? 31337,
    contractAddress: config?.escrow ?? "Unavailable",
    parties: [clientAccount ?? wallet?.account ?? "—", freelancerAccount ?? "—"],
    token: token ? { address: token.address, symbol: token.symbol, raw: raw?.toString() ?? "not transferred", formatted: raw === undefined ? token.symbol : formatTokenAmount(raw, token.decimals, token.symbol) } : undefined,
    terms: [
      `Title ${snapshot?.commitments?.titleCommitment ?? "new private agreement"}`,
      `Description ${snapshot?.commitments?.descriptionCommitment ?? "new private agreement"}`,
      `Scope ${snapshot?.commitments?.scopeCommitment ?? "new private agreement"}`,
      `Delivery rules ${snapshot?.commitments?.deliveryRuleCommitment ?? "new private agreement"}`,
      `Revision limit per milestone ${snapshot?.job?.revisionLimit ?? agreement.revisionLimit}`,
    ],
    timing: timing.length ? timing : snapshot ? [`Estimated chain time ${utc(chainTime)}`, `Proposal end ${utc(snapshot.job.proposalEnd)}`, `Milestone ${selectedMilestone + 1}`] : [`Agreement review window ${agreement.reviewWindow} seconds`],
    effects,
  });

  const runTransaction = async (action: string, summary: ConfirmationSummary, send: () => Promise<Hex>, afterReceipt?: (receipt: any, contextIsCurrent: () => boolean) => Promise<void>, allowedAction?: ContractActionId, customRefetch?: (receipt: any, contextIsCurrent: () => boolean) => Promise<any>, onReceiptOutcome?: (outcome: EvidenceReceiptOutcome) => void) => {
    if (transactionBlocksNewSend(txStatusRef.current)) throw new Error("Check the original pending or unknown transaction receipt before sending another transaction.");
    if (!config || !wallet) throw new Error("Connect a wallet and load the pinned local configuration first.");
    if (chainReadStateRef.current !== "fresh") throw new Error("Refresh the agreement from chain before sending another transaction.");
    if (allowedAction) {
      const currentPolicy = deriveActionPolicy({ snapshot, account: wallet.account, chainId: wallet.chainId, config, milestoneIndex: selectedMilestone, chainFresh: chainReadStateRef.current === "fresh" });
      if (!currentPolicy.allowedActionIds.includes(allowedAction)) throw new Error(currentPolicy.disabledReasons[allowedAction] ?? "This action is not available now.");
    }
    const transactionAccount = wallet.account.toLowerCase();
    const transactionSessionToken = sessionRef.current?.csrfToken ?? null;
    const transactionJobId = action === "Create private agreement" ? null : jobId?.toString() ?? null;
    const contextIsCurrent = () => (sessionRef.current?.csrfToken ?? null) === transactionSessionToken && walletRef.current?.account.toLowerCase() === transactionAccount &&
      (transactionJobId === null || jobIdRef.current?.toString() === transactionJobId);
    setBusy(true); setPageError(""); setNotice(""); setTxHash(""); setTxStatus("idle");
    let receiptSeen: any = null;
    try {
      const actionInput: any = {
        expectedChainId: config.chainId,
        activeChainId: wallet.chainId,
        confirm: requestConfirm,
        validateBeforeSend: async () => {
          if (!contextIsCurrent()) throw new Error("The wallet or agreement changed while confirmation was open.");
          const providerChain = Number(BigInt(await wallet.provider.request({ method: "eth_chainId" })));
          if (providerChain !== config.chainId || walletRef.current?.chainId !== config.chainId || !contextIsCurrent()) throw new Error("The wallet or network changed before the transaction. Confirm the current action again.");
          if (allowedAction && transactionJobId !== null) {
            const fresh = await refreshJob(BigInt(transactionJobId), transactionAccount);
            if (!contextIsCurrent() || !fresh) throw new Error("The wallet or agreement changed before the fresh action check.");
            const currentPolicy = deriveActionPolicy({ snapshot: fresh, account: wallet.account, chainId: providerChain, config, milestoneIndex: selectedMilestone, chainFresh: true });
            if (!currentPolicy.allowedActionIds.includes(allowedAction)) throw new Error(currentPolicy.disabledReasons[allowedAction] ?? "The action is no longer available.");
          }
          if (chainReadStateRef.current !== "fresh") throw new Error("Refresh chain state before continuing.");
        },
        send: async () => {
          const hash = await send(); setTxHash(hash);
          pendingTransaction.current = { hash, contextIsCurrent, resume: (receipt: any) => {
            receiptSeen = receipt;
            return runContractAction({ ...actionInput, confirm: async () => true, validateBeforeSend: undefined, send: async () => hash, waitForReceipt: async () => receipt });
          } };
          return hash;
        },
        waitForReceipt: async (hash: Hex) => { receiptSeen = await (publicClient(config) as any).waitForTransactionReceipt({ hash }); return receiptSeen; },
        afterReceipt: async (receipt: any) => { if (afterReceipt) await afterReceipt(receipt, contextIsCurrent); },
        onReceiptOutcome: (outcome: EvidenceReceiptOutcome) => { if (contextIsCurrent()) onReceiptOutcome?.(outcome); },
        refetchFromChain: async () => {
          if (customRefetch) {
            const fresh = await customRefetch(receiptSeen, contextIsCurrent);
            if (contextIsCurrent()) setChainReadStatus("fresh");
            return fresh;
          }
          if (action === "Create private agreement") return null;
          const fresh = await refreshJob(transactionJobId === null ? null : BigInt(transactionJobId), transactionAccount);
          if (!fresh) throw new Error("The agreement refresh did not return a chain snapshot.");
          if (!contextIsCurrent()) throw new Error("The wallet or agreement changed before the fresh read completed. Refresh the current agreement before continuing.");
          return fresh;
        },
        onStatus: (status: ContractActionStatus) => {
          txStatusRef.current = status;
          if (status === "confirmed" || status === "failed") pendingTransaction.current = null;
          setTxStatus(status);
          if (status === "confirmed" && contextIsCurrent()) setChainReadStatus("refreshing");
        },
        summary,
      };
      const result = await runContractAction(actionInput);
      if (result.hash) setTxHash(String(result.hash));
      if (result.snapshot && contextIsCurrent()) setNotice(`${action} confirmed. State refreshed from chain.`);
      else if (result.snapshot) setNotice(`${action} confirmed. The wallet or agreement changed; refresh the current view before continuing.`);
      return result;
    } catch (error) {
      if (error instanceof Error && /Transaction confirmed, but the chain refresh failed/i.test(error.message) && contextIsCurrent()) setChainReadStatus("stale");
      throw error;
    } finally { setBusy(false); }
  };

  const checkUnknownReceipt = async () => {
    const pending = pendingTransaction.current;
    if (!config || !pending || busy) return;
    setBusy(true); setPageError("");
    try {
      const receipt = await (publicClient(config) as any).getTransactionReceipt({ hash: pending.hash });
      if (receipt.status !== "success" && receipt.status !== "reverted") throw new Error("The original transaction outcome is still unknown.");
      if (pending.resume && pending.contextIsCurrent()) await pending.resume(receipt);
      else {
        const status = receipt.status === "success" ? "confirmed" : "failed";
        txStatusRef.current = status; setTxStatus(status); pendingTransaction.current = null;
        setChainReadStatus("stale");
        setNotice("Original receipt checked. Private follow-ups were discarded after a context change; refresh and recover any unsaved private content while signed in as its original wallet.");
      }
    } catch (error) { setPageError(readableError(error)); }
    finally { setBusy(false); }
  };

  const writeEscrow = async (functionName: string, args: any[], label: string, effects: string[], allowedAction?: ContractActionId, raw?: bigint, afterReceipt?: (receipt: any, contextIsCurrent: () => boolean) => Promise<void>) => {
    if (!config || !wallet) throw new Error("Connect a wallet first.");
    const summary = buildSummary(label, effects, activeToken, raw);
    return runTransaction(label, summary, () => wallet.client.writeContract({ address: config.escrow, abi: escrowAbi, functionName, args, account: wallet.account, gas: localArbitrationGasLimit(functionName, wallet.source, wallet.chainId) }), afterReceipt, allowedAction);
  };

  const changeArbiterRegistry = async (method: "addArbiter" | "removeArbiter", address: Address) => {
    if (!config || !wallet) throw new Error("Connect the registry owner wallet first.");
    const adding = method === "addArbiter";
    const registryJobId = jobIdRef.current?.toString() ?? null;
    const registrySessionToken = sessionRef.current?.csrfToken ?? null;
    let confirmed = false;
    const summary = buildSummary(adding ? "Add registered arbiter" : "Remove registered arbiter", [
      `${adding ? "Add" : "Remove"} ${address} ${adding ? "to" : "from"} the public registry.`,
      "Future selections use the updated registry. Existing snapshotted panels do not change.",
      "This action transfers no tokens and grants no access to an already assigned private case.",
    ]);
    summary.parties = [wallet.account, address];
    summary.terms = ["Owner-only registry administration; contract enforcement remains authoritative."];
    summary.timing = ["Registry changes affect future panel selection."];
    await runTransaction(summary.action, summary, async () => {
      const currentRegistry = await readArbiterRegistry(config);
      const validatedAddress = validateArbiterRegistryChange(method, address, wallet.account, currentRegistry);
      const providerChain = Number(BigInt(await wallet.provider.request({ method: "eth_chainId" })));
      if (providerChain !== config.chainId || walletRef.current?.chainId !== config.chainId || walletRef.current?.account.toLowerCase() !== wallet.account.toLowerCase()
        || (jobIdRef.current?.toString() ?? null) !== registryJobId || (sessionRef.current?.csrfToken ?? null) !== registrySessionToken) throw new Error("Wallet, network or agreement context changed during registry validation.");
      return wallet.client.writeContract({ address: config.escrow, abi: escrowAbi, functionName: method, args: [validatedAddress], account: wallet.account });
    }, async () => { confirmed = true; }, undefined, async () => {
      const registry = await readArbiterRegistry(config);
      if (jobId !== null) await refreshJob(jobId, wallet.account.toLowerCase());
      return registry;
    });
    if (!confirmed) throw new Error("Registry receipt is not confirmed. Check the original transaction before sending again.");
  };

  const ensureExactAllowance = async (tokenAddress: Address, token: { symbol: string; decimals: number }, required: bigint, actionLabel: string) => {
    if (!config || !wallet || !snapshot) throw new Error("Load the agreement before approving tokens.");
    const pc: any = publicClient(config);
    const current = await pc.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "allowance", args: [wallet.account, config.escrow] });
    if (current === required) return;
    if (current > 0n) {
      await runTransaction("Clear existing token allowance", buildSummary("Clear the prior token allowance", [`Set approval for ${token.symbol} to zero before setting the exact amount for ${actionLabel}.`], { address: tokenAddress, symbol: token.symbol, decimals: token.decimals }, 0n), () => wallet.client.writeContract({ address: tokenAddress, abi: erc20Abi, functionName: "approve", args: [config.escrow, 0n], account: wallet.account }));
    }
    await runTransaction(`Approve exact ${token.symbol} amount`, buildSummary(`Approve exact amount for ${actionLabel}`, [`Allow the escrow to transfer exactly ${formatTokenAmount(required, token.decimals, token.symbol)}. This replaces any previous allowance.`], { address: tokenAddress, symbol: token.symbol, decimals: token.decimals }, required), () => wallet.client.writeContract({ address: tokenAddress, abi: erc20Abi, functionName: "approve", args: [config.escrow, required], account: wallet.account }));
  };

  const performAllowanceAction = async (action: "fundJob" | "openDispute" | "matchDisputeDeposit", amount: bigint, tokenAddress = snapshot?.job?.token as Address) => {
    if (!config || !wallet || !snapshot || !activeToken) throw new Error("Load the agreement first.");
    const token = config.tokens.find((candidate) => candidate.address.toLowerCase() === tokenAddress.toLowerCase());
    if (!token) throw new Error("This token is not in the pinned allowlist.");
    const policyId: ContractActionId = action;
    const currentPolicy = deriveActionPolicy({ snapshot, account: wallet.account, chainId: wallet.chainId, config, milestoneIndex: selectedMilestone, chainFresh: chainReadState === "fresh" });
    if (!currentPolicy.allowedActionIds.includes(policyId)) throw new Error(currentPolicy.disabledReasons[policyId] ?? "Action unavailable.");
    await ensureExactAllowance(tokenAddress, token, amount, action);
    const index = BigInt(selectedMilestone);
    if (action === "fundJob") return writeEscrow("fundJob", [jobId], "Fund the accepted agreement", [`Transfer exactly ${formatTokenAmount(amount, token.decimals, token.symbol)} from the client into escrow.`], action, amount);
    if (action === "openDispute") return writeEscrow("openDispute", [jobId, index], "Open a milestone dispute", [`Post the exact ${formatTokenAmount(amount, token.decimals, token.symbol)} dispute deposit.`, "The milestone moves into arbitration; funds remain locked until resolution."], action, amount);
    return writeEscrow("matchDisputeDeposit", [asBigInt(currentMilestone.disputeId)], "Match the dispute deposit", [`Post the exact matching deposit of ${formatTokenAmount(amount, token.decimals, token.symbol)}.`], action, amount);
  };

  const uploadFile = async (file: File, kind: "submission" | "evidence", milestoneIndex: number, disputeId?: string) => {
    if (jobId === null || !accountMatchesSession) throw new Error("Sign in as an authorized agreement party before uploading private files.");
    if (!/^(application\/pdf|image\/png|image\/jpeg|text\/plain)$/.test(file.type) && !(file.type === "" && /\.txt$/i.test(file.name))) throw new Error("Choose a PDF, PNG, JPEG, or plain-text file.");
    const upload = file.type === "" && /\.txt$/i.test(file.name) ? new File([file], file.name, { type: "text/plain" }) : file;
    const form = new FormData(); form.set("file", upload, upload.name); form.set("kind", kind); form.set("milestoneIndex", String(milestoneIndex)); if (disputeId) form.set("disputeId", disputeId);
    return apiFetch(`/api/jobs/${jobId}/files`, { method: "POST", body: form }, true) as Promise<ApiFile>;
  };

  const saveTerms = async (id: bigint, payload: PrivateTerms, contextIsCurrent: () => boolean = () => true) => {
    if (!session?.csrfToken) throw new Error("The agreement is on chain, but you must sign in again to save its private terms.");
    await apiFetch(`/api/jobs/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, true);
    if (!contextIsCurrent()) throw new Error("The private terms were saved after the wallet changed; reconnect the original client before reading them here.");
    setTerms(payload);
    setPendingPrivateSave(null);
  };

  const saveWithRetry = async (label: string, save: () => Promise<void>, contextIsCurrent: () => boolean = () => true) => {
    try { await save(); if (contextIsCurrent()) setPendingPrivateSave(null); }
    catch (error) { if (contextIsCurrent()) setPendingPrivateSave({ label, save }); throw error; }
  };

  const retryPrivateSave = async () => {
    if (!pendingPrivateSave || !accountMatchesSession) return;
    setBusy(true); setPageError("");
    try { await pendingPrivateSave.save(); setPendingPrivateSave(null); setNotice("Private content saved to encrypted storage."); }
    catch (error) { setPageError(readableError(error)); }
    finally { setBusy(false); }
  };

  const createAgreement = async (event: FormEvent) => {
    event.preventDefault();
    if (!config || !wallet || !accountMatchesSession) { setPageError("Connect as the client and sign in to save private agreement terms."); return; }
    if (chainReadStateRef.current !== "fresh") { setPageError("Refresh the agreement from chain before creating another proposal."); return; }
    setBusy(true); setPageError(""); setNotice("");
    let createdId: bigint | null = null;
    let privateTermsSaved = false;
    let privateSaveAttempted = false;
    let freshSnapshotLoaded = false;
    try {
      const freelancer = agreement.freelancer.trim() as Address;
      if (!/^0x[0-9a-f]{40}$/i.test(freelancer) || freelancer.toLowerCase() === wallet.account.toLowerCase()) throw new Error("Enter a different valid freelancer address.");
      if (!agreement.title.trim() || !agreement.description.trim() || !agreement.scope.trim() || !agreement.deliveryRules.trim()) throw new Error("Complete every agreement term before creating the proposal.");
      if (milestoneDrafts.length < 1 || milestoneDrafts.length > 10) throw new Error("Use between 1 and 10 milestones.");
      const token = config.tokens.find((candidate) => candidate.address.toLowerCase() === agreement.token.toLowerCase()) ?? config.tokens[0];
      const commitments: Record<string, string> = {};
      const salts: Record<string, string> = {};
      const content: PrivateTerms = { title: agreement.title.trim(), description: agreement.description.trim(), scope: agreement.scope.trim(), deliveryRules: agreement.deliveryRules.trim(), criteria: [], salts, commitments };
      const fields = [
        ["title", "TITLE", content.title], ["description", "DESCRIPTION", content.description], ["scope", "SCOPE", content.scope], ["deliveryRules", "DELIVERY_RULES", content.deliveryRules],
      ] as const;
      for (const [key, tag, text] of fields) { const secret = createPrivateCommitment(tag, text); salts[key] = secret.salt; commitments[key] = secret.commitment; }
      const chainMilestones = milestoneDrafts.map((item, index) => {
        const criteriaText = item.criteria.trim();
        const amount = parseTokenAmount(item.amount, token.decimals);
        const duration = Number(item.duration);
        if (!criteriaText || !Number.isSafeInteger(duration) || duration < 1 || duration > 31_536_000) throw new Error(`Milestone ${index + 1} needs acceptance criteria and a duration between 1 second and 365 days.`);
        const key = `criteria.${index}`;
        const secret = createPrivateCommitment("ACCEPTANCE_CRITERIA", criteriaText);
        salts[key] = secret.salt; commitments[key] = secret.commitment; content.criteria.push(criteriaText);
        return { amount, duration: BigInt(duration), acceptanceCriteriaCommitment: secret.commitment };
      });
      const total = chainMilestones.reduce((sum, item) => sum + item.amount, 0n);
      const termsInput = { freelancer, token: token.address, titleCommitment: commitments.title, descriptionCommitment: commitments.description, scopeCommitment: commitments.scope, deliveryRuleCommitment: commitments.deliveryRules, reviewWindow: BigInt(agreement.reviewWindow), revisionLimit: Number(agreement.revisionLimit) };
      if (!Number.isSafeInteger(Number(agreement.reviewWindow)) || Number(agreement.reviewWindow) < 1 || Number(agreement.reviewWindow) > 31_536_000) throw new Error("Review window must be between 1 second and 365 days.");
      const summary = buildSummary("Create private agreement proposal", [
        `Create a direct proposal naming ${freelancer} as the only freelancer who can accept.`,
        `Proposal total: ${formatTokenAmount(total, token.decimals, token.symbol)} across ${chainMilestones.length} milestones.`,
        "Private terms and random salts will be saved to the encrypted service after chain confirmation.",
      ], token, total, [`Review window ${agreement.reviewWindow}s`, `Revision limit per milestone ${agreement.revisionLimit}`, ...chainMilestones.map((item, index) => `Milestone ${index + 1}: ${formatTokenAmount(item.amount, token.decimals, token.symbol)}, ${item.duration}s`)]);
      summary.parties = [wallet.account, freelancer];
      summary.terms = [
        ...buildPrivateConfirmationTerms(content, commitments),
        `Revision limit per milestone ${agreement.revisionLimit}`,
      ];
      const result = await runTransaction("Create private agreement", summary,
        () => wallet.client.writeContract({ address: config.escrow, abi: escrowAbi, functionName: "createJob", args: [termsInput, chainMilestones], account: wallet.account }),
        async (receipt, contextIsCurrent) => {
          const created = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "JobCreated", strict: false }) as any[];
          const eventJobId = extractCreatedJobIdentifier(created);
          if (eventJobId === null) throw new Error("The transaction succeeded, but its JobCreated event was missing or invalid.");
          createdId = eventJobId;
          if (!contextIsCurrent()) return;
          privateSaveAttempted = true;
          await saveWithRetry("Save the new agreement’s private terms", async () => { await saveTerms(eventJobId, content, contextIsCurrent); }, contextIsCurrent);
          privateTermsSaved = true;
        },
        undefined,
        async (_receipt, contextIsCurrent) => {
          if (createdId === null) throw new Error("The transaction succeeded, but its JobCreated event was unavailable for the fresh chain read.");
          const fresh = await readJobSnapshot(createdId, config, wallet.account);
          const events = await attachBlockTimes(await readChainEvents(createdId, config), config);
          if (contextIsCurrent()) {
            privateReadGenerationRef.current += 1;
            setTerms(null); setNotes({}); setFiles({}); setEvidence({}); setAuditEvents([]); setVoteSecrets({});
            jobIdRef.current = createdId;
            setJobId(createdId); setJobIdText(createdId.toString()); setSnapshot(fresh); setSnapshotAccount(wallet.account.toLowerCase()); setChainEvents(events); chainEventsRef.current = events; setFreshness(Date.now()); setElapsed(0); setSelectedMilestone(0);
            freshSnapshotLoaded = true;
          }
          return fresh;
        });
      const confirmedCreatedId = createdId as bigint | null;
      if (confirmedCreatedId !== null) {
        const creationContextCurrent = walletRef.current?.account.toLowerCase() === wallet.account.toLowerCase() && jobIdRef.current?.toString() === confirmedCreatedId.toString();
        if (!creationContextCurrent) {
          setShowAgreement(false);
          setNotice(`Agreement #${confirmedCreatedId} was created on chain, but the wallet changed before it could be opened. Reconnect the original client wallet and enter this ID to review its private terms.`);
          return;
        }
        setShowAgreement(false); setNotice(`Agreement #${confirmedCreatedId} created. Review its private terms before sending it to the freelancer.`);
        setAgreement({ freelancer: "", token: "", title: "", description: "", scope: "", deliveryRules: "", reviewWindow: "3600", revisionLimit: "2" });
        setMilestoneDrafts([{ amount: "", duration: "86400", criteria: "" }]);
        await refreshPrivate(confirmedCreatedId);
      }
      return result;
    } catch (error) {
      const confirmedCreatedId = createdId as bigint | null;
      if (confirmedCreatedId !== null) {
        const walletStillMatches = walletRef.current?.account.toLowerCase() === wallet.account.toLowerCase();
        if (!freshSnapshotLoaded && walletStillMatches) {
          jobIdRef.current = confirmedCreatedId;
          setJobId(confirmedCreatedId); setJobIdText(confirmedCreatedId.toString()); setSnapshot(null); setSnapshotAccount(null); setChainEvents([]); chainEventsRef.current = []; setChainReadStatus("stale");
        }
        setShowAgreement(false);
        setNotice(!walletStillMatches
          ? `Agreement #${confirmedCreatedId} was created on chain, but the wallet changed before the fresh view completed. Reconnect the original client wallet and enter this ID to review its private terms.`
          : privateTermsSaved
          ? `Agreement #${confirmedCreatedId} was created and its private terms were saved. Refresh chain state before sharing it.`
          : privateSaveAttempted
            ? `Agreement #${confirmedCreatedId} was created on chain. Retry the pending private terms save before sharing it.`
            : `Agreement #${confirmedCreatedId} was created on chain, but its private terms could not be saved in the original wallet context.`);
      }
      setPageError(readableError(error));
    }
    finally { setBusy(false); }
  };

  const runSimple = async (action: ContractActionId, functionName: string, args: any[], label: string, effects: string[], raw?: bigint, afterReceipt?: (receipt: any, contextIsCurrent: () => boolean) => Promise<void>) => {
    try { await writeEscrow(functionName, args, label, effects, action, raw, afterReceipt); }
    catch (error) { setPageError(readableError(error)); }
  };

  const submitMilestone = async (event: FormEvent<HTMLFormElement>, resubmit = false) => {
    event.preventDefault(); if (!snapshot || jobId === null) return;
    if (!wallet || !accountMatchesSession) { setPageError("Sign in as an authorized agreement party before uploading a deliverable."); return; }
    const capturedJobId = jobId; const capturedMilestone = selectedMilestone; const capturedAccount = wallet.account.toLowerCase();
    const contextIsCurrent = () => walletRef.current?.account.toLowerCase() === capturedAccount && jobIdRef.current?.toString() === capturedJobId.toString();
    const form = event.currentTarget;
    const input = form.elements.namedItem("deliverable") as HTMLInputElement;
    const file = input.files?.[0];
    setBusy(true); setPageError("");
    try {
      if (!file) throw new Error("Choose a PDF, PNG, JPEG, or plain-text deliverable to attach.");
      const uploaded = await uploadFile(file, "submission", capturedMilestone);
      if (!contextIsCurrent()) throw new Error("The file was uploaded, but the wallet or agreement changed before it could be attached here. Reopen the original agreement to continue.");
      if (!bytes32Pattern.test(uploaded.hash) || !bytes32Pattern.test(uploaded.reference)) throw new Error("The private file service returned an invalid chain hash or opaque reference.");
      setFiles((current) => stagePrivateFile(current, capturedMilestone, { ...uploaded, kind: "submission", milestoneIndex: capturedMilestone }));
      const action: ContractActionId = resubmit ? "resubmitMilestone" : "submitMilestone";
      const result = await writeEscrow(resubmit ? "resubmitMilestone" : "submitMilestone", [capturedJobId, BigInt(capturedMilestone), uploaded.hash, uploaded.reference], resubmit ? "Resubmit milestone deliverable" : "Submit milestone deliverable", [`Commit file hash ${uploaded.hash} and an opaque private file reference.`, "The client receives a review window; the file remains private and can be downloaded by authorized parties."], action, asBigInt(currentMilestone.amount));
      const freshMilestone = (result?.snapshot as JobSnapshot | undefined)?.milestones?.[capturedMilestone];
      const verified = (freshMilestone?.submissions ?? []).some((submission: any) =>
        String(submission.deliverableHash).toLowerCase() === uploaded.hash.toLowerCase() &&
        String(submission.opaqueReference).toLowerCase() === uploaded.reference.toLowerCase());
      if (!verified) { setChainReadStatus("stale"); throw new Error("The transaction is confirmed, but the fresh milestone read did not verify this exact file hash and reference. Refresh before continuing."); }
      setFiles((current) => markPrivateFileVerified(current, capturedMilestone, uploaded.id));
      form.reset();
    } catch (error) { setPageError(readableError(error)); }
    finally { setBusy(false); }
  };

  const rejectWithPrivateReason = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!snapshot || jobId === null || !accountMatchesSession) { setPageError("Sign in as the client before saving a private rejection reason."); return; }
    const form = event.currentTarget;
    const text = (new FormData(form).get("reason") as string)?.trim();
    if (!text) { setPageError("Write a private reason before rejecting this submission."); return; }
    setBusy(true); setPageError("");
    try {
      const secret = createPrivateCommitment("REJECTION_REASON", text);
      const nextVersion = Number(currentMilestone.rejectionCount) + 1;
      const capturedJobId = jobId; const capturedMilestone = selectedMilestone;
      await writeEscrow("rejectMilestone", [capturedJobId, BigInt(capturedMilestone), secret.commitment], "Reject milestone and commit private reason", ["Commit the rejection reason on chain without publishing its text.", "After confirmation, save the text and salt in encrypted private storage for the parties and current assigned panel."], "rejectMilestone", asBigInt(currentMilestone.amount), async (_receipt, contextIsCurrent) => {
        if (!contextIsCurrent()) return;
        await saveWithRetry("Save the private rejection reason", async () => {
          await apiFetch(`/api/jobs/${capturedJobId}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "rejection", milestoneIndex: capturedMilestone, version: nextVersion, text, salt: secret.salt, commitment: secret.commitment }) }, true);
          if (!contextIsCurrent()) return;
          setNotes((current) => ({ ...current, [capturedMilestone]: [...(current[capturedMilestone] ?? []), { kind: "rejection", milestoneIndex: capturedMilestone, version: nextVersion, text, commitment: secret.commitment }] }));
        }, contextIsCurrent);
      });
      form.reset();
    } catch (error) { setPageError(readableError(error)); }
    finally { setBusy(false); }
  };

  const postEvidence = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!snapshot || jobId === null || !currentDisputeId || !accountMatchesSession || !wallet || !config) { setPageError("Sign in as a party before submitting private evidence."); return; }
    const form = event.currentTarget; const data = new FormData(form);
    const text = String(data.get("evidence") ?? "").trim(); const fileInput = form.elements.namedItem("evidenceFile") as HTMLInputElement;
    const selectedFile = fileInput.files?.[0];
    const capturedJobId = jobId; const capturedDisputeId = currentDisputeId; const capturedMilestone = selectedMilestone; const capturedAccount = wallet.account;
    const capturedAccountKey = capturedAccount.toLowerCase();
    const contextKey = `${capturedJobId}:${capturedDisputeId}:${capturedAccountKey}`;
    let pendingFile = pendingEvidenceUploads.current.get(contextKey);
    let pendingText = pendingEvidenceTexts.current.get(contextKey);
    let currentEntryKind: "file" | "text" | null = null;
    let submittedAny = false;
    const contextIsCurrent = () => walletRef.current?.account.toLowerCase() === capturedAccountKey && jobIdRef.current?.toString() === capturedJobId.toString();
    setBusy(true); setPageError(""); setNotice("");
    const countFor = (value: any) => {
      const dispute = value?.milestones?.[capturedMilestone]?.dispute;
      if (!dispute) throw new Error("The chain no longer shows an active dispute for this milestone.");
      const chainClient = String(value?.job?.client ?? "").toLowerCase();
      const chainFreelancer = String(value?.job?.freelancer ?? "").toLowerCase();
      const rawCount = capturedAccountKey === chainClient ? dispute.clientEvidenceCount : capturedAccountKey === chainFreelancer ? dispute.freelancerEvidenceCount : undefined;
      if (rawCount === undefined) throw new Error("Only a named agreement party can submit dispute evidence.");
      const count = Number(rawCount);
      if (!Number.isSafeInteger(count) || count < 0 || count > 5) throw new Error("The chain returned an invalid evidence count.");
      return count;
    };
    const actionAllowed = (value: any) => {
      const latestPolicy = deriveActionPolicy({ snapshot: value, account: capturedAccount, chainId: wallet.chainId, config, milestoneIndex: capturedMilestone, chainFresh: true });
      if (!latestPolicy.allowedActionIds.includes("submitEvidence")) throw new Error(latestPolicy.disabledReasons.submitEvidence ?? "The evidence window is closed for this dispute.");
    };
    const saveEvidenceText = async () => {
      if (!pendingText || !contextIsCurrent()) throw new Error("The evidence is receipt-confirmed, but this wallet or agreement changed before its private save. Return to the original wallet and agreement to resume.");
      await apiFetch(`/api/disputes/${capturedDisputeId}/evidence`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: pendingText.text, salt: pendingText.salt, commitment: pendingText.commitment, reference: pendingText.reference }) }, true);
      if (!contextIsCurrent()) throw new Error("The private evidence was saved after the wallet changed; its content was cleared from this view.");
      pendingText.privateSaved = true;
      pendingEvidenceTexts.current.set(contextKey, pendingText);
      setEvidence((current) => {
        const existing = current[capturedDisputeId] ?? [];
        if (existing.some((item) => item.commitment?.toLowerCase() === pendingText!.commitment.toLowerCase())) return current;
        return { ...current, [capturedDisputeId]: [...existing, { text: pendingText!.text, commitment: pendingText!.commitment, reference: pendingText!.reference }] };
      });
    };
    try {
      if (!text) throw new Error("Describe the evidence in private text before submitting.");
      if (pendingText && pendingText.text !== text && pendingText.submitted) throw new Error("A previous evidence text transaction may already be on chain. Reuse that exact text to resume it before starting another evidence entry.");
      if (!pendingText || pendingText.text !== text) {
        const secret = createPrivateCommitment("EVIDENCE", text);
        pendingText = { text, salt: secret.salt, commitment: secret.commitment, reference: newReference(), submitted: false, receiptConfirmed: false, privateSaved: false };
        pendingEvidenceTexts.current.set(contextKey, pendingText);
      }

      const initial = await refreshJob(capturedJobId, capturedAccount);
      if (!initial || !contextIsCurrent() || String(initial.milestones?.[capturedMilestone]?.disputeId ?? "") !== capturedDisputeId) throw new Error("Refresh the agreement: this dispute or wallet changed before evidence submission.");
      const initialCount = countFor(initial);
      const initialRemaining = 5 - initialCount;
      const textEntry = { kind: "text" as const, hash: pendingText.commitment, reference: pendingText.reference };
      const textAlreadyCommitted = pendingEvidenceEntries([textEntry], chainEventsRef.current, capturedDisputeId, capturedAccount).length === 0;
      if (pendingText.receiptConfirmed && !textAlreadyCommitted) {
        setChainReadStatus("stale");
        throw new Error("The text receipt is confirmed, but the fresh event read did not show its exact commitment and reference. Refresh again; this entry will not be resubmitted.");
      }
      if (pendingText.submitted && !textAlreadyCommitted && !pendingText.receiptConfirmed) {
        setChainReadStatus("stale");
        throw new Error("A prior text transaction may still be pending. Refresh and verify it before trying another evidence transaction.");
      }

      let fileAlreadyCommitted = false;
      let candidateFile: { hash: string; reference: string } | undefined;
      if (selectedFile) {
        const uploadKey = `${selectedFile.name}\0${selectedFile.size}\0${selectedFile.lastModified}\0${selectedFile.type}`;
        if (pendingFile && pendingFile.key !== uploadKey && pendingFile.submitted) throw new Error("A previously submitted attachment is still being reconciled. Resume it with the same file before attaching a different one.");
        if (!pendingFile || pendingFile.key !== uploadKey) {
          const requiredBeforeUpload = (textAlreadyCommitted ? 0 : 1) + 1;
          if (initialRemaining < requiredBeforeUpload) throw new Error("A new attachment needs one evidence entry, plus one for its private text. Remove the attachment to submit text alone.");
          const uploaded = await uploadFile(selectedFile, "evidence", capturedMilestone, capturedDisputeId);
          if (!contextIsCurrent()) throw new Error("The file was uploaded, but the wallet or agreement changed before it could be attached here. Reopen the original agreement to continue.");
          if (!bytes32Pattern.test(uploaded.hash) || !bytes32Pattern.test(uploaded.reference)) throw new Error("The private file service returned an invalid raw-file hash or opaque reference.");
          pendingFile = { key: uploadKey, file: uploaded, submitted: false, receiptConfirmed: false };
          pendingEvidenceUploads.current.set(contextKey, pendingFile);
          setFiles((current) => stagePrivateFile(current, capturedMilestone, uploaded));
        }
        candidateFile = { hash: pendingFile.file.hash, reference: pendingFile.file.reference };
      } else if (pendingFile?.submitted) {
        candidateFile = { hash: pendingFile.file.hash, reference: pendingFile.file.reference };
      }

      if (candidateFile) {
        const fileEntry = { kind: "file" as const, ...candidateFile };
        fileAlreadyCommitted = pendingEvidenceEntries([fileEntry], chainEventsRef.current, capturedDisputeId, capturedAccount).length === 0;
        if (pendingFile?.receiptConfirmed && !fileAlreadyCommitted) {
          setChainReadStatus("stale");
          throw new Error("The attachment receipt is confirmed, but the fresh event read did not show its exact hash and reference. Refresh again; the attachment will not be resubmitted.");
        }
        if (pendingFile?.submitted && !fileAlreadyCommitted && !pendingFile.receiptConfirmed) {
          setChainReadStatus("stale");
          throw new Error("A prior attachment transaction may still be pending. Refresh and verify it before trying another evidence transaction.");
        }
        if (fileAlreadyCommitted && pendingFile) {
          pendingFile.receiptConfirmed = true;
          pendingEvidenceUploads.current.set(contextKey, pendingFile);
          setFiles((current) => markPrivateFileVerified(current, capturedMilestone, pendingFile!.file.id));
        }
      }

      const candidates = buildEvidenceEntries({
        textCommitment: pendingText.commitment,
        textReference: pendingText.reference,
        file: candidateFile,
        remaining: 5,
      });
      const entries = pendingEvidenceEntries(candidates, chainEventsRef.current, capturedDisputeId, capturedAccount);
      if (initialRemaining < entries.length) throw new Error(entries.some((entry) => entry.kind === "file")
        ? "This party does not have enough evidence entries for the remaining attachment and text commitments. Remove the attachment and submit text alone."
        : "This party has used all five evidence entries.");

      let latestSnapshot = initial;
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        actionAllowed(latestSnapshot);
        const remainingNow = 5 - countFor(latestSnapshot);
        if (remainingNow < entries.length - index) throw new Error("Evidence capacity changed before confirmation. Refresh the agreement and try again.");
        const isFile = entry.kind === "file";
        currentEntryKind = entry.kind;
        const label = isFile ? "Commit private evidence file" : "Commit private evidence text";
        const effects = isFile
          ? ["Bind the uploaded file’s raw-byte hash to its own opaque reference on the escrow and arbitration contracts.", "The file bytes and filename remain encrypted off chain; this entry does not reveal the file contents."]
          : ["Publish the salted evidence-text commitment and its separate opaque reference.", "The text and salt remain encrypted off chain; this transaction does not transfer tokens or change an allowance."];
        const summary = buildSummary(label, effects);
        summary.parties = [String(latestSnapshot.job.client), String(latestSnapshot.job.freelancer)];
        summary.terms = [
          `Dispute #${capturedDisputeId}`,
          `Evidence ${entry.kind} hash ${entry.hash}`,
          `Opaque reference ${entry.reference}`,
          ...(isFile ? [`File type ${pendingFile?.file.mime ?? selectedFile?.type ?? "unknown"}`, "A separate text commitment and reference will follow after this receipt refreshes the chain."] : ["Text commitment only; the corresponding salt and plaintext are private."]),
        ];
        summary.timing = [`Chain time ${utc(latestSnapshot.now)}`, `Evidence deadline ${utc(latestSnapshot.milestones[capturedMilestone]?.dispute?.evidenceDeadline)}`];
        const beforeCount = countFor(latestSnapshot);
        const result = await runTransaction(
          label,
          summary,
          async () => {
            const hash = await wallet.client.writeContract({ address: config.escrow, abi: escrowAbi, functionName: "submitEvidence", args: [asBigInt(capturedDisputeId), entry.hash, entry.reference], account: capturedAccount });
            submittedAny = true;
            if (isFile && pendingFile) { pendingFile.submitted = true; pendingEvidenceUploads.current.set(contextKey, pendingFile); }
            if (!isFile && pendingText) { pendingText.submitted = true; pendingEvidenceTexts.current.set(contextKey, pendingText); }
            return hash;
          },
          async (_receipt, isCurrent) => {
            if (!isCurrent() || !contextIsCurrent()) return;
            if (isFile && pendingFile) {
              pendingFile.receiptConfirmed = true;
              pendingEvidenceUploads.current.set(contextKey, pendingFile);
              return;
            }
            if (pendingText) {
              pendingText.receiptConfirmed = true;
              pendingEvidenceTexts.current.set(contextKey, pendingText);
              await saveWithRetry("Save private dispute evidence", saveEvidenceText, contextIsCurrent);
            }
          },
          "submitEvidence",
          undefined,
          (outcome) => {
            if (isFile && pendingFile) {
              Object.assign(pendingFile, applyEvidenceReceiptOutcome(pendingFile, outcome));
              pendingEvidenceUploads.current.set(contextKey, pendingFile);
            } else if (!isFile && pendingText) {
              Object.assign(pendingText, applyEvidenceReceiptOutcome(pendingText, outcome));
              pendingEvidenceTexts.current.set(contextKey, pendingText);
            }
          },
        );
        const refreshed = result.snapshot as any;
        const exactEventFound = pendingEvidenceEntries([entry], chainEventsRef.current, capturedDisputeId, capturedAccount).length === 0;
        if (!refreshed?.milestones?.[capturedMilestone]?.dispute || countFor(refreshed) <= beforeCount || !exactEventFound) {
          setChainReadStatus("stale");
          throw new Error(`The ${entry.kind} receipt is confirmed, but a fresh read did not verify the exact evidence event. Refresh before continuing; the same entry will not be resubmitted.`);
        }
        latestSnapshot = refreshed;
        if (isFile && pendingFile) {
          pendingFile.receiptConfirmed = true;
          pendingEvidenceUploads.current.set(contextKey, pendingFile);
          setFiles((current) => markPrivateFileVerified(current, capturedMilestone, pendingFile!.file.id));
        }
        if (!isFile && pendingText) {
          pendingText.receiptConfirmed = true;
          pendingEvidenceTexts.current.set(contextKey, pendingText);
          form.reset();
        }
      }

      if (pendingText && textAlreadyCommitted && !pendingText.privateSaved) {
        pendingText.receiptConfirmed = true;
        await saveWithRetry("Save private dispute evidence", saveEvidenceText, contextIsCurrent);
      }
      if (pendingText && pendingText.receiptConfirmed && !pendingText.privateSaved) await saveWithRetry("Save private dispute evidence", saveEvidenceText, contextIsCurrent);
      pendingEvidenceTexts.current.delete(contextKey);
      pendingEvidenceUploads.current.delete(contextKey);
      setNotice(submittedAny
        ? "Evidence commitments confirmed one at a time. Each entry was verified from a fresh chain read and the private text was saved separately."
        : "The existing evidence entries were verified from chain and the private text is saved; no duplicate commitment was submitted.");
    } catch (error) {
      const message = readableError(error);
      if (currentEntryKind && message.includes("Transaction confirmed, but the chain refresh failed")) {
        setNotice(`The ${currentEntryKind} receipt is confirmed, but the fresh chain read failed. Its private follow-up is retained; refresh and resume with the same text and attachment.`);
      } else if (pendingText?.receiptConfirmed && !pendingText.privateSaved) {
        setNotice("The text commitment is confirmed. Retry the encrypted private save; do not submit the evidence again.");
      } else if (pendingFile?.receiptConfirmed) {
        setNotice("The attachment hash and reference are confirmed. Refresh and resume with the same text and attachment to continue without duplicating the file entry.");
      }
      setPageError(message);
    } finally { setBusy(false); }
  };

  const castCommit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!snapshot || !config || !wallet || !currentDisputeId) return;
    const form = event.currentTarget; const bps = Number(new FormData(form).get("bps")); const disputeId = currentDisputeId;
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) { setPageError("Enter a share from 0 to 10,000 basis points."); return; }
    setBusy(true); setPageError("");
    try {
      const salt = randomSalt(); const pc: any = publicClient(config);
      const commitment = await pc.readContract({ address: config.escrow, abi: escrowAbi, functionName: "voteCommitment", args: [asBigInt(disputeId), wallet.account, bps, salt] });
      await writeEscrow("commitVote", [asBigInt(disputeId), commitment], "Commit sealed arbiter vote", ["Commit a sealed vote for the current panel round. The vote stays hidden until the reveal phase."], "commitVote", undefined, async (_receipt, contextIsCurrent) => {
        if (!contextIsCurrent()) return;
        setVoteSecrets((current) => ({ ...current, [disputeId]: { bps: String(bps), salt } }));
      });
    } catch (error) { setPageError(readableError(error)); }
    finally { setBusy(false); }
  };

  const revealVote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!currentDisputeId || jobId === null) return;
    const data = new FormData(event.currentTarget); const bps = Number(data.get("bps")); const salt = String(data.get("salt") ?? "").trim() as Hex;
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000 || !bytes32Pattern.test(salt)) { setPageError("Enter a share from 0 to 10,000 and the exact 32-byte reveal salt saved when committing."); return; }
    await runSimple("revealVote", "revealVote", [asBigInt(currentDisputeId), bps, salt], "Reveal arbiter vote", [`Reveal ${bps} basis points in the current panel round.`]);
  };

  const downloadFile = async (file: ApiFile) => {
    try {
      const ticket = await apiFetch(`/api/files/${file.id}/download`);
      const url = new URL(ticket.url, window.location.origin);
      if (url.origin !== window.location.origin || !url.pathname.startsWith(`/api/files/${file.id}/content`)) throw new Error("The private file ticket did not point to this local service.");
      const response = await fetch(url, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("The private file could not be downloaded.");
      const blob = await response.blob(); const objectUrl = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = objectUrl; anchor.download = `fairwork-${file.id}.${file.mime === "application/pdf" ? "pdf" : file.mime === "image/png" ? "png" : file.mime === "text/plain" ? "txt" : "jpg"}`; anchor.click(); URL.revokeObjectURL(objectUrl);
    } catch (error) { setPageError(readableError(error)); }
  };

  const devSummary = (action: string, contractAddress: string, effects: string[]) => ({
    ...buildSummary(action, effects),
    contractAddress,
  });

  const runDevControl = async (path: string, body: object, summary: ConfirmationSummary) => {
    if (!localBuild || wallet?.source !== "demo") return;
    setBusy(true); setPageError(""); setNotice("");
    try {
      const approved = await requestConfirm(summary); if (!approved) return;
      setTxStatus("pending"); setTxHash("");
      const result = await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const control = result.result ?? result;
      if (control.receiptStatus && control.receiptStatus !== "success") throw new Error("The local control transaction did not confirm successfully.");
      setTxHash(control.hash ?? ""); setTxStatus("confirmed");
      setNotice(`${summary.action} completed and confirmed. ${control.hash ?? (control.timestamp ? `Chain timestamp ${control.timestamp}.` : "Local chain updated.")}`);
      if (jobId !== null) await refreshJob(jobId);
    } catch (error) { setTxStatus("failed"); setPageError(readableError(error)); }
    finally { setBusy(false); }
  };

  const countdown = (deadline: unknown) => {
    const seconds = asBigInt(deadline) - chainTime;
    if (seconds <= 0n) return "Window closed";
    const d = seconds / 86400n; const h = (seconds % 86400n) / 3600n; const m = (seconds % 3600n) / 60n; const s = seconds % 60n;
    return `${d ? `${d}d ` : ""}${h ? `${h}h ` : ""}${m ? `${m}m ` : ""}${s}s remaining`;
  };

  const actionButton = (action: ContractActionId, label: string, onClick: () => void, variant = "") => {
    const allowed = policy.allowedActionIds.includes(action);
    const reason = policy.disabledReasons[action];
    return <button className={`button ${variant}`} type="button" disabled={!allowed || busy} onClick={onClick} title={!allowed ? reason : undefined}>{label}{!allowed && <span className="button-reason">{reason}</span>}</button>;
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a href="#top" className="brand" aria-label="Fairwork home"><span className="brand-mark">F</span><span>fairwork<span className="brand-dot">.</span></span></a>
        <div className="topbar-right">
          <span className={`environment-pill ${localBuild ? "is-local" : ""}`}><i />{localBuild ? "LOCAL CHAIN · 31337" : "LOCAL ESCROW"}</span>
          {wallet ? <div className="wallet-chip"><span className="wallet-role">{roleLabel}</span><span>{shortAddress(wallet.account)}</span><button type="button" aria-label="Disconnect wallet" onClick={async () => { await logout(); setWallet(null); }}>×</button></div> : <button className="button button-dark button-small" type="button" onClick={connectBrowserWallet}>Connect wallet</button>}
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-line" />MILESTONE ESCROW · LOCAL PROTOTYPE</p>
          <h1>Work moves forward.<br /><em>Trust stays verifiable.</em></h1>
          <p className="hero-lede">Agree on the work in private. Put each milestone on chain. Release payment only when the rules say it is due.</p>
        </div>
        <div className="hero-stamp"><span className="stamp-ring">FW</span><span>RULES FIRST<br />FUNDS SECOND</span></div>
      </section>

      {configError && <div className="banner banner-error"><strong>Local deployment unavailable</strong><span>{configError}</span></div>}
      {pageError && <div className="banner banner-error" role="alert"><strong>Couldn’t complete that action</strong><span>{pageError}</span><button type="button" onClick={() => setPageError("")}>Dismiss</button></div>}
      {notice && <div className="banner banner-success" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")}>Dismiss</button></div>}
      {pendingPrivateSave && <div className="banner banner-warn" role="status"><strong>Private save pending</strong><span>{pendingPrivateSave.label}. The chain transaction is already confirmed; retry the encrypted private save while signed in as the same wallet.</span><button className="button button-small" type="button" disabled={busy || !accountMatchesSession} onClick={() => void retryPrivateSave()}>Retry private save</button></div>}
      {txStatus === "pending" && <div className="banner banner-warn transaction-banner" role="status"><strong>Transaction pending</strong><span>Waiting for a confirmed receipt before refreshing escrow state.</span>{txHash && <code>{shortAddress(txHash)}</code>}</div>}
      {txStatus === "unknown" && <div className="banner banner-warn transaction-banner" role="status"><strong>Transaction outcome unknown</strong><span>Another send is blocked until this original receipt is checked.</span><code>{shortAddress(txHash)}</code><button type="button" className="button button-small" disabled={busy} onClick={() => void checkUnknownReceipt()}>Check original receipt</button></div>}
      {txStatus === "confirmed" && txHash && <div className={`banner transaction-banner ${chainReadState === "stale" ? "banner-warn" : "banner-success"}`} role="status"><strong>Receipt confirmed</strong><span>{chainReadState === "refreshing" ? "Completing confirmed follow-ups and reading fresh chain state…" : chainReadState === "stale" ? "The fresh chain read failed. Contract actions are paused; use Refresh before continuing." : "Chain state has been refreshed after confirmation."}</span><code>{shortAddress(txHash)}</code></div>}

      <section className="control-strip" aria-label="Wallet and agreement controls">
        <div className="control-block wallet-control">
          <div className="control-heading"><span className="step-number">01</span><div><strong>Connect your wallet</strong><small>Private access follows the signed wallet</small></div></div>
          {localBuild && config && <div className="demo-switcher"><label htmlFor="demo-role">Local role</label><select id="demo-role" value={demoRole} onChange={(event) => void connectDemoRole(event.target.value)} disabled={busy}><option value="">Choose a seeded role…</option><option value="client">Client</option><option value="freelancer">Freelancer</option><option value="treasury">Treasury</option>{config.roles.arbiters.map((arbiter, index) => <option key={arbiter} value={`arbiter-${index + 1}`}>Arbiter {index + 1} · {shortAddress(arbiter)}</option>)}</select><span className="dev-caption">Development accounts only</span></div>}
          {!wallet && <button className="button button-outline" type="button" onClick={connectBrowserWallet}>Connect browser wallet <span>↗</span></button>}
          {wallet && <div className="connected-state"><span className="connected-dot" /><div><strong>{shortAddress(wallet.account)}</strong><small>{roleLabel} · chain {wallet.chainId}</small></div>{wallet.chainId !== 31337 && <button className="button button-small button-outline" type="button" onClick={switchToLocalChain}>Switch to 31337</button>}</div>}
          {wallet && !accountMatchesSession && <button className="button button-dark" type="button" disabled={busy || wallet.chainId !== 31337} onClick={signIn}>{busy ? "Waiting for wallet…" : "Sign in to unlock private terms"}</button>}
          {accountMatchesSession && <div className="session-state"><span>Private session active until {new Date(session!.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><button type="button" onClick={() => void logout()}>Sign out</button></div>}
        </div>

        <div className="control-divider" />

        <div className="control-block job-control">
          <div className="control-heading"><span className="step-number">02</span><div><strong>Open one agreement</strong><small>Enter a job ID. There is no public job directory.</small></div></div>
          <form className="job-lookup" onSubmit={loadJob}>
            <label className="sr-only" htmlFor="job-id">Agreement ID</label><span className="input-prefix">#</span><input id="job-id" inputMode="numeric" pattern="[0-9]*" placeholder="Enter agreement ID" value={jobIdText} onChange={(event) => setJobIdText(event.target.value)} />
            <button className="button button-dark" type="submit" disabled={busy || !config}>{busy ? "Loading…" : "Open agreement"}<span>→</span></button>
          </form>
          {wallet && config && accountMatchesSession && <button className="text-button new-agreement" type="button" onClick={() => setShowAgreement(true)}>＋ Create a private agreement</button>}
        </div>
      </section>

      {wallet && wallet.chainId !== 31337 && <div className="banner banner-warn"><strong>Wrong network</strong><span>Read-only wallet connection. Contract actions are disabled until this wallet is on Fairwork Local (31337).</span><button className="button button-small" type="button" onClick={switchToLocalChain}>Switch network</button></div>}
      {wallet && config && !accountMatchesSession && <div className="privacy-callout"><span className="privacy-icon">⌑</span><span><strong>Private by authorization.</strong> Sign a SIWE message to load private agreement text, file access, rejection reasons and evidence. Signing in is separate from each contract transaction.</span></div>}

      {localBuild && config && <ArbiterRegistry config={config} account={wallet?.account ?? null} busy={busy || chainReadState !== "fresh" || Boolean(wallet && wallet.chainId !== config.chainId)} onChange={changeArbiterRegistry} />}

      {snapshot && config && jobId !== null ? (
        <div className="workspace">
          <section className="overview-card">
            <div className="overview-top">
              <div><p className="eyebrow">AGREEMENT <span className="mono">#{jobId.toString()}</span></p><h2>{accountMatchesSession && terms?.title ? terms.title : "Private agreement"}</h2><p className="overview-subtitle">{accountMatchesSession && terms?.description ? terms.description : "Terms are encrypted off chain. Verify them after signing in as a party."}</p></div>
              <div className={`status-badge state-${Number(snapshot.job.state)}` }><span className="status-dot" />{statusNames[Number(snapshot.job.state)] ?? "Unknown state"}</div>
            </div>
            <div className="overview-stats">
              <div><span>AGREEMENT VALUE</span><strong>{formatTokenAmount(asBigInt(snapshot.job.totalAmount), activeToken?.decimals ?? 18, activeToken?.symbol ?? "TOKEN")}</strong></div>
              <div><span>PARTIES</span><strong>{shortAddress(snapshot.job.client)} <b>↔</b> {shortAddress(snapshot.job.freelancer)}</strong></div>
              <div><span>MILESTONES</span><strong>{snapshot.milestones.length} <small>steps</small></strong></div>
              <div><span>REVISIONS</span><strong>{String(snapshot.job.revisionLimit)} <small>rounds</small></strong></div>
            </div>
            <div className="pin-strip"><span><i /> PINNED DEPLOYMENT</span><span>Chain {config.chainId}</span><span>Escrow <code>{shortAddress(config.escrow)}</code></span><span>Code hash <code>{String(config.codeHashes.escrow).slice(0, 10)}…</code></span><span className="chain-time">Estimated chain time · {utc(chainTime)}</span></div>
          </section>

          <div className="content-grid">
            <aside className="left-column">
              <section className="panel terms-panel">
                <div className="panel-heading"><div><p className="eyebrow">AGREEMENT TERMS</p><h3>What was agreed</h3></div><span className="lock-mark">⌑</span></div>
                {accountMatchesSession && terms ? <div className="private-terms"><div><span>Scope</span><p>{terms.scope}</p></div><div><span>Delivery rules</span><p>{terms.deliveryRules}</p></div></div> : <div className="locked-terms"><div className="lock-illustration">⌑</div><strong>Private terms are sealed</strong><p>Sign in with a party wallet to read the scope, delivery rules and acceptance criteria.</p></div>}
                <div className="commitment-list"><span className="eyebrow">ON-CHAIN COMMITMENTS</span>{Object.entries({ Title: snapshot.commitments.titleCommitment, Description: snapshot.commitments.descriptionCommitment, Scope: snapshot.commitments.scopeCommitment, "Delivery rules": snapshot.commitments.deliveryRuleCommitment }).map(([name, value]) => <div className="commitment-row" key={name}><span>{name}</span><code title={String(value)}>{String(value).slice(0, 12)}…{String(value).slice(-6)}</code></div>)}</div>
              </section>
              <section className="panel ledger-panel">
                <div className="panel-heading"><div><p className="eyebrow">YOUR LEDGER</p><h3>Available to withdraw</h3></div><span className="ledger-icon">↗</span></div>
                <strong className="ledger-amount">{ledgerIsCurrent ? formatTokenAmount(asBigInt(snapshot.claimable), activeToken?.decimals ?? 18, activeToken?.symbol ?? "TOKEN") : "—"}</strong>
                <p>{ledgerIsCurrent ? "Claimable is an escrow balance credited to this wallet. Withdrawn is counted only after a completed token transfer." : wallet ? "Reading this wallet’s ledger from chain. Previous wallet balances are hidden until that read completes." : "Connect a wallet and refresh to read its claimable and withdrawn balances."}</p>
                <div className="ledger-rows"><div><span>Withdrawn to wallet</span><strong>{ledgerIsCurrent ? formatTokenAmount(asBigInt(snapshot.withdrawn), activeToken?.decimals ?? 18, activeToken?.symbol ?? "TOKEN") : "—"}</strong></div><div><span>Principal still locked</span><strong>{ledgerIsCurrent ? formatTokenAmount(asBigInt(snapshot.lockedEscrow), activeToken?.decimals ?? 18, activeToken?.symbol ?? "TOKEN") : "—"}</strong></div><div><span>Dispute deposits held</span><strong>{ledgerIsCurrent ? formatTokenAmount(asBigInt(snapshot.disputeDeposits), activeToken?.decimals ?? 18, activeToken?.symbol ?? "TOKEN") : "—"}</strong></div></div>
                {ledgerIsCurrent ? actionButton("withdraw", "Withdraw claimable funds", () => { if (activeToken) void runSimple("withdraw", "withdraw", [activeToken.address], "Withdraw claimable funds", ["Transfer your claimable ledger balance to this connected wallet."], asBigInt(snapshot.claimable)); }, "button-dark button-full") : <button className="button button-dark button-full" type="button" disabled={busy || !wallet || jobId === null} onClick={() => void refreshJob().catch((error) => setPageError(readableError(error)))}>Refresh this wallet’s ledger</button>}
              </section>
            </aside>

            <section className="right-column">
              <section className="panel milestones-panel">
                <div className="panel-heading milestone-title"><div><p className="eyebrow">WORK IN PROGRESS</p><h3>Milestone ledger</h3></div><span className="timeline-caption">Chain deadlines · UTC · estimated countdown</span></div>
                <div className="milestone-list">{snapshot.milestones.map((milestone: any, index: number) => {
                  const selected = index === selectedMilestone;
                  const criterion = terms?.criteria?.[index];
                  const status = Number(milestone.state);
                  const deadline = status === 1 ? milestone.reviewEnd : status === 2 ? milestone.responseEnd : milestone.graceEnd;
                  return <button key={index} type="button" className={`milestone-row ${selected ? "selected" : ""} ${status >= 4 ? "terminal" : ""}`} onClick={() => setSelectedMilestone(index)}>
                    <span className={`milestone-number ${status >= 4 ? "done" : ""}`}>{status >= 4 ? "✓" : String(index + 1).padStart(2, "0")}</span><span className="milestone-main"><strong>Milestone {index + 1}</strong><small>{criterion ?? `Criteria commitment ${String(milestone.acceptanceCriteriaCommitment).slice(0, 10)}…`}</small><span className={`milestone-state state-text-${status}`}>{milestoneNames[status] ?? "Unknown"}</span></span><span className="milestone-meta"><strong>{formatTokenAmount(asBigInt(milestone.amount), activeToken?.decimals ?? 18, activeToken?.symbol ?? "TOKEN")}</strong><small>{Number(snapshot.job.state) < 2 ? "Starts when funded" : status === 0 || status === 1 || status === 2 ? countdown(deadline) : status >= 4 ? "Settled" : `Deadline ${utc(deadline)}`}</small></span><span className="row-chevron">{selected ? "⌄" : "›"}</span>
                  </button>;
                })}</div>

                {currentMilestone && <div className="milestone-detail" key={`${jobId}-${selectedMilestone}-${privateViewEpoch}`}>
                  <div className="detail-heading"><div><span className="detail-index">MILESTONE {selectedMilestone + 1}</span><h4>{milestoneNames[Number(currentMilestone.state)] ?? "Milestone"}</h4></div><span className="detail-time"><span>Deadline</span><strong>{utc(currentMilestone.deadline)}</strong></span></div>
                  <div className="detail-grid"><div><span>Delivery deadline</span><strong>{utc(currentMilestone.deadline)}</strong></div><div><span>Grace ends</span><strong>{utc(currentMilestone.graceEnd)}</strong></div><div><span>Review ends</span><strong>{utc(currentMilestone.reviewEnd)}</strong></div><div><span>Response ends</span><strong>{utc(currentMilestone.responseEnd)}</strong></div><div><span>Delivery duration</span><strong>{String(currentMilestone.duration)}s</strong></div><div><span>Revision requests · this milestone</span><strong>{Number(currentMilestone.rejectionCount)} / {Number(snapshot.job.revisionLimit)}</strong></div><div><span>Submission version</span><strong>{Number(currentMilestone.submissionCount) || "—"} / {Number(snapshot.job.revisionLimit) + 1}</strong></div></div>
                  {selectedCriterion && <div className="criteria-box"><span>ACCEPTANCE CRITERIA</span><p>{selectedCriterion}</p></div>}
                  {accountMatchesSession && notes[selectedMilestone]?.length > 0 && <div className="private-note"><span>PRIVATE REJECTION REASON</span>{notes[selectedMilestone].map((note: any) => <p key={`${note.version}-${note.commitment}`}>Version {note.version}: {note.text}</p>)}</div>}
                  {currentMilestone.submissions?.length > 0 && <div className="submission-list"><span className="eyebrow">SUBMISSIONS · ON CHAIN</span>{currentMilestone.submissions.map((item: any, index: number) => <div className="submission-row" key={`${index}-${item.deliverableHash}`}><div><strong>Version {Number(item.version) || index + 1}</strong><small>{utc(item.submittedAt)}</small></div><code title={item.deliverableHash}>{String(item.deliverableHash).slice(0, 16)}…</code><code title={item.opaqueReference}>ref {String(item.opaqueReference).slice(0, 10)}…</code></div>)}</div>}
                  {files[selectedMilestone]?.length > 0 && accountMatchesSession && <div className="file-list"><span className="eyebrow">PRIVATE FILES · AUTHORIZED ACCESS</span>{files[selectedMilestone].map((file) => <div className="file-row" key={file.id}><span className="file-type">{file.mime === "application/pdf" ? "PDF" : file.mime === "image/png" ? "PNG" : file.mime === "text/plain" ? "TXT" : "JPG"}</span><div><strong>{file.kind === "submission" ? "Milestone deliverable" : "Evidence attachment"}{file.bound === false && <em className="draft-tag">Draft</em>}</strong><small>{Math.ceil(file.size / 1024)} KB · hash {file.hash.slice(0, 12)}…{file.bound === false ? " · not committed on chain" : ""}</small></div><button type="button" onClick={() => void downloadFile(file)}>Download</button></div>)}</div>}
                  <div className="action-area">
                    <p className="eyebrow">AVAILABLE ACTIONS <span className="small-muted">· based on chain state and wallet role</span></p>
                    {snapshot.job.state === 0 && <div className="action-row">{actionButton("acceptJob", "Accept proposal", () => void runSimple("acceptJob", "acceptJob", [jobId], "Accept named proposal", ["Accept this proposal as the named freelancer. The client may then fund before the funding deadline."], undefined, undefined), "button-dark")}{actionButton("cancelExpiredProposal", "Cancel expired proposal", () => void runSimple("cancelExpiredProposal", "cancelExpiredProposal", [jobId], "Cancel expired proposal", ["Mark this proposal cancelled after its acceptance deadline."], undefined), "")}</div>}
                    {snapshot.job.state === 1 && <div className="action-row">{actionButton("fundJob", `Fund · ${formatTokenAmount(asBigInt(snapshot.job.totalAmount), activeToken?.decimals ?? 18, activeToken?.symbol ?? "TOKEN")}`, () => void (async () => { try { await performAllowanceAction("fundJob", asBigInt(snapshot.job.totalAmount)); } catch (error) { setPageError(readableError(error)); } })(), "button-dark")}{actionButton("cancelUnfundedJob", "Cancel unfunded agreement", () => void runSimple("cancelUnfundedJob", "cancelUnfundedJob", [jobId], "Cancel after funding deadline", ["Cancel the accepted agreement after its funding window closes."], undefined), "")}</div>}
                    {snapshot.job.state === 2 && <>
                      <div className="action-row">{actionButton("submitMilestone", "Submit deliverable", () => document.getElementById("submit-deliverable")?.scrollIntoView({ behavior: "smooth", block: "center" }), "button-dark")}{actionButton("resubmitMilestone", "Resubmit revision", () => document.getElementById("submit-deliverable")?.scrollIntoView({ behavior: "smooth", block: "center" }), "button-dark")}{actionButton("approveMilestone", "Approve milestone", () => void runSimple("approveMilestone", "approveMilestone", [jobId, BigInt(selectedMilestone)], "Approve milestone", ["Credit this milestone amount to the freelancer’s claimable ledger."], asBigInt(currentMilestone.amount), undefined), "button-dark")}</div>
                      {policy.allowedActionIds.includes("rejectMilestone") && <form className="inline-action-form" onSubmit={rejectWithPrivateReason}><label>Private reason for rejection<textarea name="reason" required maxLength={10000} placeholder="Explain what needs to change. This text is encrypted off chain." /></label><button className="button button-outline" type="submit" disabled={busy}>Reject and save privately</button></form>}
                      <div className="action-row">{actionButton("releaseAfterSilence", "Release after review window", () => void runSimple("releaseAfterSilence", "releaseAfterSilence", [jobId, BigInt(selectedMilestone)], "Release after review silence", ["Credit the milestone to the freelancer because the review window has ended."], asBigInt(currentMilestone.amount)))}{actionButton("refundAfterMissedDeadline", "Refund missed milestone", () => void runSimple("refundAfterMissedDeadline", "refundAfterMissedDeadline", [jobId, BigInt(selectedMilestone)], "Refund after missed delivery", ["Credit the milestone amount to the client after the delivery grace window."], asBigInt(currentMilestone.amount)))}{actionButton("refundAfterRejectionWindow", "Refund after no revision", () => void runSimple("refundAfterRejectionWindow", "refundAfterRejectionWindow", [jobId, BigInt(selectedMilestone)], "Refund after revision window", ["Credit the milestone amount to the client after the response window closes."], asBigInt(currentMilestone.amount)))}</div>
                      <form id="submit-deliverable" className="upload-action" onSubmit={(event) => void submitMilestone(event, Number(currentMilestone.state) === 2)}><div><span className="eyebrow">{Number(currentMilestone.state) === 2 ? "RESUBMIT A REVISION" : "SUBMIT WORK"}</span><small>PDF, PNG, JPEG or TXT · uploaded drafts are shared with both agreement parties</small></div><input name="deliverable" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt,application/pdf,image/png,image/jpeg,text/plain" required disabled={!accountMatchesSession} /><button className="button button-dark" type="submit" disabled={busy || !accountMatchesSession || (!policy.allowedActionIds.includes("submitMilestone") && !policy.allowedActionIds.includes("resubmitMilestone"))}>Upload and {Number(currentMilestone.state) === 2 ? "resubmit" : "submit"}</button></form>
                      <div className="action-row">{actionButton("openDispute", "Open dispute · 2% deposit", () => void (async () => { const amount = asBigInt(currentMilestone.amount) * 200n / 10_000n || 1n; try { await performAllowanceAction("openDispute", amount); } catch (error) { setPageError(readableError(error)); } })(), "button-outline")}{currentDisputeId && actionButton("matchDisputeDeposit", "Match dispute deposit", () => void (async () => { const amount = asBigInt(currentMilestone.dispute?.depositAmount); try { await performAllowanceAction("matchDisputeDeposit", amount); } catch (error) { setPageError(readableError(error)); } })(), "button-outline")}</div>

                    </>}
                    {currentDisputeId && <DisputePanel dispute={currentMilestone.dispute} panels={currentMilestone.panels} settlement={buildDisputeSettlementView(BigInt(currentDisputeId), currentMilestone.dispute?.phase, chainEvents)} disputeId={currentDisputeId} account={wallet?.account} token={activeToken} policy={policy} busy={busy} countdown={countdown} evidence={evidence[currentDisputeId] ?? []} voteSecret={voteSecrets[currentDisputeId]} runAction={runSimple} castCommit={castCommit} revealVote={revealVote} postEvidence={postEvidence} />}
                  </div>
                </div>}
              </section>

              <section className="panel activity-panel">
                <div className="panel-heading"><div><p className="eyebrow">VERIFIABLE HISTORY</p><h3>Activity ledger</h3></div><span className="activity-sources"><i /> Chain <i className="audit-dot" /> Private audit</span></div>
                <div className="activity-list">{[...chainEvents.map((event) => ({ ...event, source: "chain" })), ...auditEvents.map((event) => ({ ...event, source: "audit" }))].sort(activityOrder).slice(0, showAllActivity ? undefined : 16).map((event, index) => <div className="activity-row" key={eventKey(event, index)}><span className={`activity-marker ${event.source === "audit" ? "is-audit" : ""}`} /><div className="activity-main"><strong>{humanEvent(event.name ?? event.event ?? event.action ?? event.kind ?? "Agreement activity")}</strong><small>{event.source === "chain" ? `Chain · ${event.chainTimestamp ? utc(event.chainTimestamp) : `block ${String(event.blockNumber ?? "—")}`}` : `Private audit · ${event.createdAt ? new Date(event.createdAt).toISOString().replace("T", " ").replace(".000Z", " UTC") : "timestamp recorded"}`}</small></div>{event.transactionHash && <code title={event.transactionHash}>{String(event.transactionHash).slice(0, 10)}…</code>}</div>)}{chainEvents.length === 0 && auditEvents.length === 0 && <p className="empty-state">No activity recorded yet. Chain events appear here as the agreement moves forward.</p>}</div>{chainEvents.length + auditEvents.length > 16 && <button className="button button-outline" type="button" onClick={() => setShowAllActivity((value) => !value)}>{showAllActivity ? "Show recent activity" : "Show all activity"}</button>}
              </section>
            </section>
          </div>

          {localBuild && wallet?.source === "demo" && <section className="dev-panel"><div><p className="eyebrow">LOCAL TESTING ONLY</p><h3>Development controls</h3><p>These controls change the local chain and never appear in a public build.</p></div><div className="dev-controls"><label>Advance chain clock <span>seconds</span><input type="number" min="1" max="86400" value={devSeconds} onChange={(event) => setDevSeconds(event.target.value)} /></label><button className="button button-outline" type="button" disabled={busy || !Number.isInteger(Number(devSeconds)) || Number(devSeconds) < 1 || Number(devSeconds) > 86400} onClick={() => void runDevControl("/api/dev/time-warp", { seconds: Number(devSeconds) }, devSummary("Advance local chain time", "Local node · chain clock", [`Move the local chain forward ${devSeconds} seconds. Contract deadlines and timers will update.`]))}>Advance time</button><label>Randomness mode<select value={devMode} onChange={(event) => setDevMode(event.target.value)}><option value="0">Manual fulfillment</option><option value="1">Reject randomness requests</option><option value="2">Synchronous deterministic fulfillment</option></select></label><button className="button button-outline" type="button" disabled={busy} onClick={() => void runDevControl("/api/dev/randomness/mode", { mode: Number(devMode) }, devSummary("Change local randomness mode", config?.randomness ?? "Randomness contract", [`Mode ${devMode}: ${devMode === "0" ? "requests wait for a separate manual fulfill action" : devMode === "1" ? "randomness requests are rejected" : "requests fulfill synchronously from the deterministic local source"}.`]))}>Set mode</button><label>Fulfill request<input inputMode="numeric" value={devRequestId} onChange={(event) => setDevRequestId(event.target.value)} placeholder="Request ID" /></label><button className="button button-outline" type="button" disabled={busy || !/^[1-9][0-9]*$/.test(devRequestId)} onClick={() => void runDevControl("/api/dev/randomness/fulfill", { requestId: devRequestId }, devSummary("Fulfill mock randomness", config?.randomness ?? "Randomness contract", [`Fulfill request ${devRequestId} using the local deterministic mock source.`]))}>Fulfill request</button></div></section>}

          <div className="refresh-note"><span>{chainReadState === "fresh" ? "Fresh chain read" : chainReadState === "refreshing" ? "Chain read in progress" : "Chain read stale"} {freshness ? new Date(freshness).toLocaleTimeString() : "—"} · countdown estimates advance from this read</span><button type="button" onClick={() => void refreshJob().catch((error) => setPageError(readableError(error)))} disabled={busy}>↻ Refresh</button></div>
        </div>
      ) : <section className="empty-workspace"><div className="empty-art"><span className="empty-sun" /><span className="empty-hill hill-back" /><span className="empty-hill hill-front" /><span className="empty-card"><i /><i /><i /></span></div><div><p className="eyebrow">A QUIETER WAY TO WORK TOGETHER</p><h2>One agreement.<br /><em>Clear next steps.</em></h2><p>Open an agreement by its ID to see milestone status, chain deadlines and the actions available to your wallet. Private terms stay closed until you sign in.</p><div className="empty-checks"><span>✓ Exact token amounts</span><span>✓ Deadline-aware actions</span><span>✓ Private evidence access</span></div></div></section>}

      <footer className="footer"><span><b>fairwork.</b> · Local prototype</span><span>Local chain only · No real funds · Not audited</span><span>Chain time shown in UTC</span></footer>

      {showAgreement && <AgreementModal agreement={agreement} setAgreement={setAgreement} milestones={milestoneDrafts} setMilestones={setMilestoneDrafts} config={config} busy={busy} onClose={() => setShowAgreement(false)} onSubmit={createAgreement} />}
      {confirmSummary && <ConfirmModal summary={confirmSummary} onChoice={closeConfirm} />}
    </main>
  );
}

function AgreementModal({ agreement, setAgreement, milestones, setMilestones, config, busy, onClose, onSubmit }: any) {
  const updateMilestone = (index: number, key: keyof MilestoneDraft, value: string) => setMilestones((current: MilestoneDraft[]) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item));
  const selectedToken = config?.tokens.find((token: any) => token.address.toLowerCase() === (agreement.token || config.tokens[0]?.address || "").toLowerCase()) ?? config?.tokens[0];
  return <div className="modal-backdrop" role="presentation"><form className="agreement-modal" onSubmit={onSubmit}>
    <div className="modal-heading"><div><p className="eyebrow">NEW DIRECT PROPOSAL</p><h2>Create a private agreement</h2><p>Terms are committed on chain and encrypted in private storage after the proposal confirms.</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button></div>
    <div className="form-grid"><label className="span-two">Freelancer wallet address<input value={agreement.freelancer} onChange={(event) => setAgreement({ ...agreement, freelancer: event.target.value })} placeholder="0x…" required /></label><label>Token<select value={agreement.token || config?.tokens[0]?.address || ""} disabled={!config} onChange={(event) => setAgreement({ ...agreement, token: event.target.value })}>{config?.tokens.map((token: any) => <option key={token.address} value={token.address}>{token.symbol} · {shortAddress(token.address)}</option>)}</select></label><label>Review window · seconds<input type="number" min="1" max="31536000" value={agreement.reviewWindow} onChange={(event) => setAgreement({ ...agreement, reviewWindow: event.target.value })} required /></label><label>Revision limit · per milestone<input type="number" min="0" max="5" value={agreement.revisionLimit} onChange={(event) => setAgreement({ ...agreement, revisionLimit: event.target.value })} required /></label><label>Agreement title<input maxLength={10000} value={agreement.title} onChange={(event) => setAgreement({ ...agreement, title: event.target.value })} required /></label><label className="span-two">Description<textarea maxLength={10000} value={agreement.description} onChange={(event) => setAgreement({ ...agreement, description: event.target.value })} required /></label><label className="span-two">Scope<textarea maxLength={10000} value={agreement.scope} onChange={(event) => setAgreement({ ...agreement, scope: event.target.value })} required /></label><label className="span-two">Delivery rules<textarea maxLength={10000} value={agreement.deliveryRules} onChange={(event) => setAgreement({ ...agreement, deliveryRules: event.target.value })} required /></label></div>
    <div className="milestone-editor-heading"><div><p className="eyebrow">PAYMENT PLAN</p><strong>Milestones</strong></div><button className="text-button" type="button" disabled={milestones.length >= 10} onClick={() => setMilestones((current: MilestoneDraft[]) => [...current, { amount: "", duration: "86400", criteria: "" }])}>＋ Add milestone</button></div>
    {milestones.map((item: MilestoneDraft, index: number) => <div className="milestone-editor" key={index}><div className="editor-title"><span>{String(index + 1).padStart(2, "0")}</span><strong>Milestone {index + 1}</strong>{milestones.length > 1 && <button type="button" onClick={() => setMilestones((current: MilestoneDraft[]) => current.filter((_: unknown, i: number) => i !== index))}>Remove</button>}</div><div className="form-grid"><label>Amount · {selectedToken?.symbol ?? "TOKEN"}<input type="text" inputMode="decimal" value={item.amount} onChange={(event) => updateMilestone(index, "amount", event.target.value)} placeholder="0.00" required /></label><label>Delivery time · seconds<input type="number" min="1" max="31536000" value={item.duration} onChange={(event) => updateMilestone(index, "duration", event.target.value)} required /></label><label className="span-two">Acceptance criteria<textarea value={item.criteria} onChange={(event) => updateMilestone(index, "criteria", event.target.value)} maxLength={10000} required /></label></div></div>)}
    <div className="modal-footer"><span>Each milestone amount is exact integer token units. No unlimited approval.</span><button className="button button-outline" type="button" onClick={onClose}>Cancel</button><button className="button button-dark" type="submit" disabled={busy}>{busy ? "Waiting for confirmation…" : "Review and create proposal"}<span>→</span></button></div>
  </form></div>;
}

function ConfirmModal({ summary, onChoice }: { summary: ConfirmationSummary; onChoice: (accepted: boolean) => void }) {
  return <div className="modal-backdrop confirm-backdrop"><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-heading"><div className="confirm-mark">!</div><div className="modal-heading"><div><p className="eyebrow">READ BEFORE SIGNING</p><h2 id="confirm-heading">{summary.action}</h2><p>This is the exact chain action your wallet is being asked to sign.</p></div><button className="modal-close" type="button" onClick={() => onChoice(false)} aria-label="Close">×</button></div><div className="confirm-details"><div><span>Network</span><strong>Fairwork Local · chain {summary.chainId}</strong></div><div><span>Contract</span><code>{summary.contractAddress}</code></div><div><span>Parties</span><strong>{summary.parties.map(shortAddress).join(" ↔ ")}</strong></div>{summary.token && <div><span>Token · raw and formatted</span><strong>{summary.token.formatted} <small>({summary.token.raw} raw units)</small></strong><code>{summary.token.address}</code></div>}<div><span>Terms and commitments</span>{summary.terms.map((term) => <code key={term}>{term}</code>)}</div>{summary.timing?.length ? <div><span>Timing and revisions</span>{summary.timing.map((time) => <strong key={time}>{time}</strong>)}</div> : null}<div className="confirm-effects"><span>What happens</span>{summary.effects.map((effect) => <p key={effect}>• {effect}</p>)}</div></div><div className="modal-footer"><button className="button button-outline" type="button" onClick={() => onChoice(false)}>Cancel</button><button className="button button-dark" type="button" onClick={() => onChoice(true)}>Continue to wallet <span>↗</span></button></div></section></div>;
}

function DisputePanel({ dispute, panels, settlement, disputeId, account, token, policy, busy, countdown, evidence, voteSecret, runAction, castCommit, revealVote, postEvidence }: any) {
  if (!dispute) return null;
  const phase = Number(dispute.phase); const round = Math.max(1, Number(dispute.round) || 1); const currentPanel = panels?.[round] ?? panels?.[String(round)] ?? [];
  const assigned = Boolean(account && currentPanel.some((value: string) => value.toLowerCase() === account.toLowerCase()));
  const deposit = asBigInt(dispute.depositAmount);
  return <section className="dispute-panel"><div className="dispute-heading"><div><p className="eyebrow">DISPUTE #{disputeId}</p><h4>{phaseNames[phase] ?? "Arbitration"}</h4></div><span className="dispute-phase">PHASE {phase} · ROUND {round}</span></div><div className="panel-members"><span>CURRENT PANEL</span>{currentPanel.map((memberAddress: string, index: number) => <code key={`${memberAddress}-${index}`}>{memberAddress === "0x0000000000000000000000000000000000000000" ? "Open seat" : shortAddress(memberAddress)}</code>)}</div>{assigned && <p className="assigned-note">{phase === 10 ? "Your wallet served on this panel." : "Your wallet is on the active panel for this round."}</p>}<div className="dispute-stats"><div><span>Evidence closes</span><strong>{utc(dispute.evidenceDeadline)}<small>{countdown(dispute.evidenceDeadline)}</small></strong></div><div><span>Commit ends</span><strong>{utc(phase === 5 ? dispute.replacementCommitDeadline : dispute.commitDeadline)}<small>{countdown(phase === 5 ? dispute.replacementCommitDeadline : dispute.commitDeadline)}</small></strong></div><div><span>Reveal ends</span><strong>{utc(dispute.revealDeadline)}<small>{countdown(dispute.revealDeadline)}</small></strong></div><div><span>Deposit each</span><strong>{formatTokenAmount(deposit, token?.decimals ?? 18, token?.symbol ?? "TOKEN")} <small>({deposit} raw)</small></strong></div></div>{(phase === 2 || phase === 4 || phase === 7) && <p>Active randomness request <code>{String(dispute.activeRequestId)}</code> · {dispute.randomnessReady ? "Entropy received; advance phase to select the panel." : "Waiting for entropy; local fulfillment is available only if the mock registered this request."}</p>}{evidence.length > 0 && <div className="evidence-list"><span className="eyebrow">PRIVATE EVIDENCE · {evidence.length}</span>{evidence.map((item: any, index: number) => <div key={item.id ?? index}><strong>{item.text ?? "Evidence commitment"}</strong><code>{String(item.commitment ?? item.reference ?? "").slice(0, 18)}…</code></div>)}</div>}
    {phase === 10 && <div className="settlement-summary"><p className="eyebrow">FINAL ARBITRATION RESULT</p>{settlement ? <><p>Freelancer share: {settlement.rulingBps} basis points ({(settlement.rulingBps / 100).toFixed(2)}%) · {settlement.fallbackApplied ? `Fallback applied · ${({ 1: "insufficient eligible arbiters", 2: "randomness retry limit reached", 3: "Panel 2 did not reach quorum" } as Record<number, string>)[Number(dispute.fallbackReason)] ?? "reason unavailable"}` : "Panel ruling"}</p><div className="detail-grid">{[["Client credited", settlement.clientCredit], ["Freelancer credited", settlement.freelancerCredit], ["Treasury credited", settlement.treasuryCredit]].map(([label, amount]: any) => <div key={label}><span>{label}</span><strong>{formatTokenAmount(amount, token?.decimals ?? 18, token?.symbol ?? "TOKEN")}<small> ({String(amount)} raw)</small></strong></div>)}</div><p>These amounts were credited to claimable balances. Withdrawals are separate completed token transfers.</p>{settlement.credits.map((credit: any, index: number) => <p key={`${credit.account}-${credit.source}-${index}`}>{credit.source === 0 ? "Principal credit" : credit.source === 1 ? "Deposit refund" : "Treasury forfeiture"} · <code>{shortAddress(credit.account)}</code> · {formatTokenAmount(credit.amount, token?.decimals ?? 18, token?.symbol ?? "TOKEN")} ({String(credit.amount)} raw)</p>)}</> : <p>The settled case is recorded on chain; matching settlement events are unavailable. Refresh to load the verified credit breakdown.</p>}</div>}
    <div className="action-row">{policy.allowedActionIds.includes("advanceDispute") && <button type="button" className="button button-dark" disabled={busy} onClick={() => void runAction("advanceDispute", "advanceDispute", [BigInt(disputeId)], "Advance arbitration", ["Move the dispute to its next deadline-eligible phase. Anyone may call this when the chain window allows it."]) }>Advance phase</button>}</div>
    {policy.allowedActionIds.includes("submitEvidence") && <form className="inline-action-form" onSubmit={postEvidence}><label>Submit private evidence<textarea name="evidence" required maxLength={10000} placeholder="Describe the evidence. Only a salted commitment and opaque reference go on chain." /></label><label className="file-picker">Optional private attachment<input name="evidenceFile" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt,application/pdf,image/png,image/jpeg,text/plain" /></label><small>An attachment uses two evidence entries: one for the private file hash and one for the private text.</small><button className="button button-outline" type="submit" disabled={busy}>Commit evidence</button></form>}
    {policy.allowedActionIds.includes("commitVote") && <form className="inline-action-form vote-form" onSubmit={castCommit}><label>Freelancer share · basis points<input name="bps" inputMode="numeric" type="number" min="0" max="10000" required placeholder="0–10000" /></label><button className="button button-dark" type="submit" disabled={busy}>Create sealed vote</button><small>The fresh salt stays in this page’s memory. Copy it after the commitment; it is required to reveal.</small></form>}
    {(policy.allowedActionIds.includes("revealVote") || voteSecret) && <form className="inline-action-form vote-form" onSubmit={revealVote}><label>Freelancer share · basis points<input name="bps" type="number" min="0" max="10000" defaultValue={voteSecret?.bps ?? ""} required /></label><label>Reveal salt<input name="salt" defaultValue={voteSecret?.salt ?? ""} placeholder="0x + 64 hex characters" required /></label><button className="button button-outline" type="submit" disabled={busy || !policy.allowedActionIds.includes("revealVote")}>Reveal committed vote</button></form>}
  </section>;
}
