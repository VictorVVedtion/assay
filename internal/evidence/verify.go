package evidence

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"
)

// VerifyStatus classifies the outcome of chain verification. The distinction
// between TORN_TAIL (a recoverable crash artifact in the last line) and BREAK
// (an interior inconsistency = tamper signal) is deliberate: conflating them
// produces alarm fatigue that masks real tampering (PHASE0.md §4).
type VerifyStatus string

const (
	VerifyValid    VerifyStatus = "VALID"
	VerifyEmpty    VerifyStatus = "EMPTY"
	VerifyTornTail VerifyStatus = "TORN_TAIL"
	VerifyBreak    VerifyStatus = "BREAK"
)

// VerifyResult is the outcome of verifying an evidence file.
type VerifyResult struct {
	Status   VerifyStatus
	Records  int     // count of fully-verified records
	BreakSeq *uint64 // seq at which a BREAK was detected
	Detail   string
	Warnings []string // non-fatal observations (e.g., timestamp regressions)
	HeadHash string   // hash of the last verified record ("" if none)
}

// VerifyFile re-derives every record's hash and checks the chain end-to-end:
// strict seq increment from 0, prev_hash linkage, and hash integrity. A
// non-decreasing timestamp is checked as a non-fatal warning (a full rewriter
// can forge it; only external anchoring defends against that — PHASE0.md §4.1).
func VerifyFile(path string) (VerifyResult, error) {
	f, err := os.Open(path)
	if err != nil {
		return VerifyResult{}, fmt.Errorf("open: %w", err)
	}
	defer f.Close()

	r := bufio.NewReader(f)
	res := VerifyResult{Status: VerifyValid, HeadHash: GenesisPrevHash}
	var expected uint64
	prevHash := GenesisPrevHash
	var lastTs time.Time
	var haveTs bool

	for {
		line, readErr := r.ReadBytes('\n')
		hasNewline := len(line) > 0 && line[len(line)-1] == '\n'

		if len(line) > 0 && !hasNewline {
			res.Status = VerifyTornTail
			res.Detail = fmt.Sprintf("trailing line without newline after seq %d (recoverable crash artifact, not tamper)", expected-1)
			break
		}
		if len(line) == 0 {
			break // clean EOF
		}

		var rec Record
		if jerr := json.Unmarshal(line, &rec); jerr != nil {
			// Newline-terminated but unparseable: interior corruption.
			bs := expected
			res.Status, res.BreakSeq, res.Detail = VerifyBreak, &bs, fmt.Sprintf("unparseable record at position seq~%d: %v", expected, jerr)
			break
		}

		if rec.Seq != expected {
			bs := rec.Seq
			res.Status, res.BreakSeq = VerifyBreak, &bs
			res.Detail = fmt.Sprintf("seq gap: expected %d, got %d (record deletion or reorder)", expected, rec.Seq)
			break
		}
		if rec.PrevHash != prevHash {
			bs := rec.Seq
			res.Status, res.BreakSeq = VerifyBreak, &bs
			res.Detail = fmt.Sprintf("prev_hash mismatch at seq %d", rec.Seq)
			break
		}
		if got := Hash(&rec); got != rec.Hash {
			bs := rec.Seq
			res.Status, res.BreakSeq = VerifyBreak, &bs
			res.Detail = fmt.Sprintf("hash mismatch at seq %d (record altered): stored=%s computed=%s", rec.Seq, rec.Hash, got)
			break
		}

		if ts, perr := time.Parse(time.RFC3339Nano, rec.TsStart); perr == nil {
			if haveTs && ts.Before(lastTs) {
				res.Warnings = append(res.Warnings, fmt.Sprintf("timestamp regression at seq %d", rec.Seq))
			}
			lastTs, haveTs = ts, true
		}

		prevHash = rec.Hash
		res.HeadHash = rec.Hash
		res.Records++
		expected = rec.Seq + 1

		if readErr == io.EOF {
			break
		}
	}

	if res.Records == 0 && res.Status == VerifyValid {
		res.Status = VerifyEmpty
	}
	return res, nil
}
