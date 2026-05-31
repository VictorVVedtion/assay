/**
 * lib/server/demo.ts — DETERMINISTIC, schema-faithful demo data source.
 *
 * `npm run dev` with no real data instantly tells the whole assay story:
 *   seq 0  non-stream openai chat, honest usage          → token_recount OK,
 *                                                            provenance OK, etc.
 *   seq 1  streaming SSE openai chat, VISIBLE > BILLED    → token_recount CRITICAL
 *   seq 2  non-stream openai chat, BILLED >> VISIBLE      → token_recount WARN (inflation)
 *   seq 3  anthropic /v1/messages, masquerade (no native  → provenance WARN (score 0)
 *          markers)                                          + token_recount SKIP (non-openai)
 *   seq 4  openai chat with a leaked sk- key in request   → exposure WARN
 *   seq 5  cache replay: same long answer, DIFFERENT req  → cache_replay FLAG
 *          (paired with seq 0's identical response)
 *   seq 6  gemini :generateContent                        → token_recount SKIP (non-openai)
 *
 * Every record is chained with lib/digest canon() exactly as the Go data plane
 * would, so the in-browser digest-recompute in EvidenceDrawer shows VALID and
 * prev_hash linkage holds. The BREAK toggle mutates ONE record's body AFTER its
 * hash is computed (and re-links following prev_hashes to that record's stored,
 * now-stale hash) so the chain verifies as BREAK@seq — exactly the tamper case.
 *
 * Verdicts are hand-authored to match the EXACT detail shapes emitted by
 * analyzer/assay_analyzer/checks/*.py, including every honest-boundary note.
 * They are bound to each record's real hash (record_hash) so they stay
 * reproducible. SERVER ONLY (it imports the digest, which is isomorphic, but
 * this module is only consumed by the API routes).
 */

import { computeHash, GENESIS_PREV_HASH } from "../digest.ts";
import { ANALYZER_VERSION } from "../constants.ts";
import type {
  CacheReplayDetail,
  EvidenceRecord,
  ExposureDetail,
  Headers,
  ProvenanceDetail,
  ThroughputDetail,
  TokenRecountDetail,
  Usage,
  VerdictRecord,
} from "../types.ts";

/* A fixed clock so the demo is byte-deterministic across runs. */
const T0 = Date.parse("2026-05-30T09:15:00.000Z");
const UPSTREAM = "https://relay.example.com";

/* uuidv7-shaped deterministic ids (the timestamp prefix is fabricated but the
 * shape is faithful; the analyzer never parses them). */
function demoId(seq: number): string {
  const n = (seq + 1).toString(16).padStart(12, "0");
  return `0192f100-0000-7000-8000-${n}`;
}

function tsAt(seq: number, offsetMs = 0): string {
  // RFC3339Nano with zero-padded nanoseconds.
  const d = new Date(T0 + seq * 4000 + offsetMs);
  const iso = d.toISOString(); // ...sssZ
  return iso.replace("Z", "000000Z");
}

interface DraftRecord {
  id: string;
  ts_start: string;
  route: EvidenceRecord["route"];
  request: Omit<EvidenceRecord["request"], "raw_sha256"> & { raw_sha256?: string };
  response: Omit<EvidenceRecord["response"], "raw_sha256"> & { raw_sha256?: string };
  timing: EvidenceRecord["timing"];
  capture: EvidenceRecord["capture"];
}

/* ---- small builders to keep the drafts readable ---- */

function jsonHeaders(extra: Headers = {}): Headers {
  return { "content-type": ["application/json"], ...extra };
}
function sseHeaders(extra: Headers = {}): Headers {
  return { "content-type": ["text/event-stream"], ...extra };
}

function usage(
  prompt: number,
  completion: number,
  extra: Partial<Usage> = {},
): Usage {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...extra,
  };
}

const NOTE_TR =
  "recompute is a close estimate, not a byte-exact oracle; prompt-side padding the relay adds UPSTREAM is invisible here";
const NOTE_PROV =
  "presence = consistent with genuine upstream (markers are FORGEABLE, so never 'proven genuine'); absence = suspicion, not proof; says nothing about WHICH model served you (that is Phase 1).";
function exposureNote(truncated: boolean): string {
  return (
    "LOWER BOUND of what egressed to the relay -- 'at least', never 'safe'. " +
    "assay does NOT prevent the relay reading this; it measures so you can ship less. " +
    "Zero detected != zero present (detectors miss novel secrets, ambiguous/non-Western " +
    "names, inferable identity). Scans request AND response. " +
    (truncated
      ? "Capture was TRUNCATED at the proxy cap -- content past the cap is uncounted, so the true exposure is HIGHER than this. "
      : "")
  );
}
const NOTE_CACHE =
  "exact-replay tripwire only; paraphrase/regeneration evades (out of Phase 0 scope)";
const NOTE_TP = "measures relay pacing, not model speed; informational only";

/* A long assistant answer reused by the cache-replay pair (≥64 normalized chars). */
const SHARED_ANSWER =
  "To reset your password, open Settings, choose Security, then select Reset Password and follow the emailed link. The link expires in fifteen minutes for your protection.";

/* The streamed seq-1 sentence (delivered over SSE). Lifted to module scope so the
 * cache_replay verdict derives its normalized_len + fingerprint from this exact
 * text (mirroring cache_replay.py over the reconstructed assistant text) rather
 * than hardcoding — 105 normalized chars, above min_normalized_len=64. */
const OCEAN_ANSWER =
  "The ocean is a vast, restless expanse of saltwater that covers most of the planet and shapes its climate.";

