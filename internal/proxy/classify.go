package proxy

import (
	"encoding/json"
	"strings"

	"assay/internal/evidence"
)

// Provider/api-surface classification is by REQUEST PATH, never by the model
// string — a relay fully controls the model field and could send model="gpt-4o"
// on a /v1/messages body (PHASE0.md §6, lens api-fidelity). The path is what the
// buyer's SDK chose and is far harder to misattribute.

// ClassifyRoute maps a request path to (provider, apiSurface).
func ClassifyRoute(path string) (provider, apiSurface string) {
	p := strings.ToLower(path)
	switch {
	case strings.Contains(p, "/chat/completions"):
		return "openai", "chat.completions"
	case strings.HasSuffix(p, "/responses") || strings.Contains(p, "/responses"):
		return "openai", "responses"
	case strings.Contains(p, "/embeddings"):
		return "openai", "embeddings"
	case strings.Contains(p, "/v1/messages"):
		return "anthropic", "messages"
	case strings.Contains(p, ":generatecontent"):
		return "gemini", "generateContent"
	case strings.Contains(p, ":streamgeneratecontent"):
		return "gemini", "generateContent"
	default:
		return "unknown", "other"
	}
}

// extractModelFromRequest pulls body.model from a JSON request body. Returns nil
// if absent/unparseable — never errors (best-effort, off the client path).
func extractModelFromRequest(raw []byte) *string {
	var probe struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.Model == "" {
		return nil
	}
	m := probe.Model
	return &m
}

// extractUsage parses a relay-reported usage object from a non-streaming
// response body, tolerant of OpenAI chat, OpenAI responses, Anthropic, and
// Gemini shapes. It is best-effort and NEVER panics: on any miss it returns nil.
// The result is UNTRUSTED evidence, recorded for the analyzer to cross-check.
func extractUsage(provider, apiSurface string, body []byte) *evidence.Usage {
	defer func() { _ = recover() }() // belt-and-suspenders; must never crash capture

	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		return nil
	}

	switch provider {
	case "gemini":
		return usageFromGemini(top["usageMetadata"])
	case "anthropic":
		return usageFromAnthropic(top["usage"])
	default: // openai chat or responses
		if apiSurface == "responses" {
			return usageFromOpenAIResponses(top["usage"])
		}
		return usageFromOpenAIChat(top["usage"])
	}
}

func u64ptr(n int64) *uint64 {
	if n < 0 {
		return nil
	}
	v := uint64(n)
	return &v
}

