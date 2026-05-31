/**
 * lib/types.ts — the frozen TypeScript contract for the assay (照妖镜) audit
 * console. These types mirror, byte-for-byte where it matters:
 *
 *   - internal/evidence/record.go        (EvidenceRecord + Usage struct + json tags)
 *   - schemas/evidence.schema.json       (note: record.go is authoritative; the
 *                                         schema file is stale — it predates the
 *                                         §4 typed digest and still says ttft_ms /
 *                                         JCS. We follow record.go + digest.go.)
 *   - analyzer/assay_analyzer/checks/*.py (exact verdict.detail shapes)
 *   - internal/evidence/verify.go        (VerifyStatus)
 *   - internal/proxy/classify.go         (Provider / ApiSurface enums)
 *   - analyzer/assay_analyzer/runner.py  (heartbeat / lag shape)
 *
 * IMPORTANT for feature agents: do NOT widen or rename these. The digest port
 * (lib/digest.ts) hashes EvidenceRecord field-by-field in the order defined by
 * digest.go; any shape drift breaks hash recompute and the cross-impl vectors.
 *
 * UNTRUSTED fields (label them so in the UI): response.claimed_usage,
 * response.claimed_model, response.system_fingerprint, response.headers,
 * route.claimed_model. These are relay-reported and forgeable.
 */

/* ============================================================================
   Enums (string unions) — mirror classify.go + verify.go + base.py
   ========================================================================== */

/** Provider, classified by REQUEST PATH (never by the model string). */
export type Provider = "openai" | "anthropic" | "gemini" | "unknown";

/** API surface, classified by request path. */
export type ApiSurface =
  | "chat.completions"
  | "responses"
  | "messages"
  | "generateContent"
  | "embeddings"
  | "other";

/** Verdict check names. `model_identity` is reserved (Phase 1) — present in the
 *  schema enum and report ordering, never emitted in Phase 0. */
export type CheckName =
  | "token_recount"
  | "provenance"
  | "exposure"
  | "cache_replay"
  | "throughput"
  | "model_identity";

/** Verdict status. skip ≠ fail — render skip muted/neutral, never red. */
export type Status = "ok" | "flag" | "skip" | "error";

/** Verdict severity. estimate_only never escalates past `info`. */
export type Severity = "info" | "warn" | "critical";

/** Chain verification outcome (verify.go). BREAK ⇒ loud TAMPER state. */
export type VerifyStatus = "VALID" | "EMPTY" | "TORN_TAIL" | "BREAK";

/** Where the dashboard's current data came from. */
export type DataSource = "demo" | "live";

/** Raw body encoding fallback (identity utf8, base64 for non-UTF-8 bytes). */
export type RawEncoding = "utf8" | "base64";

/* ============================================================================
   EvidenceRecord — mirrors internal/evidence/record.go EXACTLY.
   Field presence/optionality matches the Go json tags + the digest encoding.
   ========================================================================== */

/** Relay-reported usage. UNTRUSTED. Pointers in Go → optional here; the digest
 *  treats absent and explicit-null identically (opt_u64 0x00). */
export interface Usage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  completion_tokens_details?: CompletionTokensDetails | null;
  prompt_tokens_details?: PromptTokensDetails | null;
}

export interface CompletionTokensDetails {
  reasoning_tokens?: number | null;
}

export interface PromptTokensDetails {
  cached_tokens?: number | null;
}

/** Header map: lowercase keys → list of values (Go http.Header shape). */
export type Headers = Record<string, string[]>;

export interface Route {
  method: string;
  path: string;
  upstream: string;
  /** from request body.model; may be null. UNTRUSTED. */
  claimed_model: string | null;
  provider: Provider;
  api_surface: ApiSurface;
}

export interface RequestPart {
  /** redacted; Authorization/x-api-key/cookie/etc → ["REDACTED"]. lowercase keys. */
  headers: Headers;
  /** exact request body, stored raw (not re-serialized). */
  raw: string;
  raw_encoding: RawEncoding;
  /** hex sha256 of raw bytes ("" if not computed). PART OF THE DIGEST. */
  raw_sha256: string;
  /** true total bytes even if truncated. */
  bytes: number;
  truncated: boolean;
}

