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

The composite-null rule (paper eq. 11): when references for multiple genuine
precisions exist (fp32 AND fp16), flag only if the relay rejects against ALL of
them — this structurally separates "different model" from "benign quantization".
"""

from __future__ import annotations

import hashlib
from typing import Any

from .base import Verdict, new_verdict

CHECK = "model_identity"

# Character-space comparison (paper §4.3): works for any provider without a
# tokenizer (Claude/Gemini have none public). For OpenAI we COULD tokenize, but
# character space keeps one code path and is what the paper validates at L~1000.
_PAD = "\x00"


def _hamming_kernel(a: str, b: str, length: int) -> int:
    """k_tilde (paper eq. 7): count of matching positions over fixed length L,
    both sequences right-padded to L. A simple, deterministic string kernel."""
    n = 0
    for i in range(length):
        ca = a[i] if i < len(a) else _PAD
        cb = b[i] if i < len(b) else _PAD
        if ca == cb and ca != _PAD:
            n += 1
    return n


def _truncate_pad_len(samples: list[str], cap: int) -> int:
    """L = min(cap, max observed length). Keeps the kernel bounded and stable."""
    longest = max((len(s) for s in samples), default=0)
    return min(cap, longest) if longest else 0


def _mmd2_u_stat(P: list[str], Q: list[str], length: int) -> float:
    """Unbiased U-statistic MMD^2 (paper eq. 4) with the Hamming kernel.
    Normalized by length so the statistic is scale-free in [-1, 1]-ish range."""
    nP, nQ = len(P), len(Q)
    if nP < 2 or nQ < 2 or length == 0:
        return 0.0

    def kk(x: str, y: str) -> float:
        return _hamming_kernel(x, y, length) / length

    # within-P (i != j)
    sP = 0.0
    for i in range(nP):
        for j in range(nP):
            if i != j:
                sP += kk(P[i], P[j])
    sP /= nP * (nP - 1)
    # within-Q (i != j)
    sQ = 0.0
    for i in range(nQ):
        for j in range(nQ):
            if i != j:
                sQ += kk(Q[i], Q[j])
    sQ /= nQ * (nQ - 1)
    # cross
    sPQ = 0.0
    for x in P:
        for y in Q:
            sPQ += kk(x, y)
    sPQ /= nP * nQ
    return sP + sQ - 2.0 * sPQ


def _permutation_pvalue(P: list[str], Q: list[str], length: int, b: int, seed: int) -> tuple[float, float]:
    """Permutation p-value for MMD^2 (paper). Deterministic: a stdlib LCG seeded
    from the evidence so `replay` reproduces the exact p-value (no numpy RNG)."""
    observed = _mmd2_u_stat(P, Q, length)
    pooled = P + Q
    nP = len(P)
    total = len(pooled)

    # Deterministic LCG (glibc constants) -> Fisher-Yates shuffle. No external RNG
    # so the p-value is byte-reproducible from the seed.
    state = seed & 0xFFFFFFFF

    def rnd() -> int:
        nonlocal state
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        return state

    ge = 0
    for _ in range(b):
        idx = list(range(total))
        for i in range(total - 1, 0, -1):
            j = rnd() % (i + 1)
            idx[i], idx[j] = idx[j], idx[i]
        perm = [pooled[k] for k in idx]
        stat = _mmd2_u_stat(perm[:nP], perm[nP:], length)
        if stat >= observed:
            ge += 1
    # +1 smoothing (standard) so p-value is never exactly 0
    pvalue = (ge + 1) / (b + 1)
    return observed, pvalue


def _seed_from(records_or_key: Any) -> int:
    """Stable integer seed from a string/bytes, for reproducible permutations."""
    h = hashlib.sha256(str(records_or_key).encode("utf-8")).digest()
    return int.from_bytes(h[:4], "big")


def run_mmd(probe_samples: dict[int, list[str]],
            reference: dict[str, dict[int, list[str]]],
            cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """Core MMD test, prompt-paired (kernel only compares completions of the SAME
    prompt — paper's prompt-agnostic full kernel). Returns a detail dict.

    probe_samples: {prompt_id: [completion, ...]} from the relay under test.
    reference: {precision_label: {prompt_id: [completion, ...]}} genuine refs.
    """
    cfg = cfg or {}
    alpha = float(cfg.get("alpha", 0.01))
    b = int(cfg.get("permutations", 200))
    length_cap = int(cfg.get("length_cap", 1000))

    per_ref = {}
    for label, ref in reference.items():
        # Pool the per-prompt MMD into one statistic by concatenating prompt-paired
        # comparisons; here we run one test over all shared prompts' completions
        # with a fixed L from the combined sample (paper uses the same L per test).
        shared = sorted(set(probe_samples) & set(ref))
        P, Q = [], []
        for pid in shared:
            Q.extend(probe_samples[pid])
            P.extend(ref[pid])
        length = _truncate_pad_len(P + Q, length_cap)
        seed = _seed_from((label, sorted(P), sorted(Q)))
        mmd2, pvalue = _permutation_pvalue(P, Q, length, b, seed)
        per_ref[label] = {"mmd2": round(mmd2, 6), "pvalue": round(pvalue, 6),
                          "n_ref": len(P), "n_probe": len(Q), "length": length,
                          "shared_prompts": len(shared)}

    # Composite null (eq. 11): "differs" only if it rejects vs EVERY genuine
    # reference. Rejecting just one (e.g. fp32 but not fp16) is the benign-
    # quantization gray zone -> not flagged.
    rejected_all = bool(per_ref) and all(r["pvalue"] < alpha for r in per_ref.values())
    rejected_any = any(r["pvalue"] < alpha for r in per_ref.values())
    return {"alpha": alpha, "permutations": b, "per_reference": per_ref,
            "rejected_all": rejected_all, "rejected_any": rejected_any}


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
                "to-probes is undetected. Reference built via official direct access.",
    }

    if not reference:
        d = dict(base_detail, reason="no_reference")
        return new_verdict(anchor, CHECK, "skip", "info",
                           f"model_identity: no genuine reference for {model} "
                           f"(run `assay calibrate` with official access, or import a "
                           f"community fingerprint) — verification not performed", d)

    result = run_mmd(probe_batch["samples"], reference, cfg)
    detail = dict(base_detail, **result)

    refs = ", ".join(f"{k} p={v['pvalue']}" for k, v in result["per_reference"].items())
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
                       f"undetected here", detail)
