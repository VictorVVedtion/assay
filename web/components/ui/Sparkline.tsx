/**
 * Sparkline — a tiny inline SVG line/area chart for trends (req/min, etc.).
 * Pure, no deps. Renders nothing meaningful for <2 points (shows a flat
 * baseline). Accent-colored by default; keep it quiet.
 */

import { cn } from "@/lib/cn";

export interface SparklineProps {
  /** y values, oldest→newest. */
  data: number[];
  width?: number;
  height?: number;
  /** stroke color CSS var or value (default accent). */
  color?: string;
  /** fill the area under the line with a faint gradient. */
  area?: boolean;
  /** stroke width (default 1.5). */
  strokeWidth?: number;
  className?: string;
  ariaLabel?: string;
}

export function Sparkline({
  data,
  width = 120,
  height = 28,
  color = "var(--accent)",
  area = true,
  strokeWidth = 1.5,
  className,
  ariaLabel,
}: SparklineProps) {
  const n = data.length;
  const pad = strokeWidth + 0.5;
  const w = width;
  const h = height;

  let path = "";
  let areaPath = "";

  if (n >= 2) {
    const max = Math.max(...data);
    const min = Math.min(...data);
    const span = max - min || 1;
    const stepX = (w - pad * 2) / (n - 1);
    const points = data.map((v, i) => {
      const x = pad + i * stepX;
      const y = pad + (1 - (v - min) / span) * (h - pad * 2);
      return [x, y] as const;
    });
    path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
    const [x0] = points[0];
    const [xN] = points[points.length - 1];
    areaPath = `${path} L${xN.toFixed(2)},${(h - pad).toFixed(2)} L${x0.toFixed(2)},${(h - pad).toFixed(2)} Z`;
  } else {
    // flat baseline
    const y = (h / 2).toFixed(2);
    path = `M${pad},${y} L${(w - pad).toFixed(2)},${y}`;
  }

  const gradId = `spark-${Math.random().toString(36).slice(2, 8)}`;

  return (
    <svg
      className={cn("block", className)}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={ariaLabel ?? "sparkline"}
      preserveAspectRatio="none"
    >
      {area && n >= 2 && (
        <>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />
        </>
      )}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={n >= 2 ? 1 : 0.4}
      />
    </svg>
  );
}
