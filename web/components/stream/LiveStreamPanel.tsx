/**
 * LiveStreamPanel — the live, newest-first evidence stream (the large left
 * panel of the console). A compact, dense, mono table of EvidenceRecords from
 * the store; new rows fade/slide in; clicking a row opens the EvidenceDrawer.
 *
 * Columns (machine data in mono + tabular-nums):
 *   seq · time (HH:MM:SS.mmm) · method+path · provider · claimed_model (UNTRUSTED)
 *   · status · stream (⚡) · ttft/total · bytes · billed total tokens (UNTRUSTED)
 *   · capture health (tee/disconnect dots) · verdict severity (worst across the
 *     record's verdicts; skip/none = neutral, never red).
 *
 * Keyboard: ↑/↓ move the selection (and open the drawer on the focused row);
 * Esc closes the drawer. Selection is the store's selectedRecordId so it stays
 * in sync with the drawer.
 *
 * Honest-boundary: claimed_model and billed tokens are tagged UNTRUSTED; skip
 * verdicts render muted (never red); a chain BREAK adds a quiet per-table note
 * (the loud tamper state lives in TopBar/ChainPanel/Drawer).
 *
 * Client component.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { EvidenceRecord, Severity, VerdictRecord } from "@/lib/types";
import {
  useRecords,
  useSelect,
  useSelectedRecordId,
  useStreamStatus,
  useDataSource,
  useScopeTampered,
} from "@/lib/hooks";
import { useAuditStore } from "@/lib/store";
import type { AuditState } from "@/lib/store";
import { Panel } from "@/components/ui/Panel";
import { ProviderChip } from "@/components/ui/ProviderChip";
import { StatusPill } from "@/components/ui/StatusPill";
import { StatusDot } from "@/components/ui/StatusDot";
import { SeverityBadge } from "@/components/ui/SeverityBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { fmtBytes, fmtClockMs, fmtMicros, fmtMicrosExact, fmtPath, fmtTokens } from "@/lib/format";
import { cn } from "@/lib/cn";

/* ---- worst severity across a record's verdicts (skip/ok don't count) ---- */
const SEV_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };
function worstFlagSeverity(verdicts: VerdictRecord[]): Severity | null {
  let worst: Severity | null = null;
  for (const v of verdicts) {
    if (v.status !== "flag") continue;
    if (worst === null || SEV_RANK[v.severity] > SEV_RANK[worst]) worst = v.severity;
  }
  return worst;
}

