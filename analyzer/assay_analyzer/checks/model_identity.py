"""model_identity — detect a silently substituted/quantized/套壳 model via a
Maximum Mean Discrepancy (MMD) two-sample test on PROBE completions (PHASE0.md
Phase 1; method from arXiv 2410.20247, Model Equality Testing).

WHY MMD (not LLMmap): a buyer must be able to recompute the verdict from the raw
stored completions and get the byte-identical result — assay's "anyone reproduces
from evidence bytes" contract. MMD is a pure deterministic function of
(reference_samples, probe_samples); a trained LLMmap classifier's verdict depends
on weights and is not reproducible. The math here is vendored, dependency-free
(stdlib only), and short enough to audit.

HONEST BOUNDARY (in every verdict, never softened):
  * A positive test proves "the relay's output distribution differs from the
    reference at p<alpha" — NOT "fraud". Benign quantization, a finetune, a
    watermark, or serving-engine nondeterminism are indistinguishable. Severity
    caps at "warn"; the word "fraud" never appears.
  * REQUIRES a genuine reference distribution (built via `assay calibrate`
    against official direct access). No reference -> skip, never a guessed "ok".
  * ACTIVE PROBE method only: needs m fixed prompts each sampled n times at a
    fixed temperature. It does NOT work on organic traffic. A relay that
    recognizes synthetic probes and serves genuine-only-to-probes defeats it —
    Phase 1 is an economic deterrent, not a proof against a determined adversary.
  * Power is modest: the source paper's 77.4% is a SIMULATION MEDIAN vs generic
    distortions; field power against an evasion-aware relay is unmeasured and
    lower. Do not quote 77.4% as assay's number.
  * POISONED-ROOT limit: the reference is TRUSTED, not verified. If the buyer's
    "official" calibration key itself routes through a reseller serving a
    substitute, the reference captures the substitute and a matching relay reads
    as "consistent" — there is no fully-local defense. Calibrate against the most
    direct access you have, and prefer a multi-party community reference.
  * Probes must use the SAME prompt pool and sampling params as the reference; a
    mismatch is not comparable. The binding guard skips on mismatch rather than
    comparing apples to oranges.

The composite-null rule (paper eq. 11): when references for multiple genuine
precisions exist (fp32 AND fp16), flag only if the relay rejects against ALL of
them — this structurally separates "different model" from "benign quantization".
"""

from __future__ import annotations

import hashlib
import random
import unicodedata
from typing import Any

from .base import Verdict, new_verdict

CHECK = "model_identity"

# Character-space comparison (paper §4.3): works for any provider without a
# tokenizer (Claude/Gemini have none public). For OpenAI we COULD tokenize, but
# character space keeps one code path and is what the paper validates at L~1000.
_PAD = "\x00"


def normalize_completion(text: str) -> str:
    """Canonical form fed to the kernel, applied IDENTICALLY on the calibrate
    (reference) and probe paths. Neutralizes benign formatting differences that
    the position-sensitive Hamming kernel would otherwise read as a real model
    difference (a single leading space shifts every position -> false flag).
    NFC + strip leading/trailing whitespace. Reproducible (pure function)."""
    return unicodedata.normalize("NFC", text).strip()


def _hamming_kernel(a: str, b: str, length: int) -> int:
    """k_tilde (paper eq. 7): count of matching positions over fixed length L,
    both sequences right-padded to L. A simple, deterministic string kernel."""
    n = 0
    m = min(len(a), len(b), length)
    for i in range(m):
        if a[i] == b[i]:
            n += 1
    return n


def _pair_kernel(za: tuple[int, str], zb: tuple[int, str], length: int) -> float:
    """Full sample kernel (paper): k(z,z') = 1[prompt==prompt'] * k_tilde(y,y') / L.
    The prompt indicator means completions to DIFFERENT prompts contribute ZERO —
    so the statistic measures per-prompt distributional difference, not the
    cross-prompt mixture. z = (prompt_id, completion_text)."""
    if za[0] != zb[0]:
        return 0.0
    if length == 0:
        return 0.0
    return _hamming_kernel(za[1], zb[1], length) / length


def _mmd2_u_stat(P: list[tuple[int, str]], Q: list[tuple[int, str]], length: int) -> float:
    """Unbiased U-statistic MMD^2 (paper eq. 4) with the prompt-indicator kernel.
    P/Q are lists of (prompt_id, completion) so the kernel can gate on prompt."""
    nP, nQ = len(P), len(Q)
    if nP < 2 or nQ < 2 or length == 0:
        return 0.0
    sP = 0.0
    for i in range(nP):
        for j in range(nP):
            if i != j:
                sP += _pair_kernel(P[i], P[j], length)
    sP /= nP * (nP - 1)
    sQ = 0.0
    for i in range(nQ):
        for j in range(nQ):
            if i != j:
                sQ += _pair_kernel(Q[i], Q[j], length)
    sQ /= nQ * (nQ - 1)
    sPQ = 0.0
    for x in P:
        for y in Q:
            sPQ += _pair_kernel(x, y, length)
    sPQ /= nP * nQ
    return sP + sQ - 2.0 * sPQ


