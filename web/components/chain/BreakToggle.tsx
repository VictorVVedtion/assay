/**
 * BreakToggle — DEMO-only control that injects / clears a hash-chain BREAK so a
 * buyer can see the tamper path on demand (DESIGN killer-feature C). It flips
 * the store's `breakAt` seq; the foundation refetches /api/snapshot + /api/verify
 * for that seq, which mutates ONE demo record's body AFTER its hash was computed
 * — so the chain re-verifies as BREAK@seq, exactly the post-hoc edit case. The
 * verdicts stay bound to the genuine hashes; the TAMPER state is what changes.
 *
 * Hidden in Live mode: the seq query is only honored for the demo source (a real
 * file's integrity is whatever it is — you cannot "inject" tamper into Live).
 *
 * Client component (reads/sets store state).
 */

"use client";

import { useBreakAt, useDataSource, useSetBreakAt } from "@/lib/hooks";

/** Matches lib/server/demo.ts DEMO_BREAK_SEQ (mid-chain; avoids genesis). */
const DEMO_BREAK_SEQ = 3;

export function BreakToggle() {
  const source = useDataSource();
  const breakAt = useBreakAt();
  const setBreakAt = useSetBreakAt();

  // Live integrity is observed, not injected — no toggle.
  if (source !== "demo") return null;

  const active = breakAt !== null;

  return (
    <button
      type="button"
      onClick={() => setBreakAt(active ? null : DEMO_BREAK_SEQ)}
      aria-pressed={active}
      className="micro mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 8px",
        borderRadius: "var(--r-sm)",
        border: "1px solid",
        borderColor: active ? "var(--sev-tamper-border)" : "var(--line)",
        background: active ? "var(--sev-tamper-bg)" : "transparent",
        color: active ? "var(--sev-tamper)" : "var(--text-faint)",
        cursor: "pointer",
        fontWeight: 600,
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
      }}
      title={
        active
          ? `clear the injected BREAK (restore the valid demo chain). Currently tampering seq ${breakAt}.`
          : `inject a BREAK at seq ${DEMO_BREAK_SEQ}: mutate that record's body AFTER its hash → chain verifies as BREAK@${DEMO_BREAK_SEQ} (the tamper case). DEMO only.`
      }
    >
      <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>
        {active ? "↺" : "⛓✕"}
      </span>
      {active ? `清除篡改 · clear BREAK` : `注入篡改 · inject BREAK`}
    </button>
  );
}
