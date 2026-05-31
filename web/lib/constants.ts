/**
 * lib/constants.ts — shared, dependency-free constants for both server and
 * client. Display labels, the analyzer version the demo stamps, and the
 * honest-boundary frames ported from report.py SCOPE_BANNER + each check's note.
 */

import type { CheckName, Provider, Severity, Status, VerifyStatus } from "./types.ts";

/** Mirrors analyzer/assay_analyzer/__init__.py __version__ (demo stamps this). */
export const ANALYZER_VERSION = "0.1.0a0";

/** Brand strings (bilingual, Chinese-primary). */
export const BRAND = {
  name: "assay",
  cjk: "照妖镜",
  tagline: "Live Audit Console",
  taglineCjk: "实时审计台",
} as const;

/** LOCAL-ONLY badge text (the dashboard makes ZERO external calls). */
export const LOCAL_ONLY_BADGE = {
  cjk: "本地直读 ./data · 无外呼",
  en: "LOCAL-ONLY · reads ./data · no network",
} as const;

/** Display order for checks (mirrors report.py `order`). */
export const CHECK_ORDER: CheckName[] = [
  "token_recount",
  "model_identity",
  "provenance",
  "exposure",
  "cache_replay",
  "throughput",
];

/** The five checks actually emitted in Phase 0 (model_identity is Phase 1). */
export const PHASE0_CHECKS: CheckName[] = [
  "token_recount",
  "provenance",
  "exposure",
  "cache_replay",
  "throughput",
];

/** Bilingual labels for each check (Chinese-primary, English technical term). */
export const CHECK_LABELS: Record<CheckName, { cjk: string; en: string }> = {
  token_recount: { cjk: "用量重算", en: "token_recount" },
  provenance: { cjk: "上游来源", en: "provenance" },
  exposure: { cjk: "数据泄露下界", en: "exposure" },
  cache_replay: { cjk: "缓存重放", en: "cache_replay" },
  throughput: { cjk: "吞吐遥测", en: "throughput" },
  model_identity: { cjk: "模型身份 · MMD", en: "model_identity" },
};

/** One-line honest frame per check (what a flag/skip does and does NOT mean). */
export const CHECK_HONEST_FRAME: Record<CheckName, string> = {
  token_recount:
    "仅对真·OpenAI chat 强;Claude/Gemini/未知模型 skip 属正常。对比的是「你的请求」——中转站在上游加的 prompt padding 此处不可见。",
  provenance:
    "标记可伪造:通过=「与真上游一致」,绝非「已证明为真品」;缺标记是怀疑非定罪;它不说哪个模型服务了你(Phase 1)。",
  exposure:
    "下界 / at least N — 已测量、未阻止。检测到 0 ≠ 安全。assay 阻止不了中转站读取明文(MITM 物理事实)。",
  cache_replay:
    "弱启发式:同 prompt → 同输出(尤其 temp=0)属正常,不报。只抓「不同请求 → 雷同长响应」。",
  throughput:
    "仅遥测 / telemetry。tok/s 反映中转站节流而非模型速度。仅在物理不可能时才 flag。",
  model_identity:
    "主动探针 MMD 分布检验:需 `assay calibrate` 建可信参考,无参考则 skip。flag = 与参考分布不同、非「欺诈」(良性量化无法区分);仅对探针生效、可被规避;参考被信任非被验证。",
};

/** report.py SCOPE_BANNER — the mandatory honest-limits statement. Ported to a
 *  bilingual, structured form for the ScopeBanner component. The English mirrors
 *  the Python text verbatim in spirit; the Chinese leads (repo is CJK-primary). */
