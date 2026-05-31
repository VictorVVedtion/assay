#!/usr/bin/env bash
# dev-live.sh — one-shot end-to-end into ./data, so `make dashboard` opens
# straight into LIVE on REAL (locally-captured) data:
#
#   dishonest mock relay  ->  assay proxy (transparent tee)  ->  evidence.jsonl
#                                   |                               (hash chain)
#                                   v
#                            assay verify (chain VALID)
#                                   |
#                            assay-analyzer replay  ->  verdicts.jsonl
#
# Self-contained: backgrounds the relay + proxy only for the few seconds it takes
# to capture, then tears them down. The captured data/*.jsonl persist for the
# dashboard. Strictly local — the mock relay is the only "upstream". Catches the
# two cheats Phase 0 targets (token inflation + cache replay). Run `make clean`
# to wipe ./data and revert the dashboard to its synthetic Demo story.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PY="${PY:-python3}"
RELAY_PORT="${RELAY_PORT:-9971}"
PROXY_PORT="${PROXY_PORT:-9972}"
CFG="$(mktemp -t assay-dev-live.XXXXXX)"
RELAY_PID=""
PROXY_PID=""
cleanup() { kill "$RELAY_PID" "$PROXY_PID" 2>/dev/null || true; rm -f "$CFG"; }
trap cleanup EXIT

echo "==> build bin/assay"
go build -o bin/assay ./cmd/assay

echo "==> config -> ./data (the dashboard reads this dir; ASSAY_DATA_DIR default)"
cat > "$CFG" <<YAML
listen: ":$PROXY_PORT"
upstreams:
  - target: "http://127.0.0.1:$RELAY_PORT"
    auth_mode: passthrough
evidence:
  path: "./data/evidence.jsonl"
  flush_every_records: 1
analyzer:
  verdicts_path: "./data/verdicts.jsonl"
  token_recount: { tolerance_pct: 4.0, min_abs_tokens: 5 }
  cache_replay: { min_normalized_len: 64 }
  throughput: { model_class_ceiling_tps: { default: 2000 } }
YAML

rm -f ./data/evidence.jsonl ./data/verdicts.jsonl ./data/analyzer.sqlite

echo "==> start dishonest mock relay :$RELAY_PORT + assay proxy :$PROXY_PORT"
"$PY" testdata/mock_relay.py "$RELAY_PORT" >/tmp/assay-dev-relay.log 2>&1 &
RELAY_PID=$!
./bin/assay proxy --config "$CFG" >/tmp/assay-dev-proxy.log 2>&1 &
PROXY_PID=$!

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PROXY_PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.1
done

echo "==> send sample traffic through the proxy"
send() {
  curl -fsS ${2:+-N} "http://127.0.0.1:$PROXY_PORT/v1/chat/completions" \
    -H "Authorization: Bearer test-key" -H "Content-Type: application/json" \
    -d "$1" >/dev/null
}
send '{"model":"gpt-4o","messages":[{"role":"user","content":"What is the capital of France?"}]}'
send '{"model":"gpt-4o","messages":[{"role":"user","content":"Tell me about quantum computing in detail please."}]}'
send '{"model":"gpt-4o","messages":[{"role":"user","content":"Write a haiku about the sea."}]}'
send '{"model":"gpt-4o","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"Say hi"}]}' 1
sleep 0.6

echo "==> verify evidence chain (Go)"
./bin/assay verify --evidence ./data/evidence.jsonl

echo "==> analyze -> verdicts (Python, reproducible replay)"
PYTHONPATH=analyzer "$PY" -m assay_analyzer replay \
  --evidence ./data/evidence.jsonl --config "$CFG" --out ./data/verdicts.jsonl

echo
echo "==> ./data is now LIVE:"
wc -l ./data/evidence.jsonl ./data/verdicts.jsonl | sed 's/^/    /'
cat <<'EOF'

[OK] Real captured data is in ./data. Next:
   make dashboard       # opens the Live Audit Console — auto-selects LIVE

For continuous LIVE TAILING (watch new requests stream in as you send them):
   cp assay.example.yaml assay.yaml      # set evidence.path: ./data/evidence.jsonl
   ./bin/assay proxy --config assay.yaml &
   export OPENAI_BASE_URL=http://127.0.0.1:8080/v1   # point your app at the proxy
   # then `make dashboard` and send traffic — rows appear within ~1s

Reset to the synthetic Demo story:  make clean
EOF