/* seq-4 assistant answer (140 normalized chars, also above the 64 floor). */
const ROTATE_ANSWER =
  "Please rotate that key immediately — you just shared a secret. A 401 usually means the key is invalid, revoked, or missing the right header.";

/* ============================================================================
   The seven drafts (pre-hash). Order defines seq.
   ========================================================================== */

function drafts(): DraftRecord[] {
  const out: DraftRecord[] = [];

  // seq 0 — honest non-stream OpenAI chat. Baseline "all good within scope".
  {
    const reqBody = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a concise support assistant." },
        { role: "user", content: "How do I reset my password?" },
      ],
    };
    const respBody = {
      id: "chatcmpl-DEMO0",
      object: "chat.completion",
      model: "gpt-4o-2024-08-06",
      choices: [
        { index: 0, message: { role: "assistant", content: SHARED_ANSWER }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 27, completion_tokens: 38, total_tokens: 65 },
    };
    const reqRaw = JSON.stringify(reqBody);
    const respRaw = JSON.stringify(respBody);
    out.push({
      id: demoId(0),
      ts_start: tsAt(0),
      route: {
        method: "POST",
        path: "/v1/chat/completions",
        upstream: UPSTREAM,
        claimed_model: "gpt-4o",
        provider: "openai",
        api_surface: "chat.completions",
      },
      request: {
        headers: jsonHeaders({ authorization: ["REDACTED"] }),
        raw: reqRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(reqRaw),
        truncated: false,
      },
      response: {
        status: 200,
        headers: jsonHeaders({
          "openai-version": ["2020-10-01"],
          "openai-organization": ["org-demo"],
          "x-request-id": ["req_demo0"],
        }),
        stream: false,
        complete: true,
        content_encoding: null,
        raw: respRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(respRaw),
        truncated: false,
        claimed_usage: usage(27, 38),
        claimed_model: "gpt-4o-2024-08-06",
        system_fingerprint: "fp_demo_0a",
      },
      timing: {
        ttft_us: null,
        total_us: 742_000,
        stream_chunks: 0,
        conn_reused: false,
        upstream_connect_us: 61_000,
      },
      capture: { tee_ok: true, client_disconnected: false, note: null },
    });
  }

  // seq 1 — STREAMING SSE chat, VISIBLE completion > BILLED → token_recount CRITICAL.
  // Billed completion=2 but the delivered text is clearly more tokens.
  {
    const reqBody = {
      model: "gpt-4o",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Write one sentence about the ocean." }],
    };
    const deliveredText = OCEAN_ANSWER;
    // Build an SSE body delivering deliveredText across a few chunks, then a
    // usage-only terminal chunk under-reporting completion, then [DONE].
    const words = deliveredText.split(" ");
    const dataLines: string[] = [];
    let acc = "";
    for (let i = 0; i < words.length; i++) {
      const piece = (i === 0 ? "" : " ") + words[i];
      acc += piece;
      dataLines.push(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}`,
      );
    }
    dataLines.push(
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 13, completion_tokens: 2, total_tokens: 15 },
      })}`,
    );
    dataLines.push("data: [DONE]");
    const respRaw = dataLines.join("\n\n") + "\n\n";
    const reqRaw = JSON.stringify(reqBody);
    void acc;
    out.push({
      id: demoId(1),
      ts_start: tsAt(1),
      route: {
        method: "POST",
        path: "/v1/chat/completions",
        upstream: UPSTREAM,
        claimed_model: "gpt-4o",
        provider: "openai",
        api_surface: "chat.completions",
      },
      request: {
        headers: jsonHeaders({ authorization: ["REDACTED"] }),
        raw: reqRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(reqRaw),
        truncated: false,
      },
      response: {
        status: 200,
        headers: sseHeaders({
          "openai-version": ["2020-10-01"],
          "x-request-id": ["req_demo1"],
        }),
        stream: true,
        complete: true,
        content_encoding: null,
        raw: respRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(respRaw),
        truncated: false,
        claimed_usage: usage(13, 2),
        claimed_model: "gpt-4o-2024-08-06",
        system_fingerprint: "fp_demo_1b",
      },
      timing: {
        ttft_us: 318_000,
        total_us: 1_905_000,
        stream_chunks: words.length,
        conn_reused: true,
        upstream_connect_us: 0,
      },
      capture: { tee_ok: true, client_disconnected: false, note: null },
    });
  }

  // seq 2 — non-stream chat, BILLED >> VISIBLE on a plain gpt-4o → token_recount WARN.
  // Short visible answer, but billed completion hugely inflated.
  {
    const reqBody = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Say hi." }],
    };
    const respBody = {
      id: "chatcmpl-DEMO2",
      model: "gpt-4o-2024-08-06",
      choices: [
        { index: 0, message: { role: "assistant", content: "Hi! How can I help you today?" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 240, total_tokens: 252 },
    };
    const reqRaw = JSON.stringify(reqBody);
    const respRaw = JSON.stringify(respBody);
    out.push({
      id: demoId(2),
      ts_start: tsAt(2),
      route: {
        method: "POST",
        path: "/v1/chat/completions",
        upstream: UPSTREAM,
        claimed_model: "gpt-4o",
        provider: "openai",
        api_surface: "chat.completions",
      },
      request: {
        headers: jsonHeaders({ authorization: ["REDACTED"] }),
        raw: reqRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(reqRaw),
        truncated: false,
      },
      response: {
        status: 200,
        headers: jsonHeaders({ "openai-version": ["2020-10-01"], "x-request-id": ["req_demo2"] }),
        stream: false,
        complete: true,
        content_encoding: null,
        raw: respRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(respRaw),
        truncated: false,
        claimed_usage: usage(12, 240),
        claimed_model: "gpt-4o-2024-08-06",
        system_fingerprint: "fp_demo_2c",
      },
      timing: {
        ttft_us: null,
        total_us: 690_000,
        stream_chunks: 0,
        conn_reused: true,
        upstream_connect_us: 0,
      },
      capture: { tee_ok: true, client_disconnected: false, note: null },
    });
  }

  // seq 3 — Anthropic /v1/messages, NO native Anthropic markers → provenance WARN(0).
  // token_recount SKIPs (non-openai). new-api transcode tell present.
  {
    const reqBody = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 256,
      messages: [{ role: "user", content: "Summarize the plot of Hamlet in one line." }],
    };
    const respBody = {
      // Re-wrapped into OpenAI-ish shape by the relay; crucially NO msg_ id and
      // NO anthropic-* headers below → score 0.
      id: "chatcmpl-rewrapped-DEMO3",
      model: "claude-3-5-sonnet-20241022",
      choices: [
        { index: 0, message: { role: "assistant", content: "A grieving prince feigns madness to avenge his murdered father." }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 22, completion_tokens: 16, total_tokens: 38, usage_source: "anthropic" },
    };
    const reqRaw = JSON.stringify(reqBody);
    const respRaw = JSON.stringify(respBody);
    out.push({
      id: demoId(3),
      ts_start: tsAt(3),
      route: {
        method: "POST",
        path: "/v1/messages",
        upstream: UPSTREAM,
        claimed_model: "claude-3-5-sonnet-20241022",
        provider: "anthropic",
        api_surface: "messages",
      },
      request: {
        headers: jsonHeaders({ "x-api-key": ["REDACTED"], "anthropic-version": ["2023-06-01"] }),
        raw: reqRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(reqRaw),
        truncated: false,
      },
      response: {
        status: 200,
        headers: jsonHeaders({
          // relay-stack tells, but ZERO genuine anthropic fingerprints
          "x-new-api-version": ["0.8.4"],
          "x-oneapi-request-id": ["oneapi-demo3"],
        }),
        stream: false,
        complete: true,
        content_encoding: null,
        raw: respRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(respRaw),
        truncated: false,
        claimed_usage: usage(22, 16),
        claimed_model: "claude-3-5-sonnet-20241022",
        system_fingerprint: null,
      },
      timing: {
        ttft_us: null,
        total_us: 980_000,
        stream_chunks: 0,
        conn_reused: false,
        upstream_connect_us: 72_000,
      },
      capture: { tee_ok: true, client_disconnected: false, note: null },
    });
  }

  // seq 4 — OpenAI chat with a LEAKED sk- key in the request body → exposure WARN.
  // (The proxy redacts headers, but a key pasted into message content egresses.)
  {
    const leakedKey = "sk-proj-DEMO1234abcd5678efgh9012ijkl3456mnop";
    const reqBody = {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `Here is my API key, please debug my script: ${leakedKey}. It returns 401.`,
        },
      ],
    };
    const respBody = {
      id: "chatcmpl-DEMO4",
      model: "gpt-4o-mini-2024-07-18",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: ROTATE_ANSWER,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 31, completion_tokens: 33, total_tokens: 64 },
    };
    const reqRaw = JSON.stringify(reqBody);
    const respRaw = JSON.stringify(respBody);
    out.push({
      id: demoId(4),
      ts_start: tsAt(4),
      route: {
        method: "POST",
        path: "/v1/chat/completions",
        upstream: UPSTREAM,
        claimed_model: "gpt-4o-mini",
        provider: "openai",
        api_surface: "chat.completions",
      },
      request: {
        headers: jsonHeaders({ authorization: ["REDACTED"] }),
        raw: reqRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(reqRaw),
        truncated: false,
      },
      response: {
        status: 200,
        headers: jsonHeaders({ "openai-version": ["2020-10-01"], "x-request-id": ["req_demo4"] }),
        stream: false,
        complete: true,
        content_encoding: null,
        raw: respRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(respRaw),
        truncated: false,
        claimed_usage: usage(31, 33),
        claimed_model: "gpt-4o-mini-2024-07-18",
        system_fingerprint: "fp_demo_4e",
      },
      timing: {
        ttft_us: null,
        total_us: 815_000,
        stream_chunks: 0,
        conn_reused: true,
        upstream_connect_us: 0,
      },
      capture: { tee_ok: true, client_disconnected: false, note: null },
    });
  }

  // seq 5 — CACHE REPLAY: a DIFFERENT request gets seq 0's exact long answer →
  // cache_replay FLAG (temperature 0.7 so determinism can't excuse it).
  {
    const reqBody = {
      model: "gpt-4o",
      temperature: 0.7,
      messages: [
        { role: "system", content: "You are a concise support assistant." },
        { role: "user", content: "I forgot my login credentials, what now?" }, // DIFFERENT prompt
      ],
    };
    const respBody = {
      id: "chatcmpl-DEMO5",
      model: "gpt-4o-2024-08-06",
      choices: [
        { index: 0, message: { role: "assistant", content: SHARED_ANSWER }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 28, completion_tokens: 38, total_tokens: 66 },
    };
    const reqRaw = JSON.stringify(reqBody);
    const respRaw = JSON.stringify(respBody);
    out.push({
      id: demoId(5),
      ts_start: tsAt(5),
      route: {
        method: "POST",
        path: "/v1/chat/completions",
        upstream: UPSTREAM,
        claimed_model: "gpt-4o",
        provider: "openai",
        api_surface: "chat.completions",
      },
      request: {
        headers: jsonHeaders({ authorization: ["REDACTED"] }),
        raw: reqRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(reqRaw),
        truncated: false,
      },
      response: {
        status: 200,
        headers: jsonHeaders({ "openai-version": ["2020-10-01"], "x-request-id": ["req_demo5"] }),
        stream: false,
        complete: true,
        content_encoding: null,
        raw: respRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(respRaw),
        truncated: false,
        claimed_usage: usage(28, 38),
        claimed_model: "gpt-4o-2024-08-06",
        system_fingerprint: "fp_demo_5f",
      },
      timing: {
        ttft_us: null,
        total_us: 705_000,
        stream_chunks: 0,
        conn_reused: true,
        upstream_connect_us: 0,
      },
      capture: { tee_ok: true, client_disconnected: false, note: null },
    });
  }

  // seq 6 — Gemini :generateContent → token_recount SKIP (non-openai), provenance OK.
  {
    const reqBody = {
      contents: [{ role: "user", parts: [{ text: "Name three primary colors." }] }],
    };
    const respBody = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Red, blue, and yellow are the three primary colors." }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 11, totalTokenCount: 17 },
    };
    const reqRaw = JSON.stringify(reqBody);
    const respRaw = JSON.stringify(respBody);
    out.push({
      id: demoId(6),
      ts_start: tsAt(6),
      route: {
        method: "POST",
        path: "/v1beta/models/gemini-1.5-pro:generateContent",
        upstream: UPSTREAM,
        claimed_model: "gemini-1.5-pro",
        provider: "gemini",
        api_surface: "generateContent",
      },
      request: {
        headers: jsonHeaders(),
        raw: reqRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(reqRaw),
        truncated: false,
      },
      response: {
        status: 200,
        headers: jsonHeaders({ server: ["scaffolding on HTTPServer2"], "x-goog-request-id": ["goog-demo6"] }),
        stream: false,
        complete: true,
        content_encoding: null,
        raw: respRaw,
        raw_encoding: "utf8",
        bytes: Buffer.byteLength(respRaw),
        truncated: false,
        claimed_usage: usage(6, 11),
        claimed_model: "gemini-1.5-pro",
        system_fingerprint: null,
      },
      timing: {
        ttft_us: null,
        total_us: 1_120_000,
        stream_chunks: 0,
        conn_reused: false,
        upstream_connect_us: 88_000,
      },
      capture: { tee_ok: true, client_disconnected: false, note: null },
    });
  }

  return out;
}

