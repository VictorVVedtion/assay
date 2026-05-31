#!/usr/bin/env bash
# Phase 1 end-to-end: calibrate against a "genuine" upstream, then probe both an
# honest relay (same model) and a swapped relay (cheap model), and assert
# model_identity passes the honest one and FLAGS the swap. Self-contained.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
PY="${PY:-python3}"
WORK="$(mktemp -d)"
GEN_PORT=9611      # "official" genuine endpoint (model-premium voice)
CHEAP_PORT=9612    # a relay that serves the cheap voice
trap 'kill ${GEN_PID:-} ${CHEAP_PID:-} 2>/dev/null || true; rm -rf "$WORK"' EXIT

echo "==> build"
go build -o "$WORK/assay" ./cmd/assay
PROMPTS="$WORK/prompts.txt"
printf '%s\n' \
  "Continue: The history of" \
  "Continue: Photosynthesis is" \
  "Continue: Quantum mechanics" \
  "Continue: The Great Barrier Reef" \
  "Continue: Jazz emerged when" \
  "Continue: Plate tectonics" > "$PROMPTS"

mkcfg() { # $1=evidence path  $2=target
cat > "$WORK/$3" <<YAML
listen: ":0"
upstreams:
  - target: "$2"
    auth_mode: passthrough
evidence:
  path: "$1"
  flush_every_records: 1
probe:
  prompt_pool: "$PROMPTS"
  m: 6
  n: 5
  max_tokens: 40
  temperature: 1.0
  jitter_max_ms: 0
analyzer:
  verdicts_path: "$WORK/v.jsonl"
YAML
}

echo "==> start genuine upstream (:$GEN_PORT) and cheap relay (:$CHEAP_PORT)"
"$PY" testdata/mock_models.py "$GEN_PORT" genuine & GEN_PID=$!
"$PY" testdata/mock_models.py "$CHEAP_PORT" cheap & CHEAP_PID=$!
sleep 0.6

# 1) CALIBRATE against the genuine endpoint -> reference
mkcfg "$WORK/calib.jsonl" "http://127.0.0.1:$GEN_PORT" calib.yaml
echo "==> calibrate (genuine reference)"
OFFICIAL_KEY="sk-official-demo" "$WORK/assay" calibrate --config "$WORK/calib.yaml" \
  --model model-premium --set-id calib --key-env OFFICIAL_KEY 2>&1 | grep -i "wrote\|reference" | head -3
PYTHONPATH=analyzer "$PY" -m assay_analyzer build-reference \
  --evidence "$WORK/calib.jsonl" --out "$WORK/ref-premium.json" \
  --model model-premium --prompt-pool "$PROMPTS" --temperature 1.0 --max-tokens 40 --n 5 2>&1 | tail -1

# 2) PROBE the honest relay (also genuine voice) -> should NOT flag
mkcfg "$WORK/honest.jsonl" "http://127.0.0.1:$GEN_PORT" honest.yaml
echo "==> probe honest relay"
"$WORK/assay" probe --config "$WORK/honest.yaml" --model model-premium --set-id audit 2>&1 | grep -i "wrote" | head -1

# 3) PROBE the swapped relay (cheap voice, still claims model-premium) -> MUST flag
mkcfg "$WORK/swap.jsonl" "http://127.0.0.1:$CHEAP_PORT" swap.yaml
echo "==> probe swapped relay"
"$WORK/assay" probe --config "$WORK/swap.yaml" --model model-premium --set-id audit 2>&1 | grep -i "wrote" | head -1

echo "==> verdicts"
HONEST=$(PYTHONPATH=analyzer "$PY" -m assay_analyzer replay --evidence "$WORK/honest.jsonl" \
  --reference "$WORK/ref-premium.json" 2>/dev/null | "$PY" -c "import sys,json; [print(json.loads(l)['status'],json.loads(l)['summary']) for l in sys.stdin if json.loads(l)['check']=='model_identity']")
SWAP=$(PYTHONPATH=analyzer "$PY" -m assay_analyzer replay --evidence "$WORK/swap.jsonl" \
  --reference "$WORK/ref-premium.json" 2>/dev/null | "$PY" -c "import sys,json; [print(json.loads(l)['status'],json.loads(l)['summary']) for l in sys.stdin if json.loads(l)['check']=='model_identity']")
echo "  HONEST -> $HONEST"
echo "  SWAP   -> $SWAP"

echo "==> ASSERTIONS"
[ -n "$HONEST" ] && echo "$HONEST" | grep -q "^ok" && echo "  ok  honest relay NOT flagged" || { echo "  XX  honest relay should be ok"; exit 1; }
[ -n "$SWAP" ] && echo "$SWAP" | grep -q "^flag" && echo "  ok  swapped relay FLAGGED" || { echo "  XX  swap should flag"; exit 1; }
echo "  ok  PHASE 1 E2E PASSED"