export default function LiveStreamPanel() {
  // newest-first for display; the store keeps seq-ascending.
  const ascending = useRecords();
  const rows = useMemo(() => [...ascending].reverse(), [ascending]);
  const verdictsByRecordId = useAuditStore((s: AuditState) => s.verdictsByRecordId);

  const selectedId = useSelectedRecordId();
  const select = useSelect();
  const streamStatus = useStreamStatus();
  const source = useDataSource();
  const tampered = useScopeTampered();

  const scrollRef = useRef<HTMLDivElement>(null);

  // Keyboard navigation over the (newest-first) visible order.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedId) {
          e.preventDefault();
          select(null);
        }
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (rows.length === 0) return;
      e.preventDefault();
      const idx = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1;
      let next: number;
      if (idx === -1) {
        next = e.key === "ArrowDown" ? 0 : rows.length - 1;
      } else {
        next = e.key === "ArrowDown" ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
      }
      select(rows[next].id);
    },
    [rows, selectedId, select],
  );

  // Keep the selected row in view when it changes (e.g. via keyboard).
  useEffect(() => {
    if (!selectedId || !scrollRef.current) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-row-id="${cssEscape(selectedId)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const live = streamStatus === "open";

  return (
    <Panel
      title={
        <span className="flex items-baseline gap-2">
          证据流
          <span className="micro" style={{ color: "var(--text-faint)" }}>
            live evidence stream
          </span>
        </span>
      }
      flush
      className="min-h-[320px]"
      actions={
        <div className="flex items-center gap-3">
          {tampered && (
            <span
              className="micro mono"
              style={{ color: "var(--sev-tamper)" }}
              title="hash chain is BROKEN — rows below are evidence that no longer verifies"
            >
              ⚠ chain BREAK
            </span>
          )}
          <span className="micro mono" style={{ color: "var(--text-faint)" }}>
            {rows.length} rec
          </span>
          <span className="inline-flex items-center gap-1.5">
            <StatusDot
              tone={live ? "accent" : streamStatus === "error" ? "warn" : "idle"}
              pulse={live}
              size={7}
              title={`tail: ${streamStatus}`}
            />
            <span className="micro mono" style={{ color: "var(--text-faint)" }}>
              {source}
            </span>
          </span>
        </div>
      }
    >
      {rows.length === 0 ? (
        <div className="p-3">
          <EmptyState
            glyph="⌗"
            title={source === "live" ? "等待证据 · awaiting evidence" : "暂无记录 · no records"}
            hint={
              source === "live"
                ? "本地直读 ./data/evidence.jsonl — 代理一旦记录请求，新行将自动出现。"
                : "Demo source is empty — toggle a data source in the top bar."
            }
            compact
          />
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="overflow-auto"
          style={{ maxHeight: "min(58vh, 720px)" }}
          role="grid"
          aria-label="evidence stream"
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          <table className="table-dense">
            <thead>
              <tr>
                <Th className="text-right">seq</Th>
                <Th>time</Th>
                <Th>method · path</Th>
                <Th>provider</Th>
                <Th>model*</Th>
                <Th>status</Th>
                <Th className="text-right">ttft / total</Th>
                <Th className="text-right">bytes</Th>
                <Th className="text-right">tok*</Th>
                <Th>cap</Th>
                <Th>chk</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((rec) => (
                <Row
                  key={rec.id}
                  rec={rec}
                  selected={rec.id === selectedId}
                  worst={worstFlagSeverity(verdictsByRecordId[rec.id] ?? [])}
                  verdictCount={(verdictsByRecordId[rec.id] ?? []).length}
                  onSelect={() => select(rec.id === selectedId ? null : rec.id)}
                />
              ))}
            </tbody>
          </table>
          {/* footer honest note: model + tokens are relay-reported */}
          <div
            className="micro px-3 py-1.5"
            style={{ color: "var(--text-ghost)", borderTop: "1px solid var(--line-soft)" }}
          >
            * model &amp; tok 由中转站自报，可伪造 · claimed_model and billed tokens are
            UNTRUSTED (relay-reported, forgeable). chk = worst verdict severity.
          </div>
        </div>
      )}
    </Panel>
  );
}

/* Named export so the page seam (`import { LiveStreamPanel }`) resolves too. */
export { LiveStreamPanel };

/* ============================================================================
   Row
   ========================================================================== */

