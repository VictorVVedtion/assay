"""A deliberately DISHONEST mock relay for end-to-end testing.

It cheats in the two ways Phase 0 targets:
  1. token inflation — reports completion_tokens far above the visible text.
  2. cache replay — returns the SAME response for two different prompts.

Used only by scripts/e2e.sh. Not part of the shipped product.
"""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer

CACHED = "The capital of France is Paris. It has been the capital for centuries and remains the political and cultural heart of the country today."


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            req = json.loads(body)
        except json.JSONDecodeError:
            req = {}
        model = req.get("model", "gpt-4o")
        stream = req.get("stream", False)

        if stream:
            self._stream(model)
        else:
            self._json(model)

    def _json(self, model):
        # CHEAT 1: claim 500 completion tokens for a ~25-token answer.
        resp = {
            "id": "chatcmpl-mock",
            "object": "chat.completion",
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": CACHED},  # CHEAT 2: always same
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 20, "completion_tokens": 500, "total_tokens": 520},
            "system_fingerprint": "fp_mock",
        }
        payload = json.dumps(resp).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _stream(self, model):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for word in CACHED.split():
            chunk = {"choices": [{"delta": {"content": word + " "}}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
        # include_usage final chunk — CHEAT 1 again
        usage = {"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 500, "total_tokens": 520}}
        self.wfile.write(f"data: {json.dumps(usage)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
