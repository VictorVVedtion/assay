/**
 * MetricsPanel — the forensic "charts" region of the assay console.
 *
 * Composes several small, hand-rolled SVG charts (NO chart library — zero deps,
 * reproducible, matching the project's minimal-deps ethos) over the live store:
 *
 *   1. TOKEN HONESTY (signature) — billed vs independently-recomputed completion
 *      tokens for eligible token_recount verdicts, as DIVERGING per-record bars
 *      around a center "honest" axis (recomputed == billed). Bar to the RIGHT =
 *      visible exceeds billed (CRITICAL, impossible if honest); to the LEFT =
 *      billed exceeds visible (possible inflation, WARN). Diverging bars (not a
 *      shared-axis scatter) so a 2→21 over-claim isn't crushed beside a 240→9
 *      inflation. estimate_only rows are hollow — reasoning/tool responses
 *      legitimately bill hidden tokens, so the deviation is NOT an accusation.
 *      Skips are excluded entirely.
 *   2. THROUGHPUT / TIMING — tokens/s and TTFT over the captured stream, drawn as
 *      zero-anchored areas. Telemetry ONLY: tokens/s measured through the proxy
 *      reflects RELAY pacing, not model decode speed (the dashed line is the
 *      physical ceiling, the only basis for a flag).
 *   3. PROVIDER MIX — a compact stacked bar + counts (classified by request path).
 *   4. PROVENANCE — average score/max per upstream as gauges, with the forgeable
 *      caveat: a high score is "consistent with genuine", never "proven genuine".
 *   5. EXPOSURE — a LOWER-BOUND egress counter (secrets / PII / code) summed
 *      across records. Always "下界 / at least N"; measured, not prevented;
 *      0 detected ≠ safe. Never a risk score, never a gauge.
 *
 * All charts degrade gracefully with little/no data and use the design tokens
 * (strong color only where a severity warrants it).
 */

"use client";

import { useMemo } from "react";
import { Panel, ProviderChip, GaugeBar, EmptyState } from "@/components/ui";
import { PROVIDER_META } from "@/lib/constants";
import { fmtMicros, fmtTps, fmtInt } from "@/lib/format";
import { isCheck } from "@/lib/types";
import type {
  EvidenceRecord,
  Provider,
  VerdictRecord,
} from "@/lib/types";
import { useRecords, useVerdicts, useAggregates } from "@/lib/hooks";
import { cn } from "@/lib/cn";

import { DeltaBars, type DeltaRow } from "./charts/DeltaBars.tsx";
import { Bars, type BarSegment } from "./charts/Bars.tsx";
import { MiniArea } from "./charts/MiniArea.tsx";

/* ---- design tokens reused inline (kept in one place) ---- */
const C_OK = "var(--sev-ok)";
const C_WARN = "var(--sev-warn)";
const C_CRIT = "var(--sev-critical)";
const C_ACCENT = "var(--accent)";

const PROVIDER_ORDER: Provider[] = ["openai", "anthropic", "gemini", "unknown"];

/* A small labeled sub-section within the panel body. */
function Section({
  title,
  hint,
  aside,
  children,
  className,
}: {
  title: string;
  hint?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline gap-2">
        <span className="eyebrow">{title}</span>
        {aside != null && <span className="ml-auto">{aside}</span>}
      </div>
      {children}
      {hint != null && (
        <p className="micro" style={{ color: "var(--text-faint)", lineHeight: 1.45 }}>
          {hint}
        </p>
      )}
    </section>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "var(--line-soft)" }} aria-hidden />;
}

/* A tiny legend swatch (dot or hollow ring). */
function Swatch({ color, hollow, label }: { color: string; hollow?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 micro" style={{ color: "var(--text-faint)" }}>
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          flex: "none",
          background: hollow ? "transparent" : color,
          border: `1.4px ${hollow ? "dashed" : "solid"} ${color}`,
        }}
      />
      {label}
    </span>
  );
}

/* ============================================================================
   1. Token honesty — the signature scatter.
   ========================================================================== */

interface TokenHonesty {
  rows: DeltaRow[];
  eligible: number;
  flagged: number;
  estimateOnly: number;
  /** symmetric % domain for the diverging bars. */
  domain: number;
}

/** signed % deviation: >0 ⇒ recomputed (visible) exceeds billed (right, critical);
 *  <0 ⇒ billed exceeds visible (left, possible inflation). */
function signedDeltaPct(
  claimed: number,
  recomputed: number,
  detailPct: number | null | undefined,
): number {
  if (typeof detailPct === "number") return detailPct;
  if (claimed > 0) return (100 * (recomputed - claimed)) / claimed;
  // claimed 0 with any visible text is an over-claim; show a full-right bar.
  return recomputed > 0 ? 100 : 0;
}