/* ============================================================================
   Chaining: compute raw_sha256, prev_hash, hash with the canonical impl.
   ========================================================================== */

async function sha256OfString(s: string): Promise<string> {
  const { sha256Hex } = await import("../digest.ts");
  return sha256Hex(new TextEncoder().encode(s));
}

/**
 * Materialize the demo evidence chain. If `breakAt` is a valid seq (1..n-1),
 * that record's response body is mutated AFTER its hash is computed, so its
 * stored hash no longer matches its bytes → chain verifies as BREAK@seq.
 * (We avoid seq 0 so EMPTY/genesis logic is unaffected; the brief's example is
 * BREAK@seq mid-chain.)
 */
export async function buildDemoRecords(
  breakAt: number | null = null,
): Promise<EvidenceRecord[]> {
  const ds = drafts();
  const records: EvidenceRecord[] = [];
  let prevHash = GENESIS_PREV_HASH;

  for (let seq = 0; seq < ds.length; seq++) {
    const d = ds[seq];
    const reqSha = await sha256OfString(d.request.raw);
    const respSha = await sha256OfString(d.response.raw);
    const rec: EvidenceRecord = {
      v: 1,
      seq,
      id: d.id,
      ts_start: d.ts_start,
      prev_hash: prevHash,
      hash: "", // filled below
      route: d.route,
      request: { ...d.request, raw_sha256: reqSha },
      response: { ...d.response, raw_sha256: respSha },
      timing: d.timing,
      capture: d.capture,
    };
    rec.hash = await computeHash(rec);
    prevHash = rec.hash; // next record links to THIS record's (valid) hash
    records.push(rec);
  }

  if (breakAt !== null && breakAt >= 1 && breakAt < records.length) {
    // Tamper: alter the body of records[breakAt] without recomputing its hash.
    // Its stored hash now disagrees with its bytes → verifyChain → BREAK@breakAt.
    const tampered = records[breakAt];
    const mutatedRaw = tampered.response.raw.replace(
      /"completion_tokens":\s*\d+/,
      '"completion_tokens":1',
    );
    // If the regex didn't match (e.g. streamed body), append an invisible edit.
    tampered.response = {
      ...tampered.response,
      raw:
        mutatedRaw !== tampered.response.raw
          ? mutatedRaw
          : tampered.response.raw + " ",
    };
    // Leave hash + the following prev_hashes as-is so the break is detected at
    // breakAt (stored hash mismatch), faithful to a post-hoc record edit.
  }

  return records;
}

