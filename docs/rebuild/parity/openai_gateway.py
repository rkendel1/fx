"""A scriptable loopback OpenAI-compatible chat-completions endpoint for the Chip side of the
agent-loop parity run. Same script items and log format as `../tools/scripted_gateway.py`, so one
scenario script drives both implementations.

    python3 openai_gateway.py PORT LOG.jsonl SCRIPT.json

Script items: {"text": "..."} (a streamed reply), {"status": 429, "headers": {...}, "body": "..."},
{"text": "...", "truncate": true} (stream cut before its terminal chunk),
{"text": "...", "hang": true} (the text, then silence until the client goes away).
Past the end of the script every POST gets a 500. Authorization is logged as present/absent only.
"""
from __future__ import annotations

import http.server
import json
import sys
import time


def chunk(delta: dict, finish=None, usage=None) -> bytes:
    body = {"id": "chatcmpl-parity", "object": "chat.completion.chunk", "model": "parity-model",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}] if usage is None else []}
    if usage is not None:
        body["usage"] = usage
    return f"data: {json.dumps(body)}\n\n".encode()


def main(argv: list[str]) -> int:
    port, log_path, script_path = int(argv[0]), argv[1], argv[2]
    script = json.load(open(script_path, encoding="utf-8"))
    state = {"posts": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_a) -> None:
            pass

        def _record(self, body) -> None:
            with open(log_path, "a", encoding="utf-8") as log:
                log.write(json.dumps({"method": self.command, "path": self.path,
                                      "authorization_present": any(k.lower() == "authorization" for k in self.headers),
                                      "body": body}) + "\n")

        def _send(self, status, ctype, payload, headers=None):
            self.send_response(status)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(payload)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            self._record(None)
            self._send(200, "application/json", b'{"object":"list","data":[]}')

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("content-length", 0)))
            try:
                body = json.loads(raw)
            except ValueError:
                body = raw.decode(errors="replace")
            self._record(body)
            index = state["posts"]
            state["posts"] += 1
            if index >= len(script):
                return self._send(500, "application/json", b'{"error":{"message":"script exhausted"}}')
            item = script[index]
            if "status" in item:
                return self._send(item["status"], "application/json",
                                  (item.get("body") or json.dumps({"error": {"message": "scripted"}})).encode(),
                                  item.get("headers"))
            head = chunk({"role": "assistant", "content": item["text"]})
            if item.get("hang") or item.get("truncate"):
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                if item.get("truncate"):
                    self.send_header("content-length", str(len(head) + 1000))
                else:
                    self.send_header("transfer-encoding", "chunked")
                self.end_headers()
                self.wfile.write(head if item.get("truncate") else f"{len(head):x}\r\n".encode() + head + b"\r\n")
                self.wfile.flush()
                if item.get("hang"):
                    self.connection.settimeout(0.2)
                    while True:
                        try:
                            if self.connection.recv(1) == b"":
                                break
                        except TimeoutError:
                            continue
                        except OSError:
                            break
                self.close_connection = True
                return
            payload = (head + chunk({}, finish="stop")
                       + chunk({}, usage={"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15})
                       + b"data: [DONE]\n\n")
            self._send(200, "text/event-stream", payload)

    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
