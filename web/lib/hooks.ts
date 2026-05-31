/**
 * lib/hooks.ts — React hooks over the audit store.
 *
 *   useSnapshot()      — fetches /api/snapshot for the active source/break and
 *                        hydrates the store; refetches when those change.
 *   useAuditStream()   — subscribes to /api/stream via EventSource, feeds the
 *                        store, and auto-reconnects with backoff.
 *   selectors          — useRecord(id), useVerdictsFor(id), useAggregates(),
 *                        useChainStatus(), useLag(), useSelectedRecord(),
 *                        useDataSource(), useStreamStatus(), useFlags(),
 *                        useScopeTampered().
 *
 * The dashboard page calls useSnapshot() + useAuditStream() once; panels use the
 * selectors. All client-side; the only network is to our own same-origin API.
 */

"use client";

import { useEffect, useMemo, useRef } from "react";
import { useAuditStore } from "./store.ts";
import type { AuditState, StreamStatus } from "./store.ts";
import type {
  Aggregates,
  AnalyzerLag,
  DataSource,
  EvidenceRecord,
  Snapshot,
  StreamMeta,
  VerdictRecord,
  VerifyResult,
} from "./types.ts";

/* ---- query-string helper shared by snapshot + stream ---- */
function sourceQuery(source: DataSource, breakAt: number | null, forced: boolean): string {
  const params = new URLSearchParams();
  // Until the user explicitly toggles, omit `source` so the SERVER auto-picks
  // (Live when data/evidence.jsonl is non-empty, else Demo). Forcing source=demo
  // on the first load would hide real captured data behind the bundled story.
  if (forced) params.set("source", source);
  // seq only matters in demo (BREAK injection); the live snapshot ignores it.
  if (breakAt !== null) params.set("seq", String(breakAt));
  return params.toString();
}

/**
 * Fetch the initial snapshot for the active (source, breakAt) and hydrate the
 * store. Re-runs whenever the user toggles source or the demo BREAK seq.
 */
export function useSnapshot(): { reload: () => void } {
  const source = useAuditStore((s) => s.dataSource);
  const breakAt = useAuditStore((s) => s.breakAt);
  const forced = useAuditStore((s) => s.sourceForced);
  const hydrate = useAuditStore((s) => s.hydrate);
  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/snapshot?${sourceQuery(source, breakAt, forced)}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const snap = (await res.json()) as Snapshot;
        if (!cancelled) hydrate(snap);
      } catch {
        /* offline / transient — the stream's meta will backfill */
      }
    };
    reloadRef.current = load;
    void load();
    return () => {
      cancelled = true;
    };
  }, [source, breakAt, forced, hydrate]);

  return { reload: () => reloadRef.current() };
}

/**
 * Subscribe to the SSE stream for the active (source, breakAt). Feeds evidence,
 * verdict, and meta events into the store; tracks connection status; reconnects
 * with capped backoff. Re-subscribes when source/break change.
 */
export function useAuditStream(): void {
  const source = useAuditStore((s) => s.dataSource);
  const breakAt = useAuditStore((s) => s.breakAt);
  const forced = useAuditStore((s) => s.sourceForced);
  const ingestEvidence = useAuditStore((s) => s.ingestEvidence);
  const ingestVerdict = useAuditStore((s) => s.ingestVerdict);
  const setMeta = useAuditStore((s) => s.setMeta);
  const setStreamStatus = useAuditStore((s) => s.setStreamStatus);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let retry = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      setStreamStatus("connecting");
      const url = `/api/stream?${sourceQuery(source, breakAt, forced)}`;
      es = new EventSource(url);

      es.addEventListener("open", () => {
        retry = 0;
        setStreamStatus("open");
      });

      es.addEventListener("evidence", (e) => {
        try {
          ingestEvidence(JSON.parse((e as MessageEvent).data) as EvidenceRecord);
        } catch {
          /* ignore malformed */
        }
      });

      es.addEventListener("verdict", (e) => {
        try {
          ingestVerdict(JSON.parse((e as MessageEvent).data) as VerdictRecord);
        } catch {
          /* ignore malformed */
        }
      });

      es.addEventListener("meta", (e) => {
        try {
          setMeta(JSON.parse((e as MessageEvent).data) as StreamMeta);
        } catch {
          /* ignore malformed */
        }
      });

      // `ping` events are keep-alive only; no handler needed.

      es.addEventListener("error", () => {
        if (closed) return;
        setStreamStatus("error");
        es?.close();
        es = null;
        // backoff: 0.5s, 1s, 2s, 4s, capped at 8s
        const delay = Math.min(8000, 500 * 2 ** retry);
        retry += 1;
        reconnectTimer = setTimeout(connect, delay);
      });
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      setStreamStatus("closed");
    };
  }, [source, breakAt, forced, ingestEvidence, ingestVerdict, setMeta, setStreamStatus]);
}

