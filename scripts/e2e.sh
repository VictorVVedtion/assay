#!/usr/bin/env bash
# End-to-end smoke test: dishonest mock relay -> assay proxy -> client.
# Proves transparent passthrough, evidence chain validity, and that the Phase 0
# checks catch token inflation + cache replay. Self-contained; cleans up.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PY="${PY:-python3}"
WORK="$(mktemp -d)"
RELAY_PORT=9971
PROXY_PORT=9972
trap 'kill ${RELAY_PID:-} ${PROXY_PID:-} 2>/dev/null || true; rm -rf "$WORK"' EXIT

echo "==> build assay"
go build -o "$WORK/assay" ./cmd/assay

echo "==> config"
cat > "$WORK/assay.yaml" <<YAML
listen: ":$PROXY_PORT"
upstreams:
  - target: "http://127.0.0.1:$RELAY_PORT"
    auth_mode: passthrough
evidence:
  path: "$WORK/evidence.jsonl"
  flush_every_records: 1
analyzer:
  verdicts_path: "$WORK/verdicts.jsonl"
  token_recount: { tolerance_pct: 4.0, min_abs_tokens: 5 }
  cache_replay: { min_normalized_len: 64 }
  throughput: { model_class_ceiling_tps: { default: 2000 } }
YAML

echo "==> start dishonest mock relay :$RELAY_PORT"
"$PY" testdata/mock_relay.py "$RELAY_PORT" & RELAY_PID=$!
echo "==> start assay proxy :$PROXY_PORT"
"$WORK/assay" proxy --config "$WORK/assay.yaml" & PROXY_PID=$!

# wait for proxy health
for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PROXY_PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

echo "==> request 1 (non-stream, prompt A)"
R1=$(curl -fsS "http://127.0.0.1:$PROXY_PORT/v1/chat/completions" \
  -H "Authorization: Bearer test-key" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"What is the capital of France?"}]}')
echo "$R1" | "$PY" -c "import sys,json; d=json.load(sys.stdin); print('   got:', d['choices'][0]['message']['content'][:40], '... usage.completion=', d['usage']['completion_tokens'])"

echo "==> request 2 (non-stream, DIFFERENT prompt B -> same cached answer)"
curl -fsS "http://127.0.0.1:$PROXY_PORT/v1/chat/completions" \
  -H "Authorization: Bearer test-key" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Tell me about quantum computing in detail please."}]}' >/dev/null

echo "==> request 3 (stream)"
curl -fsS -N "http://127.0.0.1:$PROXY_PORT/v1/chat/completions" \
  -H "Authorization: Bearer test-key" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"Say hi"}]}' >/dev/null

sleep 0.5

echo "==> verify evidence chain"
"$WORK/assay" verify --evidence "$WORK/evidence.jsonl"

echo "==> replay (reproducible verdicts)"
PYTHONPATH=analyzer "$PY" -m assay_analyzer replay --evidence "$WORK/evidence.jsonl" --config "$WORK/assay.yaml" --out "$WORK/verdicts.jsonl"

echo "==> scorecard"
PYTHONPATH=analyzer "$PY" -m assay_analyzer report --verdicts "$WORK/verdicts.jsonl" --evidence "$WORK/evidence.jsonl"

echo
echo "==> ASSERTIONS"
PYTHONPATH=analyzer "$PY" - "$WORK/verdicts.jsonl" <<'PYEOF'
import sys, json
verdicts = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
tr = [v for v in verdicts if v["check"] == "token_recount"]
cr = [v for v in verdicts if v["check"] == "cache_replay"]

# token_recount: with a non-reasoning model claiming 500 vs ~25 visible, the
# billed>>visible case is recorded as an observation (not a hard flag, by design).
billed_over = [v for v in tr if "billed_exceeds_visible_pct" in v.get("detail", {})]
assert billed_over, "token_recount should record billed>>visible observation"
print(f"  ✓ token_recount recorded billed-exceeds-visible on {len(billed_over)} record(s)")

# cache_replay: same answer for 2 distinct prompts -> at least one flag.
cr_flags = [v for v in cr if v["status"] == "flag"]
assert cr_flags, "cache_replay should flag the repeated response across distinct prompts"
print(f"  ✓ cache_replay flagged {len(cr_flags)} replay collision(s)")

print("  ✓ E2E PASSED")
PYEOF
