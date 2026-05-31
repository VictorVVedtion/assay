/**
 * MiniArea — a small hand-rolled SVG area/line for an ordered numeric series
 * (oldest→newest), zero-anchored so magnitude reads honestly. No chart library.
 *
 * Differs from the foundation Sparkline on purpose: it baselines at 0 (not at
 * the series min), marks the latest point, and can draw a dashed REFERENCE line
 * (e.g. the throughput physical ceiling) so "is this physically possible" is
 * visible without claiming the y-axis is anything but telemetry.
 *
 * Used for TTFT-over-time and tokens/s-over-time in MetricsPanel. Degrades to a
 * flat baseline for <2 points.
 */

import { useId } from "react";
import { cn } from "@/lib/cn";

export interface MiniAreaProps {
  /** values, oldest→newest. */
  data: number[];
  width?: number;
  height?: number;
  /** stroke / fill color (CSS var or value). */
  color?: string;
  /** optional reference line value (e.g. ceiling), drawn dashed if in range. */
  reference?: number | null;
  /** color for the reference line. */
  referenceColor?: string;
  /** mark the most-recent point with a filled dot. */
  markLast?: boolean;
  strokeWidth?: number;
  className?: string;
  ariaLabel?: string;
}

const PAD = 3;

export function MiniArea({
  data,
  width = 150,
  height = 44,
  color = "var(--accent)",
  reference = null,
  referenceColor = "var(--sev-warn)",
  markLast = true,
  strokeWidth = 1.5,
  className,
  ariaLabel,
}: MiniAreaProps) {
  const gradId = useId();
  const n = data.length;
  const w = width;
  const h = height;
  const innerW = w - PAD * 2;
  const innerH = h - PAD * 2;

  // zero-anchored domain; include the reference so it stays on-canvas.
  const dataMax = data.length ? Math.max(...data) : 0;
  const top = Math.max(dataMax, reference ?? 0, 1);
  const sx = (i: number) => PAD + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const sy = (v: number) => PAD + innerH - (v / top) * innerH;

  let line = "";
  let area = "";
  if (n >= 2) {
    const pts = data.map((v, i) => [sx(i), sy(v)] as const);
    line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
    const [x0] = pts[0];
    const [xN] = pts[pts.length - 1];
    area = `${line} L${xN.toFixed(2)},${(h - PAD).toFixed(2)} L${x0.toFixed(2)},${(h - PAD).toFixed(2)} Z`;
  } else if (n === 1) {
    const y = sy(data[0]).toFixed(2);
    line = `M${PAD},${y} L${(w - PAD).toFixed(2)},${y}`;
  } else {
    const y = (h - PAD).toFixed(2);
    line = `M${PAD},${y} L${(w - PAD).toFixed(2)},${y}`;
  }

  const refY = reference != null && reference <= top ? sy(reference) : null;
  const lastX = n ? sx(n - 1) : 0;
  const lastY = n ? sy(data[n - 1]) : 0;

  return (
    <svg
      className={cn("block", className)}
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel ?? "series"}
    >
      {n >= 2 && (
        <>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.24" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradId})`} stroke="none" />
        </>
      )}

      {refY != null && (
        <line
          x1={PAD}
          x2={w - PAD}
          y1={refY}
          y2={refY}
          stroke={referenceColor}
          strokeWidth={1}
          strokeDasharray="3 2.5"
          opacity={0.65}
        />
      )}

      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={n >= 2 ? 1 : 0.45}
        vectorEffect="non-scaling-stroke"
      />

      {markLast && n >= 1 && (
        <circle cx={lastX} cy={lastY} r={2.4} fill={color} stroke="var(--panel)" strokeWidth={1} />
      )}
    </svg>
  );
}
