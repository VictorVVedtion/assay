/**
 * StatRow — the live-counters strip across the top of the console.
 *
 * A row of compact StatTiles fed straight from the store aggregates + chain
 * status. The console is QUIET: every tile reads neutral unless the metric
 * itself warrants color. Only warn/critical flag counts and the TAMPER chain
 * state carry strong color; everything else is mono + tabular slate.
 *
 * Honest-boundary rules baked into the tiles (DESIGN §HONEST-BOUNDARY):
 *   - Exposure is a LOWER BOUND ("≥ N") and is "measured, NOT prevented";
 *     0 detected ≠ safe. It is NEVER a risk score, NEVER colored by count.
 *   - "% skipped" is neutral telemetry — skip ≠ fail, never red.
 *   - Chain integrity surfaces VALID/EMPTY/TORN_TAIL/BREAK; only BREAK is loud
 *     ("TAMPER — verdicts cannot be trusted"), never a global green "safe".
 *   - The flags tile shows warn + critical counts in their own colors; a zero
 *     count reads as calm "Phase 0 范围内无 flag", never "safe/verified".
 *
 * Client component (reads the store via hooks).
 */

"use client";

import { useMemo } from "react";
import {
  useAggregates,
  useChainStatus,
  useScopeTampered,
} from "@/lib/hooks";
import { StatTile } from "@/components/ui/StatTile";
import { Sparkline } from "@/components/ui/Sparkline";
import { ProviderChip } from "@/components/ui/ProviderChip";
import { StatusDot } from "@/components/ui/StatusDot";
import type { DotTone } from "@/components/ui/StatusDot";
import { CHAIN_STATUS_META } from "@/lib/constants";
import { fmtInt, fmtPct } from "@/lib/format";
import type { Provider } from "@/lib/types";
import { cn } from "@/lib/cn";

/* chain status tone → StatusDot tone (BREAK = tamper, pulsing). */
const CHAIN_DOT_TONE: Record<string, DotTone> = {
  ok: "ok",
  info: "info",
  warn: "warn",
  tamper: "tamper",
};

/** Provider-mix sub-line: chip + count for each present provider, dim if zero. */
function ProviderMixSub() {
  const mix = useAggregates().provider_mix;
  const order: Provider[] = ["openai", "anthropic", "gemini", "unknown"];
  const present = order.filter((p) => mix[p] > 0);
  const shown = present.length > 0 ? present : (["openai"] as Provider[]);
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 mt-0.5">
      {shown.map((p) => (
        <span key={p} className="inline-flex items-center gap-1" style={{ opacity: mix[p] > 0 ? 1 : 0.4 }}>
          <ProviderChip provider={p} />
          <span className="mono tnum micro" style={{ color: "var(--text-dim)" }}>
            {fmtInt(mix[p])}
          </span>
        </span>
      ))}
    </div>
  );
}

/** Flags sub-line: warn ● N · crit ● N in their colors; "—" reads as calm. */
function FlagsSub({ warn, critical }: { warn: number; critical: number }) {
  return (
    <div className="flex items-center gap-2.5 mt-0.5">
      <span className="inline-flex items-center gap-1" title="warn flags (within Phase 0 scope)">
        <StatusDot tone="warn" size={6} />
        <span
          className="mono tnum data-sm"
          style={{ color: warn > 0 ? "var(--sev-warn)" : "var(--text-faint)" }}
        >
          {fmtInt(warn)}
        </span>
        <span className="micro" style={{ color: "var(--text-faint)" }}>
          warn
        </span>
      </span>
      <span className="inline-flex items-center gap-1" title="critical flags (within Phase 0 scope)">
        <StatusDot tone="critical" size={6} pulse={critical > 0} />
        <span
          className="mono tnum data-sm"
          style={{ color: critical > 0 ? "var(--sev-critical)" : "var(--text-faint)" }}
        >
          {fmtInt(critical)}
        </span>
        <span className="micro" style={{ color: "var(--text-faint)" }}>
          crit
        </span>
      </span>
    </div>
  );
}

