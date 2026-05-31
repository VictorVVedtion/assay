/**
 * ChainBlock — one link in the evidence hash-chain spine.
 *
 * Renders a single EvidenceRecord as a compact block: its seq, a short mono
 * hash, the provider, and a state-driven left rail. The link glyph ABOVE the
 * block expresses prev_hash → previous.hash continuity; a broken link is drawn
 * severed and red (the tamper point). Clicking the block selects the record in
 * the store (opens the EvidenceDrawer), where the buyer can recompute the hash
 * in-browser — the per-record half of "anyone can recompute".
 *
 * This component is presentational; the spine computes each block's `state`
 * from the foundation /api/verify result (we do NOT recompute the chain here).
 *
 * Client component (it dispatches a store select on click).
 */

"use client";

import { MonoHash } from "@/components/ui/MonoHash";
import { ProviderChip } from "@/components/ui/ProviderChip";
import { fmtClock, fmtPath } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { EvidenceRecord } from "@/lib/types";

/** Per-block verification state, derived from the whole-chain VerifyResult. */
export type BlockState =
  | "verified" // hash recomputed + prev_hash linked (≤ the verified frontier)
  | "break" // the record AT which verification failed (the tamper point)
  | "unverified" // sits after a BREAK — not vouched for
  | "torn" // the torn trailing line (recoverable crash artifact, not tamper)
  | "pending"; // chain status not yet known (rare; pre-hydrate)

interface BlockTone {
  rail: string; // left rail / accent color
  dot: string;
  ring: string; // selected ring + hover border
  hashTone: "ok" | "accent" | "critical" | "dim" | "default";
}

const TONE: Record<BlockState, BlockTone> = {
  verified: {
    rail: "var(--sev-ok)",
    dot: "var(--sev-ok)",
    ring: "var(--sev-ok-border)",
    hashTone: "ok",
  },
  break: {
    rail: "var(--sev-tamper)",
    dot: "var(--sev-tamper)",
    ring: "var(--sev-tamper-border)",
    hashTone: "critical",
  },
  unverified: {
    rail: "var(--sev-critical)",
    dot: "var(--sev-critical)",
    ring: "var(--sev-critical-border)",
    hashTone: "critical",
  },
  torn: {
    rail: "var(--sev-warn)",
    dot: "var(--sev-warn)",
    ring: "var(--sev-warn-border)",
    hashTone: "dim",
  },
  pending: {
    rail: "var(--line-strong)",
    dot: "var(--text-ghost)",
    ring: "var(--line-strong)",
    hashTone: "dim",
  },
};

const STATE_NOTE: Record<BlockState, string> = {
  verified: "hash 重算一致 · prev_hash 链接成立 (verified by in-browser SHA-256)",
  break: "篡改点 — 此记录的 hash 与其字节不符,或 seq/prev_hash 不连续。以下裁决不可信。",
  unverified: "位于 BREAK 之后 — 链已断,无法担保 (not vouched for after a break)",
  torn: "末行残缺(无换行)— 崩溃残留,可恢复,非篡改 (recoverable crash artifact, not tamper)",
  pending: "等待链校验 (verifying…)",
};

/** What kind of inconsistency tripped the BREAK at this block (from verify):
 *   "link" — seq gap or prev_hash mismatch ⇒ the chain INTO this block is severed.
 *   "hash" — this record's own bytes were altered (its prev_hash may still link),
 *            so the BLOCK is the corruption; the incoming link is left intact.
 *   undefined — not a break block (or cause unknown → treat conservatively as link). */
export type BreakKind = "link" | "hash";