func usageFromOpenAIChat(raw json.RawMessage) *evidence.Usage {
	if len(raw) == 0 {
		return nil
	}
	var u struct {
		PromptTokens      *int64 `json:"prompt_tokens"`
		CompletionTokens  *int64 `json:"completion_tokens"`
		TotalTokens       *int64 `json:"total_tokens"`
		CompletionDetails *struct {
			ReasoningTokens *int64 `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
		PromptDetails *struct {
			CachedTokens *int64 `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
	}
	if err := json.Unmarshal(raw, &u); err != nil {
		return nil
	}
	out := &evidence.Usage{
		PromptTokens:     optU64(u.PromptTokens),
		CompletionTokens: optU64(u.CompletionTokens),
		TotalTokens:      optU64(u.TotalTokens),
	}
	if u.CompletionDetails != nil {
		out.CompletionDetails = &evidence.CompletionTokensDetails{ReasoningTokens: optU64(u.CompletionDetails.ReasoningTokens)}
	}
	if u.PromptDetails != nil {
		out.PromptDetails = &evidence.PromptTokensDetails{CachedTokens: optU64(u.PromptDetails.CachedTokens)}
	}
	return out
}

// usageFromOpenAIResponses maps the /v1/responses shape (input_tokens /
// output_tokens) into the canonical usage struct (PHASE0.md, lens api-fidelity).
func usageFromOpenAIResponses(raw json.RawMessage) *evidence.Usage {
	if len(raw) == 0 {
		return nil
	}
	var u struct {
		InputTokens   *int64 `json:"input_tokens"`
		OutputTokens  *int64 `json:"output_tokens"`
		TotalTokens   *int64 `json:"total_tokens"`
		OutputDetails *struct {
			ReasoningTokens *int64 `json:"reasoning_tokens"`
		} `json:"output_tokens_details"`
		InputDetails *struct {
			CachedTokens *int64 `json:"cached_tokens"`
		} `json:"input_tokens_details"`
	}
	if err := json.Unmarshal(raw, &u); err != nil {
		return nil
	}
	out := &evidence.Usage{
		PromptTokens:     optU64(u.InputTokens),
		CompletionTokens: optU64(u.OutputTokens),
		TotalTokens:      optU64(u.TotalTokens),
	}
	if u.OutputDetails != nil {
		out.CompletionDetails = &evidence.CompletionTokensDetails{ReasoningTokens: optU64(u.OutputDetails.ReasoningTokens)}
	}
	if u.InputDetails != nil {
		out.PromptDetails = &evidence.PromptTokensDetails{CachedTokens: optU64(u.InputDetails.CachedTokens)}
	}
	return out
}

// usageFromAnthropic maps usage.input_tokens / output_tokens (no total, no
// prompt/completion keys). total is synthesized for convenience.
func usageFromAnthropic(raw json.RawMessage) *evidence.Usage {
	if len(raw) == 0 {
		return nil
	}
	var u struct {
		InputTokens     *int64 `json:"input_tokens"`
		OutputTokens    *int64 `json:"output_tokens"`
		CacheReadTokens *int64 `json:"cache_read_input_tokens"`
	}
	if err := json.Unmarshal(raw, &u); err != nil {
		return nil
	}
	out := &evidence.Usage{
		PromptTokens:     optU64(u.InputTokens),
		CompletionTokens: optU64(u.OutputTokens),
	}
	if u.InputTokens != nil && u.OutputTokens != nil {
		out.TotalTokens = u64ptr(*u.InputTokens + *u.OutputTokens)
	}
	if u.CacheReadTokens != nil {
		out.PromptDetails = &evidence.PromptTokensDetails{CachedTokens: optU64(u.CacheReadTokens)}
	}
	return out
}

// usageFromGemini maps usageMetadata.{promptTokenCount,candidatesTokenCount,
// totalTokenCount,thoughtsTokenCount}.
func usageFromGemini(raw json.RawMessage) *evidence.Usage {
	if len(raw) == 0 {
		return nil
	}
	var u struct {
		PromptTokenCount        *int64 `json:"promptTokenCount"`
		CandidatesTokenCount    *int64 `json:"candidatesTokenCount"`
		TotalTokenCount         *int64 `json:"totalTokenCount"`
		ThoughtsTokenCount      *int64 `json:"thoughtsTokenCount"`
		CachedContentTokenCount *int64 `json:"cachedContentTokenCount"`
	}
	if err := json.Unmarshal(raw, &u); err != nil {
		return nil
	}
	out := &evidence.Usage{
		PromptTokens:     optU64(u.PromptTokenCount),
		CompletionTokens: optU64(u.CandidatesTokenCount),
		TotalTokens:      optU64(u.TotalTokenCount),
	}
	if u.ThoughtsTokenCount != nil {
		out.CompletionDetails = &evidence.CompletionTokensDetails{ReasoningTokens: optU64(u.ThoughtsTokenCount)}
	}
	if u.CachedContentTokenCount != nil {
		out.PromptDetails = &evidence.PromptTokensDetails{CachedTokens: optU64(u.CachedContentTokenCount)}
	}
	return out
}

func optU64(p *int64) *uint64 {
	if p == nil || *p < 0 {
		return nil
	}
	v := uint64(*p)
	return &v
}
