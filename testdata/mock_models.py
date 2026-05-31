"""Mock upstream serving two DISTINGUISHABLE models for Phase 1 e2e.

Routes by the requested model name to two different canned-but-varied response
styles, so MMD can tell them apart. Temperature is honored loosely by picking
from a small per-model phrase bank seeded by request count (gives within-model
variation without being identical). Not the real models — just two clearly
different output distributions to exercise calibrate -> probe -> model_identity.
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

# Two distinct "voices". model-genuine = formal/long; model-cheap = terse/different.
BANKS = {
    "genuine": [
        "The subject in question represents a profound and multifaceted area of study, "
        "encompassing centuries of scholarly inquiry and rigorous analysis across disciplines.",
        "This topic has been examined extensively by researchers, who have documented its "
        "intricate development through detailed historical and empirical investigation over time.",
        "A comprehensive understanding requires careful consideration of numerous interrelated "
        "factors, each contributing to the broader and richly contextualized phenomenon at hand.",
        "Scholars generally concur that the matter is characterized by remarkable complexity, "
        "warranting thorough and systematic examination of its many constituent dimensions.",
    ],
    "cheap": [
        "It's a big topic. Lots of stuff happened. People studied it.",
        "Yeah so basically this is about many things and it changed over time a lot.",
        "There are several points here. First one. Second one. Third one too.",
        "This thing is complex but also simple if you think about it the right way ok.",
    ],
}

_counter = {"n": 0}
MODE = "genuine"  # overridden in __main__; module-global so the handler sees it


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.endswith("/models"):
            self._json({"object": "list", "data": [
                {"id": "model-premium"}, {"id": "model-cheap"}]})
            return
        self._json({"error": "not found"}, code=404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        model = body.get("model", "model-premium")
        # The "relay swap" is simulated by an env-like query/header: if the request
        # asks for model-premium we serve genuine UNLESS this server is the cheap one.
        bank = BANKS["genuine"] if MODE == "genuine" else BANKS["cheap"]
        _counter["n"] += 1
        text = bank[_counter["n"] % len(bank)]
        self._json({
            "id": "chatcmpl-mock", "object": "chat.completion", "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 28, "total_tokens": 40},
        })

    def _json(self, obj, code=200):
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1])
    MODE = sys.argv[2] if len(sys.argv) > 2 else "genuine"  # genuine | cheap
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
