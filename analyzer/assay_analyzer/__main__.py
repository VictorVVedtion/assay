"""CLI entry for the assay analysis plane.

    assay-analyzer run    --config assay.yaml        tail evidence.jsonl, analyze live
    assay-analyzer replay --evidence evidence.jsonl  re-derive ALL verdicts (reproducible)
    assay-analyzer report --verdicts verdicts.jsonl  human-readable scorecard
"""

from __future__ import annotations

import argparse
import json
import sys

from . import __version__


def _load_config(path: str) -> dict:
    import yaml  # local import so `replay`/`report` work without pyyaml

    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    # Flatten analyzer sub-config knobs to top level for the checks.
    an = cfg.get("analyzer", {})
    return {
        "evidence": cfg.get("evidence", {}),
        "analyzer": an,
        "token_recount": an.get("token_recount", {}),
        "cache_replay": an.get("cache_replay", {}),
        "throughput": an.get("throughput", {}),
        "provenance": an.get("provenance", {}),
        "exposure": an.get("exposure", {}),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="assay-analyzer",
        description="assay (照妖镜) analysis plane — independent LLM relay verification",
    )
    parser.add_argument("--version", action="version", version=f"assay-analyzer {__version__}")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="tail evidence.jsonl and analyze live")
    p_run.add_argument("--config", required=True)

    p_replay = sub.add_parser("replay", help="re-derive all verdicts from scratch (reproducible)")
    p_replay.add_argument("--evidence", required=True)
    p_replay.add_argument("--config", help="optional config for check tuning")
    p_replay.add_argument("--out", help="write verdicts JSONL here (default stdout)")

    p_report = sub.add_parser("report", help="render a scorecard from verdicts")
    p_report.add_argument("--verdicts", required=True)
    p_report.add_argument("--evidence", help="also verify the evidence chain")

    args = parser.parse_args(argv)

    if args.cmd == "run":
        from .runner import run

        run(_load_config(args.config))
        return 0

    if args.cmd == "replay":
        from .runner import replay

        cfg = _load_config(args.config) if args.config else {
            "token_recount": {}, "cache_replay": {}, "throughput": {},
            "provenance": {}, "exposure": {},
        }
        verdicts = replay(args.evidence, cfg)
        out = open(args.out, "w", encoding="utf-8") if args.out else sys.stdout
        try:
            for v in verdicts:
                out.write(json.dumps(v, ensure_ascii=False) + "\n")
        finally:
            if args.out:
                out.close()
        print(f"assay-analyzer: derived {len(verdicts)} verdicts from {args.evidence}",
              file=sys.stderr)
        return 0

    if args.cmd == "report":
        from .report import build_report, load_verdicts

        chain_status = None
        if args.evidence:
            from .evidence import iter_evidence, ChainError

            try:
                n = sum(1 for _ in iter_evidence(args.evidence, verify=True))
                chain_status = "VALID" if n else "EMPTY"
            except ChainError:
                chain_status = "BREAK"
        print(build_report(load_verdicts(args.verdicts), chain_status=chain_status))
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