function Row({
  rec,
  selected,
  worst,
  verdictCount,
  onSelect,
}: {
  rec: EvidenceRecord;
  selected: boolean;
  worst: Severity | null;
  verdictCount: number;
  onSelect: () => void;
}) {
  const { route, response, timing, capture } = rec;
  const billed = response.claimed_usage?.total_tokens ?? null;
  const captureBad = !capture.tee_ok || capture.client_disconnected || !response.complete;

  return (
    <tr
      data-selected={selected}
      data-row-id={rec.id}
      onClick={onSelect}
      className="row-in"
      style={{ cursor: "pointer" }}
      role="row"
      aria-selected={selected}
    >
      {/* seq */}
      <td className="text-right">
        <span className="mono" style={{ color: "var(--accent)" }}>
          {rec.seq}
        </span>
      </td>

      {/* time HH:MM:SS.mmm */}
      <td>
        <span className="mono data-sm" style={{ color: "var(--text-dim)" }}>
          {fmtClockMs(rec.ts_start)}
        </span>
      </td>

      {/* method + path */}
      <td style={{ maxWidth: 230 }}>
        <span className="inline-flex items-baseline gap-1.5 min-w-0">
          <span className="mono data-sm" style={{ color: "var(--text-faint)" }}>
            {route.method}
          </span>
          <span
            className="mono data-sm truncate-ellipsis"
            style={{ color: "var(--text)", maxWidth: 180, display: "inline-block", verticalAlign: "bottom" }}
            title={route.path}
          >
            {fmtPath(route.path)}
          </span>
        </span>
      </td>

      {/* provider chip */}
      <td>
        <ProviderChip provider={route.provider} />
      </td>

      {/* claimed_model — UNTRUSTED */}
      <td style={{ maxWidth: 150 }}>
        <span
          className="mono data-sm truncate-ellipsis"
          style={{ color: "var(--text-dim)", maxWidth: 150, display: "inline-block" }}
          title={route.claimed_model ? `${route.claimed_model} · UNTRUSTED (relay-reported)` : "—"}
        >
          {route.claimed_model ?? "—"}
        </span>
      </td>

      {/* HTTP status */}
      <td>
        <span
          className="mono data-sm"
          style={{ color: response.status >= 400 ? "var(--sev-critical)" : "var(--text-dim)" }}
        >
          {response.status}
          {response.stream && (
            <span style={{ color: "var(--accent)", marginLeft: 4 }} title="streamed (SSE)">
              ⚡
            </span>
          )}
        </span>
      </td>

      {/* ttft / total (µs → compact) */}
      <td className="text-right">
        <span
          className="mono data-sm"
          style={{ color: "var(--text-dim)" }}
          title={`ttft ${fmtMicrosExact(timing.ttft_us)} · total ${fmtMicrosExact(timing.total_us)}`}
        >
          {timing.ttft_us !== null ? `${fmtMicros(timing.ttft_us)} / ` : ""}
          {fmtMicros(timing.total_us)}
        </span>
      </td>

      {/* response bytes */}
      <td className="text-right">
        <span className="mono data-sm" style={{ color: "var(--text-faint)" }}>
          {fmtBytes(response.bytes)}
        </span>
      </td>

      {/* billed total tokens — UNTRUSTED */}
      <td className="text-right">
        <span
          className="mono data-sm"
          style={{ color: billed === null ? "var(--text-ghost)" : "var(--text-dim)" }}
          title={billed === null ? "no usage reported" : `${fmtTokens(billed)} billed · UNTRUSTED`}
        >
          {billed === null ? "—" : fmtTokens(billed)}
        </span>
      </td>

      {/* capture health */}
      <td>
        {captureBad ? (
          <span className="inline-flex items-center gap-1" title={captureNote(rec)}>
            <StatusDot tone="warn" size={6} />
            <span className="micro mono" style={{ color: "var(--sev-warn)" }}>
              {!capture.tee_ok ? "tee" : capture.client_disconnected ? "disc" : "part"}
            </span>
          </span>
        ) : (
          <StatusDot tone="ok" size={6} title="capture complete" />
        )}
      </td>

      {/* worst verdict severity (skip/none = neutral, never red) */}
      <td>
        <VerdictCell worst={worst} count={verdictCount} />
      </td>
    </tr>
  );
}

function VerdictCell({ worst, count }: { worst: Severity | null; count: number }) {
  if (count === 0) {
    return (
      <StatusDot tone="idle" size={6} title="no verdicts yet (analyzer may be behind)" />
    );
  }
  if (worst === null) {
    // all ok/skip within scope — calm, NOT a green "verified/safe" claim
    return (
      <span title="Phase 0 范围内无 flag — not 'genuine/safe'">
        <StatusPill status="ok" />
      </span>
    );
  }
  return <SeverityBadge severity={worst} variant="dot" />;
}

/* ============================================================================
   helpers
   ========================================================================== */

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={cn(className)}>{children}</th>;
}

function captureNote(rec: EvidenceRecord): string {
  const parts: string[] = [];
  if (!rec.capture.tee_ok) parts.push("tee incomplete (capture failure)");
  if (rec.capture.client_disconnected) parts.push("client disconnected");
  if (!rec.response.complete) parts.push("partial capture (no clean EOF/[DONE])");
  if (rec.capture.note) parts.push(rec.capture.note);
  return parts.join(" · ") || "capture complete";
}

/** Minimal CSS.escape fallback for attribute selectors (uuid ids are safe, but
 *  guard against environments without CSS.escape). */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}
