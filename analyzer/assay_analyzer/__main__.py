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
    p_replay.add_argument("--reference", action="append", default=[],
                          help="path to a model_identity reference blob (repeatable); "
                               "enables model_identity batch verdicts on probe records")

    p_report = sub.add_parser("report", help="render a scorecard from verdicts")
    p_report.add_argument("--verdicts", required=True)
    p_report.add_argument("--evidence", help="also verify the evidence chain")

    p_buildref = sub.add_parser("build-reference",
                                help="assemble a model_identity reference from probe evidence")
    p_buildref.add_argument("--evidence", required=True, help="probe-tagged evidence.jsonl")
    p_buildref.add_argument("--out", required=True, help="reference blob output path")
    p_buildref.add_argument("--model", required=True)
    p_buildref.add_argument("--prompt-pool", required=True, help="newline-delimited prompt pool")
    p_buildref.add_argument("--temperature", type=float, default=1.0)
    p_buildref.add_argument("--max-tokens", type=int, default=40)
    p_buildref.add_argument("--n", type=int, default=6)
    p_buildref.add_argument("--precision", default="reference")

    args = parser.parse_args(argv)

    if args.cmd == "run":
        from .runner import run

        run(_load_config(args.config))
        return 0

    if args.cmd == "replay":
        from .runner import replay

        cfg = _load_config(args.config) if args.config else {
            "token_recount": {}, "cache_replay": {}, "throughput": {},
            "provenance": {}, "exposure": {}, "model_identity": {},
        }
        references = {}
        if args.reference:
            from .reference import load_reference

            for rp in args.reference:
                references[rp] = load_reference(rp)
        verdicts = replay(args.evidence, cfg, references)
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

    if args.cmd == "build-reference":
        from .evidence import iter_evidence
        from .probe import group_probe_batches
        from .reference import build_reference, save_reference

        prompts = [ln.strip() for ln in open(args.prompt_pool, encoding="utf-8")
                   if ln.strip()]
        records = list(iter_evidence(args.evidence, verify=True))
        batches = group_probe_batches(records)
        if not batches:
            print("build-reference: no probe records found in evidence", file=sys.stderr)
            return 1
        # Merge all batches' samples (a calibrate run is normally one batch).
        merged: dict[int, list[str]] = {}
        for b in batches.values():
            for pid, comps in b["samples"].items():
                merged.setdefault(pid, []).extend(comps)
        blob = build_reference(
            provider="openai", model=args.model, prompts=prompts, samples=merged,
            temperature=args.temperature, max_tokens=args.max_tokens, n=args.n,
            precision=args.precision)
        save_reference(blob, args.out)
        total = sum(len(v) for v in merged.values())
        print(f"build-reference: wrote {args.out} — {len(merged)} prompts, {total} samples "
              f"for {args.model}", file=sys.stderr)
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
