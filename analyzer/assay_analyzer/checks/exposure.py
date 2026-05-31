"""exposure - measure (a LOWER BOUND on) the sensitive content the buyer ships
through the relay (PHASE0.md, data-confidentiality Layer 1).

THE HONEST FRAME (every word here is load-bearing; the red-team killed earlier
overclaims):

  * assay CANNOT stop the relay reading what you send -- that is the MITM
    reality. This check does NOT protect, secure, or prevent anything. It only
    MEASURES what already egressed, so you can choose to ship less.
  * The count is a LOWER BOUND: "at least N". Detectors miss novel secret
    formats, ambiguous/non-Western names, and inferable identity. ZERO detected
    NEVER means "safe" or "clean" -- it means "nothing matched our patterns".
  * It scans BOTH the request (what you sent) AND the response (which the relay
    also sees and could harvest, and which can echo secrets/PII back).
  * The number is uncalibrated: "3 secrets" is not a risk score, just a count.
  * Truncation floor: if the captured body was truncated at the proxy cap,
    anything past the cap is neither stored nor counted -- the lower bound is
    itself floored. The verdict says so.
  * Reproducibility: detector identities+versions are recorded in every verdict
    (assay's whole trust model is "anyone can recompute"). A regex-only scan on
    one box must equal a regex-only scan on another.

It is INTENTIONALLY regex/entropy-based by default (zero heavy deps, fully
reproducible). If Microsoft Presidio is installed it is used for PII recall and
its versions are pinned into the verdict; absence is not an error, just a
lower-recall scan flagged in the detail.
"""

from __future__ import annotations

import math
import re
from typing import Any

from .base import Verdict, new_verdict

CHECK = "exposure"

# Credential shapes (mirror of the Go bodySecretPatterns; if the Go proxy already
# scrubbed bodies, those appear as [assay-redacted:TYPE] markers which we ALSO
# count, so the scorecard reflects true egress even post-scrub).
_SECRET_PATTERNS = [
    ("openai_key", re.compile(r"sk-(?!ant-)[A-Za-z0-9_\-]{16,}")),
    ("anthropic_key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{16,}")),
    ("aws_key", re.compile(r"AKIA[0-9A-Z]{12,}")),
    ("google_key", re.compile(r"AIza[0-9A-Za-z_\-]{20,}")),
    ("github_pat", re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}")),
    ("slack_token", re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}")),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")),
    ("private_key_block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    # already-scrubbed-by-proxy markers still count as egress (the relay saw the
    # original; only OUR stored copy is redacted).
    ("scrubbed_marker", re.compile(r"\[assay-redacted:([a-z_]+)\]")),
]