export const SCOPE_BANNER = {
  headline: {
    cjk: "范围与诚实边界 — 干净的报告不等于干净的体检报告",
    en: "SCOPE & HONEST LIMITS — a clean report is NOT a clean bill of health",
  },
  oneLine: {
    cjk: "「无 flag」≠「正品 / 安全」。模型身份仅由主动探针检验(需 assay calibrate),你在此看到的常规流量不做身份检验。",
    en: "'No flags' ≠ 'genuine / safe'. Model identity is tested only by active probes (needs `assay calibrate`); the organic traffic shown here is not identity-tested.",
  },
  points: [
    {
      key: "model_identity",
      cjk: "模型身份由主动探针(model_identity / MMD)检测,需用 `assay calibrate` 建可信参考;无参考则 SKIP。flag = 输出分布与参考不同,绝非「欺诈」(良性量化 / 微调无法区分);只对探针生效——中转站若只对探针发真模型即可规避;参考是「被信任」非「被验证」。你在此看到的常规流量不做身份检验。",
      en: "MODEL IDENTITY is tested ONLY by active probes (model_identity / MMD), which need a genuine reference via `assay calibrate`; with none it SKIPS. A flag = output distribution DIFFERS from the reference, NOT 'fraud' (benign quantization/finetune indistinguishable); active-probe only — a relay serving genuine-to-probes evades it; the reference is TRUSTED, not verified. The organic traffic shown here is NOT identity-tested.",
    },
    {
      key: "provenance",
      cjk: "provenance 只看上游响应头,而头部可伪造——「与之一致」,绝非「已证明为真」;缺标记是怀疑,非定罪。",
      en: "provenance only checks upstream headers, which are FORGEABLE — 'consistent with', never 'proven genuine'; absence is suspicion, not proof.",
    },
    {
      key: "exposure",
      cjk: "数据泄露是「度量」而非「阻止」:assay 阻止不了中转站读取你发送的内容(它必须解密才能转发——MITM 物理事实)。泄露计数是下界(「至少 N」);检测到 0 ≠ 安全。",
      en: "DATA EXPOSURE is MEASURED, not PREVENTED: assay CANNOT stop the relay reading what you send (it must decrypt to forward — the MITM reality). The exposure count is a LOWER BOUND ('at least N'); zero detected ≠ safe.",
    },
    {
      key: "token_recount",
      cjk: "token_recount 对比的是「你的请求」(中转站在上游加的 prompt padding 不可见),且对 Claude/Gemini 一律 skip(无公开分词器)。",
      en: "token_recount compares against YOUR request (prompt padding the relay adds UPSTREAM is invisible) and SKIPS Claude/Gemini (no public tokenizer).",
    },
  ],
  tamper: {
    cjk: "证据被篡改 — 以下裁决不可信。",
    en: "EVIDENCE TAMPERED — verdicts below cannot be trusted.",
  },
} as const;

/** Chain-status pill display (label + tone). BREAK ⇒ tamper. */
export const CHAIN_STATUS_META: Record<
  VerifyStatus,
  { label: string; cjk: string; tone: "ok" | "info" | "warn" | "tamper" }
> = {
  VALID: { label: "VALID", cjk: "链完整", tone: "ok" },
  EMPTY: { label: "EMPTY", cjk: "暂无证据", tone: "info" },
  TORN_TAIL: { label: "TORN_TAIL", cjk: "尾行残缺(可恢复)", tone: "warn" },
  BREAK: { label: "BREAK", cjk: "链断裂 · 篡改", tone: "tamper" },
};

/** Provider chip display. */
export const PROVIDER_META: Record<
  Provider,
  { label: string; colorVar: string; bgVar: string }
> = {
  openai: { label: "openai", colorVar: "--prov-openai", bgVar: "--prov-openai-bg" },
  anthropic: { label: "anthropic", colorVar: "--prov-anthropic", bgVar: "--prov-anthropic-bg" },
  gemini: { label: "gemini", colorVar: "--prov-gemini", bgVar: "--prov-gemini-bg" },
  unknown: { label: "unknown", colorVar: "--prov-unknown", bgVar: "--prov-unknown-bg" },
};

/** Severity display (label + the CSS var token feature agents use). */
export const SEVERITY_META: Record<
  Severity,
  { label: string; colorVar: string; bgVar: string; borderVar: string }
> = {
  info: { label: "INFO", colorVar: "--sev-info", bgVar: "--sev-info-bg", borderVar: "--sev-info-border" },
  warn: { label: "WARN", colorVar: "--sev-warn", bgVar: "--sev-warn-bg", borderVar: "--sev-warn-border" },
  critical: {
    label: "CRITICAL",
    colorVar: "--sev-critical",
    bgVar: "--sev-critical-bg",
    borderVar: "--sev-critical-border",
  },
};

/** Verdict status display. skip ≠ fail → muted/neutral, never red. */
export const STATUS_META: Record<
  Status,
  { label: string; cjk: string; tone: "ok" | "flag" | "skip" | "error" }
> = {
  ok: { label: "OK", cjk: "通过", tone: "ok" },
  flag: { label: "FLAG", cjk: "标记", tone: "flag" },
  skip: { label: "SKIP", cjk: "跳过 (不适用)", tone: "skip" },
  error: { label: "ERROR", cjk: "执行错误", tone: "error" },
};

/** UNTRUSTED field paths — feature agents tag these in the UI. */
export const UNTRUSTED_NOTE = {
  cjk: "不可信 / UNTRUSTED — 由中转站自报,可伪造",
  en: "UNTRUSTED — relay-reported, forgeable",
} as const;