/* ============================================================================
   Verdicts — authored to mirror the Python checks' exact detail shapes, bound
   to each record's real hash. Built from the UNTAMPERED records so the verdicts
   are the genuine derivations; when a BREAK is injected the UI must show the
   TAMPER state and treat these as untrustworthy (chainStatus drives that).
   ========================================================================== */

function v(
  rec: EvidenceRecord,
  check: VerdictRecord["check"],
  status: VerdictRecord["status"],
  severity: VerdictRecord["severity"],
  summary: string,
  detail: VerdictRecord["detail"],
): VerdictRecord {
  return {
    v: 1,
    record_id: rec.id,
    record_seq: rec.seq,
    record_hash: rec.hash,
    check,
    analyzer_version: ANALYZER_VERSION,
    ts: rec.ts_start,
    status,
    severity,
    summary,
    detail,
  } as VerdictRecord;
}

function trSkip(rec: EvidenceRecord, reason: string): VerdictRecord {
  const d: TokenRecountDetail = {
    reason,
    provider: rec.route.provider,
    api_surface: rec.route.api_surface,
  };
  return v(rec, "token_recount", "skip", "info", `skipped: ${reason}`, d);
}

function provFor(
  rec: EvidenceRecord,
  opts: {
    status: VerdictRecord["status"];
    severity: VerdictRecord["severity"];
    summary: string;
    expected: string;
    present: string[];
    absent: string[];
    score: number;
    max_score: number;
    tells?: string[];
  },
): VerdictRecord {
  const d: ProvenanceDetail = {
    claimed_model: rec.route.claimed_model,
    expected_upstream: opts.expected,
    relay_stack_tells: opts.tells ?? [],
    signals_present: opts.present,
    signals_absent: opts.absent,
    score: opts.score,
    max_score: opts.max_score,
    note: NOTE_PROV,
  };
  return v(rec, "provenance", opts.status, opts.severity, opts.summary, d);
}

