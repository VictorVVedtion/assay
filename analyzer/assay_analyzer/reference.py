"""Reference fingerprint store for model_identity (PHASE0.md Phase 1).

A "reference" is a set of genuine-model completions over a FIXED prompt pool at
FIXED sampling params, collected via official direct access (`assay calibrate`).
model_identity's MMD test compares a relay's probe completions against it.

Format (one JSON file per reference, params-keyed so a probe batch can only be
compared against a reference sampled the SAME way):

    {
      "v": 1,
      "provider": "openai", "model": "gpt-4o-mini",
      "precision": "reference",            # label; fp32/fp16 when known
      "prompt_pool_hash": "<sha256>",      # binds to the exact prompt set
      "sampling_params_hash": "<sha256>",  # binds to temp/max_tokens/n
      "samples": { "<prompt_id>": ["completion", ...] }
    }

The reference holds ONLY completion text (Wikipedia-continuation style) — never
the official key, which `assay calibrate` uses transiently and never stores.
A mismatch in either hash means the comparison is invalid -> model_identity
must skip (stale/mismatched reference), never silently compare apples to oranges.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

REFERENCE_VERSION = 1


def prompt_pool_hash(prompts: list[str]) -> str:
    """Stable hash of the ordered prompt pool."""
    h = hashlib.sha256()
    for p in prompts:
        h.update(len(p).to_bytes(8, "big"))
        h.update(p.encode("utf-8"))
    return h.hexdigest()


def sampling_params_hash(temperature: float, max_tokens: int, n: int) -> str:
    """Stable hash of the sampling parameters that shape the distribution.
    Temperature is quantized to 3 decimals so float formatting can't drift it."""
    key = f"temp={temperature:.3f}|max_tokens={int(max_tokens)}|n={int(n)}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def build_reference(
    *,
    provider: str,
    model: str,
    prompts: list[str],
    samples: dict[int, list[str]],
    temperature: float,
    max_tokens: int,
    n: int,
    precision: str = "reference",
) -> dict[str, Any]:
    """Assemble a reference blob from collected genuine-model completions.
    samples: {prompt_id: [completion, ...]}. Keys are stored as strings (JSON)."""
    return {
        "v": REFERENCE_VERSION,
        "provider": provider,
        "model": model,
        "precision": precision,
        "prompt_pool_hash": prompt_pool_hash(prompts),
        "sampling_params_hash": sampling_params_hash(temperature, max_tokens, n),
        "samples": {str(k): v for k, v in samples.items()},
    }


def save_reference(blob: dict[str, Any], path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(blob, f, ensure_ascii=False, indent=1)


def load_reference(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        blob = json.load(f)
    if blob.get("v") != REFERENCE_VERSION:
        raise ValueError(f"unsupported reference version {blob.get('v')}")
    return blob


def reference_samples(blob: dict[str, Any]) -> dict[int, list[str]]:
    """Return samples keyed by int prompt id (MMD uses int keys)."""
    return {int(k): v for k, v in blob.get("samples", {}).items()}


class ParamMismatch(Exception):
    """Raised when a probe batch's params don't match the reference's."""


def verify_params(reference: dict[str, Any], pool_hash: str, params_hash: str) -> None:
    """Ensure a probe batch was sampled the SAME way as the reference. If not,
    the MMD comparison is invalid and the caller must skip (not compare)."""
    if reference.get("prompt_pool_hash") != pool_hash:
        raise ParamMismatch(
            f"prompt pool mismatch: reference {reference.get('prompt_pool_hash', '')[:12]} "
            f"!= probe {pool_hash[:12]} — recalibrate against the same prompt pool"
        )
    if reference.get("sampling_params_hash") != params_hash:
        raise ParamMismatch(
            f"sampling params mismatch: reference {reference.get('sampling_params_hash', '')[:12]} "
            f"!= probe {params_hash[:12]} — temperature/max_tokens/n differ"
        )
