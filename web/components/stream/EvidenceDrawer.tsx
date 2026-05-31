/**
 * EvidenceDrawer — the right-side slide-over for the selected EvidenceRecord.
 *
 * Driven entirely by the store: useSelectedRecord() / useSelect(). Opening is a
 * row click in LiveStreamPanel (or any chain block) that calls select(id);
 * closing (Esc / scrim / ✕) calls select(null). The underlying Drawer primitive
 * handles focus-trap, Esc, scrim, and body-scroll-lock.
 *
 * Four sections, top to bottom:
 *   (1) Route + timing + capture — with UNTRUSTED fields explicitly tagged.
 *   (2) Integrity — <DigestRecompute/>: recompute sha256(canon(record)) in the
 *       BROWSER vs stored hash + prev_hash linkage. The signature trust feature.
 *   (3) Request & Response bodies — <BodyViewer/>: JSON / parsed SSE / redaction
 *       marks / base64 / truncated, encoding-aware.
 *   (4) Verdicts for this record — each via <VerdictDetail/> from the verdicts
 *       feature (cross-feature seam). If the chain is BREAK (tamper), a loud
 *       banner above the verdicts: they cannot be trusted.
 *
 * Client component.
 */

"use client";

import type { ReactNode } from "react";
import type { EvidenceRecord, VerdictRecord } from "@/lib/types";
import { CHECK_LABELS, UNTRUSTED_NOTE } from "@/lib/constants";
import {
  useSelectedRecord,
  useSelect,
  useVerdictsFor,
  useScopeTampered,
} from "@/lib/hooks";
import { Drawer } from "@/components/ui/Drawer";
import { ProviderChip } from "@/components/ui/ProviderChip";
import { StatusPill } from "@/components/ui/StatusPill";
import { StatusDot } from "@/components/ui/StatusDot";
import {
  fmtBytes,
  fmtClockMs,
  fmtInt,
  fmtMicros,
  fmtMicrosExact,
  fmtTokens,
} from "@/lib/format";
import { cn } from "@/lib/cn";

import { DigestRecompute } from "./DigestRecompute";
import { BodyViewer } from "./BodyViewer";
// Cross-feature seam: the verdicts feature owns the per-check detail renderer.
import { VerdictDetail } from "@/components/verdicts/VerdictDetail";

export default function EvidenceDrawer() {
  const record = useSelectedRecord();
  const select = useSelect();
  const open = record !== undefined;

  return (
    <Drawer
      open={open}
      onClose={() => select(null)}
      width={560}
      title={
        record ? (
          <span className="flex items-baseline gap-2">
            <span className="mono" style={{ color: "var(--accent)" }}>
              #{record.seq}
            </span>
            <span className="mono data-sm" style={{ color: "var(--text-dim)" }}>
              {record.route.method} {fmtPathLabel(record.route.path)}
            </span>
          </span>
        ) : (
          "evidence"
        )
      }
      subtitle={
        record ? (
          <span className="mono">
            {fmtClockMs(record.ts_start)} · id <span style={{ color: "var(--text-dim)" }}>{record.id}</span>
          </span>
        ) : undefined
      }
      actions={record ? <ProviderChip provider={record.route.provider} apiSurface={record.route.api_surface} /> : undefined}
    >
      {record && <DrawerBody record={record} />}
    </Drawer>
  );
}

/* Named export so the page seam (`import { EvidenceDrawer }`) resolves too. */
export { EvidenceDrawer };

/* ============================================================================
   Body
   ========================================================================== */

function DrawerBody({ record }: { record: EvidenceRecord }) {
  const verdicts = useVerdictsFor(record.id);
  const tampered = useScopeTampered();

  return (
    <div className="flex flex-col gap-4">
      {/* (1) Route + timing + capture */}
      <Section title="route · timing · capture" cjk="路由 · 时延 · 抓取">
        <RouteTimingCapture record={record} />
      </Section>

      {/* (2) Integrity — the in-browser digest recompute (killer feature) */}
      <Section
        title="integrity · digest recompute"
        cjk="完整性 · 哈希复算"
        accent
      >
        <DigestRecompute record={record} />
      </Section>

      {/* (3) Request body */}
      <Section title="request" cjk="请求">
        <BodyViewer kind="request" part={record.request} />
      </Section>

      {/* (3) Response body */}
      <Section
        title="response"
        cjk="响应"
        right={<ResponseMeta record={record} />}
      >
        <BodyViewer kind="response" part={record.response} stream={record.response.stream} />
      </Section>

      {/* (4) Verdicts */}
      <Section
        title="verdicts"
        cjk="裁决"
        right={
          <span className="micro mono" style={{ color: "var(--text-faint)" }}>
            {verdicts.length} check{verdicts.length === 1 ? "" : "s"}
          </span>
        }
      >
        {tampered && <TamperBanner />}
        <VerdictsList verdicts={verdicts} dimmed={tampered} />
      </Section>
    </div>
  );
}