function expoOk(rec: EvidenceRecord, summary: string): VerdictRecord {
  const d: ExposureDetail = {
    request: { secrets: {}, pii: {}, high_entropy_blobs: 0, code_blocks: 0 },
    response: { secrets: {}, pii: {}, high_entropy_blobs: 0, code_blocks: 0 },
    truncated_capture: false,
    detector_versions: {
      builtin_regex: "1",
      entropy: "shannon>4.0/len>=32",
      presidio: "absent (lower recall on names/orgs/locations)",
    },
    lower_bound: true,
    note: exposureNote(false),
  };
  return v(rec, "exposure", "ok", "info", summary, d);
}

function cacheSkip(rec: EvidenceRecord, reason: string, extra: Partial<CacheReplayDetail> = {}): VerdictRecord {
  const d: CacheReplayDetail = { reason, ...extra };
  return v(rec, "cache_replay", "skip", "info", `skipped: ${reason}`, d);
}

function tpSkip(rec: EvidenceRecord, reason: string, extra: Partial<ThroughputDetail> = {}): VerdictRecord {
  const d: ThroughputDetail = { reason, ...extra };
  return v(rec, "throughput", "skip", "info", reasonToTpSummary(reason), d);
}
function reasonToTpSummary(reason: string): string {
  if (reason === "non_stream_or_incomplete") return "skipped: non-stream or incomplete";
  if (reason === "low_resolution") return "skipped: insufficient timing resolution";
  if (reason === "no_completion_count") return "skipped: no completion token count";
  return `skipped: ${reason}`;
}

/** Build the verdicts for one record, in the analyzer's check order. The
 *  cache_replay verdict is precomputed in a chain-wide pass (buildCacheVerdicts)
 *  so its distinct-request counting + normalized_len + fingerprint are
 *  analyzer-faithful and derived, never hand-typed; it is spliced in here at the
 *  cache_replay position. */
