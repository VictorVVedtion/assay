/**
 * TopBar — always-present masthead.
 *
 *   brand "assay · 照妖镜" (faint scan-line glint) + "Live Audit Console"
 *   LOCAL-ONLY badge ("本地直读 ./data · 无外呼")
 *   live-tail status dot (SSE connection)
 *   evidence-chain status pill (VALID / EMPTY / TORN_TAIL / BREAK → TAMPER)
 *   analyzer lag ("current" / "N behind")
 *   Demo / Live data-source toggle
 *
 * Reads the store via hooks; the toggle calls setSource (clears + refetch).
 * Client component.
 */

"use client";

import {
  useChainStatus,
  useDataSource,
  useLag,
  useSetSource,
  useStreamStatus,
} from "@/lib/hooks";
import { StatusDot } from "@/components/ui/StatusDot";
import {
  BRAND,
  CHAIN_STATUS_META,
  LOCAL_ONLY_BADGE,
} from "@/lib/constants";
import type { DataSource } from "@/lib/types";
import type { DotTone } from "@/components/ui/StatusDot";

function ChainPill() {
  const chain = useChainStatus();
  const meta = CHAIN_STATUS_META[chain.status];
  const toneToVar: Record<string, { color: string; bg: string; border: string }> = {
    ok: { color: "var(--sev-ok)", bg: "var(--sev-ok-bg)", border: "var(--sev-ok-border)" },
    info: { color: "var(--sev-info)", bg: "var(--sev-info-bg)", border: "var(--sev-info-border)" },
    warn: { color: "var(--sev-warn)", bg: "var(--sev-warn-bg)", border: "var(--sev-warn-border)" },
    tamper: { color: "var(--sev-tamper)", bg: "var(--sev-tamper-bg)", border: "var(--sev-tamper-border)" },
  };
  const c = toneToVar[meta.tone];
  const isTamper = meta.tone === "tamper";
  return (
    <span
      className={isTamper ? "pill tamper-pulse" : "pill"}
      style={{ color: c.color, background: c.bg, borderColor: c.border }}
      title={
        chain.detail ||
        `evidence chain: ${chain.status} (${chain.records} records verified by in-browser SHA-256 recompute)`
      }
    >
      <span aria-hidden>⛓</span>
      <span className="mono">{meta.label}</span>
      <span style={{ opacity: 0.8 }}>{meta.cjk}</span>
      {chain.break_seq !== null && (
        <span className="mono" style={{ opacity: 0.9 }}>
          @{chain.break_seq}
        </span>
      )}
    </span>
  );
}

function LiveDot() {
  const status = useStreamStatus();
  const source = useDataSource();
  const tone: DotTone =
    status === "open" ? "accent" : status === "connecting" ? "warn" : status === "error" ? "critical" : "idle";
  const label =
    status === "open"
      ? `live-tail 连接中 · ${source}`
      : status === "connecting"
        ? "connecting…"
        : status === "error"
          ? "stream error — retrying"
          : "idle";
  return (
    <span className="flex items-center gap-1.5" title={label}>
      <StatusDot tone={tone} pulse={status === "open"} title={label} />
      <span className="micro" style={{ color: "var(--text-faint)" }}>
        live-tail
      </span>
    </span>
  );
}

function LagBadge() {
  const lag = useLag();
  const behind = lag.lag_records > 0;
  return (
    <span
      className="micro mono"
      style={{ color: behind ? "var(--sev-warn)" : "var(--text-faint)" }}
      title={`analyzer last processed seq ${lag.last_processed_seq}; evidence head seq ${lag.evidence_head_seq}`}
    >
      analyzer {behind ? `${lag.lag_records}↑ behind` : "current"}
    </span>
  );
}

function SourceToggle() {
  const source = useDataSource();
  const setSource = useSetSource();
  const opt = (value: DataSource, label: string) => {
    const active = source === value;
    return (
      <button
        type="button"
        onClick={() => !active && setSource(value)}
        aria-pressed={active}
        className="micro mono"
        style={{
          padding: "3px 9px",
          borderRadius: "var(--r-sm)",
          border: "1px solid",
          borderColor: active ? "var(--accent-dim)" : "transparent",
          background: active ? "var(--accent-ghost)" : "transparent",
          color: active ? "var(--accent-bright)" : "var(--text-faint)",
          cursor: active ? "default" : "pointer",
          fontWeight: 600,
          letterSpacing: "0.04em",
        }}
        title={
          value === "demo"
            ? "Demo: bundled deterministic story (no setup)"
            : "Live: read data/evidence.jsonl + verdicts.jsonl on this machine"
        }
      >
        {label}
      </button>
    );
  };
  return (
    <div
      className="flex items-center gap-0.5"
      style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", padding: 2 }}
      role="group"
      aria-label="data source"
    >
      {opt("demo", "DEMO")}
      {opt("live", "LIVE")}
    </div>
  );
}

export function TopBar() {
  return (
    <header
      className="flex items-center gap-3 px-4 shrink-0"
      style={{
        height: 52,
        background: "var(--panel-2)",
        borderBottom: "1px solid var(--line)",
      }}
    >
      {/* brand */}
      <div className="flex items-baseline gap-2 min-w-0">
        <span
          className="brand-glint"
          style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em", color: "var(--accent)" }}
        >
          {BRAND.name} · {BRAND.cjk}
        </span>
        <span className="micro" style={{ color: "var(--text-faint)" }}>
          {BRAND.tagline}
        </span>
      </div>

      {/* local-only badge */}
      <span
        className="chip"
        style={{
          color: "var(--accent)",
          background: "var(--accent-ghost)",
          borderColor: "var(--accent-dim)",
        }}
        title={`${LOCAL_ONLY_BADGE.en} — this dashboard makes zero external network calls`}
      >
        <span aria-hidden>🔒</span>
        {LOCAL_ONLY_BADGE.cjk}
      </span>

      {/* right cluster */}
      <div className="ml-auto flex items-center gap-4">
        <LiveDot />
        <ChainPill />
        <LagBadge />
        <SourceToggle />
      </div>
    </header>
  );
}
