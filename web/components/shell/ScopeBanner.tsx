/**
 * ScopeBanner — the MANDATORY honest-limits banner (PHASE0.md §9 + report.py
 * SCOPE_BANNER). It LEADS the whole UI, is ALWAYS visible, collapsible to a
 * single line, and NEVER removable (no dismiss/close — only expand/collapse).
 *
 * It carries the three non-negotiable truths, bilingual (Chinese-primary):
 *   1. model identity is NOT verified (provenance markers are forgeable);
 *   2. data exposure is MEASURED, not PREVENTED (lower bound; 0 ≠ safe);
 *   3. token_recount compares YOUR request and SKIPS Claude/Gemini.
 *
 * When the evidence chain is BREAK it switches to the loud TAMPER state:
 * "证据被篡改 — 以下裁决不可信 / EVIDENCE TAMPERED — verdicts cannot be trusted",
 * intensified red with a slow pulse. This cannot be collapsed away.
 *
 * Client component (collapse state + reads chain status).
 */

"use client";

import { useState } from "react";
import { useScopeTampered } from "@/lib/hooks";
import { SCOPE_BANNER } from "@/lib/constants";

export function ScopeBanner() {
  const [collapsed, setCollapsed] = useState(false);
  const tampered = useScopeTampered();

  return (
    <section
      aria-label="scope and honest limits — mandatory"
      className={tampered ? "tamper-pulse" : undefined}
      style={{
        borderBottom: "1px solid",
        borderColor: tampered ? "var(--sev-tamper-border)" : "var(--line)",
        background: tampered ? "var(--sev-tamper-bg)" : "var(--panel)",
      }}
    >
      <div className="px-4 py-2">
        {/* header row: always visible */}
        <div className="flex items-start gap-2">
          <span
            aria-hidden
            style={{
              fontSize: 13,
              lineHeight: 1.4,
              color: tampered ? "var(--sev-tamper)" : "var(--sev-warn)",
            }}
          >
            {tampered ? "⛔" : "⚠"}
          </span>

          <div className="flex-1 min-w-0">
            {tampered ? (
              <div className="flex flex-col">
                <strong style={{ color: "var(--sev-tamper)", fontSize: "var(--fs-body)" }}>
                  {SCOPE_BANNER.tamper.cjk}
                </strong>
                <span className="micro" style={{ color: "var(--sev-critical)" }}>
                  {SCOPE_BANNER.tamper.en}
                </span>
              </div>
            ) : (
              <>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <strong style={{ color: "var(--text)", fontSize: "var(--fs-body)" }}>
                    {SCOPE_BANNER.headline.cjk}
                  </strong>
                  <span className="micro" style={{ color: "var(--text-faint)" }}>
                    {SCOPE_BANNER.headline.en}
                  </span>
                </div>
                {collapsed && (
                  <div className="micro mt-0.5" style={{ color: "var(--text-dim)" }}>
                    {SCOPE_BANNER.oneLine.cjk}
                  </div>
                )}
              </>
            )}
          </div>

          {/* collapse/expand — NOT a dismiss. The banner can never be removed. */}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            className="micro shrink-0"
            style={{
              color: "var(--text-faint)",
              background: "transparent",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-sm)",
              padding: "2px 7px",
              cursor: "pointer",
            }}
            title={collapsed ? "展开范围说明 / expand" : "折叠为一行 / collapse to one line"}
          >
            {collapsed ? "展开 ▾" : "折叠 ▴"}
          </button>
        </div>

        {/* expanded body: the three truths. Tamper state still shows them. */}
        {!collapsed && (
          <ol
            className="mt-2 flex flex-col gap-1.5"
            style={{ paddingLeft: 22, listStyle: "decimal", color: "var(--text-dim)" }}
          >
            {SCOPE_BANNER.points.map((p) => (
              <li key={p.key} style={{ fontSize: "12.5px", lineHeight: 1.5 }}>
                <span style={{ color: "var(--text)" }}>{p.cjk}</span>
                <span className="micro block" style={{ color: "var(--text-faint)", marginTop: 1 }}>
                  {p.en}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
