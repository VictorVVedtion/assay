/**
 * ChainSpine — the vertical sequence of linked evidence blocks (the app's
 * "spine"). Records flow newest at the BOTTOM (head), matching append-only
 * growth; genesis (seq 0) anchors the top.
 *
 * Per-block state is DERIVED from the foundation VerifyResult (we rely on
 * /api/verify via the store; we do NOT recompute the chain here — the drawer
 * does per-record recompute):
 *
 *   VALID      → every shown block "verified".
 *   TORN_TAIL  → all but the trailing line verified; the last block is "torn".
 *   BREAK@seq  → blocks with seq <  break_seq are "verified";
 *                the block with seq == break_seq is the "break" (tamper point);
 *                blocks with seq >  break_seq are "unverified" (not vouched for).
 *   EMPTY      → handled by the parent (empty state).
 *
 * Long chains are collapsed to a head window + tail window with an elided middle
 * so the panel stays dense in the narrow rail; if a BREAK exists it is always
 * kept visible (the spine expands around it).
 */

"use client";

import { useMemo } from "react";
import { ChainBlock, type BlockState, type BreakKind } from "./ChainBlock";
import { GENESIS_PREV_HASH } from "@/lib/types";
import type { EvidenceRecord, VerifyResult } from "@/lib/types";

/** How many blocks to keep at the top and bottom before eliding the middle. */
const HEAD_WINDOW = 3;
const TAIL_WINDOW = 8;
/** Below this count we never elide (show everything). */
const NO_ELIDE_BELOW = HEAD_WINDOW + TAIL_WINDOW + 2;

export interface ChainSpineProps {
  records: EvidenceRecord[]; // sorted by seq asc (store guarantees this)
  chain: VerifyResult;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** Classify one record's block state from the chain result + its position. */
function blockStateFor(
  rec: EvidenceRecord,
  index: number,
  total: number,
  chain: VerifyResult,
): BlockState {
  switch (chain.status) {
    case "BREAK": {
      if (chain.break_seq === null) return "verified";
      if (rec.seq < chain.break_seq) return "verified";
      if (rec.seq === chain.break_seq) return "break";
      return "unverified";
    }
    case "TORN_TAIL":
      // the trailing record is the torn line; all earlier verified.
      return index === total - 1 ? "torn" : "verified";
    case "VALID":
      return "verified";
    case "EMPTY":
    default:
      return "pending";
  }
}

/** Infer the break cause from verify.ts's detail string so the break block can
 *  render faithfully: a pure "hash mismatch" altered the record's bytes (link
 *  into it intact); "seq gap" / "prev_hash mismatch" / "unparseable" sever the
 *  incoming link. Defaults to "link" (conservative) when the detail is opaque. */
function breakKindFromDetail(detail: string): BreakKind {
  return /hash mismatch/i.test(detail) && !/prev_hash/i.test(detail) ? "hash" : "link";
}

type Row =
  | { kind: "block"; rec: EvidenceRecord; index: number }
  | { kind: "elision"; count: number; key: string };

export function ChainSpine({ records, chain, selectedId, onSelect }: ChainSpineProps) {
  const rows = useMemo<Row[]>(() => {
    const n = records.length;
    if (n === 0) return [];

    // Indices we must keep visible: the head window, the tail window, and (if a
    // BREAK exists) the break block plus its immediate neighbours.
    const keep = new Set<number>();
    for (let i = 0; i < Math.min(HEAD_WINDOW, n); i++) keep.add(i);
    for (let i = Math.max(0, n - TAIL_WINDOW); i < n; i++) keep.add(i);
    if (chain.status === "BREAK" && chain.break_seq !== null) {
      const bi = records.findIndex((r) => r.seq === chain.break_seq);
      if (bi >= 0) {
        for (let i = Math.max(0, bi - 1); i <= Math.min(n - 1, bi + 1); i++) keep.add(i);
      }
    }

    if (n < NO_ELIDE_BELOW) {
      return records.map((rec, index) => ({ kind: "block", rec, index }) as Row);
    }

    const out: Row[] = [];
    let i = 0;
    while (i < n) {
      if (keep.has(i)) {
        out.push({ kind: "block", rec: records[i], index: i });
        i++;
      } else {
        // collapse a run of non-kept indices into a single elision marker.
        let j = i;
        while (j < n && !keep.has(j)) j++;
        out.push({ kind: "elision", count: j - i, key: `elide-${i}-${j}` });
        i = j;
      }
    }
    return out;
  }, [records, chain.status, chain.break_seq]);

  const n = records.length;
  const breakKind: BreakKind =
    chain.status === "BREAK" ? breakKindFromDetail(chain.detail) : "link";

  return (
    <ol
      className="flex flex-col"
      style={{ margin: 0, padding: 0, gap: 0 }}
      aria-label="evidence hash chain, oldest at top"
    >
      {rows.map((row) => {
        if (row.kind === "elision") {
          return <Elision key={row.key} count={row.count} />;
        }
        const { rec, index } = row;
        const state = blockStateFor(rec, index, n, chain);
        const prev = index > 0 ? records[index - 1] : null;
        const genesis = rec.seq === 0 || (index === 0 && rec.prev_hash === GENESIS_PREV_HASH);
        const expectedPrev = genesis ? null : (prev ? prev.hash : null);
        return (
          <ChainBlock
            key={rec.id}
            record={rec}
            state={state}
            expectedPrev={expectedPrev}
            genesis={genesis}
            breakKind={state === "break" ? breakKind : undefined}
            selected={rec.id === selectedId}
            onSelect={onSelect}
          />
        );
      })}
    </ol>
  );
}

/** A collapsed run of verified blocks (kept off-screen to stay dense). The
 *  dotted rail makes clear the chain is continuous through the hidden span. */
function Elision({ count }: { count: number }) {
  return (
    <li style={{ listStyle: "none" }} aria-label={`${count} verified records hidden`}>
      <div className="flex items-center gap-2" style={{ padding: "3px 9px 3px 2px" }}>
        <span
          aria-hidden
          style={{
            width: 3,
            height: 22,
            marginLeft: 5,
            borderRadius: 2,
            background:
              "repeating-linear-gradient(to bottom, var(--sev-ok) 0 2px, transparent 2px 6px)",
            opacity: 0.5,
          }}
        />
        <span className="micro" style={{ color: "var(--text-faint)" }}>
          ⋮ {count} 条已验证记录已折叠 · {count} verified link{count === 1 ? "" : "s"} hidden
        </span>
      </div>
    </li>
  );
}
