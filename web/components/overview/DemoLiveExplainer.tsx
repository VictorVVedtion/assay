/**
 * DemoLiveExplainer — a small inline note that explains the Demo/Live toggle
 * (which lives in the TopBar) and the honesty around each source:
 *
 *   - DEMO is synthetic, deterministic, and fully LOCAL — a bundled story so the
 *     whole console makes sense with zero setup. Nothing here is real traffic.
 *   - LIVE reads the real append-only files in ./data on THIS machine.
 *   - Either way the dashboard makes ZERO external network calls.
 *
 * When Demo is active it also exposes the tamper-demo control: inject / clear a
 * hash-chain BREAK so a buyer can watch the loud TAMPER state and the in-browser
 * digest-recompute catch it. (The break mutates a record AFTER it was hashed, so
 * the client recompute legitimately fails — that is the whole point.)
 *
 * Client component (reads source/break, drives the source + break actions).
 */

"use client";

import { Card } from "@/components/ui/Panel";
import { StatusDot } from "@/components/ui/StatusDot";
import {
  useBreakAt,
  useDataSource,
  useSetBreakAt,
  useSetSource,
} from "@/lib/hooks";
import { LOCAL_ONLY_BADGE } from "@/lib/constants";

const DATA_DIR_HINT = "./data";

/** One source row: dot + name + a one-line bilingual gloss; active = accent. */
function SourceLine({
  active,
  tone,
  name,
  cjk,
  en,
  onClick,
  title,
}: {
  active: boolean;
  tone: "accent" | "ok";
  name: string;
  cjk: string;
  en: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className="flex items-start gap-2 w-full text-left"
      style={{
        background: active ? "var(--accent-ghost)" : "transparent",
        border: "1px solid",
        borderColor: active ? "var(--accent-dim)" : "var(--line-soft)",
        borderRadius: "var(--r-sm)",
        padding: "0.4rem 0.55rem",
        cursor: active ? "default" : "pointer",
      }}
    >
      <StatusDot tone={active ? tone : "idle"} size={7} className="mt-1 shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="flex items-baseline gap-1.5">
          <span
            className="mono"
            style={{
              fontSize: "var(--fs-data)",
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: active ? "var(--accent-bright)" : "var(--text-dim)",
            }}
          >
            {name}
          </span>
          <span style={{ fontSize: "12px", color: active ? "var(--text)" : "var(--text-dim)" }}>
            {cjk}
          </span>
        </span>
        <span className="micro block" style={{ color: "var(--text-faint)", marginTop: 1, lineHeight: 1.45 }}>
          {en}
        </span>
      </span>
    </button>
  );
}

export function DemoLiveExplainer() {
  const source = useDataSource();
  const setSource = useSetSource();
  const breakAt = useBreakAt();
  const setBreakAt = useSetBreakAt();

  const isDemo = source === "demo";
  const broken = breakAt !== null;

  return (
    <Card className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5">
        <span className="eyebrow">数据源 · data source</span>
        <span
          className="micro mono ml-auto"
          style={{ color: "var(--accent-dim)" }}
          title={`${LOCAL_ONLY_BADGE.en} — this dashboard makes zero external calls`}
        >
          0 外呼 · 0 external
        </span>
      </div>

      <p style={{ color: "var(--text-dim)", fontSize: "12px", lineHeight: 1.5 }}>
        顶栏的 <span className="mono" style={{ color: "var(--text)" }}>DEMO / LIVE</span> 开关切换数据源。两者都只在本机读取,绝不外呼。
        <span className="micro block" style={{ color: "var(--text-faint)", marginTop: 1 }}>
          The DEMO / LIVE switch (top bar) flips the source. Both read locally only; neither makes a network call.
        </span>
      </p>

      <div className="flex flex-col gap-1.5">
        <SourceLine
          active={isDemo}
          tone="accent"
          name="DEMO"
          cjk="合成 · 确定性 · 本地"
          en="Synthetic, deterministic, bundled — the whole story, zero setup. Not real traffic."
          onClick={() => !isDemo && setSource("demo")}
          title="Demo: a deterministic, schema-faithful bundled story. Fully local."
        />
        <SourceLine
          active={!isDemo}
          tone="ok"
          name="LIVE"
          cjk={`直读 ${DATA_DIR_HINT}`}
          en={`Reads the real append-only evidence.jsonl + verdicts.jsonl in ${DATA_DIR_HINT} on this machine.`}
          onClick={() => isDemo && setSource("live")}
          title="Live: read the real ./data files on this machine."
        />
      </div>

      {/* Honest caveat under Demo scrutiny: the digest/hash-chain recompute is
          GENUINE (recomputed in-browser from the canonical encoding), but the
          recomputed *token* counts shown on token_recount rows are illustrative
          fixtures — in Live both come from the real analyzer pipeline. */}
      {isDemo && (
        <p
          className="micro"
          style={{ color: "var(--text-ghost)", lineHeight: 1.45 }}
        >
          DEMO 的 token 重算数字为示意 fixture;
          <span style={{ color: "var(--text-faint)" }}> 但哈希链重算是真的(浏览器内按规范编码算出)。Live 下两者都出自真实流水线。</span>
          <span className="micro block" style={{ color: "var(--text-ghost)", marginTop: 1 }}>
            In Demo the recomputed token counts are illustrative; the hash-chain recompute is genuine. In Live both come from the real pipeline.
          </span>
        </p>
      )}

      {/* Tamper-demo control — only meaningful in Demo (the break mutates a
          bundled record post-hash so the in-browser recompute catches it). */}
      {isDemo && (
        <div
          className="flex items-center gap-2 pt-2"
          style={{ borderTop: "1px solid var(--line-soft)" }}
        >
          <div className="flex-1 min-w-0">
            <span
              className="micro"
              style={{ color: broken ? "var(--sev-tamper)" : "var(--text-faint)", fontWeight: broken ? 600 : undefined }}
            >
              {broken ? "已注入链断裂 · chain BREAK injected" : "篡改演示 · tamper demo"}
            </span>
            <span className="micro block" style={{ color: "var(--text-ghost)", lineHeight: 1.4 }}>
              {broken
                ? "证据被改 → 浏览器内重算哈希将不匹配。"
                : "注入一处篡改,看裁决转为不可信。"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setBreakAt(broken ? null : 3)}
            aria-pressed={broken}
            className="micro mono shrink-0"
            style={{
              border: "1px solid",
              borderColor: broken ? "var(--sev-tamper-border)" : "var(--line-strong)",
              background: broken ? "var(--sev-tamper-bg)" : "transparent",
              color: broken ? "var(--sev-tamper)" : "var(--text-dim)",
              borderRadius: "var(--r-sm)",
              padding: "3px 9px",
              fontWeight: 600,
              letterSpacing: "0.03em",
              cursor: "pointer",
            }}
            title={
              broken
                ? "Clear the injected hash-chain BREAK"
                : "Inject a hash-chain BREAK @seq 3 — watch the TAMPER state + in-browser digest mismatch"
            }
          >
            {broken ? "✕ 清除 · clear" : "⚡ 注入 BREAK"}
          </button>
        </div>
      )}
    </Card>
  );
}

export default DemoLiveExplainer;