export interface ResponsePart {
  status: number;
  /** unmodified upstream headers, lowercase keys. UNTRUSTED. */
  headers: Headers;
  stream: boolean;
  /** saw [DONE] / clean EOF. false ⇒ partial capture ⇒ analyzers skip. */
  complete: boolean;
  /** upstream's Content-Encoding; should be identity after AE strip. UNTRUSTED. */
  content_encoding: string | null;
  /** non-stream: exact body; stream: exact concatenated SSE text. */
  raw: string;
  raw_encoding: RawEncoding;
  raw_sha256: string;
  bytes: number;
  truncated: boolean;
  /** null when stream w/o include_usage. UNTRUSTED. */
  claimed_usage: Usage | null;
  /** echoed model. UNTRUSTED. */
  claimed_model: string | null;
  /** UNTRUSTED. */
  system_fingerprint: string | null;
}

/** Integer MICROSECONDS (no floats — keeps the digest deterministic). */
export interface Timing {
  /** request sent → first non-empty delta.content; null for non-stream. */
  ttft_us: number | null;
  total_us: number | null;
  /** SSE data events with non-empty choices (excludes [DONE] / usage-only). */
  stream_chunks: number;
  conn_reused: boolean;
  upstream_connect_us: number | null;
}

export interface Capture {
  /** false = capture incomplete (overload drop / redaction / decode failure). */
  tee_ok: boolean;
  client_disconnected: boolean;
  note: string | null;
}

/** One immutable, hash-chained evidence entry (evidence.jsonl, one per line). */
export interface EvidenceRecord {
  v: 1;
  /** monotonic from 0; assigned by the writer goroutine. */
  seq: number;
  /** uuidv7. */
  id: string;
  /** RFC3339Nano; when proxy received the client request. */
  ts_start: string;
  /** sha256 of previous record's hash; genesis = 64×"0". */
  prev_hash: string;
  /** hex(sha256(canon(record))); excluded from canon. */
  hash: string;
  route: Route;
  request: RequestPart;
  response: ResponsePart;
  timing: Timing;
  capture: Capture;
}

/** prev_hash of the seq=0 record (64 hex zeros). */
export const GENESIS_PREV_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

/* ============================================================================
   Verdict detail shapes — mirror analyzer/assay_analyzer/checks/*.py EXACTLY.
   Each is keyed to a CheckName; VerdictDetail is the discriminated union.
   Fields are optional where the Python only sets them on some code paths.
   ========================================================================== */

/** token_recount.py — independently recompute OpenAI usage with tiktoken. */
export interface TokenRecountDetail {
  provider: Provider | string;
  api_surface: ApiSurface | string;
  encoding?: string;
  /** present on the run path; skip path omits it. */
  eligible?: boolean;
  estimate_only?: boolean;
  estimate_reasons?: string[];
  claimed?: { prompt: number | null; completion: number | null };
  recomputed?: { prompt: number | null; completion: number | null };
  framing?: { tokens_per_message: number; reply_priming: number };
  tolerance_pct?: number;
  min_abs_tokens?: number;
  note?: string;
  /** completion comparison (set when both sides present). */
  completion_delta?: number;
  completion_delta_pct?: number | null;
  /** WARN path: billed greatly exceeds visible. */
  billed_exceeds_visible_pct?: number;
  /** prompt comparison (observation only). negative = relay over-claims. */
  prompt_delta?: number;
  prompt_delta_pct?: number;
  observations?: string[];
  /** skip path: {reason, provider, api_surface}. */
  reason?: string;
}

/** provenance.py — passive upstream-fingerprint scoring. */
export interface ProvenanceDetail {
  claimed_model: string | null;
  expected_upstream: string;
  relay_stack_tells: string[];
  /** present on the scored path. */
  signals_present?: string[];
  signals_absent?: string[];
  score?: number;
  max_score?: number;
  note: string;
  /** skip path: no signature library for this upstream. */
  reason?: string;
}

