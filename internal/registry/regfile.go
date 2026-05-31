package registry

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

// registry.jsonl — the distributed registry, one signed Statement per line.
//
// Redteam major: the evidence log's append-only seq/prev_hash chain is the WRONG
// primitive here. That chain works because ONE writer appends sequentially; a
// community registry has MANY contributors and a merging maintainer, so benign
// co-signs would rewrite the HEAD the buyer is told to pin, and the chain proves
// LINKAGE not COMPLETENESS. So the registry is a SET of independently-signed
// statements with NO inter-entry chaining — each statement's Ed25519 signature
// is its own integrity anchor, and the quorum is computed over the set. (A
// root-signed snapshot over the whole set is the next increment for anti-rollback;
// see DESIGN — deferred, disclosed as a limit, not faked here.)

// LoadRegistry reads all statements from a registry.jsonl file. Malformed lines
// are reported (not silently skipped) so a corrupt registry is loud. Order is
// irrelevant — the quorum groups by FingerprintID.
func LoadRegistry(path string) ([]*Statement, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var out []*Statement
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	line := 0
	for sc.Scan() {
		line++
		raw := sc.Bytes()
		if len(trimSpace(raw)) == 0 {
			continue
		}
		var st Statement
		if err := json.Unmarshal(raw, &st); err != nil {
			return nil, fmt.Errorf("registry line %d: %w", line, err)
		}
		out = append(out, &st)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// AppendStatement adds one signed statement to a registry.jsonl (creating it).
// De-dup is the caller's concern; the quorum is idempotent over duplicate
// (signer, fingerprint) pairs anyway (appendUniq on pubkey).
func AppendStatement(path string, st *Statement) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	_, err = f.Write(append(b, '\n'))
	return err
}

func trimSpace(b []byte) []byte {
	i, j := 0, len(b)
	for i < j && (b[i] == ' ' || b[i] == '\t' || b[i] == '\r' || b[i] == '\n') {
		i++
	}
	for j > i && (b[j-1] == ' ' || b[j-1] == '\t' || b[j-1] == '\r' || b[j-1] == '\n') {
		j--
	}
	return b[i:j]
}