/* ============================================================================
   (1) Route + timing + capture
   ========================================================================== */

function RouteTimingCapture({ record }: { record: EvidenceRecord }) {
  const { route, timing, capture, response } = record;
  return (
    <div className="flex flex-col gap-2.5">
      {/* route facts (provider/api_surface are classified by PATH, trustworthy;
          claimed_model is from the body → UNTRUSTED). */}
      <KVGrid>
        <KV k="upstream">
          <span className="mono data-sm" style={{ color: "var(--text)", wordBreak: "break-all" }}>
            {route.upstream}
          </span>
        </KV>
        <KV k="path">
          <span className="mono data-sm" style={{ color: "var(--text)", wordBreak: "break-all" }}>
            {route.path}
          </span>
        </KV>
        <KV k="claimed_model" untrusted>
          <span className="mono data-sm" style={{ color: "var(--text)" }}>
            {route.claimed_model ?? "—"}
          </span>
        </KV>
        <KV k="status">
          <span
            className="mono data-sm"
            style={{ color: response.status >= 400 ? "var(--sev-critical)" : "var(--text)" }}
          >
            {response.status}
          </span>
        </KV>
      </KVGrid>

      {/* timing (integer microseconds, rendered compact + exact-on-hover) */}
      <div>
        <div className="eyebrow mb-1">timing</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Metric label="ttft" value={fmtMicros(timing.ttft_us)} exact={fmtMicrosExact(timing.ttft_us)} />
          <Metric label="total" value={fmtMicros(timing.total_us)} exact={fmtMicrosExact(timing.total_us)} />
          <Metric
            label="connect"
            value={fmtMicros(timing.upstream_connect_us)}
            exact={fmtMicrosExact(timing.upstream_connect_us)}
          />
          <Metric label="chunks" value={fmtInt(timing.stream_chunks)} />
          <Metric label="conn" value={timing.conn_reused ? "reused" : "new"} />
        </div>
      </div>

      {/* capture health */}
      <div>
        <div className="eyebrow mb-1">capture</div>
        <div className="flex flex-wrap items-center gap-3">
          <CaptureFlag
            ok={capture.tee_ok}
            okLabel="tee_ok"
            badLabel="tee incomplete"
            badTone="warn"
            title={
              capture.tee_ok
                ? "capture complete"
                : "capture incomplete (overload drop / redaction / decode failure) — analyzers may skip"
            }
          />
          <CaptureFlag
            ok={!capture.client_disconnected}
            okLabel="client connected"
            badLabel="client disconnected"
            badTone="warn"
            title={capture.client_disconnected ? "client closed before completion" : "client stayed connected"}
          />
          <CaptureFlag
            ok={response.complete}
            okLabel="complete"
            badLabel="partial"
            badTone="warn"
            title={response.complete ? "saw clean EOF / [DONE]" : "partial capture — analyzers skip"}
          />
        </div>
        {capture.note && (
          <div className="micro mt-1" style={{ color: "var(--text-faint)" }}>
            note: {capture.note}
          </div>
        )}
      </div>
    </div>
  );
}

function ResponseMeta({ record }: { record: EvidenceRecord }) {
  const { response } = record;
  const u = response.claimed_usage;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {response.stream && (
        <span className="chip mono" style={{ color: "var(--accent)", borderColor: "var(--accent-dim)" }} title="streamed (SSE)">
          ⚡ stream
        </span>
      )}
      <span className="micro mono" style={{ color: "var(--text-faint)" }} title="response body size">
        {fmtBytes(response.bytes)}
      </span>
      {u && (
        <span
          className="micro mono"
          style={{ color: "var(--text-faint)" }}
          title={`${UNTRUSTED_NOTE.en} — billed usage as reported by the relay`}
        >
          ⚠ billed {fmtTokens(u.total_tokens)} tok
        </span>
      )}
    </div>
  );
}

