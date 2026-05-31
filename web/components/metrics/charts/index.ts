/**
 * components/metrics/charts — hand-rolled SVG chart primitives for MetricsPanel.
 * Zero dependencies (matches the project's minimal-deps, reproducible ethos);
 * the foundation Sparkline is reused for the simplest trend.
 *
 *   DeltaBars — diverging per-record bars (the token-honesty signature; a center
 *               "honest" axis, direction = discrepancy kind). Chosen over a
 *               shared-axis scatter so a 2-token over-claim isn't crushed beside
 *               a 240-token inflation.
 *   Bars      — single stacked horizontal bar (provider mix).
 *   MiniArea  — zero-anchored area/line with an optional reference line
 *               (throughput ceiling, TTFT trend).
 */
export { DeltaBars } from "./DeltaBars.tsx";
export type { DeltaBarsProps, DeltaRow } from "./DeltaBars.tsx";

export { Bars } from "./Bars.tsx";
export type { BarsProps, BarSegment } from "./Bars.tsx";

export { MiniArea } from "./MiniArea.tsx";
export type { MiniAreaProps } from "./MiniArea.tsx";
