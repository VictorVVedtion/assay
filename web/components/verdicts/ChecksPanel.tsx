/**
 * ChecksPanel — the five Phase 0 checks as a scorecard (mirrors report.py
 * build_report tally). One card per check, in CHECK_ORDER (minus model_identity,
 * which is Phase 1 and never emitted in Phase 0):
 *
 *   token_recount · provenance · exposure · cache_replay · throughput
 *
 * Each card shows:
 *   - the bilingual check label + a marker ([FLAG] if any flag this check, else
 *     a NEUTRAL "ok" reading — never a triumphant green "pass").
 *   - the ok / flag / skip / error tally (skip rendered muted/"napping").
 *   - a one-line honest caption (CHECK_HONEST_FRAME — what a flag/skip does and
 *     does NOT mean).
 *   - the most recent NOTABLE verdict (newest flag if any, else newest verdict),
 *     clickable to open that record in the drawer.
 *
 * HONEST-BOUNDARY: a card with only ok/skip never reads "verified/safe/genuine".
 * Its marker reads "无 flag (Phase 0 范围内)". skip ≠ fail.
 */

"use client";

import { useMemo } from "react";
import type { CheckName, CheckTally, VerdictRecord } from "@/lib/types";
import { CHECK_ORDER, PHASE0_CHECKS, CHECK_LABELS, CHECK_HONEST_FRAME } from "@/lib/constants";
import { useVerdicts, useAggregates, useSelect } from "@/lib/hooks";
import { Panel } from "@/components/ui/Panel";
import { StatusPill } from "@/components/ui/StatusPill";
import { SeverityBadge } from "@/components/ui/SeverityBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { fmtInt } from "@/lib/format";
import { cn } from "@/lib/cn";

const EMPTY_TALLY: CheckTally = { ok: 0, flag: 0, skip: 0, error: 0, total: 0, worst: "none" };

// Exported both as a named export (the frozen seam in app/page.tsx imports it by
// name, matching every other panel) and as the default (per assignment).
export function ChecksPanel() {
  const verdicts = useVerdicts();
  const aggregates = useAggregates();
  const select = useSelect();

  // Most NOTABLE verdict per check: newest flag (by record_seq) if any flags
  // exist for that check, otherwise the newest verdict of any status.
  const notableByCheck = useMemo(() => {
    const map: Partial<Record<CheckName, VerdictRecord>> = {};
    for (const check of CHECK_ORDER) {
      const forCheck = verdicts.filter((v) => v.check === check);
      if (forCheck.length === 0) continue;
      const flags = forCheck.filter((v) => v.status === "flag");
      const pool = flags.length > 0 ? flags : forCheck;
      map[check] = pool.reduce((best, v) => (v.record_seq > best.record_seq ? v : best));
    }
    return map;
  }, [verdicts]);

  const anyData = aggregates.verdict_count > 0;

  // Always show the five Phase 0 checks; show model_identity (Phase 1, active-
  // probe MMD) only once it has verdicts — an empty model_identity card would
  // read as "no flags" when it simply did not run (no probes / no calibration).
  const checksToShow = CHECK_ORDER.filter(
    (c) => PHASE0_CHECKS.includes(c) || (aggregates.by_check[c]?.total ?? 0) > 0,
  );

  return (
    <Panel
      eyebrow={`scorecard · ${checksToShow.length} checks`}
      title="检测项 Checks"
      actions={
        <span
          className="micro"
          style={{ color: "var(--text-faint)" }}
          title="Phase 0 emits these five checks; model_identity is Phase 1"
        >
          Phase 0
        </span>
      }
      bodyClassName="p-2 flex flex-col gap-2"
    >
      {!anyData ? (
        <EmptyState
          compact
          glyph="◌"
          title="暂无裁决 / no verdicts yet"
          hint="等待 analyzer 处理证据 · waiting for the analyzer"
        />
      ) : (
        checksToShow.map((check) => (
          <CheckCard
            key={check}
            check={check}
            tally={aggregates.by_check[check] ?? EMPTY_TALLY}
            notable={notableByCheck[check]}
            onSelect={select}
          />
        ))
      )}
    </Panel>
  );
}

