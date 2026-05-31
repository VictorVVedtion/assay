/**
 * lib/digest.ts — canonical evidence digest, ported byte-for-byte from
 * internal/evidence/digest.go (and its twin analyzer/assay_analyzer/digest.py).
 * See PHASE0.md §4.
 *
 * This is the project's "anyone can recompute" guarantee, realized IN THE
 * BROWSER: given a raw EvidenceRecord, this reproduces the exact bytes the Go
 * data plane hashed, so EvidenceDrawer can show sha256(canon(record)) ==
 * stored hash and prev_hash linkage — no server, no trust.
 *
 * Encoding is a custom length-prefixed, explicitly-typed scheme — deliberately
 * NOT JSON/JCS — so it has no float-formatting, key-ordering, or
 * unicode-normalization ambiguity. The cross-language golden in
 * testdata/digest_vectors.json pins it; lib/digest.vectors.test.ts asserts this
 * port reproduces every vector.
 *
 * Primitives (big-endian), mirroring digest.go:
 *
 *   u64(n)     = 8-byte big-endian
 *   b(x)       = u64(len(x)) || x
 *   s(str)     = b(utf8(str))
 *   optU64(p)  = 0x00 if null/undefined else 0x01 || u64(p)
 *   optS(p)    = 0x00 if null/undefined else 0x01 || s(p)
 *   u8b(bool)  = 0x00 / 0x01
 *   hmap(h)    = u64(nKeys) || for key asc: s(key) || s(values joined by "\n")
 *
 * canon(record) concatenates, in this EXACT field order (any change rebases
 * every hash and must bump SchemaVersion):
 *   s("assay-evidence-v1")                                   // domain separator
 *   u64(seq) s(id) s(ts_start) s(prev_hash)
 *   route:    s(method) s(path) s(upstream) optS(claimed_model) s(provider) s(api_surface)
 *   request:  hmap(headers) s(raw) s(raw_encoding) s(raw_sha256) u64(bytes) u8b(truncated)
 *   response: u64(status) hmap(headers) u8b(stream) u8b(complete) optS(content_encoding)
 *             s(raw) s(raw_encoding) s(raw_sha256) u64(bytes) u8b(truncated)
 *             usage(claimed_usage) optS(claimed_model) optS(system_fingerprint)
 *   timing:   optU64(ttft_us) optU64(total_us) u64(stream_chunks) u8b(conn_reused) optU64(upstream_connect_us)
 *   capture:  u8b(tee_ok) u8b(client_disconnected) optS(note)
 *
 * usage(u) = 0x00 if null else
 *   0x01 || optU64(prompt) || optU64(completion) || optU64(total)
 *        || optU64(reasoning_tokens) || optU64(cached_tokens)
 */

import type { EvidenceRecord, Headers, Usage } from "./types.ts";
import { GENESIS_PREV_HASH } from "./types.ts";

export const DOMAIN = "assay-evidence-v1";

const U64_MAX = 18446744073709551615n; // 2^64 - 1
const textEncoder = new TextEncoder();

