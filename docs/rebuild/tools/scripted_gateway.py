"""A scriptable loopback fake of the Zig oracle's inference wire protocol.

Planning and parity tooling only. Each POST to the language-model endpoint is answered with
the next scripted item and logged, so the real `fx` binary's behavior (how many requests it
makes, what it sends back after a tool result, what it does after a 429) can be observed
without a credential or a network.

    python3 scripted_gateway.py PORT LOG.jsonl SCRIPT.json

SCRIPT.json is a list. Each item is one of:

    {"sse": [<event object>, ...]}                  a complete stream (the events are sent as given)
    {"sse": [...], "truncate": true}                the stream stops after the events, without [DONE]
    {"sse": [...], "hang": true}                    the events, then the connection stays open and silent
                                                    until the client goes away (cancellation scenarios)
    {"status": 429, "headers": {"retry-after": "1"}, "body": "..."}   an HTTP error

When the script runs out, every further POST gets a 500. GETs answer an empty model list.
The Authorization header is recorded only as present or absent.
"""

from __future__ import annotations

import http.server
import json
import sys
import time


def text_stream(text: str, finish: str = "stop") -> list[dict]:
    return [
        {"type": "stream-start", "warnings": []},
        {"type": "text-start", "id": "a"},
        {"type": "text-delta", "id": "a", "delta": text},
        {"type": "text-end", "id": "a"},
        {
            "type": "finish",
            "finishReason": {"unified": finish, "raw": finish},
            "usage": {"inputTokens": {"total": 12}, "outputTokens": {"total": 3}},
        },
    ]


def tool_stream(call_id: str, name: str, arguments: str) -> list[dict]:
    return [
        {"type": "tool-input-start", "id": call_id, "toolName": name},
        {"type": "tool-input-delta", "id": call_id, "delta": arguments},
        {"type": "tool-input-end", "id": call_id},
        {"type": "tool-call", "toolCallId": call_id, "toolName": name, "input": arguments},
        {
            "type": "finish",
            "finishReason": {"unified": "tool-calls", "raw": "tool_calls"},
            "usage": {"inputTokens": {"total": 20}, "outputTokens": {"total": 5}},
        },
    ]


def render(events: list[dict], done: bool) -> bytes:
    body = "".join(f"data: {json.dumps(event)}\n\n" for event in events)
    if done:
        body += "data: [DONE]\n\n"
    return body.encode()


def main(argv: list[str]) -> int:
    port, log_path, script_path = int(argv[0]), argv[1], argv[2]
    with open(script_path, encoding="utf-8") as handle:
        script = json.load(handle)
    state = {"posts": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:
            pass

        def _record(self, body: object) -> None:
            with open(log_path, "a", encoding="utf-8") as log:
                log.write(
                    json.dumps(
                        {
                            "method": self.command,
                            "path": self.path,
                            "authorization_present": any(k.lower() == "authorization" for k in self.headers),
                            "body": body,
                        }
                    )
                    + "\n"
                )

        def _send(self, status: int, content_type: str, payload: bytes, headers: dict | None = None) -> None:
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(payload)))
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:
            self._record(None)
            self._send(200, "application/json", json.dumps({"object": "list", "data": []}).encode())

        def do_POST(self) -> None:
            raw = self.rfile.read(int(self.headers.get("content-length", 0)))
            try:
                body: object = json.loads(raw)
            except ValueError:
                body = raw.decode(errors="replace")
            self._record(body)
            index = state["posts"]
            state["posts"] += 1
            if index >= len(script):
                return self._send(500, "application/json", b'{"error":{"message":"script exhausted"}}')
            item = script[index]
            if "status" in item:
                return self._send(
                    item["status"],
                    "application/json",
                    (item.get("body") or json.dumps({"error": {"message": "scripted"}})).encode(),
                    item.get("headers"),
                )
            if item.get("hang"):
                payload = render(item["sse"], done=False)
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("transfer-encoding", "chunked")
                self.end_headers()
                self.wfile.write(f"{len(payload):x}\r\n".encode() + payload + b"\r\n")
                self.wfile.flush()
                try:
                    while True:
                        time.sleep(0.2)
                        self.wfile.write(b"")
                        self.connection.setblocking(False)
                        try:
                            if self.connection.recv(1) == b"":
                                break
                        except BlockingIOError:
                            pass
                        self.connection.setblocking(True)
                except OSError:
                    pass
                self.close_connection = True
                return
            if item.get("truncate"):
                # Promise more than is sent, then close: a stream cut off without its terminal.
                payload = render(item["sse"], done=False)
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(payload) + 1000))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()
                self.close_connection = True
                return
            self._send(200, "text/event-stream", render(item["sse"], done=True))

    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