function CheckCard({
  check,
  tally,
  notable,
  onSelect,
}: {
  check: CheckName;
  tally: CheckTally;
  notable: VerdictRecord | undefined;
  onSelect: (id: string | null) => void;
}) {
  const label = CHECK_LABELS[check];
  const hasFlag = tally.flag > 0;
  const worst = tally.worst; // Severity | "none"

  // Card edge tint: only flags earn color; ok/skip-only stays calm.
  const edge = hasFlag
    ? worst === "critical"
      ? "var(--sev-critical-border)"
      : "var(--sev-warn-border)"
    : "var(--line)";

  return (
    <div
      className="flex flex-col gap-1.5 p-2.5"
      style={{
        background: "var(--panel-2)",
        border: `1px solid ${edge}`,
        borderLeft: `2px solid ${
          hasFlag
            ? worst === "critical"
              ? "var(--sev-critical)"
              : "var(--sev-warn)"
            : "var(--line-strong)"
        }`,
        borderRadius: "var(--r)",
      }}
    >
      {/* title row + marker */}
      <div className="flex items-center gap-2">
        <span style={{ fontSize: "var(--fs-data)", fontWeight: 600, color: "var(--text)" }}>
          {label.cjk}
        </span>
        <span className="mono micro" style={{ color: "var(--text-ghost)" }}>
          {label.en}
        </span>
        <span className="ml-auto">
          {hasFlag ? (
            <span className="inline-flex items-center gap-1">
              <SeverityBadge severity={worst === "none" ? "warn" : worst} />
              <span className="mono micro tnum" style={{ color: "var(--sev-warn)" }}>
                {fmtInt(tally.flag)}
              </span>
            </span>
          ) : (
            <span
              className="pill"
              style={{
                color: "var(--text-faint)",
                borderColor: "var(--line)",
                background: "transparent",
              }}
              title="无 flag — Phase 0 范围内未发现问题(并非 '正品/安全' 断言)"
            >
              无 flag
            </span>
          )}
        </span>
      </div>

      {/* tally chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <TallyChip kind="ok" n={tally.ok} />
        <TallyChip kind="flag" n={tally.flag} />
        <TallyChip kind="skip" n={tally.skip} />
        {tally.error > 0 && <TallyChip kind="error" n={tally.error} />}
        <span className="micro mono tnum ml-auto" style={{ color: "var(--text-ghost)" }}>
          {fmtInt(tally.total)} rec
        </span>
      </div>

      {/* honest caption — what a flag/skip does and does NOT mean */}
      <p className="micro" style={{ color: "var(--text-faint)", lineHeight: 1.5 }}>
        {CHECK_HONEST_FRAME[check]}
      </p>

      {/* most notable verdict (clickable → drawer) */}
      {notable && (
        <button
          type="button"
          onClick={() => onSelect(notable.record_id)}
          className={cn("flex items-start gap-2 text-left w-full")}
          style={{
            background: "var(--inset)",
            border: "1px solid var(--line-soft)",
            borderRadius: "var(--r-sm)",
            padding: "0.34rem 0.5rem",
            cursor: "pointer",
          }}
          title="open this record in the evidence drawer"
        >
          <span style={{ flex: "none", marginTop: 1 }}>
            <StatusPill
              status={notable.status}
              severity={notable.status === "flag" ? notable.severity : undefined}
            />
          </span>
          <span className="min-w-0 flex flex-col">
            <span
              className="truncate-ellipsis"
              style={{ fontSize: "var(--fs-data-sm)", color: "var(--text-dim)" }}
            >
              {notable.summary}
            </span>
            <span className="mono micro" style={{ color: "var(--text-ghost)" }}>
              seq {fmtInt(notable.record_seq)}
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

function TallyChip({
  kind,
  n,
}: {
  kind: "ok" | "flag" | "skip" | "error";
  n: number;
}) {
  const zero = n === 0;
  const map = {
    ok: { label: "ok", color: "var(--sev-ok)", bg: "var(--sev-ok-bg)", border: "var(--sev-ok-border)" },
    flag: { label: "flag", color: "var(--sev-warn)", bg: "var(--sev-warn-bg)", border: "var(--sev-warn-border)" },
    skip: { label: "skip", color: "var(--sev-skip)", bg: "var(--sev-skip-bg)", border: "var(--sev-skip-border)" },
    error: { label: "err", color: "var(--sev-error)", bg: "var(--sev-error-bg)", border: "var(--sev-error-border)" },
  }[kind];
  return (
    <span
      className={cn("chip mono tnum", kind === "skip" && "is-skip")}
      style={{
        color: zero ? "var(--text-ghost)" : map.color,
        background: zero ? "transparent" : map.bg,
        borderColor: zero ? "var(--line-soft)" : map.border,
        opacity: zero && kind !== "skip" ? 0.6 : undefined,
      }}
      title={`${map.label}: ${n}`}
    >
      {map.label}
      <span>{fmtInt(n)}</span>
    </span>
  );
}

export default ChecksPanel;