/** exposure.py — lower-bound egress measurement (request + response). */
export interface ExposureScan {
  /** secret type → count, e.g. {"openai_key": 1}. */
  secrets: Record<string, number>;
  /** pii type → count. */
  pii: Record<string, number>;
  high_entropy_blobs: number;
  code_blocks: number;
}

export interface ExposureDetail {
  request: ExposureScan;
  response: ExposureScan;
  truncated_capture: boolean;
  /** detector identity → version (reproducibility). */
  detector_versions: Record<string, string>;
  /** ALWAYS true — "at least N", measured not prevented. */
  lower_bound: true;
  note: string;
}

/** cache_replay.py — same long response served for ≥2 distinct requests. */
export interface CacheReplayDetail {
  resp_fingerprint?: string;
  normalized_len?: number;
  distinct_request_count?: number;
  first_seen_record_id?: string;
  temperature?: number | null;
  has_seed?: boolean;
  note?: string;
  /** skip path: {reason} (+ normalized_len on below_min_len). */
  reason?: string;
}

/** throughput.py — telemetry only; flag only on physically impossible tok/s. */
export interface ThroughputDetail {
  completion_tokens_used?: number;
  gen_us?: number;
  ttft_us?: number | null;
  tokens_per_s?: number;
  ceiling_tps?: number;
  stream_chunks?: number;
  note?: string;
  /** skip path: {reason} (+ ttft_us/total_us on low_resolution). */
  reason?: string;
  total_us?: number | null;
}

/** model_identity.py — MMD two-sample test on active-probe completions. */
export interface ModelIdentityPerRef {
  /** unbiased U-statistic MMD² (null when insufficient shared evidence). */
  mmd2: number | null;
  /** permutation p-value (null when insufficient). */
  pvalue: number | null;
  n_ref: number;
  n_probe: number;
  length: number;
  shared_prompts: number;
  insufficient: boolean;
}

export interface ModelIdentityDetail {
  model: string | null;
  probe_batch_digest?: string;
  member_record_hashes?: string[];
  /** verbatim honest note (flag ≠ fraud; evadable; reference trusted not verified). */
  note: string;
  alpha?: number;
  permutations?: number;
  /** precision label (e.g. "fp16") → per-reference MMD result. */
  per_reference?: Record<string, ModelIdentityPerRef>;
  /** composite null: rejected vs EVERY usable reference (the flag condition). */
  rejected_all?: boolean;
  rejected_any?: boolean;
  all_insufficient?: boolean;
  usable_references?: number;
  /** skip paths: "no_reference" | "param_mismatch". */
  reason?: string;
  /** param_mismatch path: per-reference mismatch descriptions. */
  mismatches?: string[];
}

/** Fallback for any forward-compatible / not-yet-modeled detail. */
export type UnknownDetail = Record<string, unknown>;

/** Discriminated mapping check → detail. */
export interface VerdictDetailByCheck {
  token_recount: TokenRecountDetail;
  provenance: ProvenanceDetail;
  exposure: ExposureDetail;
  cache_replay: CacheReplayDetail;
  throughput: ThroughputDetail;
  model_identity: ModelIdentityDetail;
}

/** Any verdict detail. */
export type VerdictDetail =
  | TokenRecountDetail
  | ProvenanceDetail
  | ExposureDetail
  | CacheReplayDetail
  | ThroughputDetail
  | ModelIdentityDetail
  | UnknownDetail;

/* ============================================================================
   VerdictRecord — mirrors base.py new_verdict() + verdict.schema.json.
   Derived, reproducible; NOT part of the evidence hash chain.
   ========================================================================== */

/** A verdict whose `check` discriminates `detail`. Use this generic form when
 *  you have narrowed the check; `VerdictRecord` is the open union. */
export interface Verdict<C extends CheckName = CheckName> {
  v: 1;
  record_id: string;
  record_seq: number;
  /** binds verdict to exact evidence → reproducible. */
  record_hash: string;
  check: C;
  analyzer_version: string;
  /** RFC3339; wall-clock stamp, excluded from reproducible identity. */
  ts: string;
  status: Status;
  severity: Severity;
  summary: string;
  detail: C extends keyof VerdictDetailByCheck
    ? VerdictDetailByCheck[C]
    : VerdictDetail;
}

