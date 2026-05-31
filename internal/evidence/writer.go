package evidence

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Writer is the SINGLE owner of evidence.jsonl. It runs one goroutine that
// alone assigns seq, threads prev_hash, computes the hash, and appends. Request
// goroutines never touch the file or the chain — they only Submit a draft via a
// bounded, non-blocking channel. This is the mechanism that makes fail-open real
// (PHASE0.md §2): under overload the writer drops EVIDENCE (counted), never the
// user's request, and no marshal/hash/fsync ever runs on a client connection.
type Writer struct {
	opt WriterOptions

	ch   chan *Record
	quit chan struct{}
	wg   sync.WaitGroup

	f  *os.File
	bw *bufio.Writer

	// owned exclusively by the writer goroutine:
	seq        uint64
	prevHash   string
	sinceFlush int

	dropped     atomic.Uint64
	written     atomic.Uint64
	writeErrors atomic.Uint64
}

type WriterOptions struct {
	Path              string
	QueueSize         int           // bounded in-flight drafts; default 4096
	FlushEveryRecords int           // default 64
	FlushInterval     time.Duration // default 500ms
	Fsync             bool
	FileMode          os.FileMode // default 0600 (evidence holds plaintext)
	OnError           func(error) // optional; called off the hot path
}

func (o *WriterOptions) defaults() {
	if o.QueueSize <= 0 {
		o.QueueSize = 4096
	}
	if o.FlushEveryRecords <= 0 {
		o.FlushEveryRecords = 64
	}
	if o.FlushInterval <= 0 {
		o.FlushInterval = 500 * time.Millisecond
	}
	if o.FileMode == 0 {
		o.FileMode = 0o600
	}
}

// NewWriter opens (creating if needed) the evidence file, takes an exclusive
// advisory lock so a second proxy can't corrupt the chain, recovers seq/prev_hash
// from the last good line (truncating a torn trailing write), and starts the
// writer goroutine. It returns an error — refusing to start — if it finds
// INTERIOR corruption (a complete line that fails to parse or breaks the chain),
// because that is a tamper signal an operator must investigate, not silently fix.
func NewWriter(opt WriterOptions) (*Writer, error) {
	opt.defaults()

	f, err := os.OpenFile(opt.Path, os.O_RDWR|os.O_CREATE, opt.FileMode)
	if err != nil {
		return nil, fmt.Errorf("open evidence file: %w", err)
	}

	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("lock evidence file (is another assay proxy running?): %w", err)
	}

	seq, prev, err := recoverTail(f)
	if err != nil {
		f.Close()
		return nil, err
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		f.Close()
		return nil, fmt.Errorf("seek to end: %w", err)
	}

	w := &Writer{
		opt:      opt,
		ch:       make(chan *Record, opt.QueueSize),
		quit:     make(chan struct{}),
		f:        f,
		bw:       bufio.NewWriterSize(f, 1<<16),
		seq:      seq,
		prevHash: prev,
	}
	w.wg.Add(1)
	go w.loop()
	return w, nil
}

// Submit hands a draft record to the writer goroutine. It NEVER blocks: if the
// queue is full it drops the record, increments the dropped counter, and returns
// false. Callers are on the client path and must treat false as "evidence lost
// for this request" — never as a reason to fail the client.
func (w *Writer) Submit(r *Record) bool {
	select {
	case w.ch <- r:
		return true
	default:
		w.dropped.Add(1)
		return false
	}
}

// Stats returns observable counters for the doctor/health endpoint.
func (w *Writer) Stats() (written, dropped, writeErrors uint64) {
	return w.written.Load(), w.dropped.Load(), w.writeErrors.Load()
}

// Head returns the current chain head (next seq, last hash). Writer-goroutine
// state; safe to read only after Close, or for tests. Used by the anchor hook.
func (w *Writer) Head() (nextSeq uint64, headHash string) { return w.seq, w.prevHash }

func (w *Writer) loop() {
	defer w.wg.Done()
	t := time.NewTicker(w.opt.FlushInterval)
	defer t.Stop()
	for {
		select {
		case <-w.quit:
			for { // drain whatever is queued, then flush and exit
				select {
				case r := <-w.ch:
					w.handle(r)
				default:
					w.flush()
					return
				}
			}
		case r := <-w.ch:
			w.handle(r)
		case <-t.C:
			w.flush()
		}
	}
}

