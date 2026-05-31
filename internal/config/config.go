// Package config loads and validates the assay proxy configuration (assay.yaml).
// See PHASE0.md §7. The config is intentionally small; defaults are filled so a
// single-upstream buyer setup needs only `upstreams[0].target`.
package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the top-level proxy configuration.
type Config struct {
	Listen              string     `yaml:"listen"`
	FailOpen            bool       `yaml:"fail_open"`
	Upstreams           []Upstream `yaml:"upstreams"`
	StripAcceptEncoding bool       `yaml:"strip_accept_encoding"`
	InjectIncludeUsage  bool       `yaml:"inject_include_usage"`
	Timeouts            Timeouts   `yaml:"timeouts"`
	Capture             Capture    `yaml:"capture"`
	Evidence            Evidence   `yaml:"evidence"`

	// Analyzer is consumed by the Python analysis plane, not the Go proxy. It is
	// declared here only so the SHARED assay.yaml passes strict parsing; the Go
	// side ignores its contents.
	Analyzer map[string]any `yaml:"analyzer"`
}

// Upstream is one relay/中转站 target. MVP uses exactly one; with one upstream
// all paths forward verbatim to target (no path_prefix needed — PHASE0.md §9).
type Upstream struct {
	PathPrefix string `yaml:"path_prefix"`
	Target     string `yaml:"target"`
	// AuthMode: "passthrough" (forward the client's Authorization, MVP default)
	// or "inject" (proxy supplies the relay credential from CredentialEnv).
	AuthMode      string `yaml:"auth_mode"`
	CredentialEnv string `yaml:"credential_env"`
	ForwardAuth   bool   `yaml:"forward_auth"` // legacy alias for auth_mode: passthrough

	// resolved at load time; never serialized.
	credential string `yaml:"-"`
}

// Credential returns the injected credential (empty in passthrough mode).
func (u *Upstream) Credential() string { return u.credential }

// Timeouts configure the upstream Transport. There is deliberately no overall
// client timeout — it would kill long streams (PHASE0.md §7).
type Timeouts struct {
	DialMs           int `yaml:"dial_ms"`
	TLSHandshakeMs   int `yaml:"tls_handshake_ms"`
	ResponseHeaderMs int `yaml:"response_header_ms"`
	StreamIdleMs     int `yaml:"stream_idle_ms"`
}

func (t Timeouts) Dial() time.Duration { return time.Duration(t.DialMs) * time.Millisecond }
func (t Timeouts) TLSHandshake() time.Duration {
	return time.Duration(t.TLSHandshakeMs) * time.Millisecond
}
func (t Timeouts) ResponseHeader() time.Duration {
	return time.Duration(t.ResponseHeaderMs) * time.Millisecond
}
func (t Timeouts) StreamIdle() time.Duration {
	return time.Duration(t.StreamIdleMs) * time.Millisecond
}

// Capture bounds what the audit copy retains. The cap applies ONLY to the
// captured copy — the client stream is never bounded (PHASE0.md §3.3).
type Capture struct {
	MaxBodyBytes      int  `yaml:"max_body_bytes"`
	ChannelSize       int  `yaml:"channel_size"`
	DrainOnDisconnect bool `yaml:"drain_on_disconnect"`
}

// Evidence configures the hash-chained log writer.
type Evidence struct {
	Path              string   `yaml:"path"`
	FlushEveryRecords int      `yaml:"flush_every_records"`
	FlushEveryMs      int      `yaml:"flush_every_ms"`
	Fsync             bool     `yaml:"fsync"`
	FileMode          string   `yaml:"file_mode"`
	RedactHeaders     []string `yaml:"redact_headers"`
	RedactQueryKeys   []string `yaml:"redact_query_keys"`
	AnchorLog         string   `yaml:"anchor_log"`

	// ScrubBodySecrets replaces credential-shaped substrings in stored
	// request/response bodies with typed markers BEFORE they touch disk, so
	// assay's own log is not a durable copy of the buyer's credentials. The
	// hash chain is computed over the scrubbed bytes (what is actually stored),
	// keeping replay reproducible. Default on: a credential in a body is almost
	// always a mistake. Catches credential SHAPES only — NOT prose/code/PII.
	ScrubBodySecrets *bool `yaml:"scrub_body_secrets"`
}

// ScrubBodySecretsEnabled reports whether body secret-scrubbing is on (default true).
func (e Evidence) ScrubBodySecretsEnabled() bool {
	return e.ScrubBodySecrets == nil || *e.ScrubBodySecrets
}