/* ---- a growable byte sink (mirrors Go's append-to-[]byte) ---- */
class ByteSink {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  pushByte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  pushBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /** big-endian u64. Accepts number or bigint; rejects negatives / overflow. */
  pushU64(n: number | bigint): void {
    let v: bigint;
    if (typeof n === "bigint") {
      v = n;
    } else {
      if (!Number.isFinite(n) || Math.floor(n) !== n) {
        throw new RangeError(`u64 requires an integer, got ${n}`);
      }
      v = BigInt(n);
    }
    if (v < 0n || v > U64_MAX) {
      throw new RangeError(`u64 out of range: ${v}`);
    }
    this.ensure(8);
    // big-endian
    for (let i = 7; i >= 0; i--) {
      this.buf[this.len + i] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.len += 8;
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

/* ---- primitives ---- */

function putBytes(sink: ByteSink, x: Uint8Array): void {
  sink.pushU64(x.length);
  sink.pushBytes(x);
}

function putS(sink: ByteSink, s: string): void {
  putBytes(sink, textEncoder.encode(s));
}

function putOptU64(sink: ByteSink, p: number | null | undefined): void {
  if (p === null || p === undefined) {
    sink.pushByte(0x00);
    return;
  }
  sink.pushByte(0x01);
  sink.pushU64(p);
}

function putOptS(sink: ByteSink, p: string | null | undefined): void {
  if (p === null || p === undefined) {
    sink.pushByte(0x00);
    return;
  }
  sink.pushByte(0x01);
  putS(sink, p);
}

function putU8b(sink: ByteSink, v: boolean): void {
  sink.pushByte(v ? 0x01 : 0x00);
}

/** Header map: keys sorted ascending (lexicographic by UTF-16 code unit, which
 *  matches Go sort.Strings for the ASCII-lowercase header keys we store), each
 *  key's values joined by "\n". */
function putHmap(sink: ByteSink, h: Headers | null | undefined): void {
  const map = h ?? {};
  const keys = Object.keys(map).sort();
  sink.pushU64(keys.length);
  for (const k of keys) {
    putS(sink, k);
    putS(sink, (map[k] ?? []).join("\n"));
  }
}

function putUsage(sink: ByteSink, u: Usage | null | undefined): void {
  if (u === null || u === undefined) {
    sink.pushByte(0x00);
    return;
  }
  sink.pushByte(0x01);
  putOptU64(sink, u.prompt_tokens);
  putOptU64(sink, u.completion_tokens);
  putOptU64(sink, u.total_tokens);
  putOptU64(sink, u.completion_tokens_details?.reasoning_tokens);
  putOptU64(sink, u.prompt_tokens_details?.cached_tokens);
}

/**
 * canon — the canonical byte encoding of an evidence record (the sha256
 * preimage). The record's own `hash` field is excluded.
 */
export function canon(r: EvidenceRecord): Uint8Array {
  // Pre-size generously to avoid reallocations on large bodies.
  const sink = new ByteSink(1024 + r.request.raw.length + r.response.raw.length);

  putS(sink, DOMAIN);

  sink.pushU64(r.seq);
  putS(sink, r.id);
  putS(sink, r.ts_start);
  putS(sink, r.prev_hash);

  // route
  putS(sink, r.route.method);
  putS(sink, r.route.path);
  putS(sink, r.route.upstream);
  putOptS(sink, r.route.claimed_model);
  putS(sink, r.route.provider);
  putS(sink, r.route.api_surface);

  // request
  putHmap(sink, r.request.headers);
  putS(sink, r.request.raw);
  putS(sink, r.request.raw_encoding);
  putS(sink, r.request.raw_sha256);
  sink.pushU64(r.request.bytes);
  putU8b(sink, r.request.truncated);

  // response
  sink.pushU64(r.response.status);
  putHmap(sink, r.response.headers);
  putU8b(sink, r.response.stream);
  putU8b(sink, r.response.complete);
  putOptS(sink, r.response.content_encoding);
  putS(sink, r.response.raw);
  putS(sink, r.response.raw_encoding);
  putS(sink, r.response.raw_sha256);
  sink.pushU64(r.response.bytes);
  putU8b(sink, r.response.truncated);
  putUsage(sink, r.response.claimed_usage);
  putOptS(sink, r.response.claimed_model);
  putOptS(sink, r.response.system_fingerprint);

  // timing
  putOptU64(sink, r.timing.ttft_us);
  putOptU64(sink, r.timing.total_us);
  sink.pushU64(r.timing.stream_chunks);
  putU8b(sink, r.timing.conn_reused);
  putOptU64(sink, r.timing.upstream_connect_us);

  // capture
  putU8b(sink, r.capture.tee_ok);
  putU8b(sink, r.capture.client_disconnected);
  putOptS(sink, r.capture.note);

  // Copy out of the backing buffer so callers get a tight, stable view.
  return sink.bytes().slice();
}

/* ---- hashing (Web Crypto SHA-256, async) ---- */

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return out;
}

/** sha256 of arbitrary bytes → lowercase hex. Uses Web Crypto (browser + Node). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Pass a fresh ArrayBuffer slice so subtle.digest gets exactly these bytes.
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", ab);
  return toHex(new Uint8Array(digest));
}

/**
 * computeHash(record) = hex(sha256(canon(record))). The record's own `hash`
 * field is ignored, so this is well-defined regardless of its current value.
 */
export async function computeHash(r: EvidenceRecord): Promise<string> {
  return sha256Hex(canon(r));
}

/** canon(record) as hex — handy for the drawer's "show the preimage" affordance
 *  and for the vector self-test. */
export function canonHex(r: EvidenceRecord): string {
  return toHex(canon(r));
}

/**
 * verifyRecordHash(record) — true iff computeHash(record) === record.hash.
 * This is the per-record integrity half of chain verification; prev_hash
 * linkage is checked by the caller (lib/server/verify or the drawer).
 */
export async function verifyRecordHash(r: EvidenceRecord): Promise<boolean> {
  const got = await computeHash(r);
  return got === r.hash;
}

/**
 * verifyLink(record, prevHash) — does this record's prev_hash match the prior
 * record's hash AND does its own hash recompute? Convenience for the drawer's
 * "prev_hash linkage to the previous record" display.
 */
export async function verifyLink(
  r: EvidenceRecord,
  prevHash: string,
): Promise<{ hashOk: boolean; linkOk: boolean }> {
  const hashOk = await verifyRecordHash(r);
  const linkOk = r.prev_hash === prevHash;
  return { hashOk, linkOk };
}

export { GENESIS_PREV_HASH };