/** The open verdict union as it appears in verdicts.jsonl. */
export type VerdictRecord =
  | Verdict<"token_recount">
  | Verdict<"provenance">
  | Verdict<"exposure">
  | Verdict<"cache_replay">
  | Verdict<"throughput">
  | Verdict<"model_identity">;

/* ----- per-check verdict narrowing helper (handy for VerdictDetail.tsx) -----
   Narrows a VerdictRecord to the concrete per-check variant so `detail` is
   typed. Implemented against the discriminated union (not a free generic) so
   the type predicate is sound. */
export function isCheck<C extends CheckName>(
  v: VerdictRecord,
  check: C,
): v is Extract<VerdictRecord, { check: C }> {
  return v.check === check;
}

/* ============================================================================
   Chain verification result — mirrors verify.go VerifyResult (TS recompute).
   ========================================================================== */

export interface VerifyResult {
  status: VerifyStatus;
  /** count of fully-verified records. */
  records: number;
  /** seq at which a BREAK was detected, if any. */
  break_seq: number | null;
  detail: string;
  /** non-fatal observations (e.g. timestamp regression). */
  warnings: string[];
  /** hash of the last verified record (genesis if none). */
  head_hash: string;
}

/* ============================================================================
   Analyzer lag — mirrors runner.py heartbeat payload.
   ========================================================================== */

export interface AnalyzerLag {
  last_processed_seq: number;
  /** highest evidence seq seen. */
  evidence_head_seq: number;
  /** max(0, head - processed). */
  lag_records: number;
  /** RFC3339; when the heartbeat was written (null if unknown). */
  updated_at: string | null;
}

/* ============================================================================
   Aggregates / scorecard — derived client+server side for StatRow / ChecksPanel.
   Mirrors the meaning of report.py build_report (tally by check, flags list).
   ========================================================================== */

/** ok/flag/skip/error tally for one check. */
export interface CheckTally {
  ok: number;
  flag: number;
  skip: number;
  error: number;
  total: number;
  /** worst severity among this check's flags ("none" if no flag). */
  worst: Severity | "none";
}

/** counts bucketed by severity across all flagged verdicts. */
export interface SeverityCounts {
  info: number;
  warn: number;
  critical: number;
}

export interface ProviderMix {
  openai: number;
  anthropic: number;
  gemini: number;
  unknown: number;
}

/** A single point for the req/min sparkline (epoch-minute bucket → count). */
export interface RatePoint {
  /** minute bucket start, epoch ms. */
  t: number;
  count: number;
}

/** Everything the overview/stat layer needs, recomputable from records+verdicts. */
export interface Aggregates {
  total_requests: number;
  /** req/min over a trailing window, oldest→newest. */
  rate_series: RatePoint[];
  /** flags bucketed by severity. */
  severity: SeverityCounts;
  provider_mix: ProviderMix;
  /** % of verdicts with status "skip" (0..100). */
  skipped_pct: number;
  /** lower-bound count of egressed secrets across all records (exposure). */
  exposure_secret_lower_bound: number;
  /** per-check tallies, keyed by CheckName. */
  by_check: Partial<Record<CheckName, CheckTally>>;
  /** total verdicts seen. */
  verdict_count: number;
}

/* ============================================================================
   Wire shape — /api/snapshot response and the SSE event payloads.
   Demo and Live share this shape (the toggle only swaps the source).
   ========================================================================== */

export interface Snapshot {
  records: EvidenceRecord[];
  verdicts: VerdictRecord[];
  aggregates: Aggregates;
  chainStatus: VerifyResult;
  lag: AnalyzerLag;
  source: DataSource;
  /** if Demo and a BREAK was injected, the seq it was injected at. */
  breakAt?: number | null;
}

/** SSE event names emitted by /api/stream. */
export type StreamEventName = "evidence" | "verdict" | "meta" | "ping";

/** payload of a `meta` SSE event (chain/lag/source refresh). */
export interface StreamMeta {
  chainStatus: VerifyResult;
  lag: AnalyzerLag;
  source: DataSource;
  breakAt?: number | null;
}