// Load reads, parses, validates, and defaults a config file.
func Load(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var c Config
	dec := yaml.NewDecoder(strings.NewReader(string(b)))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}
	c.applyDefaults()
	if err := c.resolveAndValidate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) applyDefaults() {
	if c.Listen == "" {
		c.Listen = ":8080"
	}
	c.FailOpen = true // MVP: always fail-open, regardless of file (PHASE0.md §7)
	// strip_accept_encoding defaults true so captured bytes are decodable text.
	// (yaml zero value is false; flip it on unless explicitly set false — we
	// detect "explicitly set" by leaving it to the user; default-on here.)
	if !c.StripAcceptEncoding {
		c.StripAcceptEncoding = true
	}
	if c.Timeouts.DialMs == 0 {
		c.Timeouts.DialMs = 10000
	}
	if c.Timeouts.TLSHandshakeMs == 0 {
		c.Timeouts.TLSHandshakeMs = 10000
	}
	if c.Timeouts.ResponseHeaderMs == 0 {
		c.Timeouts.ResponseHeaderMs = 60000
	}
	if c.Timeouts.StreamIdleMs == 0 {
		c.Timeouts.StreamIdleMs = 120000
	}
	if c.Capture.MaxBodyBytes == 0 {
		c.Capture.MaxBodyBytes = 8 << 20 // 8 MiB
	}
	if c.Capture.ChannelSize == 0 {
		c.Capture.ChannelSize = 4096
	}
	if !c.Capture.DrainOnDisconnect {
		c.Capture.DrainOnDisconnect = true
	}
	if c.Evidence.Path == "" {
		c.Evidence.Path = "./data/evidence.jsonl"
	}
	if c.Evidence.FlushEveryRecords == 0 {
		c.Evidence.FlushEveryRecords = 64
	}
	if c.Evidence.FlushEveryMs == 0 {
		c.Evidence.FlushEveryMs = 500
	}
	if c.Evidence.FileMode == "" {
		c.Evidence.FileMode = "0600"
	}
	if len(c.Evidence.RedactHeaders) == 0 {
		c.Evidence.RedactHeaders = []string{
			"authorization", "x-api-key", "api-key", "x-goog-api-key",
			"cookie", "set-cookie", "proxy-authorization",
		}
	}
	if len(c.Evidence.RedactQueryKeys) == 0 {
		c.Evidence.RedactQueryKeys = []string{"key", "api_key", "access_token"}
	}
}

func (c *Config) resolveAndValidate() error {
	if len(c.Upstreams) == 0 {
		return fmt.Errorf("config: at least one upstream is required")
	}
	for i := range c.Upstreams {
		u := &c.Upstreams[i]
		if u.Target == "" {
			return fmt.Errorf("config: upstreams[%d].target is required", i)
		}
		if !strings.HasPrefix(u.Target, "http://") && !strings.HasPrefix(u.Target, "https://") {
			return fmt.Errorf("config: upstreams[%d].target must be an http(s) URL, got %q", i, u.Target)
		}
		u.Target = strings.TrimRight(u.Target, "/")
		if u.AuthMode == "" {
			if u.ForwardAuth {
				u.AuthMode = "passthrough"
			} else {
				u.AuthMode = "passthrough" // MVP default
			}
		}
		switch u.AuthMode {
		case "passthrough":
			// nothing to resolve
		case "inject":
			if u.CredentialEnv == "" {
				return fmt.Errorf("config: upstreams[%d] auth_mode=inject requires credential_env", i)
			}
			cred := os.Getenv(u.CredentialEnv)
			if cred == "" {
				return fmt.Errorf("config: upstreams[%d] credential_env %q is empty (fail closed)", i, u.CredentialEnv)
			}
			u.credential = cred
		default:
			return fmt.Errorf("config: upstreams[%d].auth_mode must be passthrough|inject, got %q", i, u.AuthMode)
		}
	}
	if len(c.Upstreams) > 1 {
		// Multi-upstream needs a real discriminator; MVP supports one.
		return fmt.Errorf("config: MVP supports exactly one upstream (got %d); multi-upstream routing is a later phase", len(c.Upstreams))
	}
	return nil
}

// FileModeOctal parses the FileMode string (e.g. "0600") into an os.FileMode.
func (e Evidence) FileModeOctal() (os.FileMode, error) {
	var m uint32
	_, err := fmt.Sscanf(e.FileMode, "%o", &m)
	if err != nil {
		return 0, fmt.Errorf("invalid file_mode %q: %w", e.FileMode, err)
	}
	return os.FileMode(m), nil
}