function useTokenHonesty(verdicts: VerdictRecord[]): TokenHonesty {
  return useMemo(() => {
    const rows: DeltaRow[] = [];
    let eligible = 0;
    let flagged = 0;
    let estimateOnly = 0;
    // Bars encode the SIGNED % deviation, but the % is unbounded when billed is
    // near zero (a 2→21 over-claim is +950%). Cap the visual domain at 100% so
    // an over-claim and an inflation read at comparable, large size; the EXACT
    // token counts live in each row's label + tooltip, so no information is lost.
    const DOMAIN_CAP = 100;

    for (const v of verdicts) {
      if (!isCheck(v, "token_recount")) continue;
      if (v.status === "skip" || v.status === "error") continue; // skips excluded
      const d = v.detail;
      const claimed = d.claimed?.completion;
      const recomputed = d.recomputed?.completion;
      if (
        d.eligible !== true ||
        claimed === null ||
        claimed === undefined ||
        recomputed === null ||
        recomputed === undefined
      ) {
        continue;
      }
      eligible += 1;
      const est = d.estimate_only === true;
      if (est) estimateOnly += 1;
      const isFlag = v.status === "flag";
      if (isFlag) flagged += 1;

      const pct = signedDeltaPct(claimed, recomputed, d.completion_delta_pct);

      // color faithful to the check semantics:
      //   recomputed > claimed (pct>0) → visible exceeds billed → critical
      //   flagged inflation (severity warn) → warn
      //   else within tolerance → calm ok
      let color = C_OK;
      if (v.severity === "critical" || recomputed > claimed) color = C_CRIT;
      else if (v.severity === "warn") color = C_WARN;

      const sign = recomputed - claimed > 0 ? "+" : "";
      rows.push({
        id: v.record_id + ":tr",
        label: `seq ${v.record_seq} ${d.api_surface === "responses" ? "resp" : "chat"}`,
        value: pct,
        valueText: `${claimed}→${recomputed}`,
        color,
        hollow: est,
        title:
          `seq ${v.record_seq} · ${d.provider}/${d.api_surface}\n` +
          `billed ${claimed} → recomputed ${recomputed} (${sign}${recomputed - claimed} tok)` +
          (est ? `\nestimate-only: ${d.estimate_reasons?.join(", ") || "hidden tokens"}` : "") +
          `\n${v.summary}`,
      });
    }
    // sort most-deviant first so the eye lands on the catch.
    rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    return { rows, eligible, flagged, estimateOnly, domain: DOMAIN_CAP };
  }, [verdicts]);
}

function TokenHonestySection({ data }: { data: TokenHonesty }) {
  const { rows, eligible, flagged, estimateOnly, domain } = data;
  return (
    <Section
      title="Token honesty · 用量诚实度"
      aside={
        <span className="mono data-sm" style={{ color: flagged ? C_WARN : "var(--text-faint)" }}>
          {eligible} eligible{flagged > 0 ? ` · ${flagged} flagged` : ""}
        </span>
      }
      hint="中线 = 诚实 (recomputed=billed). 右侧=可见超出计费 (不可能,critical);左侧=计费远超可见 (可能虚报,warn). 空心条=估算 (推理/工具隐藏 token,非指控). 仅 OpenAI chat 可算;Claude/Gemini skip 不在此图。右栏 = billed→recomputed。"
    >
      {eligible === 0 ? (
        <EmptyState
          compact
          glyph="∅"
          title="无可重算用量 / nothing recomputable yet"
          hint="token_recount 仅对 OpenAI chat 生效;其余 skip。"
        />
      ) : (
        <>
          <div className="flex justify-between micro" style={{ color: "var(--text-ghost)" }}>
            <span>← billed ≫ visible (inflation)</span>
            <span>visible &gt; billed →</span>
          </div>
          <DeltaBars
            rows={rows}
            domain={domain}
            rowHeight={19}
            ariaLabel="signed completion-token deviation per eligible record"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Swatch color={C_OK} label="within tolerance" />
            <Swatch color={C_CRIT} label="visible > billed" />
            <Swatch color={C_WARN} label="billed ≫ visible" />
            <Swatch color="var(--text-faint)" hollow label={`estimate-only (${estimateOnly})`} />
          </div>
        </>
      )}
    </Section>
  );
}

/* ============================================================================
   2. Throughput / timing — telemetry only.
   ========================================================================== */

