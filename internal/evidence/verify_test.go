package evidence

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func draftRec(tag string) *Record {
	return &Record{
		ID: "id-" + tag, TsStart: "2026-05-30T12:00:00.000000000Z",
		Route: Route{
			Method: "POST", Path: "/v1/chat/completions", Upstream: "https://r.example.com",
			ClaimedModel: ps("gpt-4o"), Provider: "openai", APISurface: "chat.completions",
		},
		Request:  Request{Headers: map[string][]string{}, Raw: tag, RawEncoding: "utf8", Bytes: uint64(len(tag))},
		Response: Response{Status: 200, Headers: map[string][]string{}, Complete: true, Raw: "resp-" + tag, RawEncoding: "utf8", Bytes: 5, ClaimedModel: ps("gpt-4o")},
		Timing:   Timing{},
		Capture:  Capture{TeeOk: true},
	}
}

func writeRecords(t *testing.T, path string, tags ...string) {
	t.Helper()
	w, err := NewWriter(WriterOptions{Path: path, FlushEveryRecords: 1})
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	for _, tag := range tags {
		if !w.Submit(draftRec(tag)) {
			t.Fatalf("Submit(%s) dropped", tag)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestWriterRoundTripAndVerify(t *testing.T) {
	path := filepath.Join(t.TempDir(), "evidence.jsonl")
	writeRecords(t, path, "REQ0", "REQ1", "REQ2")

	res, err := VerifyFile(path)
	if err != nil {
		t.Fatalf("VerifyFile: %v", err)
	}
	if res.Status != VerifyValid || res.Records != 3 {
		t.Fatalf("got status=%s records=%d, want VALID/3 (detail=%s)", res.Status, res.Records, res.Detail)
	}
}

func TestVerifyTornTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "evidence.jsonl")
	writeRecords(t, path, "REQ0", "REQ1", "REQ2")

	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(`{"v":1,"seq":3,"partial`)
	_ = f.Close()

	res, _ := VerifyFile(path)
	if res.Status != VerifyTornTail || res.Records != 3 {
		t.Fatalf("got status=%s records=%d, want TORN_TAIL/3", res.Status, res.Records)
	}
}

func TestWriterRecoversTornTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "evidence.jsonl")
	writeRecords(t, path, "REQ0", "REQ1", "REQ2")

	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(`{"v":1,"seq":3,"partial`)
	_ = f.Close()

	// Reopening must truncate the torn tail and resume at seq 3.
	w, err := NewWriter(WriterOptions{Path: path, FlushEveryRecords: 1})
	if err != nil {
		t.Fatalf("NewWriter after torn tail: %v", err)
	}
	if !w.Submit(draftRec("REQ3")) {
		t.Fatal("submit after recovery dropped")
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	res, _ := VerifyFile(path)
	if res.Status != VerifyValid || res.Records != 4 {
		t.Fatalf("after recovery got status=%s records=%d, want VALID/4 (detail=%s)", res.Status, res.Records, res.Detail)
	}
}

func TestVerifyInteriorTamperAndWriterRefuses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "evidence.jsonl")
	writeRecords(t, path, "REQ0", "REQ1", "REQ2")

	// Flip an interior record's body without fixing its hash (same length).
	b, _ := os.ReadFile(path)
	b = bytes.Replace(b, []byte("REQ1"), []byte("REQX"), 1)
	_ = os.WriteFile(path, b, 0o600)

	res, _ := VerifyFile(path)
	if res.Status != VerifyBreak || res.BreakSeq == nil || *res.BreakSeq != 1 {
		t.Fatalf("got status=%s breakSeq=%v, want BREAK at seq 1 (detail=%s)", res.Status, res.BreakSeq, res.Detail)
	}

	// The writer must REFUSE to start on interior tamper (not silently overwrite).
	if _, err := NewWriter(WriterOptions{Path: path}); err == nil {
		t.Fatal("NewWriter should refuse to start on a tampered chain")
	}
}

func TestVerifySeqGapFromDeletion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "evidence.jsonl")
	writeRecords(t, path, "REQ0", "REQ1", "REQ2")

	// Delete the interior record (seq 1) entirely.
	b, _ := os.ReadFile(path)
	lines := []string{}
	for _, ln := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if !strings.Contains(ln, `"seq":1,`) {
			lines = append(lines, ln)
		}
	}
	_ = os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600)

	res, _ := VerifyFile(path)
	if res.Status != VerifyBreak {
		t.Fatalf("got status=%s, want BREAK on deletion (detail=%s)", res.Status, res.Detail)
	}
	if res.BreakSeq == nil || *res.BreakSeq != 2 {
		t.Fatalf("got breakSeq=%v, want 2 (seq jumps 0->2)", res.BreakSeq)
	}
}

func TestConcurrentWriterIsLocked(t *testing.T) {
	path := filepath.Join(t.TempDir(), "evidence.jsonl")
	w, err := NewWriter(WriterOptions{Path: path})
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	defer w.Close()

	if _, err := NewWriter(WriterOptions{Path: path}); err == nil {
		t.Fatal("second NewWriter on same path should fail (flock)")
	}
}

var _ = fmt.Sprintf
