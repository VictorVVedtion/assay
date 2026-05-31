/**
 * DeltaBars — a tiny hand-rolled SVG diverging bar chart (no chart library).
 * Each row is one record; the bar grows LEFT or RIGHT from a center "honest"
 * axis by a signed magnitude. Purpose-built for the token-honesty signal, where
 * a shared scatter axis would crush a 2-token over-claim next to a 240-token
 * inflation — here every record is weighted equally and the DIRECTION encodes
 * the kind of discrepancy:
 *
 *   center line = honest (recomputed == billed)
 *   bar to the RIGHT (recomputed > billed) → visible exceeds billed → impossible
 *                                             if honest (critical)
 *   bar to the LEFT  (billed > recomputed)  → billed exceeds visible → possible
 *                                             inflation (warn)
 *
 * Magnitude is the signed % deviation (clamped for layout; the true numbers live
 * in the row label + tooltip). Hollow bars = estimate-only (not an accusation).
 */

import { cn } from "@/lib/cn";

export interface DeltaRow {
  id: string;
  /** left-side label (e.g. "seq 2 · gpt-4o"). */
  label: string;
  /** signed deviation used for bar length & direction. >0 right, <0 left. */
  value: number;
  /** right-side value text (e.g. "240→9"). */
  valueText: string;
  color: string;
  /** hollow + dashed (estimate-only). */
  hollow?: boolean;
  title?: string;
}

export interface DeltaBarsProps {
  rows: DeltaRow[];
  /** symmetric domain bound; bars clamp to ±domain. Auto if omitted. */
  domain?: number;
  rowHeight?: number;
  className?: string;
  ariaLabel?: string;
}

const LABEL_W = 92; // left labels
const VALUE_W = 62; // right value text
const GAP = 6;

export function DeltaBars({
  rows,
  domain,
  rowHeight = 18,
  className,
  ariaLabel,
}: DeltaBarsProps) {
  const max = domain ?? Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const height = Math.max(rowHeight, rows.length * rowHeight);
  // viewBox in a 0..100 horizontal space for the bar track region.
  const trackX = LABEL_W + GAP;
  const trackW = 1000 - trackX - VALUE_W - GAP; // virtual width units
  const centerX = trackX + trackW / 2;
  const unit = trackW / 2 / max;

  return (
    <svg
      className={cn("block", className)}
      width="100%"
      height={height}
      viewBox={`0 0 1000 ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel ?? "token deviation per record"}
    >
      {/* center honest axis */}
      <line
        x1={centerX}
        x2={centerX}
        y1={0}
        y2={height}
        stroke="var(--accent-dim)"
        strokeWidth={1}
        strokeDasharray="2 2"
        opacity={0.6}
      />
      {rows.map((r, i) => {
        const cy = i * rowHeight + rowHeight / 2;
        const len = Math.min(Math.abs(r.value), max) * unit;
        const goRight = r.value > 0;
        const x = goRight ? centerX : centerX - len;
        const barH = Math.min(10, rowHeight - 6);
        return (
          <g key={r.id}>
            {r.title && <title>{r.title}</title>}
            {/* left label */}
            <text
              x={LABEL_W}
              y={cy}
              textAnchor="end"
              dominantBaseline="middle"
              className="mono"
              fontSize="9.5"
              fill="var(--text-faint)"
            >
              {r.label}
            </text>
            {/* bar */}
            <rect
              x={x}
              y={cy - barH / 2}
              width={Math.max(len, r.value === 0 ? 0 : 1.5)}
              height={barH}
              rx={1.5}
              fill={r.hollow ? "transparent" : r.color}
              stroke={r.color}
              strokeWidth={r.hollow ? 1.2 : 0}
              strokeDasharray={r.hollow ? "3 2" : undefined}
              opacity={r.hollow ? 0.9 : 0.85}
            />
            {/* right value text */}
            <text
              x={1000 - VALUE_W + 4}
              y={cy}
              dominantBaseline="middle"
              className="mono"
              fontSize="9.5"
              fill="var(--text-dim)"
            >
              {r.valueText}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