// handle is panic-isolated: a poison record degrades evidence (counted), it
// never kills the writer or the process (PHASE0.md §2 fail-open).
func (w *Writer) handle(r *Record) {
	defer func() {
		if rec := recover(); rec != nil {
			w.writeErrors.Add(1)
			w.reportf("evidence writer recovered from panic: %v", rec)
		}
	}()

	r.V = SchemaVersion
	r.Seq = w.seq
	r.PrevHash = w.prevHash
	r.Hash = Hash(r)

	line, err := json.Marshal(r)
	if err != nil {
		w.writeErrors.Add(1)
		w.reportf("marshal evidence record seq=%d: %v", r.Seq, err)
		return // do not advance the chain
	}
	line = append(line, '\n')
	if _, err := w.bw.Write(line); err != nil {
		w.writeErrors.Add(1)
		w.reportf("append evidence record seq=%d: %v", r.Seq, err)
		return // do not advance the chain
	}

	w.prevHash = r.Hash
	w.seq++
	w.written.Add(1)
	w.sinceFlush++
	if w.sinceFlush >= w.opt.FlushEveryRecords {
		w.flush()
	}
}

func (w *Writer) flush() {
	if err := w.bw.Flush(); err != nil {
		w.writeErrors.Add(1)
		w.reportf("flush evidence: %v", err)
		return
	}
	if w.opt.Fsync {
		_ = w.f.Sync()
	}
	w.sinceFlush = 0
}

func (w *Writer) reportf(format string, args ...any) {
	if w.opt.OnError != nil {
		w.opt.OnError(fmt.Errorf(format, args...))
	}
}

// Close stops the writer, flushes buffered records, and releases the lock.
func (w *Writer) Close() error {
	close(w.quit)
	w.wg.Wait()
	return w.f.Close() // closing the fd releases the flock
}

// recoverTail scans an existing evidence file to find the chain head. It returns
// the next seq and the head hash. A torn TRAILING line (no newline, or final
// chunk that doesn't parse) is truncated — that's an expected crash artifact. An
// INTERIOR inconsistency (a newline-terminated line that fails to parse or breaks
// seq/prev_hash/hash) returns an error: the writer must refuse to start so a real
// tamper isn't silently overwritten.
func recoverTail(f *os.File) (nextSeq uint64, headHash string, err error) {
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return 0, "", fmt.Errorf("seek start: %w", err)
	}
	r := bufio.NewReader(f)

	headHash = GenesisPrevHash
	var expected uint64
	var goodEnd int64

	for {
		line, readErr := r.ReadBytes('\n')

		hasNewline := len(line) > 0 && line[len(line)-1] == '\n'
		if len(line) > 0 && !hasNewline {
			// Final chunk without a newline: torn trailing write. Truncate it.
			if terr := f.Truncate(goodEnd); terr != nil {
				return 0, "", fmt.Errorf("truncate torn tail: %w", terr)
			}
			return expected, headHash, nil
		}
		if len(line) == 0 {
			// EOF with nothing pending.
			return expected, headHash, nil
		}

		var rec Record
		if jerr := json.Unmarshal(line, &rec); jerr != nil {
			// A newline-terminated line that won't parse = interior corruption.
			return 0, "", fmt.Errorf("corrupt evidence line at seq~%d (interior, refusing to start): %w", expected, jerr)
		}
		if rec.Seq != expected {
			return 0, "", fmt.Errorf("evidence seq gap: expected %d, got %d (chain break, refusing to start)", expected, rec.Seq)
		}
		if rec.PrevHash != headHash {
			return 0, "", fmt.Errorf("evidence prev_hash mismatch at seq %d (chain break, refusing to start)", rec.Seq)
		}
		if Hash(&rec) != rec.Hash {
			return 0, "", fmt.Errorf("evidence hash mismatch at seq %d (tamper, refusing to start)", rec.Seq)
		}

		goodEnd += int64(len(line))
		headHash = rec.Hash
		expected = rec.Seq + 1

		if readErr == io.EOF {
			return expected, headHash, nil
		}
	}
}
