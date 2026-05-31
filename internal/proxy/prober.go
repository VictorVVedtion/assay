package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strings"
	"time"

	"assay/internal/config"
)

// The probe plane (PHASE0.md Phase 1): fire N synthetic requests (m fixed
// prompts x n completions, temperature=1.0) through the same upstream machinery
// the proxy uses, tagging each evidence record so the analyzer routes it to
// model_identity instead of the per-record checks. Two drivers use this:
//
//   - `assay calibrate` against the buyer's OFFICIAL key  -> genuine reference
//   - `assay probe`     against the relay under audit       -> samples to test
//
// Both write probe-tagged evidence via the same hash-chained Writer, so a
// reference and an audit are built from byte-identical, reproducible records.
//
// Honest scope (must not be oversold): a fixed prompt set sampled n-times at
// temp=1.0 in a burst is a recognizable synthetic signature. A relay that
// fingerprints probes can serve the genuine model only to them. Jittered
// dispatch and a rotating prompt pool raise that cost but do not eliminate it.

// ProbeSpec configures one probe batch.
type ProbeSpec struct {
	SetID       string   // groups the batch (calibrate/audit run id)
	Model       string   // the model to request
	Prompts     []string // fixed prompt pool (a random subset of M is used)
	M           int      // number of distinct prompts to use this batch
	N           int      // completions per prompt
	MaxTokens   int      // per completion
	Temperature float64  // MUST be >0 (1.0) — MMD needs the sampling distribution
	JitterMaxMs int      // upper bound on per-request Poisson-ish dispatch jitter
}

func (s *ProbeSpec) defaults() {
	if s.M <= 0 || s.M > len(s.Prompts) {
		s.M = len(s.Prompts)
	}
	if s.N <= 0 {
		s.N = 6
	}
	if s.MaxTokens <= 0 {
		s.MaxTokens = 40
	}
	if s.Temperature <= 0 {
		s.Temperature = 1.0
	}
}

// probeJitter returns a deterministic-but-spread delay for request index i, so
// dispatch is not a perfectly uniform burst. Deterministic (seeded by set id +
// index) keeps runs reproducible while still de-uniforming the timing.
func probeJitter(setID string, i, maxMs int) time.Duration {
	if maxMs <= 0 {
		return 0
	}
	// simple hash -> [0,maxMs)
	h := uint32(2166136261)
	for _, c := range setID {
		h = (h ^ uint32(c)) * 16777619
	}
	h = (h ^ uint32(i)) * 16777619
	// Skew toward smaller delays (exp-ish) so most are quick, some longer.
	frac := float64(h%1000) / 1000.0
	skewed := -math.Log(1.0-frac*0.95) / 3.0 // in ~[0, ~1)
	if skewed > 1 {
		skewed = 1
	}
	return time.Duration(skewed*float64(maxMs)) * time.Millisecond
}

// RunProbeBatch fires the batch through the upstream and writes one tagged
// evidence record per completion. It is NOT on any client path, so it does the
// simple synchronous thing: send, read fully, build+submit record. Returns the
// number of successful completions captured.
//
// authHeader/authValue let the caller supply the credential transiently (e.g.
// the official key for calibrate) WITHOUT it being stored — redaction scrubs it
// from the evidence exactly as for proxied traffic.
func (p *Proxy) RunProbeBatch(ctx context.Context, spec ProbeSpec, authHeader, authValue string) (int, error) {
	spec.defaults()
	if len(spec.Prompts) == 0 {
		return 0, fmt.Errorf("probe: empty prompt pool")
	}
	prompts := spec.Prompts[:spec.M]

	provider, apiSurface := ClassifyRoute("/v1/chat/completions")
	ok := 0
	idx := 0
	for pid, prompt := range prompts {
		for j := 0; j < spec.N; j++ {
			select {
			case <-ctx.Done():
				return ok, ctx.Err()
			default:
			}
			if d := probeJitter(spec.SetID, idx, spec.JitterMaxMs); d > 0 {
				timer := time.NewTimer(d)
				select {
				case <-ctx.Done():
					timer.Stop()
					return ok, ctx.Err()
				case <-timer.C:
				}
			}
			idx++

			reqBody := buildChatRequest(spec.Model, prompt, spec.MaxTokens, spec.Temperature)
			note := probeNote(spec.SetID, pid)
			captured, ttftUs, totalUs, status, complete, connReused := p.fireOne(ctx, reqBody, authHeader, authValue)

			rec := p.buildRecord(recordInput{
				startWall: time.Now().UTC(), method: "POST", path: "/v1/chat/completions",
				provider: provider, apiSurface: apiSurface,
				reqHeaders: probeReqHeaders(authHeader), reqBody: reqBody,
				respHeaders: nil, respBody: captured, respTotal: len(captured),
				status: status, stream: false, complete: complete,
				ttftUs: ttftUs, totalUs: totalUs, connReused: connReused,
				teeOk: true, note: &note,
			})
			if !p.writer.Submit(rec) {
				// queue full — drop (counted by writer), keep going
			}
			if complete && status == 200 {
				ok++
			}
		}
	}
	return ok, nil
}