def _truncate_pad_len(samples: list[tuple[int, str]], cap: int) -> int:
    longest = max((len(s[1]) for s in samples), default=0)
    return min(cap, longest) if longest else 0


def _permutation_pvalue(P: list[tuple[int, str]], Q: list[tuple[int, str]],
                        length: int, b: int, seed: int) -> tuple[float, float]:
    """Two-sample permutation p-value for MMD^2. Reproducible AND uniform: the
    pool is CANONICALLY ORDERED (sorted) so the same multiset always permutes the
    same way, and shuffling uses random.Random(seed) (uniform, unlike the
    low-bit-biased hand-rolled LCG). The seed is derived deterministically from
    the evidence (see run_mmd), so replay reproduces the byte-identical p-value."""
    observed = _mmd2_u_stat(P, Q, length)
    nP = len(P)
    # Canonical pool order: sort so the permutation null is invariant to the
    # arrival/merge order of completions (equal multisets -> identical p-value).
    pool = sorted(P + Q)
    rng = random.Random(seed)
    ge = 0
    for _ in range(b):
        idx = list(range(len(pool)))
        rng.shuffle(idx)
        perm = [pool[k] for k in idx]
        if _mmd2_u_stat(perm[:nP], perm[nP:], length) >= observed:
            ge += 1
    pvalue = (ge + 1) / (b + 1)  # +1 smoothing; never exactly 0
    return observed, pvalue


def _seed_from(parts: Any) -> int:
    """Deterministic integer seed from the (sorted) evidence. str() of a sorted
    list of (int,str) tuples is stable across Python versions for these types."""
    h = hashlib.sha256(repr(parts).encode("utf-8")).digest()
    return int.from_bytes(h[:8], "big")


def _flatten(samples: dict[int, list[str]], shared: list[int]) -> list[tuple[int, str]]:
    """Flatten {pid:[text,...]} into [(pid, normalized_text), ...] over shared
    prompts, in canonical (sorted) order so seeding/permutation are reproducible."""
    out: list[tuple[int, str]] = []
    for pid in shared:
        for text in samples[pid]:
            out.append((pid, normalize_completion(text)))
    return out


