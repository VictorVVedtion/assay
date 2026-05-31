/**
 * Bars — a tiny hand-rolled SVG stacked horizontal bar (no chart library). One
 * full-width track; segments sized by value, colored by the caller. Used for the
 * provider mix (openai/anthropic/gemini/unknown) — a compact, dense "where did
 * the traffic go" strip that reads at a glance.
 *
 * Deliberately minimal: a single bar, hairline separators between segments, an
 * optional legend the caller composes alongside. Degrades to an empty track.
 */

import { cn } from "@/lib/cn";

export interface BarSegment {
  /** stable key + accessible label. */
  label: string;
  value: number;
  /** segment color (CSS var or value). */
  color: string;
}

export interface BarsProps {
  segments: BarSegment[];
  /** bar height in px. */
  height?: number;
  className?: string;
  ariaLabel?: string;
}

export function Bars({ segments, height = 12, className, ariaLabel }: BarsProps) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);

  return (
    <svg
      className={cn("block", className)}
      width="100%"
      height={height}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel ?? "stacked breakdown"}
    >
      {/* track */}
      <rect x={0} y={0} width={100} height={height} rx={2} fill="var(--inset)" />
      {total > 0 &&
        (() => {
          let x = 0;
          return segments
            .filter((s) => s.value > 0)
            .map((seg) => {
              const w = (seg.value / total) * 100;
              const node = (
                <rect
                  key={seg.label}
                  x={x}
                  y={0}
                  width={w}
                  height={height}
                  fill={seg.color}
                  opacity={0.85}
                >
                  <title>
                    {seg.label}: {seg.value} ({Math.round((seg.value / total) * 100)}%)
                  </title>
                </rect>
              );
              x += w;
              return node;
            });
        })()}
    </svg>
  );
}
