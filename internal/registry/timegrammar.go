package registry

import (
	"fmt"
	"regexp"
	"time"
)

// Frozen canonical timestamp grammar for ALL signed registry artifacts
// (redteam major: timestamps were compared with no clock code and an unsafe
// grammar). RFC3339 with MANDATORY 'Z' UTC, mandatory seconds, NO fractional
// seconds, NO numeric offset. Validated at sign time and re-validated on verify
// so two implementations can never disagree on what a timestamp means.
var rfc3339zRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`)

// parseRFC3339Z parses a timestamp in the frozen grammar, rejecting any other
// form (fractional seconds, +00:00 offset, missing Z, etc.).
func parseRFC3339Z(s string) (time.Time, error) {
	if !rfc3339zRe.MatchString(s) {
		return time.Time{}, fmt.Errorf("timestamp %q not in canonical RFC3339Z form (YYYY-MM-DDThh:mm:ssZ)", s)
	}
	return time.Parse("2006-01-02T15:04:05Z", s)
}

// ValidTimestamp reports whether s is in the canonical grammar (for sign-time
// validation). Empty string is allowed only where a field is explicitly optional.
func ValidTimestamp(s string) bool {
	return rfc3339zRe.MatchString(s)
}

// NowZ returns the current UTC time formatted in the canonical grammar.
func NowZ(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05Z")
}
