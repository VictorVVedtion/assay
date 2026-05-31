# assay-analyzer (照妖镜 · 分析面)

Python analysis plane for [assay](../README.md). Tails the Go data plane's
hash-chained `evidence.jsonl`, runs reference-free checks, writes reproducible
`verdicts.jsonl`. Contract: [../PHASE0.md](../PHASE0.md).

```bash
pip install -e .
assay-analyzer run    --config ../assay.yaml          # live
assay-analyzer replay --evidence ../data/evidence.jsonl  # reproduce all verdicts
```

Checks (Phase 0): `token_recount` (tiktoken), `cache_replay`, `throughput`.