export function StatRow() {
  const agg = useAggregates();
  const chain = useChainStatus();
  const tampered = useScopeTampered();

  const rateData = useMemo(
    () => agg.rate_series.map((p) => p.count),
    [agg.rate_series],
  );
  // current req/min = the most recent bucket (0 if no data yet).
  const currentRate =
    agg.rate_series.length > 0 ? agg.rate_series[agg.rate_series.length - 1].count : 0;

  const { warn, critical } = agg.severity;
  const totalFlags = warn + critical;

  const chainMeta = CHAIN_STATUS_META[chain.status];
  const chainTone: DotTone = CHAIN_DOT_TONE[chainMeta.tone] ?? "info";

  // Tile tones: only flags + chain can be loud. Everything else stays default.
  const flagsTone =
    critical > 0 ? "critical" : warn > 0 ? "warn" : ("default" as const);
  const chainTileTone =
    chain.status === "BREAK"
      ? "critical"
      : chain.status === "TORN_TAIL"
        ? "warn"
        : ("default" as const);

  return (
    <section
      aria-label="live counters"
      className={cn(
        "grid gap-3",
        "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7",
        tampered && "tamper-pulse",
      )}
      style={{
        borderRadius: tampered ? "var(--r-lg)" : undefined,
        boxShadow: tampered ? "0 0 0 1px var(--sev-tamper-border)" : undefined,
      }}
    >
      {/* total requests — the headline KPI */}
      <StatTile
        accent
        label="证据记录 · evidence"
        value={fmtInt(agg.total_requests)}
        unit="rec"
        title="proxied request/response pairs captured in this window (hash-chained, immutable)"
        sub={
          <span className="micro" style={{ color: "var(--text-faint)" }}>
            {fmtInt(agg.verdict_count)} verdicts
          </span>
        }
      />

      {/* req/min sparkline */}
      <StatTile
        label="请求速率 · req/min"
        value={fmtInt(currentRate)}
        unit="/min"
        title="requests per minute over a trailing window (newest bucket shown; trend in the sparkline)"
        sub={
          <div className="mt-0.5">
            <Sparkline
              data={rateData}
              width={120}
              height={22}
              ariaLabel="requests per minute trend"
            />
          </div>
        }
      />

      {/* flags by severity */}
      <StatTile
        label="标记 · flags"
        value={fmtInt(totalFlags)}
        tone={flagsTone}
        title="flagged verdicts within Phase 0 scope. Zero flags ≠ genuine/safe — it means 'no flag within scope'."
        sub={<FlagsSub warn={warn} critical={critical} />}
      />

      {/* provider mix */}
      <StatTile
        label="上游分布 · provider"
        value={fmtInt(
          agg.provider_mix.openai +
            agg.provider_mix.anthropic +
            agg.provider_mix.gemini +
            agg.provider_mix.unknown,
        )}
        unit="req"
        title="provider classified by REQUEST PATH (not the model string) — harder for a relay to misattribute"
        sub={<ProviderMixSub />}
      />

      {/* % of checks skipped — neutral telemetry, never red */}
      <StatTile
        label="跳过率 · skipped"
        value={fmtPct(agg.skipped_pct)}
        tone="dim"
        title="share of verdicts with status skip. skip ≠ fail — Claude/Gemini/non-chat are SKIPPED as NORMAL (not applicable)."
        sub={
          <span className="micro" style={{ color: "var(--text-faint)" }}>
            skip ≠ fail · 不适用
          </span>
        }
      />

      {/* exposure egress lower bound — measured, not prevented */}
      <StatTile
        label="泄露下界 · exposure"
        value={`≥ ${fmtInt(agg.exposure_secret_lower_bound)}`}
        unit="secrets"
        tone={agg.exposure_secret_lower_bound > 0 ? "warn" : "dim"}
        title="LOWER BOUND of credentials egressed (req+resp). Measured, NOT prevented — assay cannot stop a relay reading plaintext. 0 detected ≠ safe."
        sub={
          <span className="micro" style={{ color: "var(--text-faint)" }}>
            下界 · 0 ≠ 安全 · measured not prevented
          </span>
        }
      />

      {/* chain integrity */}
      <StatTile
        label="证据链 · chain"
        value={
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone={chainTone} size={8} pulse={chain.status === "BREAK"} />
            <span style={{ fontSize: "var(--fs-h)" }}>{chainMeta.label}</span>
          </span>
        }
        tone={chainTileTone}
        title={
          chain.detail ||
          `evidence-chain status: ${chain.status} — ${chain.records} records verified by in-browser SHA-256 recompute`
        }
        sub={
          <span
            className="micro"
            style={{
              color: chain.status === "BREAK" ? "var(--sev-tamper)" : "var(--text-faint)",
              fontWeight: chain.status === "BREAK" ? 600 : undefined,
            }}
          >
            {chain.status === "BREAK"
              ? `篡改 @seq ${chain.break_seq} · 裁决不可信`
              : `${chainMeta.cjk} · ${fmtInt(chain.records)} verified`}
          </span>
        }
      />
    </section>
  );
}

export default StatRow;