interface ThroughputData {
  tps: number[];
  ceiling: number | null;
  ttft: number[];
  flagged: number;
  count: number;
  lastTps: number | null;
  lastTtft: number | null;
}

function useThroughput(records: EvidenceRecord[], verdicts: VerdictRecord[]): ThroughputData {
  return useMemo(() => {
    // tokens/s from throughput verdicts (ok or flag), in record_seq order.
    const tpRows = verdicts
      .filter((v): v is Extract<VerdictRecord, { check: "throughput" }> =>
        isCheck(v, "throughput"),
      )
      .filter((v) => v.status === "ok" || v.status === "flag")
      .sort((a, b) => a.record_seq - b.record_seq);

    const tps: number[] = [];
    let ceiling: number | null = null;
    let flagged = 0;
    for (const v of tpRows) {
      const t = v.detail.tokens_per_s;
      if (typeof t === "number") tps.push(t);
      if (typeof v.detail.ceiling_tps === "number") ceiling = v.detail.ceiling_tps;
      if (v.status === "flag") flagged += 1;
    }

    // TTFT from streamed, complete records (ttft_us present), in seq order.
    const ttft = records
      .filter((r) => r.response.stream && r.timing.ttft_us !== null)
      .sort((a, b) => a.seq - b.seq)
      .map((r) => r.timing.ttft_us as number);

    return {
      tps,
      ceiling,
      ttft,
      flagged,
      count: tpRows.length,
      lastTps: tps.length ? tps[tps.length - 1] : null,
      lastTtft: ttft.length ? ttft[ttft.length - 1] : null,
    };
  }, [records, verdicts]);
}

function ThroughputSection({ data }: { data: ThroughputData }) {
  const { tps, ceiling, ttft, flagged, lastTps, lastTtft } = data;
  const hasTps = tps.length > 0;
  const hasTtft = ttft.length > 0;
  return (
    <Section
      title="Throughput / timing · 吞吐遥测"
      hint="仅遥测 / telemetry only. tok/s 反映中转站节流而非模型解码速度;仅当超过物理上限 (虚线) 才会 flag。"
    >
      {!hasTps && !hasTtft ? (
        <EmptyState
          compact
          glyph="〜"
          title="无流式时序 / no streamed timing yet"
          hint="非流式响应无 TTFT;吞吐对其 skip。"
        />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-baseline justify-between gap-1">
              <span className="micro" style={{ color: "var(--text-faint)" }}>
                tokens/s
              </span>
              <span
                className="mono data-sm tnum"
                style={{ color: flagged ? C_WARN : "var(--text-dim)" }}
              >
                {lastTps != null ? fmtTps(lastTps) : "—"}
              </span>
            </div>
            <MiniArea
              data={tps}
              height={42}
              color={flagged ? C_WARN : C_ACCENT}
              reference={ceiling}
              referenceColor={C_CRIT}
              ariaLabel="tokens per second over the captured stream"
            />
            <span className="micro" style={{ color: "var(--text-ghost)" }}>
              {ceiling != null ? `ceiling ${fmtInt(ceiling)} tok/s` : "no ceiling"}
            </span>
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-baseline justify-between gap-1">
              <span className="micro" style={{ color: "var(--text-faint)" }}>
                TTFT
              </span>
              <span className="mono data-sm tnum" style={{ color: "var(--text-dim)" }}>
                {lastTtft != null ? fmtMicros(lastTtft) : "—"}
              </span>
            </div>
            <MiniArea
              data={ttft}
              height={42}
              color={C_ACCENT}
              markLast
              ariaLabel="time to first token over streamed records"
            />
            <span className="micro" style={{ color: "var(--text-ghost)" }}>
              first-byte latency
            </span>
          </div>
        </div>
      )}
    </Section>
  );
}

/* ============================================================================
   3. Provider mix — stacked bar + counts.
   ========================================================================== */

interface SurfaceCount {
  surface: string;
  count: number;
}