function verdictsForRecord(rec: EvidenceRecord, cacheVerdict: VerdictRecord): VerdictRecord[] {
  const seq = rec.seq;
  const list: VerdictRecord[] = [];

  switch (seq) {
    case 0: {
      // honest openai chat
      const recDetail: TokenRecountDetail = {
        provider: "openai",
        api_surface: "chat.completions",
        encoding: "o200k_base",
        eligible: true,
        estimate_only: false,
        estimate_reasons: [],
        claimed: { prompt: 27, completion: 38 },
        recomputed: { prompt: 26, completion: 37 },
        framing: { tokens_per_message: 3, reply_priming: 3 },
        tolerance_pct: 4.0,
        min_abs_tokens: 5,
        note: NOTE_TR,
        completion_delta: -1,
        completion_delta_pct: -2.63,
      };
      list.push(v(rec, "token_recount", "ok", "info", "usage within tolerance", recDetail));
      list.push(
        provFor(rec, {
          status: "ok",
          severity: "info",
          summary:
            "consistent with genuine openai upstream (provenance score 6/8; markers forgeable, not proof)",
          expected: "openai",
          present: [
            "openai-* headers (openai-version/organization/processing-ms)",
            "x-request-id header",
            "native chatcmpl-/resp- id",
          ],
          absent: ["x-ratelimit-*-requests headers"],
          score: 6,
          max_score: 8,
        }),
      );
      list.push(expoOk(rec, "egress exposure (lower bound): measured, not prevented"));
      list.push(cacheVerdict);
      list.push(tpSkip(rec, "non_stream_or_incomplete"));
      break;
    }
    case 1: {
      // CRITICAL: visible completion exceeds billed (billed=2)
      const recomputedCompletion = 21; // ~ tokens in the delivered sentence
      const recDetail: TokenRecountDetail = {
        provider: "openai",
        api_surface: "chat.completions",
        encoding: "o200k_base",
        eligible: true,
        estimate_only: false,
        estimate_reasons: [],
        claimed: { prompt: 13, completion: 2 },
        recomputed: { prompt: 11, completion: recomputedCompletion },
        framing: { tokens_per_message: 3, reply_priming: 3 },
        tolerance_pct: 4.0,
        min_abs_tokens: 5,
        note: NOTE_TR,
        completion_delta: recomputedCompletion - 2,
        completion_delta_pct: Math.round((100 * (recomputedCompletion - 2)) / 2 * 100) / 100,
      };
      list.push(
        v(
          rec,
          "token_recount",
          "flag",
          "critical",
          `visible completion ${recomputedCompletion} exceeds billed 2 by ${recomputedCompletion - 2} (impossible if honest — capture error or under-billing)`,
          recDetail,
        ),
      );
      list.push(
        provFor(rec, {
          status: "ok",
          severity: "info",
          summary:
            "consistent with genuine openai upstream (provenance score 5/8; markers forgeable, not proof)",
          expected: "openai",
          present: [
            "openai-* headers (openai-version/organization/processing-ms)",
            "x-request-id header",
            "native chatcmpl-/resp- id",
          ],
          absent: ["x-ratelimit-*-requests headers"],
          score: 5,
          max_score: 8,
        }),
      );
      list.push(expoOk(rec, "egress exposure (lower bound): measured, not prevented"));
      // 105-char streamed answer → above min_normalized_len, unique fingerprint →
      // cache_replay OK ("no replay collision"), exactly as cache_replay.py emits.
      list.push(cacheVerdict);
      // streaming with timing resolution → throughput telemetry OK
      {
        const gen = 1_905_000 - 318_000;
        const tps = Math.round((2 * 1_000_000) / gen * 10) / 10;
        const d: ThroughputDetail = {
          completion_tokens_used: 2,
          gen_us: gen,
          ttft_us: 318_000,
          tokens_per_s: tps,
          ceiling_tps: 2000,
          stream_chunks: rec.timing.stream_chunks,
          note: NOTE_TP,
        };
        list.push(v(rec, "throughput", "ok", "info", `${Math.round(tps)} tok/s`, d));
      }
      break;
    }
    case 2: {
      // WARN: billed completion (240) >> visible (~9) on plain gpt-4o
      const recomputedCompletion = 9;
      const billed = 240;
      const underPct = Math.round((100 * (billed - recomputedCompletion)) / billed * 10) / 10;
      const recDetail: TokenRecountDetail = {
        provider: "openai",
        api_surface: "chat.completions",
        encoding: "o200k_base",
        eligible: true,
        estimate_only: false,
        estimate_reasons: [],
        claimed: { prompt: 12, completion: billed },
        recomputed: { prompt: 10, completion: recomputedCompletion },
        framing: { tokens_per_message: 3, reply_priming: 3 },
        tolerance_pct: 4.0,
        min_abs_tokens: 5,
        note: NOTE_TR,
        completion_delta: recomputedCompletion - billed,
        completion_delta_pct: Math.round((100 * (recomputedCompletion - billed)) / billed * 100) / 100,
        billed_exceeds_visible_pct: underPct,
      };
      list.push(
        v(
          rec,
          "token_recount",
          "flag",
          "warn",
          `billed completion ${billed} exceeds visible text ${recomputedCompletion} by ${billed - recomputedCompletion} (${underPct.toFixed(1)}%) on a non-reasoning, non-tool response — possible inflation`,
          recDetail,
        ),
      );
      list.push(
        provFor(rec, {
          status: "ok",
          severity: "info",
          summary:
            "consistent with genuine openai upstream (provenance score 5/8; markers forgeable, not proof)",
          expected: "openai",
          present: [
            "openai-* headers (openai-version/organization/processing-ms)",
            "x-request-id header",
            "native chatcmpl-/resp- id",
          ],
          absent: ["x-ratelimit-*-requests headers"],
          score: 5,
          max_score: 8,
        }),
      );
      list.push(expoOk(rec, "egress exposure (lower bound): measured, not prevented"));
      list.push(cacheVerdict);
      list.push(tpSkip(rec, "non_stream_or_incomplete"));
      break;
    }
    case 3: {
      // Anthropic masquerade: token_recount SKIP, provenance WARN(0)
      list.push(trSkip(rec, "non-openai/unsupported surface (anthropic/messages); no public tokenizer"));
      list.push(
        provFor(rec, {
          status: "flag",
          severity: "warn",
          summary:
            "NO genuine anthropic markers found (score 0/11): response lacks every native anthropic fingerprint. Suspicious of masquerade/套壳, but markers are forgeable/strippable so this is not proof -- escalate to Phase 1.",
          expected: "anthropic",
          present: [],
          absent: [
            "anthropic-ratelimit-* headers",
            "anthropic-organization-id header",
            "native request-id (req_...)",
            "native message id (msg_...)",
            "anthropic-version / x-anthropic header",
          ],
          score: 0,
          max_score: 11,
          tells: ["x-new-api-version=0.8.4", "x-oneapi-request-id present (one-api/new-api)", "usage.usage_source=anthropic"],
        }),
      );
      list.push(expoOk(rec, "egress exposure (lower bound): measured, not prevented"));
      list.push(cacheVerdict);
      list.push(tpSkip(rec, "non_stream_or_incomplete"));
      break;
    }
    case 4: {
      // exposure WARN: leaked sk- key in request
      const recDetail: TokenRecountDetail = {
        provider: "openai",
        api_surface: "chat.completions",
        encoding: "o200k_base",
        eligible: true,
        estimate_only: false,
        estimate_reasons: [],
        claimed: { prompt: 31, completion: 33 },
        recomputed: { prompt: 30, completion: 32 },
        framing: { tokens_per_message: 3, reply_priming: 3 },
        tolerance_pct: 4.0,
        min_abs_tokens: 5,
        note: NOTE_TR,
        completion_delta: -1,
        completion_delta_pct: -3.03,
      };
      list.push(v(rec, "token_recount", "ok", "info", "usage within tolerance", recDetail));
      list.push(
        provFor(rec, {
          status: "ok",
          severity: "info",
          summary:
            "consistent with genuine openai upstream (provenance score 5/8; markers forgeable, not proof)",
          expected: "openai",
          present: [
            "openai-* headers (openai-version/organization/processing-ms)",
            "x-request-id header",
            "native chatcmpl-/resp- id",
          ],
          absent: ["x-ratelimit-*-requests headers"],
          score: 5,
          max_score: 8,
        }),
      );
      {
        const d: ExposureDetail = {
          request: { secrets: { openai_key: 1 }, pii: {}, high_entropy_blobs: 1, code_blocks: 0 },
          response: { secrets: {}, pii: {}, high_entropy_blobs: 0, code_blocks: 0 },
          truncated_capture: false,
          detector_versions: {
            builtin_regex: "1",
            entropy: "shannon>4.0/len>=32",
            presidio: "absent (lower recall on names/orgs/locations)",
          },
          lower_bound: true,
          note: exposureNote(false),
        };
        list.push(
          v(
            rec,
            "exposure",
            "flag",
            "warn",
            "at least 1 credential(s) egressed to the relay (1 in request) -- the relay can read these; rotate/remove them",
            d,
          ),
        );
      }
      // 140-char answer → above min_normalized_len, unique fingerprint →
      // cache_replay OK, exactly as cache_replay.py emits (not a below_min skip).
      list.push(cacheVerdict);
      list.push(tpSkip(rec, "non_stream_or_incomplete"));
      break;
    }
    case 5: {
      // cache_replay FLAG: shared answer for a DIFFERENT request, temp 0.7 —
      // produced by the chain-wide pass tracking seq 0's identical response as a
      // distinct request (distinct_request_count=2), exactly as cache_replay.py.
      const recDetail: TokenRecountDetail = {
        provider: "openai",
        api_surface: "chat.completions",
        encoding: "o200k_base",
        eligible: true,
        estimate_only: false,
        estimate_reasons: [],
        claimed: { prompt: 28, completion: 38 },
        recomputed: { prompt: 27, completion: 37 },
        framing: { tokens_per_message: 3, reply_priming: 3 },
        tolerance_pct: 4.0,
        min_abs_tokens: 5,
        note: NOTE_TR,
        completion_delta: -1,
        completion_delta_pct: -2.63,
      };
      list.push(v(rec, "token_recount", "ok", "info", "usage within tolerance", recDetail));
      list.push(
        provFor(rec, {
          status: "ok",
          severity: "info",
          summary:
            "consistent with genuine openai upstream (provenance score 5/8; markers forgeable, not proof)",
          expected: "openai",
          present: [
            "openai-* headers (openai-version/organization/processing-ms)",
            "x-request-id header",
            "native chatcmpl-/resp- id",
          ],
          absent: ["x-ratelimit-*-requests headers"],
          score: 5,
          max_score: 8,
        }),
      );
      list.push(expoOk(rec, "egress exposure (lower bound): measured, not prevented"));
      list.push(cacheVerdict);
      list.push(tpSkip(rec, "non_stream_or_incomplete"));
      break;
    }
    case 6: {
      // Gemini: token_recount SKIP (non-openai), provenance OK
      list.push(trSkip(rec, "non-openai/unsupported surface (gemini/generateContent); no public tokenizer"));
      list.push(
        provFor(rec, {
          status: "ok",
          severity: "info",
          summary:
            "consistent with genuine gemini upstream (provenance score 5/7; markers forgeable, not proof)",
          expected: "gemini",
          present: [
            "usageMetadata block (Gemini native)",
            "candidates[] block (Gemini native)",
            "google server / x-goog headers",
          ],
          absent: [],
          score: 7,
          max_score: 7,
        }),
      );
      list.push(expoOk(rec, "egress exposure (lower bound): measured, not prevented"));
      list.push(cacheVerdict);
      list.push(tpSkip(rec, "non_stream_or_incomplete"));
      break;
    }
  }
  return list;
}

