"""Reference-free Phase 0 checks (PHASE0.md §6).

Each check is a pure function: ``(record, config, state) -> Verdict | None``.
Purity is what makes ``assay-analyzer replay`` reproduce ``run`` exactly.
"""

from .base import Verdict, new_verdict
from .token_recount import check_token_recount
from .cache_replay import CacheReplayState, check_cache_replay
from .throughput import check_throughput
from .provenance import check_provenance
from .exposure import check_exposure
from .model_identity import check_model_identity, run_mmd

__all__ = [
    "Verdict",
    "new_verdict",
    "check_token_recount",
    "check_cache_replay",
    "CacheReplayState",
    "check_throughput",
    "check_provenance",
    "check_exposure",
    "check_model_identity",
    "run_mmd",
]
