/**
 * GaugeBar — a thin horizontal bar for proportions / scores. Used by the
 * provenance score (n/max), the ChecksPanel tallies, and the scorecard
 * progress bars. Token-driven color via `tone`.
 *
 * Deliberately NOT a "risk score" widget — callers control framing. For
 * provenance, label it "score n/max (markers forgeable)"; for exposure, do NOT
 * use a gauge (exposure is a lower-bound count, not a ratio).
 */

import { cn } from "@/lib/cn";

export type GaugeTone = "ok" | "info" | "warn" | "critical" | "skip" | "accent" | "neutral";

const TONE: Record<GaugeTone, { fill: string; track: string }> = {
  ok: { fill: "var(--sev-ok)", track: "var(--sev-ok-bg)" },
  info: { fill: "var(--sev-info)", track: "var(--sev-info-bg)" },
  warn: { fill: "var(--sev-warn)", track: "var(--sev-warn-bg)" },
  critical: { fill: "var(--sev-critical)", track: "var(--sev-critical-bg)" },
  skip: { fill: "var(--sev-skip)", track: "var(--sev-skip-bg)" },
  accent: { fill: "var(--accent)", track: "var(--accent-ghost)" },
  neutral: { fill: "var(--text-faint)", track: "var(--line)" },
};

export interface GaugeBarProps {
  /** current value. */
  value: number;
  /** max value (default 100). */
  max?: number;
  tone?: GaugeTone;
  /** bar height in px (default 6). */
  height?: number;
  /** show "value/max" text to the right. */
  showValue?: boolean;
  /** label rendered to the right of the value (e.g. "score"). */
  suffix?: string;
  className?: string;
  /** accessible label. */
  ariaLabel?: string;
}

export function GaugeBar({
  value,
  max = 100,
  tone = "accent",
  height = 6,
  showValue,
  suffix,
  className,
  ariaLabel,
}: GaugeBarProps) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  const t = TONE[tone];
  return (
    <div className={cn("flex items-center gap-2 min-w-0", className)}>
      <div
        className="relative flex-1 overflow-hidden"
        style={{ height, background: t.track, borderRadius: 999 }}
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={ariaLabel}
      >
        <div
          className="absolute inset-y-0 left-0"
          style={{
            width: `${pct * 100}%`,
            background: t.fill,
            borderRadius: 999,
            transition: "width 0.35s cubic-bezier(0.2,0.7,0.3,1)",
          }}
        />
      </div>
      {showValue && (
        <span className="mono data-sm tnum" style={{ color: t.fill, whiteSpace: "nowrap" }}>
          {value}
          <span style={{ color: "var(--text-faint)" }}>/{max}</span>
          {suffix ? <span style={{ color: "var(--text-faint)" }}> {suffix}</span> : null}
        </span>
      )}
    </div>
  );
}
