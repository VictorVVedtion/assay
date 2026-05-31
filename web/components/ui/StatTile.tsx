/**
 * StatTile — a single live counter for the StatRow: a small uppercased label,
 * a big mono tabular-nums value, an optional unit, an optional sub-line (e.g. a
 * sparkline or breakdown), and an optional tone for the value color.
 *
 * Keep values mono + tabular so they don't jitter as they tick. Color earns
 * attention only when the metric warrants it (pass tone for warn/critical).
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
  className,
  title,
  adornment,
}: StatTileProps) {
  return (
    <div className={cn("flex flex-col gap-1 min-w-0", className)} title={title}>
      <div className="flex items-center gap-1.5">
        <span className="eyebrow truncate-ellipsis">{label}</span>
        {adornment != null && <span className="ml-auto">{adornment}</span>}
      </div>
      <div className="flex items-baseline gap-1">
        <span
          className="mono tnum"
          style={{ color: TONE_COLOR[tone], fontSize: "var(--fs-stat)", lineHeight: 1.05, fontWeight: 600 }}
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