/** Normalize like cache_replay.py _normalize: NFKC, strip zero-width + other
 *  control chars, collapse whitespace, trim. */
const ZERO_WIDTH_RE = /[​‌‍﻿]/g;
// All Unicode "Other" (C*) category code points — control/format/surrogate/
// private-use/unassigned — matching cat[0] == "C" in the Python.
const CONTROL_CAT_RE = /\p{C}/gu;
function normalizeForCache(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(CONTROL_CAT_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reconstruct the delivered assistant text for a record, mirroring
 *  token_recount.py _reconstruct_assistant_text (used by cache_replay.py): SSE
 *  delta.content concatenation for streams, choices[].message.content for
 *  non-stream. Returns "" when there is no assistant text. Only utf8 bodies. */
function reconstructAssistantText(rec: EvidenceRecord): string {
  const resp = rec.response;
  if (resp.raw_encoding !== "utf8") return "";
  if (resp.stream) {
    const parts: string[] = [];
    for (const line of resp.raw.replace(/\r\n/g, "\n").split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).replace(/^ +/, "");
      if (payload === "[DONE]") continue;
      let obj: unknown;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      const o = obj as { choices?: Array<{ delta?: { content?: unknown } }>; type?: string; delta?: unknown };
      for (const ch of o.choices ?? []) {
        if (typeof ch.delta?.content === "string") parts.push(ch.delta.content);
      }
      if (o.type === "response.output_text.delta" && typeof o.delta === "string") {
        parts.push(o.delta);
      }
    }
    return parts.join("");
  }
  let body: unknown;
  try {
    body = JSON.parse(resp.raw);
  } catch {
    return "";
  }
  const b = body as { choices?: Array<{ message?: { content?: unknown } }> };
  const parts: string[] = [];
  for (const ch of b.choices ?? []) {
    if (typeof ch.message?.content === "string") parts.push(ch.message.content);
  }
  return parts.join("");
}

/** Semantic request fingerprint, mirroring cache_replay.py
 *  _request_semantic_fingerprint: hash {model, messages, input} with sorted keys
 *  so two genuinely-equal requests collapse. */
async function requestSemanticFingerprint(rec: EvidenceRecord): Promise<string | null> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rec.request.raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sem = {
    input: body.input ?? null,
    messages: body.messages ?? null,
    model: body.model ?? null,
  };
  // JSON.stringify here emits keys in insertion order; we listed them sorted
  // (input < messages < model) to match Python's json.dumps(sort_keys=True).
  return sha256OfString(JSON.stringify(sem));
}