export interface ChainBlockProps {
  record: EvidenceRecord;
  state: BlockState;
  /** the seq.hash this block's prev_hash SHOULD equal (the prior record's hash),
   *  or null for genesis. Used only for the linkage tooltip. */
  expectedPrev: string | null;
  /** is this the genesis (seq 0) record? draws the genesis anchor instead of a link. */
  genesis: boolean;
  /** for a break block, which inconsistency tripped it (drives the visual). */
  breakKind?: BreakKind;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function ChainBlock({
  record,
  state,
  expectedPrev,
  genesis,
  breakKind,
  selected,
  onSelect,
}: ChainBlockProps) {
  const tone = TONE[state];
  const isBreak = state === "break";
  // Sever the link INTO this block only when the break is a seq/prev_hash
  // discontinuity. A pure hash mismatch leaves prev_hash linking the prior
  // record, so we keep the line and mark the BLOCK's hash as failing recompute.
  const linkBroken = isBreak && breakKind !== "hash";
  const hashTampered = isBreak && breakKind === "hash";
  const linkMatches = expectedPrev !== null && record.prev_hash === expectedPrev;
  const baseBorderColor = selected
    ? "var(--accent)"
    : isBreak
      ? "var(--sev-tamper-border)"
      : "var(--line)";

  return (
    <li className="row-in" style={{ listStyle: "none" }}>
      {/* connector ABOVE the block: genesis anchor, or a link glyph */}
      <ChainConnector
        genesis={genesis}
        broken={linkBroken}
        matches={linkMatches}
        toneColor={tone.rail}
        prevHash={record.prev_hash}
      />

      {/* role="button" (not a native <button>) because the block contains the
          nested MonoHash copy <button> — interactive elements can't nest. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(record.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(record.id);
          }
        }}
        aria-pressed={selected}
        aria-label={`evidence record seq ${record.seq} — ${state}; open details`}
        title={STATE_NOTE[state]}
        className={cn("chain-block", isBreak && "tamper-pulse")}
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          alignItems: "center",
          gap: 8,
          width: "100%",
          textAlign: "left",
          background: selected ? "var(--accent-ghost)" : "var(--panel-2)",
          // PER-SIDE longhands only — no `border` / `borderWidth` / `borderColor`
          // shorthands. `borderColor` is itself a shorthand (all four sides), so
          // mixing it with `borderLeftColor` still trips React's shorthand/longhand
          // conflict warning when the color changes on select/break rerenders.
          borderStyle: "solid",
          borderTopWidth: 1,
          borderRightWidth: 1,
          borderBottomWidth: 1,
          borderLeftWidth: 3,
          borderTopColor: baseBorderColor,
          borderRightColor: baseBorderColor,
          borderBottomColor: baseBorderColor,
          borderLeftColor: tone.rail,
          borderRadius: "var(--r)",
          padding: "6px 9px",
          cursor: "pointer",
          boxShadow: selected ? "inset 0 0 0 1px var(--accent-ghost)" : undefined,
          transition: "background 0.12s ease, border-color 0.12s ease",
        }}
      >
        {/* seq + state dot */}
        <span className="flex items-center gap-2 shrink-0">
          <span
            className="dot"
            style={{ background: tone.dot, boxShadow: isBreak ? "0 0 6px 0 var(--sev-tamper-glow)" : undefined }}
            aria-hidden
          />
          <span
            className="mono data-sm"
            style={{ color: "var(--text-faint)", minWidth: 24, fontWeight: 600 }}
            title={`seq ${record.seq}`}
          >
            #{record.seq}
          </span>
        </span>

        {/* hash + provider/path */}
        <span className="flex flex-col min-w-0" style={{ gap: 1 }}>
          <span className="flex items-center gap-1 min-w-0">
            <MonoHash
              value={record.hash}
              head={10}
              tail={6}
              tone={tone.hashTone}
              prefix={hashTampered ? "stored" : "hash"}
              expandable={false}
            />
            {hashTampered && (
              <span
                className="micro mono"
                style={{ color: "var(--sev-tamper)", fontWeight: 700, whiteSpace: "nowrap" }}
                title="recompute sha256(canon(record)) ≠ stored hash — this record's bytes were altered after hashing. Open it to recompute in-browser."
              >
                ✗ 重算不符
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 min-w-0">
            <ProviderChip provider={record.route.provider} />
            <span
              className="mono micro truncate-ellipsis"
              style={{ color: "var(--text-faint)" }}
              title={record.route.path}
            >
              {fmtPath(record.route.path)}
            </span>
          </span>
        </span>

        {/* right: clock + open affordance */}
        <span className="flex flex-col items-end shrink-0" style={{ gap: 2 }}>
          <span className="mono micro" style={{ color: "var(--text-faint)" }}>
            {fmtClock(record.ts_start)}
          </span>
          {isBreak ? (
            <span
              className="micro mono"
              style={{ color: "var(--sev-tamper)", fontWeight: 700, letterSpacing: "0.04em" }}
            >
              BREAK
            </span>
          ) : state === "unverified" ? (
            <span className="micro" style={{ color: "var(--sev-critical)" }}>
              未担保
            </span>
          ) : state === "torn" ? (
            <span className="micro" style={{ color: "var(--sev-warn)" }}>
              torn
            </span>
          ) : (
            <span
              aria-hidden
              style={{ color: "var(--text-ghost)", fontSize: 12, lineHeight: 1 }}
            >
              →
            </span>
          )}
        </span>
      </div>
    </li>
  );
}

/* ---- the link glyph that sits above each block ------------------------------
   Genesis: a small "anchor" cap (prev_hash = 64×0). Non-genesis: a short
   vertical connector with a chain-link glyph; severed + red when broken. */
function ChainConnector({
  genesis,
  broken,
  matches,
  toneColor,
  prevHash,
}: {
  genesis: boolean;
  broken: boolean;
  matches: boolean;
  toneColor: string;
  prevHash: string;
}) {
  if (genesis) {
    return (
      <div
        className="flex items-center gap-1.5"
        style={{ paddingLeft: 2, height: 16 }}
        title={`genesis: prev_hash = ${prevHash} (64 zeros)`}
      >
        <span
          aria-hidden
          style={{
            width: 3,
            height: 10,
            background: `linear-gradient(to bottom, transparent, ${toneColor})`,
            marginLeft: 5,
            borderRadius: 2,
          }}
        />
        <span className="micro" style={{ color: "var(--text-ghost)", letterSpacing: "0.06em" }}>
          ⌜ genesis · prev_hash = 0×64
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-1.5"
      style={{ paddingLeft: 2, height: 18 }}
      title={
        broken
          ? "链接断裂:此记录 prev_hash 与上一条 hash 不一致 / hash 重算失败 (BREAK)"
          : matches
            ? "prev_hash 链接成立 (== previous record hash)"
            : "prev_hash 链接 (continuity)"
      }
    >
      {/* vertical link segment */}
      <span
        aria-hidden
        style={{
          width: broken ? 0 : 3,
          height: 12,
          marginLeft: broken ? 6 : 5,
          background: broken ? "transparent" : toneColor,
          opacity: broken ? 0 : 0.85,
          borderRadius: 2,
          borderLeft: broken ? "3px dashed var(--sev-tamper)" : undefined,
        }}
      />
      {broken ? (
        <span
          className="micro mono"
          style={{ color: "var(--sev-tamper)", fontWeight: 700, letterSpacing: "0.04em" }}
        >
          ⛓✕ 链断 · prev_hash ✗
        </span>
      ) : (
        <span aria-hidden style={{ color: toneColor, opacity: 0.7, fontSize: 11, lineHeight: 1 }}>
          ⛓
        </span>
      )}
    </div>
  );
}
