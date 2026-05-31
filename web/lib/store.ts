/**
 * lib/store.ts — the client-side audit store (zustand).
 *
 * Holds the evidence/verdict stream plus everything derived for the panels, and
 * the only mutating actions. Feature agents read state via the selector hooks in
 * lib/hooks.ts (preferred) or `useAuditStore(selector)` directly.
 *
 * Derivation policy: aggregates are RE-DERIVED from records+verdicts on every
 * ingest. A live console handles bounded volume, and re-derivation keeps the
 * StatRow/ChecksPanel honest with zero drift. Records/verdicts are capped to a
 * trailing window (MAX_RECORDS) so memory stays flat on long sessions; the
 * newest are always retained.
 *
 * Ordering: records are kept sorted by seq ascending (LiveStreamPanel can render
 * newest-first by reading from the end). Duplicate seqs/ids are de-duplicated
 * (a reconnect may re-deliver the tail).
 */

"use client";

import { create } from "zustand";
import { computeAggregates, emptyAggregates } from "./aggregate.ts";
import { GENESIS_PREV_HASH } from "./types.ts";
import type {
  Aggregates,
  AnalyzerLag,
  DataSource,
  EvidenceRecord,
  Snapshot,
  VerdictRecord,
  VerifyResult,
} from "./types.ts";

const MAX_RECORDS = 2000;

/** Connection state of the SSE feed, surfaced by the TopBar live dot. */
export type StreamStatus = "idle" | "connecting" | "open" | "closed" | "error";

export interface AuditState {
  /* ---- data ---- */
  records: EvidenceRecord[]; // sorted by seq asc
  verdicts: VerdictRecord[]; // insertion order
  /** record_id → record (fast lookup for the drawer / selectors). */
  recordsById: Record<string, EvidenceRecord>;
  /** record_id → verdicts for that record. */
  verdictsByRecordId: Record<string, VerdictRecord[]>;

  /* ---- derived ---- */
  aggregates: Aggregates;
  chainStatus: VerifyResult;
  lag: AnalyzerLag;

  /* ---- ui / meta ---- */
  selectedRecordId: string | null;
  dataSource: DataSource;
  /** if a demo BREAK is injected, the seq; else null. */
  breakAt: number | null;
  streamStatus: StreamStatus;
  /** whether the first snapshot has loaded. */
  hydrated: boolean;
  /** whether the user explicitly chose a source via the toggle. Until then the
   *  initial load omits ?source= so the server auto-picks Live (data present) or
   *  Demo (empty) — forcing demo on first load would hide real captured data. */
  sourceForced: boolean;

  /* ---- actions ---- */
  /** Replace everything from an initial /api/snapshot payload. */
  hydrate: (snapshot: Snapshot) => void;
  /** Ingest one streamed evidence record (de-duped, re-derives aggregates). */
  ingestEvidence: (rec: EvidenceRecord) => void;
  /** Ingest one streamed verdict (de-duped on id+check, re-derives aggregates). */
  ingestVerdict: (verdict: VerdictRecord) => void;
  /** Update chain status + lag + source from a `meta` SSE event. */
  setMeta: (meta: {
    chainStatus: VerifyResult;
    lag: AnalyzerLag;
    source?: DataSource;
    breakAt?: number | null;
  }) => void;
  /** Select an evidence record (opens the drawer); null closes it. */
  select: (id: string | null) => void;
  /** Switch the active data source. Clears data so the next snapshot repaints. */
  setSource: (source: DataSource) => void;
  /** Set demo BREAK injection seq (null = none). UI-only; refetch drives data. */
  setBreakAt: (seq: number | null) => void;
  /** Set SSE connection status. */
  setStreamStatus: (status: StreamStatus) => void;
  /** Reset to an empty store (e.g. before switching source). */
  reset: () => void;
}

const EMPTY_CHAIN: VerifyResult = {
  status: "EMPTY",
  records: 0,
  break_seq: null,
  detail: "",
  warnings: [],
  head_hash: GENESIS_PREV_HASH,
};

const EMPTY_LAG: AnalyzerLag = {
  last_processed_seq: -1,
  evidence_head_seq: -1,
  lag_records: 0,
  updated_at: null,
};

