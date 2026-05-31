/**
 * Panel / Card — the standard surface for every dashboard region.
 *
 * Panel: a titled, bordered container with an optional header (title + eyebrow +
 * right-aligned actions) and a body. Use `bodyClassName` to control padding /
 * scrolling (e.g. tables want p-0 + overflow-auto).
 *
 * Card: a lighter, header-less surface for small tiles (used inside grids).
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface PanelProps {
  /** primary heading (sans). */
  title?: ReactNode;
  /** small uppercased eyebrow above/with the title. */
  eyebrow?: ReactNode;
  /** right-aligned header controls (toggles, counts, status pills). */
  actions?: ReactNode;
  /** elevated surface (panel-2) — used for the drawer / header strips. */
  elevated?: boolean;
  /** remove body padding (tables/charts manage their own). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  /** stretch body to fill remaining height (panel must have a height). */
  fill?: boolean;
  children?: ReactNode;
  /** optional id for aria / anchors. */
  id?: string;
}

export function Panel({
  title,
  eyebrow,
  actions,
  elevated,
  flush,
  className,
  bodyClassName,
  fill,
  children,
  id,
}: PanelProps) {
  const hasHeader = title != null || eyebrow != null || actions != null;
  return (
    <section
      id={id}
      className={cn(
        "panel flex flex-col min-h-0",
        elevated && "panel-2",
        className,
      )}
    >
      {hasHeader && (
        <header className="panel-head">
          <div className="flex flex-col min-w-0">
            {eyebrow != null && <span className="eyebrow">{eyebrow}</span>}
            {title != null && <span className="panel-title truncate-ellipsis">{title}</span>}
          </div>
          {actions != null && (
            <div className="ml-auto flex items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div
        className={cn(
          !flush && "p-3",
          fill && "flex-1 min-h-0",
          "min-w-0",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

export interface CardProps {
  className?: string;
  children?: ReactNode;
  /** subtle inset well styling for mono content. */
  well?: boolean;
}

export function Card({ className, children, well }: CardProps) {
  return (
    <div
      className={cn(
        well ? "well" : "panel panel-2",
        "p-3 min-w-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
