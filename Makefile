# assay (照妖镜) — dev entry points
.PHONY: all build test test-go test-py vectors e2e clean fmt vet

PY ?= python3

all: build test

build:
	go build -o bin/assay ./cmd/assay

# Full test suite: Go unit/integration + cross-language digest + Python checks.
test: test-go test-py

test-go:
	go test ./...

test-py:
	$(PY) analyzer/tests/test_digest.py
	PYTHONPATH=analyzer $(PY) analyzer/tests/test_checks.py
	PYTHONPATH=analyzer $(PY) analyzer/tests/test_provenance.py
	PYTHONPATH=analyzer $(PY) analyzer/tests/test_exposure.py
	PYTHONPATH=analyzer $(PY) analyzer/tests/test_model_identity.py
	PYTHONPATH=analyzer $(PY) analyzer/tests/test_probe_pipeline.py

# Regenerate the shared Go<->Python digest golden vectors (run after a schema
# change; commit the result). Python then verifies against them in test-py.
vectors:
	UPDATE_VECTORS=1 go test ./internal/evidence/ -run TestDigestVectors -count=1
	$(PY) analyzer/tests/test_digest.py

# End-to-end smoke: dishonest mock relay -> assay -> client; asserts the cheats
# are caught and the evidence chain verifies.
e2e:
	PY=$(PY) bash scripts/e2e.sh

# Phase 1 end-to-end: calibrate -> probe (honest + swapped) -> model_identity.
e2e-phase1:
	PY=$(PY) bash scripts/e2e_phase1.sh

vet:
	go vet ./...

fmt:
	go fmt ./...

clean:
	rm -rf bin/ data/*.jsonl data/*.checkpoint data/*.status data/*.sqlite
