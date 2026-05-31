package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"

	"assay/internal/evidence"
)

// SSE parsing for the CAPTURE path only — it runs in the capture goroutine on a
// copy of the bytes, never on the client's read path. It reconstructs the
// delivered assistant text and the relay-reported usage from a streamed
// response so the analyzer has clean inputs (PHASE0.md §3.1, §6).
//
// Defensive throughout: relay-controlled bytes must never panic the capturer.

// SSEResult is what we extract from a captured SSE stream.
type SSEResult struct {
	AssistantText string          // concatenated delivered text (per-choice index 0)
	DataEvents    uint64          // data events with non-empty choices (stream_chunks)
	SawDone       bool            // saw "data: [DONE]" (OpenAI) — clean completion
	Usage         *evidence.Usage // last usage object seen (include_usage / responses / etc.)
}

// ParseSSE walks raw SSE bytes and reconstructs text + usage + completion signal.
// It tolerates \n, \r\n, comment lines (':'), multi-line data fields, empty
// choices arrays (the terminal usage chunk), and both OpenAI chat and responses
// streaming shapes.
func ParseSSE(raw []byte) SSEResult {
	var res SSEResult
	defer func() { _ = recover() }()

	// Normalize CRLF -> LF so event splitting is uniform.
	norm := bytes.ReplaceAll(raw, []byte("\r\n"), []byte("\n"))

	sc := bufio.NewScanner(bytes.NewReader(norm))
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20) // large lines (tool args, base64)

	var dataLines []string
	flush := func() {
		if len(dataLines) == 0 {
			return
		}
		payload := strings.Join(dataLines, "\n")
		dataLines = dataLines[:0]
		res.consumeEvent(payload)
	}

	for sc.Scan() {
		line := sc.Text()
		if line == "" { // blank line terminates an event
			flush()
			continue
		}
		if strings.HasPrefix(line, ":") { // comment / heartbeat
			continue
		}
		if strings.HasPrefix(line, "data:") {
			// SSE strips exactly one optional leading space after the colon.
			d := line[len("data:"):]
			d = strings.TrimPrefix(d, " ")
			dataLines = append(dataLines, d)
		}
		// other SSE fields (event:, id:, retry:) are ignored for capture
	}
	flush()
	return res
}

func (res *SSEResult) consumeEvent(payload string) {
	if payload == "[DONE]" {
		res.SawDone = true
		return
	}
	var ev map[string]json.RawMessage
	if err := json.Unmarshal([]byte(payload), &ev); err != nil {
		return // non-JSON event; ignore
	}

	// usage may appear top-level (chat include_usage) ...
	if u, ok := ev["usage"]; ok && len(u) > 0 {
		if parsed := usageFromOpenAIChat(u); parsed != nil {
			res.Usage = parsed
		}
	}
	// ... or nested in a responses-API "response" object on the terminal event.
	if r, ok := ev["response"]; ok && len(r) > 0 {
		var inner struct {
			Usage json.RawMessage `json:"usage"`
		}
		if json.Unmarshal(r, &inner) == nil && len(inner.Usage) > 0 {
			if parsed := usageFromOpenAIResponses(inner.Usage); parsed != nil {
				res.Usage = parsed
			}
		}
	}

	// responses-API text delta event
	if t, ok := ev["type"]; ok {
		var typ string
		if json.Unmarshal(t, &typ) == nil && typ == "response.output_text.delta" {
			var d struct {
				Delta string `json:"delta"`
			}
			if json.Unmarshal([]byte(payload), &d) == nil {
				res.AssistantText += d.Delta
			}
			return
		}
	}

	// chat.completions: choices[].delta.content
	if c, ok := ev["choices"]; ok {
		var choices []struct {
			Delta struct {
				Content string `json:"content"`
			} `json:"delta"`
		}
		if json.Unmarshal(c, &choices) == nil {
			if len(choices) > 0 {
				res.DataEvents++
				res.AssistantText += choices[0].Delta.Content
			}
			// choices:[] (terminal usage chunk) -> not counted as a data event
		}
	}
}

// requestWantsStream reports whether the request body has "stream": true.
func requestWantsStream(raw []byte) bool {
	var probe struct {
		Stream bool `json:"stream"`
	}
	return json.Unmarshal(raw, &probe) == nil && probe.Stream
}

// requestHasIncludeUsage reports whether stream_options.include_usage is set.
func requestHasIncludeUsage(raw []byte) bool {
	var probe struct {
		StreamOptions struct {
			IncludeUsage bool `json:"include_usage"`
		} `json:"stream_options"`
	}
	return json.Unmarshal(raw, &probe) == nil && probe.StreamOptions.IncludeUsage
}