# Lightweight PII regexes — always available, low recall. Presidio (if present)
# augments names/locations/etc.
_PII_PATTERNS = [
    ("email", re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")),
    ("ipv4", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    ("phone_intl", re.compile(r"(?<!\d)(?:\+?\d[\d \-]{7,}\d)(?!\d)")),
    ("credit_card", re.compile(r"\b(?:\d[ \-]?){13,16}\b")),
    # crude CN id / long national-id-like number
    ("long_id_number", re.compile(r"\b\d{15,18}[\dXx]?\b")),
]

_CODE_FENCE = re.compile(r"```")
_HIGH_ENTROPY = re.compile(r"\b[A-Za-z0-9+/_\-]{32,}\b")

# Recorded into every verdict so the lower bound is reproducible.
_DETECTOR_VERSIONS = {"builtin_regex": "1", "entropy": "shannon>4.0/len>=32"}


def _shannon(s: str) -> float:
    if not s:
        return 0.0
    freq: dict[str, int] = {}
    for c in s:
        freq[c] = freq.get(c, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in freq.values())


def _try_presidio():
    try:
        import presidio_analyzer  # noqa: F401
        from presidio_analyzer import AnalyzerEngine

        return AnalyzerEngine(), getattr(presidio_analyzer, "__version__", "unknown")
    except Exception:  # noqa: BLE001 — absence is normal, never an error
        return None, None


_PRESIDIO_ENGINE, _PRESIDIO_VERSION = _try_presidio()


def _scan_text(text: str) -> dict[str, Any]:
    secrets: dict[str, int] = {}
    for name, pat in _SECRET_PATTERNS:
        hits = pat.findall(text)
        if hits:
            if name == "scrubbed_marker":
                # group(1) is the original type; attribute counts to it.
                for t in hits:
                    key = t if isinstance(t, str) else (t[0] if t else "unknown")
                    secrets[key] = secrets.get(key, 0) + 1
            else:
                secrets[name] = secrets.get(name, 0) + len(hits)

    pii: dict[str, int] = {}
    for name, pat in _PII_PATTERNS:
        hits = pat.findall(text)
        if hits:
            pii[name] = pii.get(name, 0) + len(hits)

    # Presidio augmentation (names, orgs, locations the regexes miss).
    if _PRESIDIO_ENGINE is not None and text:
        try:
            results = _PRESIDIO_ENGINE.analyze(text=text[:50000], language="en")
            for r in results:
                if r.score >= 0.5:
                    pii[r.entity_type.lower()] = pii.get(r.entity_type.lower(), 0) + 1
        except Exception:  # noqa: BLE001
            pass

    # high-entropy unknown blobs (possible novel secrets) — reported separately,
    # NOT as confirmed secrets (avoids false precision).
    entropy_blobs = sum(1 for m in _HIGH_ENTROPY.findall(text) if _shannon(m) > 4.0)
    code_fences = len(_CODE_FENCE.findall(text)) // 2

    return {
        "secrets": secrets,
        "pii": pii,
        "high_entropy_blobs": entropy_blobs,
        "code_blocks": code_fences,
    }


def _total(d: dict[str, int]) -> int:
    return sum(d.values())


def check_exposure(rec: dict, cfg: dict[str, Any] | None = None) -> Verdict:
    cfg = cfg or {}
    req = rec.get("request", {})
    resp = rec.get("response", {})

    req_text = req.get("raw", "") if req.get("raw_encoding") == "utf8" else ""
    resp_text = resp.get("raw", "") if resp.get("raw_encoding") == "utf8" else ""

    req_scan = _scan_text(req_text)
    resp_scan = _scan_text(resp_text)

    req_secrets = _total(req_scan["secrets"])
    req_pii = _total(req_scan["pii"])
    resp_secrets = _total(resp_scan["secrets"])
    resp_pii = _total(resp_scan["pii"])

    truncated = bool(req.get("truncated") or resp.get("truncated"))

    detectors = dict(_DETECTOR_VERSIONS)
    if _PRESIDIO_VERSION:
        detectors["presidio"] = _PRESIDIO_VERSION
    else:
        detectors["presidio"] = "absent (lower recall on names/orgs/locations)"

    detail = {
        "request": {
            "secrets": req_scan["secrets"], "pii": req_scan["pii"],
            "high_entropy_blobs": req_scan["high_entropy_blobs"],
            "code_blocks": req_scan["code_blocks"],
        },
        "response": {
            "secrets": resp_scan["secrets"], "pii": resp_scan["pii"],
            "high_entropy_blobs": resp_scan["high_entropy_blobs"],
            "code_blocks": resp_scan["code_blocks"],
        },
        "truncated_capture": truncated,
        "detector_versions": detectors,
        "lower_bound": True,
        "note": (
            "LOWER BOUND of what egressed to the relay -- 'at least', never 'safe'. "
            "assay does NOT prevent the relay reading this; it measures so you can ship less. "
            "Zero detected != zero present (detectors miss novel secrets, ambiguous/non-Western "
            "names, inferable identity). Scans request AND response. "
            + ("Capture was TRUNCATED at the proxy cap -- content past the cap is uncounted, "
               "so the true exposure is HIGHER than this. " if truncated else "")
        ),
    }

    total_secrets = req_secrets + resp_secrets
    total_pii = req_pii + resp_pii

    # Severity: secrets in egress are the loud signal (almost always a mistake);
    # PII/code are informational exposure measurements, not alarms.
    if total_secrets > 0:
        where = []
        if req_secrets:
            where.append(f"{req_secrets} in request")
        if resp_secrets:
            where.append(f"{resp_secrets} in response")
        return new_verdict(
            rec, CHECK, "flag", "warn",
            f"at least {total_secrets} credential(s) egressed to the relay "
            f"({', '.join(where)}) -- the relay can read these; rotate/remove them",
            detail)

    if total_pii > 0 or req_scan["code_blocks"] or resp_scan["code_blocks"]:
        bits = []
        if total_pii:
            bits.append(f"{total_pii} PII entit(y/ies)")
        cb = req_scan["code_blocks"] + resp_scan["code_blocks"]
        if cb:
            bits.append(f"{cb} code block(s)")
        return new_verdict(
            rec, CHECK, "ok", "info",
            f"egress exposure (lower bound): {', '.join(bits)} -- measured, not prevented",
            detail)

    return new_verdict(
        rec, CHECK, "ok", "info",
        "no patterned sensitive content detected (LOWER BOUND -- not a clean bill of health; "
        "detectors miss novel/ambiguous content)",
        detail)