// fireOne performs a single non-stream upstream request and returns the captured
// body + timing. Errors are folded into (complete=false) — never panics.
func (p *Proxy) fireOne(ctx context.Context, reqBody []byte, authHeader, authValue string) (
	captured []byte, ttftUs, totalUs *uint64, status int, complete bool, connReused bool) {

	start := time.Now()
	target := p.upstream.Target + "/v1/chat/completions"
	req, err := http.NewRequestWithContext(ctx, "POST", target, bytes.NewReader(reqBody))
	if err != nil {
		return nil, nil, nil, http.StatusBadGateway, false, false
	}
	req.Header.Set("Content-Type", "application/json")
	if p.cfg.StripAcceptEncoding {
		req.Header.Set("Accept-Encoding", "identity")
	}
	if authHeader != "" && authValue != "" {
		req.Header.Set(authHeader, authValue)
	} else {
		applyAuth(req, p.upstream)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, nil, nil, http.StatusBadGateway, false, false
	}
	defer resp.Body.Close()
	connReused = false // httptrace omitted for probes; not needed for MMD

	body, _ := io.ReadAll(io.LimitReader(resp.Body, int64(p.maxBody)))
	t := uint64(time.Since(start).Microseconds())
	totalUs = &t
	// ttft ~ total for a fully-read non-stream response; record nil to avoid
	// implying a measurement we didn't take.
	return body, nil, totalUs, resp.StatusCode, true, connReused
}

// buildChatRequest builds a minimal OpenAI-compatible chat request body.
func buildChatRequest(model, prompt string, maxTokens int, temp float64) []byte {
	m := map[string]any{
		"model":       model,
		"max_tokens":  maxTokens,
		"temperature": temp,
		"messages":    []map[string]string{{"role": "user", "content": prompt}},
	}
	b, _ := json.Marshal(m)
	return b
}

// probeNote is the evidence tag the analyzer's probe.parse_probe_tag reads.
// Format mirrors analyzer/assay_analyzer/probe.py make_probe_note EXACTLY.
func probeNote(setID string, promptID int) string {
	return fmt.Sprintf("assay-probe:%s:%d", setID, promptID)
}

// probeReqHeaders returns the header set recorded for a probe request. The auth
// header name is included so redaction scrubs its value (the credential is never
// stored), matching proxied-traffic behavior.
func probeReqHeaders(authHeader string) http.Header {
	h := http.Header{}
	h.Set("content-type", "application/json")
	if authHeader != "" {
		h.Set(authHeader, "placeholder-redacted-by-evidence")
	}
	return h
}

// ProbePromptPool loads the committed probe prompt pool from a config-referenced
// file (one prompt per line). Falls back to a small built-in pool if unset.
func ProbePromptPool(path string) ([]string, error) {
	if path == "" {
		return builtinProbePrompts(), nil
	}
	data, err := readFile(path)
	if err != nil {
		return nil, err
	}
	var prompts []string
	for _, line := range splitLines(data) {
		if line != "" {
			prompts = append(prompts, line)
		}
	}
	if len(prompts) == 0 {
		return builtinProbePrompts(), nil
	}
	return prompts, nil
}

func builtinProbePrompts() []string {
	return []string{
		"Continue this text: The history of the Roman Empire",
		"Continue this text: Photosynthesis is the process by which",
		"Continue this text: In the field of quantum mechanics,",
		"Continue this text: The Great Barrier Reef is",
		"Continue this text: Jazz emerged in the early twentieth century",
		"Continue this text: The theory of plate tectonics explains",
		"Continue this text: During the Renaissance, artists",
		"Continue this text: The human immune system defends",
	}
}

func readFile(path string) ([]byte, error) { return os.ReadFile(path) }

func splitLines(b []byte) []string {
	lines := strings.Split(string(b), "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		out = append(out, strings.TrimSpace(l))
	}
	return out
}

var _ = config.Probe{} // ensure config.Probe exists (compile-time link)
