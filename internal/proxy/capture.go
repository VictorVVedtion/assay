package proxy

import (
	"bytes"
	"encoding/json"
)

// newDecoder returns a strict-ish JSON decoder over b (used by tests and any
// strict parse path).
func newDecoder(b []byte) *json.Decoder { return json.NewDecoder(bytes.NewReader(b)) }

// captureBuf is a bounded byte buffer for the audit copy. It accumulates up to a
// cap; beyond the cap it stops storing but keeps counting the true total, and
// marks itself overflowed. It is touched only by the request goroutine's copy
// loop and never blocks (PHASE0.md §3.3 — the cap applies to the COPY only; the
// client stream is never bounded).
type captureBuf struct {
	max      int
	data     []byte
	total    int
	overflow bool
}

func newCaptureBuf(max int) *captureBuf {
	return &captureBuf{max: max, data: make([]byte, 0, min(max, 64*1024))}
}

func (c *captureBuf) append(b []byte) {
	c.total += len(b)
	if c.overflow {
		return
	}
	room := c.max - len(c.data)
	if room <= 0 {
		c.overflow = true
		return
	}
	if len(b) > room {
		c.data = append(c.data, b[:room]...)
		c.overflow = true
		return
	}
	c.data = append(c.data, b...)
}

// bytes returns the captured copy, whether it was truncated, and the true total.
func (c *captureBuf) bytes() (data []byte, truncated bool, total int) {
	return c.data, c.overflow, c.total
}

func (c *captureBuf) overflowed() bool { return c.overflow }

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// jsonUnmarshal is a tiny helper that never panics on relay-controlled bytes.
func jsonUnmarshal(b []byte, v any) bool {
	defer func() { _ = recover() }()
	return json.Unmarshal(b, v) == nil
}
