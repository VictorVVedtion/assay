/**
 * StatTile — a single live KPI card for the StatRow: a small uppercased label,
 * a big mono tabular-nums value, an optional unit, an optional sub-line (e.g. a
 * sparkline or breakdown), and an optional tone for the value color.
 *
 * Rendered as a carded surface (.kpi-card) so the top strip reads as distinct
 * headline KPIs rather than one flat band. `accent` marks the primary tile;
 * `tone` tints the card edge (warn/critical) so attention is earned, never
 * decorative. Values stay mono + tabular so they don't jitter as they tick.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type TileTone = "default" | "accent" | "ok" | "warn" | "critical" | "dim";

const TONE_COLOR: Record<TileTone, string> = {
  default: "var(--text)",
  accent: "var(--accent)",
  ok: "var(--sev-ok)",
  warn: "var(--sev-warn)",
  critical: "var(--sev-critical)",
  dim: "var(--text-dim)",
};

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  /** secondary line under the value (sparkline, mini-breakdown, note). */
  sub?: ReactNode;
  tone?: TileTone;
  /** mark the headline tile with a leading accent rail + faint top wash. */
  accent?: boolean;
  className?: string;
  /** tooltip — the place to put honest-boundary caveats (e.g. exposure "≥"). */
  title?: string;
  /** right-aligned adornment (e.g. a trend arrow or chip). */
  adornment?: ReactNode;
}

export function StatTile({
  label,
  value,
  unit,
  sub,
  tone = "default",
  accent,
  className,
  title,
  adornment,
}: StatTileProps) {
  // The card edge tint only fires for the attention tones (warn/critical); the
  // value color still follows `tone` for ok/dim/accent.
  const cardTone = tone === "warn" || tone === "critical" ? tone : undefined;
  return (
    <div
      className={cn("kpi-card", className)}
      data-accent={accent || undefined}
      data-tone={cardTone}
      title={title}
    >
      <div className="flex items-center gap-1.5">
        <span className="eyebrow truncate-ellipsis">{label}</span>
        {adornment != null && <span className="ml-auto">{adornment}</span>}
      </div>
      <div className="flex items-baseline gap-1">
        <span
          className="mono tnum"
          style={{ color: TONE_COLOR[tone], fontSize: "var(--fs-stat)", lineHeight: 1.0, fontWeight: 600 }}
        >
          {value}
        </span>
        {unit != null && (
          <span className="micro" style={{ color: "var(--text-faint)" }}>
            {unit}
          </span>
        )}
      </div>
      {sub != null && <div className="min-w-0">{sub}</div>}
    </div>
  );
}
