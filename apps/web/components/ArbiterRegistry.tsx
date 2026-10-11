"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Address } from "viem";
import type { PublicConfig } from "../lib/chain.ts";
import {
  isRegistryOwner,
  readArbiterRegistry,
  validateArbiterRegistryChange,
  type ArbiterRegistryMethod,
  type ArbiterRegistrySnapshot,
} from "../lib/client/arbiter-registry.ts";

type ArbiterRegistryProps = {
  config: PublicConfig;
  account: string | null;
  busy: boolean;
  onChange: (method: ArbiterRegistryMethod, address: Address) => Promise<void>;
};

function shortAddress(address: string) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "The registry request could not be completed.";
  return message.length > 240 ? `${message.slice(0, 237)}…` : message;
}

export default function ArbiterRegistry({ config, account, busy, onChange }: ArbiterRegistryProps) {
  const [snapshot, setSnapshot] = useState<ArbiterRegistrySnapshot | null>(null);
  const [readState, setReadState] = useState<"loading" | "ready" | "error">("loading");
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [candidateAddress, setCandidateAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const readVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++readVersion.current;
    setReadState("loading");
    setReadError("");
    try {
      const next = await readArbiterRegistry(config);
      if (version !== readVersion.current) return;
      setSnapshot(next);
      setReadState("ready");
    } catch (error) {
      if (version !== readVersion.current) return;
      setReadError(errorMessage(error));
      setReadState("error");
    }
  }, [config]);

  useEffect(() => {
    void refresh();
    return () => { readVersion.current += 1; };
  }, [refresh, account]);

  const isOwner = Boolean(snapshot && isRegistryOwner(account, snapshot.owner));
  const canChange = readState === "ready" && Boolean(snapshot) && isOwner && !busy && !submitting;

  const changeRegistry = async (method: ArbiterRegistryMethod, rawAddress: string) => {
    if (!snapshot || readState !== "ready") {
      setActionError("The registry is not fresh yet. Refresh it before making a change.");
      return;
    }

    let address: Address;
    try {
      address = validateArbiterRegistryChange(method, rawAddress, account, snapshot);
    } catch (error) {
      setActionError(errorMessage(error));
      return;
    }

    setSubmitting(true);
    setActionError("");
    setNotice("");
    try {
      await onChange(method, address);
      setCandidateAddress("");
      setNotice(method === "addArbiter" ? "The transaction was confirmed. A fresh pinned read will update the roster below." : "The removal was confirmed. A fresh pinned read will update the roster below.");
      await refresh();
    } catch (error) {
      setActionError(errorMessage(error));
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const submitAdd = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void changeRegistry("addArbiter", candidateAddress);
  };

  return (
    <section className="panel terms-panel" aria-labelledby="arbiter-registry-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">ARBITRATION GOVERNANCE</p>
          <h3 id="arbiter-registry-heading">Arbiter registry</h3>
        </div>
        <span className="lock-mark" aria-hidden="true">⌑</span>
      </div>

      <p className="overview-subtitle" style={{ marginTop: 12 }}>
        The owner-controlled on-chain wallet roster. Changes apply to future panel selections; current panel assignments remain snapshotted.
      </p>

      {readState === "loading" && (
        <p className="banner banner-warn" role="status" style={{ marginTop: 14 }}>
          Reading owner and arbiter membership from one pinned block…
        </p>
      )}
      {readState === "error" && (
        <div className="banner banner-error" role="alert" style={{ marginTop: 14 }}>
          <strong>Registry read failed</strong>
          <span>{readError} {snapshot ? "The last snapshot is stale; owner controls are disabled." : "No roster is shown until a pinned read succeeds."}</span>
        </div>
      )}
      {readState === "loading" && snapshot && (
        <p className="banner banner-warn" role="status" style={{ marginTop: 14 }}>
          Showing the previous snapshot while the pinned registry refreshes. Owner controls are disabled.
        </p>
      )}
      {actionError && <div className="banner banner-error" role="alert" style={{ marginTop: 14 }}><strong>Registry change needs review</strong><span>{actionError}</span></div>}
      {notice && <div className="banner banner-success" role="status" style={{ marginTop: 14 }}><span>{notice}</span></div>}

      {snapshot && (
        <>
          <dl style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "8px 16px", margin: "18px 0", padding: "13px 14px", border: "1px solid var(--line)", borderRadius: 9, background: "#fafbf7", fontSize: 12 }}>
            <dt style={{ color: "var(--muted)" }}>On-chain owner</dt>
            <dd className="mono" style={{ margin: 0, overflowWrap: "anywhere", textAlign: "right" }} title={snapshot.owner}>{shortAddress(snapshot.owner)}</dd>
            <dt style={{ color: "var(--muted)" }}>Registered arbiters</dt>
            <dd style={{ margin: 0, textAlign: "right" }}>{snapshot.count} / 128</dd>
            <dt style={{ color: "var(--muted)" }}>Read at block</dt>
            <dd className="mono" style={{ margin: 0, textAlign: "right" }}>{snapshot.blockNumber.toString()}</dd>
          </dl>

          <div style={{ display: "grid", gap: 9 }} aria-label="Current arbiter members">
            {snapshot.members.length === 0 ? (
              <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>No arbiters are currently registered.</p>
            ) : snapshot.members.map((member, index) => (
              <div key={member.toLowerCase()} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8 }}>
                <span style={{ minWidth: 0, overflowWrap: "anywhere", fontSize: 12 }}>
                  <strong style={{ marginRight: 8 }}>Arbiter {index + 1}</strong>
                  <code title={member}>{member}</code>
                </span>
                <button
                  className="button button-small button-outline"
                  type="button"
                  disabled={!canChange}
                  aria-label={`Remove arbiter ${member}`}
                  onClick={() => void changeRegistry("removeArbiter", member)}
                >
                  {submitting ? "Waiting…" : "Remove"}
                </button>
              </div>
            ))}
          </div>

          <form onSubmit={submitAdd} style={{ display: "grid", gap: 8, marginTop: 18 }}>
            <label htmlFor="arbiter-registry-address" style={{ color: "var(--ink-soft)", fontSize: 12, fontWeight: 700 }}>Add an arbiter wallet address</label>
            <input
              id="arbiter-registry-address"
              name="arbiter-address"
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              placeholder="0x…"
              value={candidateAddress}
              onChange={(event) => { setCandidateAddress(event.target.value); setActionError(""); }}
              disabled={!canChange}
              aria-describedby="arbiter-registry-vetting"
              style={{ width: "100%", minWidth: 0, padding: "10px 11px", border: "1px solid var(--line)", borderRadius: 8, color: "var(--ink)", background: "#fffefa", fontFamily: "var(--mono)", fontSize: 12 }}
            />
            <button className="button button-dark" type="submit" disabled={!canChange || !candidateAddress.trim()}>
              {submitting ? "Waiting for confirmed receipt…" : "Add arbiter"}
            </button>
          </form>

          <p id="arbiter-registry-vetting" className="privacy-callout" style={{ alignItems: "flex-start", marginTop: 14 }}>
            <span aria-hidden="true" className="privacy-icon">⌑</span>
            <span><strong>Wallets only.</strong> Local demo wallets are synthetic. Real arbiters require off-chain identity vetting before registration; no identity details belong here.</span>
          </p>

          {!isOwner && (
            <p style={{ margin: "12px 0 0", color: "var(--muted)", fontSize: 11 }}>
              Registry changes are disabled for this wallet. Connect the on-chain owner shown above to manage membership.
            </p>
          )}
          {isOwner && readState === "ready" && (
            <p style={{ margin: "12px 0 0", color: "var(--muted)", fontSize: 11 }}>
              Registry order may change after removal. Existing panels and draws keep their recorded membership.
            </p>
          )}
          <button className="text-button" type="button" disabled={busy || submitting} onClick={() => void refresh()} style={{ marginTop: 12 }}>
            {readState === "loading" ? "Refreshing registry…" : "Refresh registry"}
          </button>
        </>
      )}

      {!snapshot && readState !== "error" && <p style={{ margin: "14px 0 0", color: "var(--muted)", fontSize: 12 }}>Loading the read-only registry…</p>}
      {!snapshot && readState === "error" && <button className="button button-outline" type="button" disabled={busy} onClick={() => void refresh()} style={{ marginTop: 14 }}>Retry pinned registry read</button>}
    </section>
  );
}
