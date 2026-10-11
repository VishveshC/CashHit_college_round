type SessionView = { wallet: string; expiresAt: string };

export function buildPrivateConfirmationTerms(content: { title: string; description: string; scope: string; deliveryRules: string; criteria: string[] }, commitments: Record<string, string>): string[] {
  return [
    `Title: ${content.title} — ${commitments.title}`,
    `Description: ${content.description} — ${commitments.description}`,
    `Scope: ${content.scope} — ${commitments.scope}`,
    `Delivery rules: ${content.deliveryRules} — ${commitments.deliveryRules}`,
    ...content.criteria.map((criterion, index) => `Milestone ${index + 1} acceptance: ${criterion} — ${commitments[`criteria.${index}`]}`),
  ];
}

export function subscribePrivateSessionInvalidation(channel: {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}, invalidate: () => void): () => void {
  const listener = (event: MessageEvent) => { if (event.data?.type === "private-session-invalidated") invalidate(); };
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}

export function privateSessionIsCurrent(session: SessionView | null, wallet: string | null, nowMs: number): boolean {
  if (!session || !wallet || !Number.isFinite(nowMs) || session.wallet.toLowerCase() !== wallet.toLowerCase()) return false;
  const expiry = Date.parse(session.expiresAt);
  return Number.isFinite(expiry) && nowMs < expiry;
}

export function resetPrivateViewForContextChange(_state: Record<string, unknown> = {}) {
  return {
    terms: null, notes: {}, files: {}, evidence: {}, auditEvents: [], voteSecrets: {}, pendingPrivateSave: null,
    agreement: { freelancer: "", token: "", title: "", description: "", scope: "", deliveryRules: "", reviewWindow: "3600", revisionLimit: "2" },
    milestoneDrafts: [{ amount: "", duration: "86400", criteria: "" }],
    showAgreement: false, confirmSummary: null,
  };
}