/* ============================================================================
   (4) Verdicts
   ========================================================================== */

function VerdictsList({ verdicts, dimmed }: { verdicts: VerdictRecord[]; dimmed: boolean }) {
  if (verdicts.length === 0) {
    return (
      <div className="micro" style={{ color: "var(--text-faint)" }}>
        尚无裁决 · no verdicts derived for this record yet (analyzer may be behind).
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-2", dimmed && "is-tamper-dim")} style={dimmed ? { opacity: 0.62 } : undefined}>
      {verdicts.map((v) => (
        <div key={`${v.record_id}:${v.check}`} className="well p-2.5">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="data-sm" style={{ color: "var(--text)", fontWeight: 600 }}>
              {CHECK_LABELS[v.check]?.cjk ?? v.check}
            </span>
            <span className="micro mono" style={{ color: "var(--text-faint)" }}>
              {CHECK_LABELS[v.check]?.en ?? v.check}
            </span>
            <span className="ml-auto">
              <StatusPill status={v.status} severity={v.severity} />
            </span>
          </div>
          <VerdictDetail verdict={v} />
        </div>
      ))}
    </div>
  );
}

function TamperBanner() {
  return (
    <div
      className="tamper-pulse flex items-start gap-2 mb-2"
      style={{
        background: "var(--sev-tamper-bg)",
        border: "1px solid var(--sev-tamper-border)",
        borderRadius: "var(--r)",
        padding: "8px 10px",
      }}
      role="alert"
    >
      <StatusDot tone="tamper" pulse size={9} />
      <div className="min-w-0">
        <div className="data-sm" style={{ color: "var(--sev-tamper)", fontWeight: 700 }}>
          证据被篡改 — 以下裁决不可信
        </div>
        <div className="micro" style={{ color: "var(--text-dim)", lineHeight: 1.45 }}>
          EVIDENCE TAMPERED — the hash chain is BROKEN, so these verdicts cannot be
          trusted. They were derived from evidence that no longer verifies.
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   Shared layout bits
   ========================================================================== */

function Section({
  title,
  cjk,
  right,
  accent,
  children,
}: {
  title: string;
  cjk?: string;
  right?: ReactNode;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <section>
      <header
        className="flex items-center gap-2 mb-2 pb-1.5"
        style={{ borderBottom: "1px solid var(--line-soft)" }}
      >
        <span
          className="panel-title"
          style={{ fontSize: 13.5, color: accent ? "var(--accent)" : "var(--text)" }}
        >
          {title}
        </span>
        {cjk && (
          <span className="micro" style={{ color: "var(--text-faint)" }}>
            {cjk}
          </span>
        )}
        {right != null && <span className="ml-auto">{right}</span>}
      </header>
      {children}
    </section>
  );
}

function KVGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-1">{children}</div>;
}

function KV({
  k,
  untrusted,
  children,
}: {
  k: string;
  untrusted?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span
        className="micro mono shrink-0 flex items-center gap-1"
        style={{ color: "var(--text-faint)", minWidth: 120 }}
      >
        {k}
        {untrusted && (
          <span style={{ color: "var(--sev-warn)" }} title={UNTRUSTED_NOTE.en}>
            ⚠
          </span>
        )}
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Metric({ label, value, exact }: { label: string; value: string; exact?: string }) {
  return (
    <div className="flex flex-col" title={exact}>
      <span className="micro" style={{ color: "var(--text-faint)" }}>
        {label}
      </span>
      <span className="mono data-sm" style={{ color: "var(--text)" }}>
        {value}
      </span>
    </div>
  );
}

function CaptureFlag({
  ok,
  okLabel,
  badLabel,
  badTone,
  title,
}: {
  ok: boolean;
  okLabel: string;
  badLabel: string;
  badTone: "warn" | "critical";
  title?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <StatusDot tone={ok ? "ok" : badTone} size={6} />
      <span className="micro mono" style={{ color: ok ? "var(--text-dim)" : `var(--sev-${badTone})` }}>
        {ok ? okLabel : badLabel}
      </span>
    </span>
  );
}

/* drop a long query string from the path for the header label */
function fmtPathLabel(path: string): string {
  const q = path.indexOf("?");
  const base = q >= 0 ? path.slice(0, q) : path;
  return base;
}