/* ============================================================================
   Selectors — thin, memo-friendly reads. Use these in panels.
   ========================================================================== */

export function useRecord(id: string | null | undefined): EvidenceRecord | undefined {
  return useAuditStore((s) => (id ? s.recordsById[id] : undefined));
}

const EMPTY_VERDICTS: VerdictRecord[] = [];
export function useVerdictsFor(id: string | null | undefined): VerdictRecord[] {
  return useAuditStore((s) => (id ? (s.verdictsByRecordId[id] ?? EMPTY_VERDICTS) : EMPTY_VERDICTS));
}

export function useAggregates(): Aggregates {
  return useAuditStore((s) => s.aggregates);
}

export function useChainStatus(): VerifyResult {
  return useAuditStore((s) => s.chainStatus);
}

export function useLag(): AnalyzerLag {
  return useAuditStore((s) => s.lag);
}

export function useRecords(): EvidenceRecord[] {
  return useAuditStore((s) => s.records);
}

export function useVerdicts(): VerdictRecord[] {
  return useAuditStore((s) => s.verdicts);
}

export function useSelectedRecordId(): string | null {
  return useAuditStore((s) => s.selectedRecordId);
}

export function useSelectedRecord(): EvidenceRecord | undefined {
  return useAuditStore((s) => (s.selectedRecordId ? s.recordsById[s.selectedRecordId] : undefined));
}

export function useDataSource(): DataSource {
  return useAuditStore((s) => s.dataSource);
}

export function useBreakAt(): number | null {
  return useAuditStore((s) => s.breakAt);
}

export function useStreamStatus(): StreamStatus {
  return useAuditStore((s) => s.streamStatus);
}

export function useHydrated(): boolean {
  return useAuditStore((s) => s.hydrated);
}

/** True when the chain is BREAK — the loud TAMPER state. Verdicts shown while
 *  this is true must be framed as untrustworthy (PHASE0.md §4). */
export function useScopeTampered(): boolean {
  return useAuditStore((s) => s.chainStatus.status === "BREAK");
}

/** All flagged verdicts (status === "flag"), newest first by record_seq.
 *
 *  The filter+sort is derived with useMemo over the stable `s.verdicts` ref
 *  rather than inside the zustand selector: a selector that returns a fresh
 *  array on every call makes useSyncExternalStore's snapshot change every render
 *  ("getServerSnapshot should be cached to avoid an infinite loop"). Selecting
 *  the stable array and memoizing the derivation keeps the snapshot stable and
 *  only recomputes when verdicts actually change. */
export function useFlags(): VerdictRecord[] {
  const verdicts = useAuditStore((s) => s.verdicts);
  return useMemo(
    () =>
      verdicts.filter((v) => v.status === "flag").sort((a, b) => b.record_seq - a.record_seq),
    [verdicts],
  );
}

/* ---- action accessors (for the TopBar toggle, drawer close, etc.) ---- */
export function useSelect(): AuditState["select"] {
  return useAuditStore((s) => s.select);
}
export function useSetSource(): AuditState["setSource"] {
  return useAuditStore((s) => s.setSource);
}
export function useSetBreakAt(): AuditState["setBreakAt"] {
  return useAuditStore((s) => s.setBreakAt);
}