function ProviderSection() {
  const aggregates = useAggregates();
  const records = useRecords();
  const mix = aggregates.provider_mix;
  const total = aggregates.total_requests;

  const segments: BarSegment[] = PROVIDER_ORDER.map((p) => ({
    label: p,
    value: mix[p] ?? 0,
    color: `var(${PROVIDER_META[p].colorVar})`,
  }));

  const surfaces = useMemo<SurfaceCount[]>(() => {
    const m = new Map<string, number>();
    for (const r of records) {
      const s = r.route.api_surface;
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([surface, count]) => ({ surface, count }))
      .sort((a, b) => b.count - a.count);
  }, [records]);

  return (
    <Section
      title="Provider mix · 上游分布"
      aside={
        <span className="mono data-sm" style={{ color: "var(--text-faint)" }}>
          {fmtInt(total)} req
        </span>
      }
      hint="按请求路径分类 (非 model 字串)。"
    >
      {total === 0 ? (
        <EmptyState compact glyph="◫" title="无请求 / no requests yet" />
      ) : (
        <>
          <Bars segments={segments} height={12} ariaLabel="provider mix" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-0.5">
            {PROVIDER_ORDER.filter((p) => (mix[p] ?? 0) > 0).map((p) => (
              <span key={p} className="inline-flex items-center gap-1.5">
                <ProviderChip provider={p} />
                <span className="mono data-sm tnum" style={{ color: "var(--text-dim)" }}>
                  {mix[p]}
                </span>
              </span>
            ))}
          </div>
          {surfaces.length > 0 && (
            <div className="flex flex-wrap gap-x-2.5 gap-y-1 mt-1">
              {surfaces.map((s) => (
                <span
                  key={s.surface}
                  className="mono data-sm"
                  style={{ color: "var(--text-faint)" }}
                  title="api_surface (request path)"
                >
                  {s.surface}
                  <span style={{ color: "var(--text-dim)" }}> {s.count}</span>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/* ============================================================================
   4. Provenance — average score/max per upstream, with the forgeable caveat.
   ========================================================================== */

interface ProvRow {
  upstream: string;
  avg: number;
  max: number;
  n: number;
  hasFlag: boolean;
  zero: number; // count of score==0 (suspected masquerade)
}

function useProvenance(verdicts: VerdictRecord[]): ProvRow[] {
  return useMemo(() => {
    const acc = new Map<
      string,
      { sumScore: number; maxScore: number; n: number; hasFlag: boolean; zero: number }
    >();
    for (const v of verdicts) {
      if (!isCheck(v, "provenance")) continue;
      if (v.status === "skip" || v.status === "error") continue; // no signature lib → exclude
      const d = v.detail;
      if (typeof d.score !== "number" || typeof d.max_score !== "number") continue;
      const key = d.expected_upstream || "unknown";
      const cur = acc.get(key) ?? { sumScore: 0, maxScore: 0, n: 0, hasFlag: false, zero: 0 };
      cur.sumScore += d.score;
      cur.maxScore = Math.max(cur.maxScore, d.max_score);
      cur.n += 1;
      if (v.status === "flag") cur.hasFlag = true;
      if (d.score === 0) cur.zero += 1;
      acc.set(key, cur);
    }
    return [...acc.entries()]
      .map(([upstream, a]) => ({
        upstream,
        avg: a.n ? a.sumScore / a.n : 0,
        max: a.maxScore,
        n: a.n,
        hasFlag: a.hasFlag,
        zero: a.zero,
      }))
      .sort((a, b) => b.n - a.n);
  }, [verdicts]);
}

function ProvenanceSection({ rows }: { rows: ProvRow[] }) {
  return (
    <Section
      title="Provenance score · 上游来源"
      hint="平均 score/max,按声称上游。标记可伪造 → 高分=「与真上游一致」,绝非「已证明为真品」;且不说哪个模型服务了你 (Phase 1)。"
    >
      {rows.length === 0 ? (
        <EmptyState
          compact
          glyph="◇"
          title="无可评分来源 / no scored upstream yet"
          hint="无签名库的上游 (如 deepseek) skip。"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => {
            // score-0 / any weak score is severity WARN (suspicion, not proof) —
            // never critical/red here, which would overclaim "proven fraud".
            const tone = r.hasFlag ? "warn" : "ok";
            const avgRounded = Math.round(r.avg * 10) / 10;
            return (
              <div key={r.upstream} className="flex flex-col gap-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="data-sm" style={{ color: "var(--text-dim)" }}>
                    {r.upstream}
                  </span>
                  <span className="micro" style={{ color: "var(--text-ghost)" }}>
                    n={r.n}
                  </span>
                  {r.zero > 0 && (
                    <span className="micro ml-auto" style={{ color: C_WARN }}>
                      {r.zero}× score 0 · 疑套壳
                    </span>
                  )}
                </div>
                <GaugeBar
                  value={avgRounded}
                  max={r.max || 1}
                  tone={tone}
                  showValue
                  suffix="avg"
                  ariaLabel={`${r.upstream} provenance average score`}
                />
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/* ============================================================================
   5. Exposure — LOWER-BOUND egress counter. Never a risk score.
   ========================================================================== */

interface ExposureTotals {
  secrets: number;
  pii: number;
  highEntropy: number;
  codeBlocks: number;
  truncated: boolean;
  scanned: number;
}

function useExposure(verdicts: VerdictRecord[]): ExposureTotals {
  return useMemo(() => {
    let secrets = 0;
    let pii = 0;
    let highEntropy = 0;
    let codeBlocks = 0;
    let truncated = false;
    let scanned = 0;
    for (const v of verdicts) {
      if (!isCheck(v, "exposure")) continue;
      scanned += 1;
      const d = v.detail;
      for (const scan of [d.request, d.response]) {
        if (!scan) continue;
        for (const n of Object.values(scan.secrets ?? {})) secrets += n;
        for (const n of Object.values(scan.pii ?? {})) pii += n;
        highEntropy += scan.high_entropy_blobs ?? 0;
        codeBlocks += scan.code_blocks ?? 0;
      }
      if (d.truncated_capture) truncated = true;
    }
    return { secrets, pii, highEntropy, codeBlocks, truncated, scanned };
  }, [verdicts]);
}

/* one egress metric, rendered as "≥ N" so the lower-bound framing is inescapable. */
function EgressStat({
  label,
  cjk,
  value,
  tone = "dim",
  title,
}: {
  label: string;
  cjk: string;
  value: number;
  tone?: "dim" | "warn";
  title: string;
}) {
  const color = tone === "warn" && value > 0 ? C_WARN : "var(--text)";
  return (
    <div className="flex flex-col gap-0.5 min-w-0" title={title}>
      <span className="mono tnum" style={{ color, fontSize: 18, fontWeight: 600, lineHeight: 1.1 }}>
        <span style={{ color: "var(--text-faint)", fontSize: 12, fontWeight: 500 }}>≥ </span>
        {fmtInt(value)}
      </span>
      <span className="micro" style={{ color: "var(--text-faint)" }}>
        {cjk} · {label}
      </span>
    </div>
  );
}

function ExposureSection({ totals }: { totals: ExposureTotals }) {
  const { secrets, pii, highEntropy, codeBlocks, truncated, scanned } = totals;
  return (
    <Section
      title="Exposure egress · 数据泄露下界"
      aside={
        <span
          className="micro"
          style={{ color: "var(--sev-warn)", letterSpacing: "0.06em" }}
          title="exposure 永远是下界 — 已测量、未阻止;检测到 0 ≠ 安全"
        >
          下界 / LOWER BOUND
        </span>
      }
      hint="「至少 N」— 已测量、未阻止 (MITM 物理事实)。检测到 0 ≠ 安全 (检测器会漏掉新型 secret / 模糊姓名)。扫描请求与响应。"
    >
      {scanned === 0 ? (
        <EmptyState compact glyph="◌" title="尚未扫描 / nothing scanned yet" />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2">
            <EgressStat
              label="secrets"
              cjk="凭证"
              value={secrets}
              tone="warn"
              title="凭证 egress（下界）。中转站能读到这些;请轮换/移除。0 ≠ 安全。"
            />
            <EgressStat
              label="PII"
              cjk="个人信息"
              value={pii}
              title="个人信息 egress（下界）。检测器漏检很多;0 ≠ 安全。"
            />
            <EgressStat
              label="entropy"
              cjk="高熵块"
              value={highEntropy}
              title="高熵 blob（可能是新型 secret),单列计数避免误判。"
            />
            <EgressStat
              label="code"
              cjk="代码块"
              value={codeBlocks}
              title="代码块计数（可能含逻辑/凭证)。"
            />
          </div>
          {truncated && (
            <p className="micro" style={{ color: C_WARN, lineHeight: 1.4 }}>
              ⚠ 捕获被截断 — 截断点之后的内容未计;真实 egress 高于此下界。
            </p>
          )}
        </>
      )}
    </Section>
  );
}

/* ============================================================================
   MetricsPanel — compose the sections.
   ========================================================================== */

export function MetricsPanel() {
  const records = useRecords();
  const verdicts = useVerdicts();

  const tokenHonesty = useTokenHonesty(verdicts);
  const throughput = useThroughput(records, verdicts);
  const provenance = useProvenance(verdicts);
  const exposure = useExposure(verdicts);

  return (
    <Panel
      eyebrow="metrics · 图表"
      title="Signals & charts"
      bodyClassName="p-3 flex flex-col gap-3.5 overflow-auto"
    >
      <TokenHonestySection data={tokenHonesty} />
      <Divider />
      <ThroughputSection data={throughput} />
      <Divider />
      <ProviderSection />
      <Divider />
      <ProvenanceSection rows={provenance} />
      <Divider />
      <ExposureSection totals={exposure} />
    </Panel>
  );
}

export default MetricsPanel;