/** Rebuild the id indices + capped record window from scratch. */
function reindex(records: EvidenceRecord[], verdicts: VerdictRecord[]) {
  // sort + cap (keep newest by seq)
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  const capped =
    sorted.length > MAX_RECORDS ? sorted.slice(sorted.length - MAX_RECORDS) : sorted;

  const recordsById: Record<string, EvidenceRecord> = {};
  for (const r of capped) recordsById[r.id] = r;

  const verdictsByRecordId: Record<string, VerdictRecord[]> = {};
  for (const v of verdicts) {
    (verdictsByRecordId[v.record_id] ??= []).push(v);
  }

  return { capped, recordsById, verdictsByRecordId };
}

export const useAuditStore = create<AuditState>((set, get) => ({
  records: [],
  verdicts: [],
  recordsById: {},
  verdictsByRecordId: {},
  aggregates: emptyAggregates(),
  chainStatus: EMPTY_CHAIN,
  lag: EMPTY_LAG,
  selectedRecordId: null,
  dataSource: "demo",
  breakAt: null,
  streamStatus: "idle",
  hydrated: false,
  sourceForced: false,

  hydrate: (snapshot) => {
    const { capped, recordsById, verdictsByRecordId } = reindex(
      snapshot.records,
      snapshot.verdicts,
    );
    set({
      records: capped,
      verdicts: snapshot.verdicts,
      recordsById,
      verdictsByRecordId,
      aggregates: snapshot.aggregates ?? computeAggregates(capped, snapshot.verdicts),
      chainStatus: snapshot.chainStatus,
      lag: snapshot.lag,
      dataSource: snapshot.source,
      breakAt: snapshot.breakAt ?? null,
      hydrated: true,
    });
  },

  ingestEvidence: (rec) => {
    const state = get();
    if (state.recordsById[rec.id]) return; // de-dupe
    // insert keeping seq order (append is the common case)
    const records = state.records;
    let records2: EvidenceRecord[];
    if (records.length === 0 || rec.seq >= records[records.length - 1].seq) {
      records2 = [...records, rec];
    } else {
      records2 = [...records, rec].sort((a, b) => a.seq - b.seq);
    }
    const { capped, recordsById, verdictsByRecordId } = reindex(records2, state.verdicts);
    set({
      records: capped,
      recordsById,
      verdictsByRecordId,
      aggregates: computeAggregates(capped, state.verdicts),
    });
  },

  ingestVerdict: (verdict) => {
    const state = get();
    const existing = state.verdictsByRecordId[verdict.record_id] ?? [];
    if (existing.some((v) => v.check === verdict.check)) return; // de-dupe per (record, check)
    const verdicts = [...state.verdicts, verdict];
    const verdictsByRecordId = {
      ...state.verdictsByRecordId,
      [verdict.record_id]: [...existing, verdict],
    };
    set({
      verdicts,
      verdictsByRecordId,
      aggregates: computeAggregates(state.records, verdicts),
    });
  },

  setMeta: (meta) =>
    set((state) => ({
      chainStatus: meta.chainStatus ?? state.chainStatus,
      lag: meta.lag ?? state.lag,
      dataSource: meta.source ?? state.dataSource,
      breakAt: meta.breakAt !== undefined ? meta.breakAt : state.breakAt,
    })),

  select: (id) => set({ selectedRecordId: id }),

  setSource: (source) =>
    set({
      dataSource: source,
      sourceForced: true,
      // clear data so the next snapshot repaints cleanly
      records: [],
      verdicts: [],
      recordsById: {},
      verdictsByRecordId: {},
      aggregates: emptyAggregates(),
      chainStatus: EMPTY_CHAIN,
      lag: EMPTY_LAG,
      selectedRecordId: null,
      hydrated: false,
    }),

  setBreakAt: (seq) => set({ breakAt: seq }),

  setStreamStatus: (status) => set({ streamStatus: status }),

  reset: () =>
    set({
      records: [],
      verdicts: [],
      recordsById: {},
      verdictsByRecordId: {},
      aggregates: emptyAggregates(),
      chainStatus: EMPTY_CHAIN,
      lag: EMPTY_LAG,
      selectedRecordId: null,
      breakAt: null,
      sourceForced: false,
      hydrated: false,
    }),
}));
