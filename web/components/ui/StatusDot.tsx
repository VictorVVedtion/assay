/**
 * StatusDot — a small colored dot for inline/at-a-glance status. Used for the
 * live-tail indicator (TopBar), per-row status, and the chain pill. Optional
 * `pulse` adds the calm breathing animation (live) or, for tamper, pass
 * tone="tamper" with pulse for the ominous slow pulse.
 */

import { cn } from "@/lib/cn";

export type DotTone =
  | "ok"
  | "info"
  | "skip"
  | "warn"
  | "critical"
  | "tamper"
  | "accent"
  | "idle";

const TONE_VAR: Record<DotTone, string> = {
  ok: "--sev-ok",
  info: "--sev-info",
  skip: "--sev-skip",
  warn: "--sev-warn",
  critical: "--sev-critical",
  tamper: "--sev-tamper",
  accent: "--accent",
  idle: "--text-ghost",
};

export interface StatusDotProps {
  tone: DotTone;
  pulse?: boolean;
  /** diameter in px (default 7). */
  size?: number;
  className?: string;
  title?: string;
}

export function StatusDot({ tone, pulse, size = 7, className, title }: StatusDotProps) {
  return (
    <span
      className={cn("dot", pulse && "live-dot", className)}
      style={{
        background: `var(${TONE_VAR[tone]})`,
        width: size,
        height: size,
        boxShadow: tone === "tamper" ? `0 0 6px 0 var(--sev-tamper-glow)` : undefined,
      }}
      title={title}
      aria-hidden={!title}
      role={title ? "img" : undefined}
      aria-label={title}
    />
  );
}
