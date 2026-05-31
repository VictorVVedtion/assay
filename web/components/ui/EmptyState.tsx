/**
 * EmptyState — a calm, centered placeholder for panels with no data yet (e.g.
 * Live mode before any request, or a feed with zero flags). Forensic-quiet: a
 * faint glyph, a short bilingual line, optional hint + action. Never alarming.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  /** monochrome glyph / icon (kept faint). */
  glyph?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** compact variant for small cards. */
  compact?: boolean;
}

export function EmptyState({ glyph, title, hint, action, className, compact }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-1.5 py-6" : "gap-2 py-12",
        className,
      )}
    >
      {glyph != null && (
        <div style={{ color: "var(--text-ghost)", fontSize: compact ? 20 : 28, lineHeight: 1 }} aria-hidden>
          {glyph}
        </div>
      )}
      <div style={{ color: "var(--text-dim)" }} className="text-sm">
        {title}
      </div>
      {hint != null && (
        <div style={{ color: "var(--text-faint)" }} className="micro max-w-xs">
          {hint}
        </div>
      )}
      {action != null && <div className="mt-1">{action}</div>}
    </div>
  );
}