def run_mmd(probe_samples: dict[int, list[str]],
            reference: dict[str, dict[int, list[str]]],
            cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """Per-prompt MMD two-sample test (paper prompt-indicator kernel). The kernel
    only compares completions of the SAME prompt; the U-statistic aggregates that
    per-prompt signal. Returns a detail dict with per-reference p-values.

    probe_samples: {prompt_id: [completion, ...]} from the relay under test.
    reference: {precision_label: {prompt_id: [completion, ...]}} genuine refs.

    Insufficient shared evidence (no overlapping prompts, or <2 samples a side)
    yields per_ref[label]["insufficient"]=True and is treated as skip by the
    caller — NEVER a silent 'ok'."""
    cfg = cfg or {}
    alpha = float(cfg.get("alpha", 0.01))
    b = int(cfg.get("permutations", 200))
    length_cap = int(cfg.get("length_cap", 1000))
    min_per_side = int(cfg.get("min_samples_per_side", 2))

    per_ref = {}
    for label, ref in reference.items():
        shared = sorted(set(probe_samples) & set(ref))
        P = _flatten(ref, shared)
        Q = _flatten(probe_samples, shared)
        insufficient = len(shared) == 0 or len(P) < min_per_side or len(Q) < min_per_side
        if insufficient:
            per_ref[label] = {"mmd2": None, "pvalue": None, "n_ref": len(P),
                              "n_probe": len(Q), "length": 0, "shared_prompts": len(shared),
                              "insufficient": True}
            continue
        length = _truncate_pad_len(P + Q, length_cap)
        seed = _seed_from((label, sorted(P), sorted(Q)))
        mmd2, pvalue = _permutation_pvalue(P, Q, length, b, seed)
        per_ref[label] = {"mmd2": round(mmd2, 6), "pvalue": round(pvalue, 6),
                          "n_ref": len(P), "n_probe": len(Q), "length": length,
                          "shared_prompts": len(shared), "insufficient": False}

    # Only references with sufficient shared evidence count toward a verdict.
    usable = {k: v for k, v in per_ref.items() if not v.get("insufficient")}
    all_insufficient = bool(per_ref) and not usable

    # Composite null (eq. 11): "differs" only if it rejects vs EVERY usable
    # reference. Rejecting just one (e.g. fp32 but not fp16) is the benign-
    # quantization gray zone -> not flagged.
    rejected_all = bool(usable) and all(r["pvalue"] < alpha for r in usable.values())
    rejected_any = any(r["pvalue"] < alpha for r in usable.values())
    return {"alpha": alpha, "permutations": b, "per_reference": per_ref,
            "rejected_all": rejected_all, "rejected_any": rejected_any,
            "all_insufficient": all_insufficient, "usable_references": len(usable)}


def check_model_identity(probe_batch: dict[str, Any], cfg: dict[str, Any] | None = None) -> Verdict:
    """Build a model_identity verdict from a probe batch + its reference.

    probe_batch: {
      'anchor_record': <evidence record>,   # for record_hash binding
      'model': <claimed model>,
      'samples': {prompt_id: [completion,...]},
      'reference': {precision: {prompt_id: [completion,...]}} | None,
      'member_record_hashes': [...],
    }
    """
    cfg = cfg or {}
    anchor = probe_batch["anchor_record"]
    model = probe_batch.get("model")
    reference = probe_batch.get("reference")
    # Optional param identity of the PROBE batch, for the binding guard. When the
    # caller supplies these, every reference must match or the comparison is
    # invalid (different prompts/temperature -> not apples-to-apples -> skip).
    probe_pool_hash = probe_batch.get("prompt_pool_hash")
    probe_params_hash = probe_batch.get("sampling_params_hash")
    ref_blobs = probe_batch.get("reference_blobs") or {}

    batch_digest = hashlib.sha256(
        "".join(sorted(probe_batch.get("member_record_hashes", []))).encode()
    ).hexdigest()

    base_detail = {
        "model": model,
        "probe_batch_digest": batch_digest,
        "member_record_hashes": probe_batch.get("member_record_hashes", []),
        "note": "MMD distribution test on active probes. A flag means 'differs from "
                "reference', NOT 'fraud' (benign quantization/finetune/serving variation "
                "indistinguishable). Modest power; an evasion-aware relay serving genuine-"
                "to-probes is undetected. The reference is TRUSTED, not verified — if the "
                "calibration key itself routed through a reseller serving a substitute, a "
                "matching relay reads as 'consistent' (poisoned-root limit). Reference built "
                "via official direct access; probes must use the SAME prompt pool & sampling.",
    }

    if not reference:
        d = dict(base_detail, reason="no_reference")
        return new_verdict(anchor, CHECK, "skip", "info",
                           f"model_identity: no genuine reference for {model} "
                           f"(run `assay calibrate` with official access, or import a "
                           f"community fingerprint) — verification not performed", d)

    # Binding guard (findings #5/#8/#9): a reference sampled with a different
    # prompt pool or sampling params is NOT comparable. If the probe batch
    # declares its params, every candidate reference must match — else skip,
    # never silently compare apples to oranges.
    if probe_pool_hash and probe_params_hash and ref_blobs:
        from ..reference import ParamMismatch, verify_params
        mismatches = []
        for label, blob in ref_blobs.items():
            try:
                verify_params(blob, probe_pool_hash, probe_params_hash)
            except ParamMismatch as e:
                mismatches.append(f"{label}: {e}")
        if mismatches:
            d = dict(base_detail, reason="param_mismatch", mismatches=mismatches)
            return new_verdict(anchor, CHECK, "skip", "warn",
                               f"model_identity: probe params don't match the {model} reference "
                               f"({mismatches[0]}) — recalibrate with the same prompt pool & "
                               f"sampling; not comparing mismatched distributions", d)

    result = run_mmd(probe_batch["samples"], reference, cfg)
    detail = dict(base_detail, **result)

    # Insufficient shared evidence (finding #10): skip, never a silent 'ok'.
    if result.get("all_insufficient"):
        shared = max((v.get("shared_prompts", 0) for v in result["per_reference"].values()), default=0)
        return new_verdict(anchor, CHECK, "skip", "warn",
                           f"model_identity: insufficient shared evidence for {model} "
                           f"(shared_prompts={shared}); too few comparable probe/reference "
                           f"samples — re-probe with the reference's prompt pool", detail)

    usable = [f"{k} p={v['pvalue']}" for k, v in result["per_reference"].items()
              if not v.get("insufficient")]
    refs = ", ".join(usable)
    if result["rejected_all"]:
        return new_verdict(anchor, CHECK, "flag", "warn",
                           f"output distribution differs from ALL genuine references of {model} "
                           f"({refs}) — distribution mismatch, NOT proof of substitution "
                           f"(benign quantization/serving variation indistinguishable; escalate)",
                           detail)
    if result["rejected_any"]:
        return new_verdict(anchor, CHECK, "ok", "info",
                           f"partial mismatch for {model} ({refs}) — rejected some but not all "
                           f"references; consistent with benign quantization (composite-null gray "
                           f"zone), not flagged", detail)
    return new_verdict(anchor, CHECK, "ok", "info",
                       f"consistent with {model} reference ({refs}); ~modest power, NOT proof of "
                       f"genuineness — an evasion-aware relay serving genuine-to-probes is "
                       f"undetected here (and the reference is trusted, not verified)", detail)
