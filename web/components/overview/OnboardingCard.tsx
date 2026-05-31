/**
 * OnboardingCard — "how to feed me data". A short, bilingual quick-start that
 * mirrors the README §快速开始: stand up the proxy + analyzer, point your app's
 * OPENAI_BASE_URL at the proxy, and this console tails ./data live.
 *
 * It is most prominent when the active source is LIVE but no evidence has
 * arrived (empty ./data) — that is the moment a real buyer needs the recipe.
 * In Demo, or once Live records exist, it collapses to a one-line hint so it
 * stays out of the way. It NEVER blocks; it offers a one-click jump to Demo so
 * the whole story is visible with zero setup.
 *
 * Honest framing: the console reads local files only and makes ZERO external
 * calls — the recipe sets up the *proxy*, not this dashboard.
 *
 * Client component (reads source/hydrated/records, can flip to Demo).
 */

"use client";

import { Panel } from "@/components/ui/Panel";
import {
  useDataSource,
  useHydrated,
  useRecords,
  useSetSource,
} from "@/lib/hooks";

/* The exact env line a buyer exports to route their app through the proxy
   (README §快速开始). Tee'd evidence then lands in ./data, which this tails. */
const BASE_URL = "http://localhost:8080/v1";
/* Where the console reads from (server resolves ASSAY_DATA_DIR; default ./data). */
const DATA_DIR_HINT = "./data";

interface Step {
  n: number;
  cjk: string;
  en: string;
  /** monospace command to show in an inset well (optional). */
  code?: string;
  codeComment?: string;
}

const STEPS: Step[] = [
  {
    n: 1,
    cjk: "起 proxy + analyzer(数据面 Go + 分析面 Python)。",
    en: "Bring up the proxy + analyzer (Go data-plane + Python analyzer).",
    code: "cp assay.example.yaml assay.yaml\ndocker compose up -d",
    codeComment: "# 填上你的中转站地址 · set your relay upstream",
  },
  {
    n: 2,
    cjk: "把你的 app 指向代理 —— 只改一个环境变量。",
    en: "Point your app at the proxy — one env var, nothing else.",
    code: `export OPENAI_BASE_URL=${BASE_URL}`,
    codeComment: "# 你的 app 指过来即可 · drop-in, OpenAI-compatible",
  },
  {
    n: 3,
    cjk: "正常发请求。代理透传(fail-open,绝不阻断),并 tee 一份完整副本到证据链。",
    en: "Make requests as usual. The proxy passes through (fail-open, never blocks) and tees a full copy into the hash-chained evidence log.",
  },
  {
    n: 4,
    cjk: "本台实时 tail ./data —— evidence.jsonl + verdicts.jsonl 一出现即逐行点亮。",
    en: "This console live-tails ./data — rows light up the instant evidence.jsonl + verdicts.jsonl appear.",
  },
];

/** A single numbered step with optional mono command well. */
function StepRow({ step }: { step: Step }) {
  return (
    <li className="flex gap-2.5">
      <span
        className="mono tnum shrink-0 flex items-center justify-center"
        aria-hidden
        style={{
          width: 18,
          height: 18,
          marginTop: 1,
          borderRadius: 999,
          border: "1px solid var(--line-strong)",
          color: "var(--accent)",
          fontSize: "var(--fs-micro)",
          fontWeight: 700,
        }}
      >
        {step.n}
      </span>
      <div className="flex-1 min-w-0">
        <div style={{ color: "var(--text)", fontSize: "12.5px", lineHeight: 1.5 }}>{step.cjk}</div>
        <div className="micro" style={{ color: "var(--text-faint)", marginTop: 1, lineHeight: 1.45 }}>
          {step.en}
        </div>
        {step.code && (
          <pre
            className="well mono data-sm mt-1.5"
            style={{
              color: "var(--text-dim)",
              padding: "0.45rem 0.6rem",
              overflowX: "auto",
              whiteSpace: "pre",
              lineHeight: 1.55,
            }}
          >
            {step.code}
            {step.codeComment ? (
              <span style={{ color: "var(--text-ghost)" }}>{"\n" + step.codeComment}</span>
            ) : null}
          </pre>
        )}
      </div>
    </li>
  );
}

export function OnboardingCard() {
  const source = useDataSource();
  const hydrated = useHydrated();
  const hasRecords = useRecords().length > 0;
  const setSource = useSetSource();

  // The "needs help" moment: Live, hydrated, but no evidence has arrived.
  const liveEmpty = source === "live" && hydrated && !hasRecords;

  return (
    <Panel
      eyebrow="快速开始 · quick-start"
      title="把数据喂给我 · feed me data"
      actions={
        liveEmpty ? (
          <span
            className="pill"
            style={{
              color: "var(--sev-warn)",
              background: "var(--sev-warn-bg)",
              borderColor: "var(--sev-warn-border)",
            }}
            title="Live source selected but ./data is empty — no evidence captured yet"
          >
            等待证据 · awaiting evidence
          </span>
        ) : undefined
      }
    >
      {liveEmpty ? (
        <p
          className="mb-3"
          style={{ color: "var(--text-dim)", fontSize: "12.5px", lineHeight: 1.55 }}
        >
          <span style={{ color: "var(--text)" }}>
            Live 已选中,但 {DATA_DIR_HINT} 尚无证据。
          </span>{" "}
          按下面三步把你的流量接进来 —— 或先看 Demo,零配置即可看懂全流程。
          <span className="micro block" style={{ color: "var(--text-faint)", marginTop: 2 }}>
            Live is selected but {DATA_DIR_HINT} is empty. Wire your traffic in below — or peek at Demo to see the whole story with zero setup.
          </span>
        </p>
      ) : (
        <p
          className="mb-3"
          style={{ color: "var(--text-dim)", fontSize: "12.5px", lineHeight: 1.55 }}
        >
          指一次 base URL,本台就开始实时 tail 你的证据链。下面是最小接入路径。
          <span className="micro block" style={{ color: "var(--text-faint)", marginTop: 2 }}>
            Point your base URL once; this console live-tails your evidence chain. The minimal path:
          </span>
        </p>
      )}

      <ol className="flex flex-col gap-2.5">
        {STEPS.map((s) => (
          <StepRow key={s.n} step={s} />
        ))}
      </ol>

      <div
        className="mt-3 pt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5"
        style={{ borderTop: "1px solid var(--line-soft)" }}
      >
        {liveEmpty && (
          <button
            type="button"
            onClick={() => setSource("demo")}
            className="micro mono link"
            style={{
              border: "1px solid var(--accent-dim)",
              background: "var(--accent-ghost)",
              color: "var(--accent-bright)",
              borderRadius: "var(--r-sm)",
              padding: "3px 9px",
              fontWeight: 600,
              letterSpacing: "0.03em",
            }}
            title="Switch to the bundled deterministic Demo (no setup, fully local)"
          >
            ▸ 先看 Demo · view Demo
          </button>
        )}
        <span className="micro" style={{ color: "var(--text-faint)", lineHeight: 1.5 }}>
          本台只读本地 {DATA_DIR_HINT},零外呼。配方搭的是代理,不是这块面板。
          <span style={{ color: "var(--text-ghost)" }}>
            {" "}
            · console reads local {DATA_DIR_HINT} only — zero external calls.
          </span>
        </span>
      </div>
    </Panel>
  );
}

export default OnboardingCard;
