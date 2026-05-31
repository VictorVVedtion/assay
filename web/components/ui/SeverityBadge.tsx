/**
 * SeverityBadge — colored severity label. Severity is one of the few places
 * strong color is allowed (info/warn/critical). `info` reads calm; `warn` amber;
 * `critical` red. There is intentionally no "ok/green success" severity here —
 * that lives in StatusPill, and even there it is a muted slate-teal, never a
 * triumphant green (honest-boundary rule #2).
 */

import type { Severity } from "@/lib/types";
import { SEVERITY_META } from "@/lib/constants";
import { cn } from "@/lib/cn";

export interface SeverityBadgeProps {
  severity: Severity;
  /** show a leading dot instead of filled background (quieter). */
  variant?: "solid" | "dot";
  className?: string;
  /** override the label text (defaults to INFO/WARN/CRITICAL). */
  label?: string;
}

export function SeverityBadge({
  severity,
  variant = "solid",
  className,
  label,
}: SeverityBadgeProps) {
  const meta = SEVERITY_META[severity];
  const text = label ?? meta.label;

  if (variant === "dot") {
    return (
      <span className={cn("pill", className)} style={{ color: `var(${meta.colorVar})` }}>
        <span
          className="dot"
          style={{ background: `var(${meta.colorVar})` }}
          aria-hidden
        />
        {text}
      </span>
    );
  }

  return (
    <span
      className={cn("pill", className)}
      style={{
        color: `var(${meta.colorVar})`,
        background: `var(${meta.bgVar})`,
        borderColor: `var(${meta.borderVar})`,
      }}
    >
      {text}
    </span>
  );
}
