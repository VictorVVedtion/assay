// Command assay is the data-plane CLI for assay (照妖镜): a transparent,
// fail-open audit proxy that independently verifies the usage and model
// authenticity of an LLM API relay ("中转站").
//
// Subcommands (Phase 0):
//
//	assay proxy   --config assay.yaml        run the transparent audit proxy
//	assay verify  --evidence evidence.jsonl  check the evidence hash chain
//
// The analysis plane (token recount, cache-replay, throughput) is a separate
// Python tool: assay-analyzer (see ../../analyzer).
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"assay/internal/config"
	"assay/internal/evidence"
	"assay/internal/proxy"
)

// version is the current build version. Keep in sync with analyzer __version__.
const version = "0.1.0-alpha"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "proxy":
		runProxy(os.Args[2:])
	case "verify":
		runVerify(os.Args[2:])
	case "version", "-v", "--version":
		fmt.Println("assay", version)
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "assay: unknown command %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func runProxy(args []string) {
	fs := flag.NewFlagSet("proxy", flag.ExitOnError)
	cfgPath := fs.String("config", "assay.yaml", "path to config file")
	_ = fs.Parse(args)

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fail(err.Error())
	}
	mode, err := cfg.Evidence.FileModeOctal()
	if err != nil {
		fail(err.Error())
	}

	w, err := evidence.NewWriter(evidence.WriterOptions{
		Path:              cfg.Evidence.Path,
		QueueSize:         cfg.Capture.ChannelSize,
		FlushEveryRecords: cfg.Evidence.FlushEveryRecords,
		FlushInterval:     time.Duration(cfg.Evidence.FlushEveryMs) * time.Millisecond,
		Fsync:             cfg.Evidence.Fsync,
		FileMode:          mode,
		OnError: func(e error) {
			fmt.Fprintln(os.Stderr, "assay[evidence]:", e)
		},
	})
	if err != nil {
		fail("evidence writer: " + err.Error())
	}
	defer w.Close()

	p := proxy.New(cfg, w)
	srv := &http.Server{Addr: cfg.Listen, Handler: p}

	go func() {
		up := cfg.Upstreams[0]
		fmt.Fprintf(os.Stderr, "assay %s — proxy on %s → %s (auth=%s)\n", version, cfg.Listen, up.Target, up.AuthMode)
		fmt.Fprintf(os.Stderr, "assay: evidence → %s  | point your app at http://%s\n", cfg.Evidence.Path, cfg.Listen)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fail("listen: " + err.Error())
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	fmt.Fprintln(os.Stderr, "\nassay: shutting down…")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func runVerify(args []string) {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	evPath := fs.String("evidence", "./data/evidence.jsonl", "path to evidence.jsonl")
	_ = fs.Parse(args)

	res, err := evidence.VerifyFile(*evPath)
	if err != nil {
		fail(err.Error())
	}

	icon := map[evidence.VerifyStatus]string{
		evidence.VerifyValid: "✅", evidence.VerifyEmpty: "∅",
		evidence.VerifyTornTail: "⚠️ ", evidence.VerifyBreak: "❌",
	}[res.Status]

	fmt.Printf("%s %s — %d records verified\n", icon, res.Status, res.Records)
	if res.HeadHash != "" && res.Records > 0 {
		fmt.Printf("   head: %s\n", res.HeadHash)
	}
	if res.Detail != "" {
		fmt.Printf("   %s\n", res.Detail)
	}
	for _, wmsg := range res.Warnings {
		fmt.Printf("   ⚠ %s\n", wmsg)
	}

	switch res.Status {
	case evidence.VerifyBreak:
		os.Exit(1) // tamper — non-zero exit for scripting
	case evidence.VerifyTornTail:
		os.Exit(0) // recoverable
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `assay (照妖镜) `+version+` — independent LLM relay auditor (data plane)

usage:
  assay proxy   --config assay.yaml         run the transparent audit proxy
  assay verify  --evidence evidence.jsonl   verify the evidence hash chain
  assay version                             print version

The analysis plane is the separate assay-analyzer (Python) tool.
Docs: README.md · DESIGN.md · PHASE0.md
`)
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "assay: "+msg)
	os.Exit(1)
}
