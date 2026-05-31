/**
 * FlagsFeed — a compact reverse-chronological list of flagged verdicts (the
 * things that earned attention). Each row: severity badge · check · seq ·
 * summary. Clicking a row selects that evidence record (opens the drawer).
 *
 * Color earns attention only here and in the checks cards: a warn flag is amber,
 * a critical flag red. An empty feed is calm and explicitly framed as "no flags
 * within Phase 0's scope" — NOT "safe / clean / verified" (honest-boundary #2).
 *
 * When the evidence chain is BROKEN (useScopeTampered), a loud TAMPER banner
 * leads the feed: the verdicts below are derived from tampered evidence and
 * cannot be trusted (PHASE0.md §4 / report.py).
 */

"use client";

import type { VerdictRecord } from "@/lib/types";
import { CHECK_LABELS, SCOPE_BANNER } from "@/lib/constants";
import { useFlags, useSelect, useScopeTampered, useSelectedRecordId } from "@/lib/hooks";
import { Panel } from "@/components/ui/Panel";
import { SeverityBadge } from "@/components/ui/SeverityBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { fmtInt } from "@/lib/format";
import { cn } from "@/lib/cn";

// Exported both as a named export (the frozen seam in app/page.tsx imports it by
// name, matching every other panel) and as the default (per assignment).
export function FlagsFeed() {
  const flags = useFlags(); // status==="flag", newest-first by record_seq
  const select = useSelect();
  const selectedId = useSelectedRecordId();
  const tampered = useScopeTampered();

  const counts = flags.reduce(
    (acc, v) => {
      if (v.severity === "critical") acc.critical += 1;
      else if (v.severity === "warn") acc.warn += 1;
      else acc.info += 1;
      return acc;
    },
    { critical: 0, warn: 0, info: 0 },
  );

  return (
    <Panel
      eyebrow="attention · reverse-chron"
      title="标记 Flags"
      actions={
        flags.length > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            {counts.critical > 0 && (
              <SeverityBadge severity="critical" variant="dot" label={`${counts.critical}`} />
            )}
            {counts.warn > 0 && (
              <SeverityBadge severity="warn" variant="dot" label={`${counts.warn}`} />
            )}
            <span className="micro mono tnum" style={{ color: "var(--text-faint)" }}>
              {fmtInt(flags.length)} total
            </span>
          </span>
        ) : null
      }
      bodyClassName="p-0 flex flex-col min-h-0"
      className="min-h-0"
    >
      {tampered && (
        <div
          className="tamper-pulse flex items-start gap-2 m-2 px-2.5 py-2"
          style={{
            background: "var(--sev-tamper-bg)",
            border: "1px solid var(--sev-tamper-border)",
            borderRadius: "var(--r)",
          }}
          role="alert"
        >
          <span aria-hidden style={{ color: "var(--sev-tamper)", flex: "none" }}>
            ✕
          </span>
          <span style={{ fontSize: "var(--fs-data-sm)", color: "var(--sev-tamper)" }}>
            <strong>{SCOPE_BANNER.tamper.cjk}</strong>
            <br />
            <span style={{ color: "var(--text-dim)" }}>{SCOPE_BANNER.tamper.en}</span>
          </span>
        </div>
      )}

      {flags.length === 0 ? (
        <EmptyState
          compact
          glyph="○"
          title="无 flag / no flags raised"
          hint={
            <>
              在 Phase 0 的有限范围内未发现问题 —— 这<strong>不是</strong>「正品 / 安全」断言。
              <br />
              No flags within Phase 0&apos;s limited scope (not a clean bill of health).
            </>
          }
        />
      ) : (
        <ul className="flex flex-col overflow-auto" style={{ maxHeight: 320 }}>
          {flags.map((v, i) => (
            <FlagRow
              key={`${v.record_id}-${v.check}`}
              verdict={v}
              selected={v.record_id === selectedId}
              onSelect={select}
              fresh={i === 0}
              tampered={tampered}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function FlagRow({
  verdict,
  selected,
  onSelect,
  fresh,
  tampered,
}: {
  verdict: VerdictRecord;
  selected: boolean;
  onSelect: (id: string | null) => void;
  fresh: boolean;
  tampered: boolean;
}) {
  const label = CHECK_LABELS[verdict.check];
  return (
    <li
      className={cn("flag-row", fresh && "row-in")}
      data-selected={selected || undefined}
    >
      <button
        type="button"
        onClick={() => onSelect(verdict.record_id)}
        className="flex items-start gap-2 w-full text-left"
        style={{
          padding: "0.5rem 0.75rem",
          borderBottom: "1px solid var(--line-soft)",
          background: selected ? "var(--accent-ghost)" : "transparent",
          boxShadow: selected ? "inset 2px 0 0 0 var(--accent)" : undefined,
          cursor: "pointer",
          // tamper desaturates flags: they're derived from untrusted evidence.
          opacity: tampered ? 0.6 : 1,
        }}
        title="open this record in the evidence drawer"
      >
        <span style={{ flex: "none", marginTop: 1 }}>
          <SeverityBadge severity={verdict.severity} variant="dot" />
        </span>
        <span className="min-w-0 flex flex-col gap-0.5 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="mono micro" style={{ color: "var(--text-dim)" }}>
              {label?.en ?? verdict.check}
            </span>
            <span className="micro" style={{ color: "var(--text-faint)" }}>
              {label?.cjk}
            </span>
            <span className="ml-auto mono micro tnum" style={{ color: "var(--text-ghost)" }}>
              seq {fmtInt(verdict.record_seq)}
            </span>
          </span>
          <span
            style={{
              fontSize: "var(--fs-data-sm)",
              color:
                verdict.severity === "critical" ? "var(--sev-critical)" : "var(--text-dim)",
              lineHeight: 1.45,
            }}
          >
            {verdict.summary}
          </span>
        </span>
      </button>
    </li>
  );
}

export default FlagsFeed;
