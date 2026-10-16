"""Loopback fake of the current inference wire protocol, for capturing evidence.

Planning tooling only. It records every request fx sends and answers with a
scripted AI SDK LanguageModelV3 SSE stream, so the exact request shape and the
stream fx accepts can be observed against a freshly built binary without any
credential or network access.

Usage:

    python3 docs/rebuild/tools/fake_gateway.py PORT LOG.jsonl [text|tool]

    HOME=$(mktemp -d) AI_GATEWAY_API_KEY=placeholder \\
      FX_GATEWAY_BASE_URL=http://127.0.0.1:PORT \\
      FX_GATEWAY_CHAT_URL=http://127.0.0.1:PORT/v3/ai/language-model \\
      ./zig-out/bin/fx ask --json "say hi"

`text` answers every request with one text part. `tool` answers the first
request with a `list_files` tool-call proposal and every later request with
text, which exercises one full tool round trip. The Authorization header is
recorded only as present or absent.
"""

from __future__ import annotations

import http.server
import json
import sys

TEXT_STREAM = (
    'data: {"type":"stream-start","warnings":[]}\n\n'
    'data: {"type":"text-start","id":"a"}\n\n'
    'data: {"type":"text-delta","id":"a","delta":"hello from fake"}\n\n'
    'data: {"type":"text-end","id":"a"}\n\n'
    'data: {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},'
    '"usage":{"inputTokens":{"total":12},"outputTokens":{"total":3}}}\n\n'
    "data: [DONE]\n\n"
)

TOOL_STREAM = (
    'data: {"type":"tool-input-start","id":"call_1","toolName":"list_files"}\n\n'
    'data: {"type":"tool-input-delta","id":"call_1","delta":"{\\"path\\":\\".\\"}"}\n\n'
    'data: {"type":"tool-input-end","id":"call_1"}\n\n'
    'data: {"type":"tool-call","toolCallId":"call_1","toolName":"list_files","input":"{\\"path\\":\\".\\"}"}\n\n'
    'data: {"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool_calls"},'
    '"usage":{"inputTokens":{"total":20},"outputTokens":{"total":5}}}\n\n'
    "data: [DONE]\n\n"
)


def main(argv: list[str]) -> int:
    port, log_path = int(argv[0]), argv[1]
    mode = argv[2] if len(argv) > 2 else "text"
    state = {"posts": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:
            pass

        def _record(self, body: object) -> None:
            headers = {k: v for k, v in self.headers.items() if k.lower() != "authorization"}
            entry = {
                "method": self.command,
                "path": self.path,
                "authorization_present": "authorization" in {k.lower() for k in self.headers},
                "headers": headers,
                "body": body,
            }
            with open(log_path, "a", encoding="utf-8") as log:
                log.write(json.dumps(entry) + "\n")

        def _send(self, content_type: str, payload: bytes) -> None:
            self.send_response(200)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:
            self._record(None)
            self._send("application/json", json.dumps({"object": "list", "data": []}).encode())

        def do_POST(self) -> None:
            raw = self.rfile.read(int(self.headers.get("content-length", 0)))
            try:
                body: object = json.loads(raw)
            except ValueError:
                body = raw.decode(errors="replace")
            self._record(body)
            state["posts"] += 1
            stream = TOOL_STREAM if mode == "tool" and state["posts"] == 1 else TEXT_STREAM
            self._send("text/event-stream", stream.encode())

    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