const CACHE_MIN_NORMALIZED_LEN = 64;

/**
 * Build the cache_replay verdict for every record in a single pass, mirroring
 * cache_replay.py + CacheReplayState EXACTLY (so Demo reproduces what the real
 * analyzer would emit, not a hand-typed approximation):
 *
 *   - skip incomplete/truncated, or no assistant text, or normalized < 64,
 *     or an unparseable request — with the analyzer's reason + normalized_len.
 *   - otherwise track (resp_fingerprint → set of distinct request fingerprints);
 *     distinct_request_count >= 2 ⇒ flag (warn) unless temp==0/seed ⇒ skip;
 *     else ok ("no replay collision").
 *
 * Returns a map seq → VerdictRecord so verdictsForRecord can splice it in at the
 * right position in the per-record check order.
 */
async function buildCacheVerdicts(
  records: EvidenceRecord[],
): Promise<Map<number, VerdictRecord>> {
  const out = new Map<number, VerdictRecord>();
  // resp_fingerprint -> { firstSeenId, reqFps:set }
  const idx = new Map<string, { firstSeenId: string; reqFps: Set<string> }>();

  for (const rec of records) {
    const resp = rec.response;
    if (!resp.complete || resp.truncated) {
      out.set(rec.seq, cacheSkip(rec, "incomplete_or_truncated"));
      continue;
    }
    const text = reconstructAssistantText(rec);
    if (!text) {
      out.set(rec.seq, cacheSkip(rec, "no_text"));
      continue;
    }
    const normalized = normalizeForCache(text);
    if (normalized.length < CACHE_MIN_NORMALIZED_LEN) {
      out.set(rec.seq, cacheSkip(rec, "below_min_len", { normalized_len: normalized.length }));
      continue;
    }
    const reqFp = await requestSemanticFingerprint(rec);
    if (reqFp === null) {
      out.set(rec.seq, cacheSkip(rec, "bad_request"));
      continue;
    }
    const respFp = await sha256OfString(normalized);
    let entry = idx.get(respFp);
    if (!entry) {
      entry = { firstSeenId: rec.id, reqFps: new Set() };
      idx.set(respFp, entry);
    }
    entry.reqFps.add(reqFp);
    const count = entry.reqFps.size;

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(rec.request.raw) as Record<string, unknown>;
    } catch {
      /* unreachable: reqFp would be null above */
    }
    const temp = (typeof body.temperature === "number" ? body.temperature : null) as number | null;
    const hasSeed = "seed" in body;

    const detail: CacheReplayDetail = {
      resp_fingerprint: respFp,
      normalized_len: normalized.length,
      distinct_request_count: count,
      first_seen_record_id: entry.firstSeenId,
      temperature: temp,
      has_seed: hasSeed,
      note: NOTE_CACHE,
    };

    if (count >= 2) {
      if (temp === 0 || hasSeed) {
        out.set(
          rec.seq,
          v(
            rec,
            "cache_replay",
            "skip",
            "info",
            "identical output across requests, but temperature=0/seed set (determinism expected)",
            detail,
          ),
        );
      } else {
        out.set(
          rec.seq,
          v(
            rec,
            "cache_replay",
            "flag",
            "warn",
            `same ${normalized.length}-char response served for ${count} distinct requests (temp=${temp}) — possible cache replay`,
            detail,
          ),
        );
      }
    } else {
      out.set(rec.seq, v(rec, "cache_replay", "ok", "info", "no replay collision", detail));
    }
  }
  return out;
}

/** Build all demo verdicts for the (untampered) records, in seq then check order.
 *  cache_replay is computed in a single chain-wide pass first (so distinct-request
 *  counting matches the analyzer's stateful index) and spliced per record. */
export async function buildDemoVerdicts(
  records: EvidenceRecord[],
): Promise<VerdictRecord[]> {
  const cacheVerdicts = await buildCacheVerdicts(records);
  const all: VerdictRecord[] = [];
  for (const rec of records) {
    const cacheVerdict = cacheVerdicts.get(rec.seq);
    if (cacheVerdict === undefined) {
      throw new Error(`demo: missing cache verdict for seq ${rec.seq}`);
    }
    all.push(...verdictsForRecord(rec, cacheVerdict));
  }
  return all;
}

/**
 * Full demo source: records (optionally with a BREAK injected) + the verdicts
 * derived from the untampered records (so the verdicts themselves are genuine;
 * the TAMPER state comes from chain verification over the tampered records).
 */
export async function buildDemoSource(breakAt: number | null = null): Promise<{
  records: EvidenceRecord[];
  verdicts: VerdictRecord[];
  tornTail: boolean;
}> {
  // Verdicts are bound to the genuine hashes, so derive them from a clean build.
  const clean = await buildDemoRecords(null);
  const verdicts = await buildDemoVerdicts(clean);
  const records = breakAt === null ? clean : await buildDemoRecords(breakAt);
  return { records, verdicts, tornTail: false };
}

/** The seq the demo BREAK toggle targets by default (mid-chain). */
export const DEMO_BREAK_SEQ = 3;
