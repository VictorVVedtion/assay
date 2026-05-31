/**
 * Drawer — a right-side slide-over panel with accessible behavior:
 *   - focus trap (Tab cycles within; focus moves in on open, restores on close)
 *   - Esc to close
 *   - a scrim that closes on click
 *   - role="dialog" + aria-modal, labelled by the title
 *   - body scroll lock while open
 *   - subtle slide-in; honors prefers-reduced-motion via globals
 *
 * Headless-ish: pass a `title`, `subtitle`, optional header `actions`, and the
 * content as children. EvidenceDrawer (a feature component) composes this.
 *
 * Client component.
 */

"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** width in px (default 520). */
  width?: number;
  children?: ReactNode;
  className?: string;
  /** id used for aria-labelledby. */
  labelId?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  actions,
  width = 520,
  children,
  className,
  labelId = "drawer-title",
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const nodes = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
        ).filter((el) => el.offsetParent !== null);
        if (nodes.length === 0) {
          e.preventDefault();
          panelRef.current.focus();
          return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose],
  );

  // open/close side-effects: focus management + body scroll lock.
  useEffect(() => {
    if (!open) return;
    lastFocused.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // move focus into the panel (next tick so it's mounted)
    const id = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const firstFocusable = panel.querySelector<HTMLElement>(FOCUSABLE);
      (firstFocusable ?? panel).focus();
    }, 0);

    return () => {
      window.clearTimeout(id);
      document.body.style.overflow = prevOverflow;
      // restore focus to the trigger
      lastFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" aria-hidden={false}>
      {/* scrim */}
      <div
        className="fixed inset-0 fade-in"
        style={{ background: "rgba(2,4,8,0.62)", backdropFilter: "blur(1.5px)" }}
        onClick={onClose}
        aria-hidden
      />
      {/* panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? labelId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={cn(
          "fixed right-0 top-0 h-full flex flex-col panel-2 row-in outline-none",
          className,
        )}
        style={{
          width: `min(${width}px, 100vw)`,
          borderLeft: "1px solid var(--line-strong)",
          boxShadow: "var(--shadow-drawer)",
          borderRadius: 0,
        }}
      >
        <header
          className="flex items-start gap-2 px-4 py-3"
          style={{ borderBottom: "1px solid var(--line-soft)" }}
        >
          <div className="flex flex-col min-w-0 flex-1">
            {title != null && (
              <h2 id={labelId} className="panel-title truncate-ellipsis">
                {title}
              </h2>
            )}
            {subtitle != null && (
              <div className="micro" style={{ color: "var(--text-faint)" }}>
                {subtitle}
              </div>
            )}
          </div>
          {actions != null && <div className="flex items-center gap-2">{actions}</div>}
          <button
            type="button"
            onClick={onClose}
            aria-label="close drawer"
            className="shrink-0"
            style={{
              color: "var(--text-dim)",
              background: "transparent",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-sm)",
              width: 26,
              height: 26,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}
