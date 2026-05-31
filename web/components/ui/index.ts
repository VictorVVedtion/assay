/**
 * components/ui — barrel export of the forensic UI primitive kit. Feature agents
 * may import from "@/components/ui" or from the individual files; both resolve.
 */
export { Panel, Card } from "./Panel.tsx";
export type { PanelProps, CardProps } from "./Panel.tsx";

export { SeverityBadge } from "./SeverityBadge.tsx";
export type { SeverityBadgeProps } from "./SeverityBadge.tsx";

export { StatusPill } from "./StatusPill.tsx";
export type { StatusPillProps } from "./StatusPill.tsx";

export { StatusDot } from "./StatusDot.tsx";
export type { StatusDotProps, DotTone } from "./StatusDot.tsx";

export { ProviderChip } from "./ProviderChip.tsx";
export type { ProviderChipProps } from "./ProviderChip.tsx";

export { MonoHash } from "./MonoHash.tsx";
export type { MonoHashProps } from "./MonoHash.tsx";

export { Sparkline } from "./Sparkline.tsx";
export type { SparklineProps } from "./Sparkline.tsx";

export { StatTile } from "./StatTile.tsx";
export type { StatTileProps, TileTone } from "./StatTile.tsx";

export { Drawer } from "./Drawer.tsx";
export type { DrawerProps } from "./Drawer.tsx";

export { JsonView } from "./JsonView.tsx";
export type { JsonViewProps } from "./JsonView.tsx";

export { RedactionMark } from "./RedactionMark.tsx";
export type { RedactionMarkProps } from "./RedactionMark.tsx";

export { GaugeBar } from "./GaugeBar.tsx";
export type { GaugeBarProps, GaugeTone } from "./GaugeBar.tsx";

export { EmptyState } from "./EmptyState.tsx";
export type { EmptyStateProps } from "./EmptyState.tsx";
