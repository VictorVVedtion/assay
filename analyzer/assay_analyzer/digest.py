"""Canonical evidence digest — byte-identical to the Go implementation in
``internal/evidence/digest.go``. See PHASE0.md §4.

Zero third-party dependencies (stdlib ``hashlib``/``struct`` only) so it can be
audited and run anywhere, and so ``assay-analyzer replay`` reproduces the exact
hashes the Go data plane wrote. If this drifts from the Go encoding, the shared
golden vectors in ``testdata/digest_vectors.json`` fail in CI.

Primitives (big-endian), mirroring digest.go:

    u64(n)    = 8-byte big-endian
    b(x)      = u64(len(x)) || x
    s(str)    = b(utf8(str))
    opt_u64(p)= 0x00 if None else 0x01 || u64(p)
    opt_s(p)  = 0x00 if None else 0x01 || s(p)
    u8b(bool) = 0x00 / 0x01
    hmap(h)   = u64(nKeys) || for key asc: s(key) || s(values joined by "\\n")
"""

from __future__ import annotations

import hashlib
import struct

DOMAIN = "assay-evidence-v1"


def _u64(n: int) -> bytes:
    if n < 0 or n > 0xFFFFFFFFFFFFFFFF:
        raise ValueError(f"u64 out of range: {n}")
    return struct.pack(">Q", n)


def _b(x: bytes) -> bytes:
    return _u64(len(x)) + x


def _s(value: str) -> bytes:
    return _b(value.encode("utf-8"))


def _opt_u64(n: int | None) -> bytes:
    return b"\x00" if n is None else b"\x01" + _u64(n)


def _opt_s(value: str | None) -> bytes:
    return b"\x00" if value is None else b"\x01" + _s(value)


def _u8b(value: bool) -> bytes:
    return b"\x01" if value else b"\x00"


def _hmap(h: dict | None) -> bytes:
    h = h or {}
    keys = sorted(h.keys())
    out = [_u64(len(keys))]
    for k in keys:
        out.append(_s(k))
        out.append(_s("\n".join(h[k])))
    return b"".join(out)


def _usage(u: dict | None) -> bytes:
    if u is None:
        return b"\x00"
    cd = u.get("completion_tokens_details") or {}
    pd = u.get("prompt_tokens_details") or {}
    return b"".join([
        b"\x01",
        _opt_u64(u.get("prompt_tokens")),
        _opt_u64(u.get("completion_tokens")),
        _opt_u64(u.get("total_tokens")),
        _opt_u64(cd.get("reasoning_tokens")),
        _opt_u64(pd.get("cached_tokens")),
    ])


def canon(r: dict) -> bytes:
    """Canonical byte encoding of an evidence record (preimage of its hash)."""
    rt, rq, rs, tm, cp = r["route"], r["request"], r["response"], r["timing"], r["capture"]
    parts = [
        _s(DOMAIN),
        _u64(r["seq"]), _s(r["id"]), _s(r["ts_start"]), _s(r["prev_hash"]),
        # route
        _s(rt["method"]), _s(rt["path"]), _s(rt["upstream"]),
        _opt_s(rt.get("claimed_model")), _s(rt["provider"]), _s(rt["api_surface"]),
        # request
        _hmap(rq.get("headers")), _s(rq["raw"]), _s(rq["raw_encoding"]),
        _s(rq["raw_sha256"]), _u64(rq["bytes"]), _u8b(rq["truncated"]),
        # response
        _u64(rs["status"]), _hmap(rs.get("headers")), _u8b(rs["stream"]), _u8b(rs["complete"]),
        _opt_s(rs.get("content_encoding")), _s(rs["raw"]), _s(rs["raw_encoding"]),
        _s(rs["raw_sha256"]), _u64(rs["bytes"]), _u8b(rs["truncated"]),
        _usage(rs.get("claimed_usage")), _opt_s(rs.get("claimed_model")),
        _opt_s(rs.get("system_fingerprint")),
        # timing
        _opt_u64(tm.get("ttft_us")), _opt_u64(tm.get("total_us")), _u64(tm["stream_chunks"]),
        _u8b(tm["conn_reused"]), _opt_u64(tm.get("upstream_connect_us")),
        # capture
        _u8b(cp["tee_ok"]), _u8b(cp["client_disconnected"]), _opt_s(cp.get("note")),
    ]
    return b"".join(parts)


def record_hash(r: dict) -> str:
    """hex(sha256(canon(record))). The record's own ``hash`` field is ignored."""
    return hashlib.sha256(canon(r)).hexdigest()
