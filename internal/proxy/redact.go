package proxy

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// Redaction runs in the capture path on a DEEP COPY of the headers — the
// request forwarded upstream is NEVER mutated (PHASE0.md §10, lens fail-open:
// in-place redaction would replace the real relay key with "REDACTED" and 401
// every call). It is default-deny: known secret headers are dropped to
// "REDACTED" and value-level secret patterns are scrubbed even from other
// headers.

const redactedMarker = "REDACTED"

// secretValuePattern matches common credential shapes that may appear in header
// values not on the name denylist (defense in depth).
var secretValuePattern = regexp.MustCompile(`(?i)(bearer\s+\S+|sk-[A-Za-z0-9_\-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_\-]{20,})`)

// bodySecretPatterns are typed credential shapes scrubbed from STORED request/
// response bodies so assay's own evidence log does not become a durable second
// copy of the buyer's credentials (the "don't be a second leak" rule). Each is
// replaced with a typed marker the analyzer can count.
//
// HONEST LIMIT (must not be overstated): this catches credential SHAPES only —
// novel/unprefixed secrets are missed, and prose/source-code/PII are NOT touched
// (they remain stored verbatim unless body redaction is enabled). It is
// best-effort, not a completeness guarantee.
var bodySecretPatterns = []struct {
	name string
	re   *regexp.Regexp
}{
	{"openai_key", regexp.MustCompile(`sk-[A-Za-z0-9_\-]{16,}`)},
	{"anthropic_key", regexp.MustCompile(`sk-ant-[A-Za-z0-9_\-]{16,}`)},
	{"aws_key", regexp.MustCompile(`AKIA[0-9A-Z]{12,}`)},
	{"google_key", regexp.MustCompile(`AIza[0-9A-Za-z_\-]{20,}`)},
	{"github_pat", regexp.MustCompile(`gh[pousr]_[A-Za-z0-9]{20,}`)},
	{"slack_token", regexp.MustCompile(`xox[baprs]-[A-Za-z0-9\-]{10,}`)},
	{"jwt", regexp.MustCompile(`eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}`)},
	{"private_key_block", regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`)},
}

// scrubBodySecrets replaces credential-shaped substrings in a body with typed
// markers like [assay-redacted:openai_key]. Returns the scrubbed bytes and the
// per-type counts of what was scrubbed. Ordered so the more specific
// anthropic_key (sk-ant-) is tried before the generic openai_key (sk-).
func scrubBodySecrets(body []byte) (scrubbed []byte, counts map[string]int) {
	if len(body) == 0 {
		return body, nil
	}
	counts = map[string]int{}
	out := body
	// anthropic before openai so sk-ant-... isn't half-eaten by the sk- rule.
	order := []int{1, 0, 2, 3, 4, 5, 6, 7}
	for _, idx := range order {
		p := bodySecretPatterns[idx]
		n := 0
		out = p.re.ReplaceAllFunc(out, func(m []byte) []byte {
			n++
			return []byte("[assay-redacted:" + p.name + "]")
		})
		if n > 0 {
			counts[p.name] = n
		}
	}
	if len(counts) == 0 {
		return body, nil
	}
	return out, counts
}

// redactHeaders returns a redacted deep copy of h with lowercase keys. denylist
// entries are fully replaced; all other values are scrubbed for secret patterns.
func redactHeaders(h http.Header, denylist []string) map[string][]string {
	deny := make(map[string]bool, len(denylist))
	for _, k := range denylist {
		deny[strings.ToLower(k)] = true
	}
	out := make(map[string][]string, len(h))
	for k, vs := range h {
		lk := strings.ToLower(k)
		if deny[lk] {
			out[lk] = []string{redactedMarker}
			continue
		}
		cp := make([]string, len(vs))
		for i, v := range vs {
			cp[i] = secretValuePattern.ReplaceAllString(v, redactedMarker)
		}
		out[lk] = cp
	}
	return out
}

// redactURLQuery returns the request URI with secret query values scrubbed
// (e.g. Gemini's ?key=...). Operates on a copy; never mutates the live URL.
func redactURLQuery(u *url.URL, denyKeys []string) string {
	if u.RawQuery == "" {
		return u.Path
	}
	deny := make(map[string]bool, len(denyKeys))
	for _, k := range denyKeys {
		deny[strings.ToLower(k)] = true
	}
	q := u.Query()
	for k := range q {
		if deny[strings.ToLower(k)] {
			q.Set(k, redactedMarker)
		}
	}
	cp := *u
	cp.RawQuery = q.Encode()
	return cp.RequestURI()
}
