// @ts-check
// A local OpenAI-compatible endpoint for deterministic runs. The behavior is chosen by the
// requested model name, so one server covers success, rate limits, resets and hangs.
// Used by the tests and by examples/mock-openai.mjs. It needs no credentials or network.

import http from "node:http";

/**
 * @typedef {{ model: string, stream: boolean, authorization: string | undefined }} Seen
 */

/** @param {import("node:http").ServerResponse} res @param {unknown} chunk */
const sse = (res, chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);

/**
 * @returns {Promise<{ url: string, requests: Seen[], aborted: () => number, close: () => Promise<void> }>}
 */
export async function startMockServer() {
  /** @type {Seen[]} */
  const requests = [];
  let aborted = 0;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (piece) => (raw += piece));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ model: body.model, stream: body.stream === true, authorization: req.headers.authorization });
      // `close` before the response ended means the client dropped the connection.
      res.on("close", () => {
        if (!res.writableEnded) aborted += 1;
      });

      const fail = (/** @type {number} */ status, /** @type {string} */ message, /** @type {Record<string, string>} */ headers = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify({ error: { message } }));
      };

      switch (body.model) {
        case "ratelimit":
          return fail(429, "slow down", { "Retry-After": "3" });
        case "unauthorized":
          return fail(401, "invalid api key");
        case "server-error":
          return fail(500, "rate limit exceeded 429 unauthorized 401");
        case "hang":
          res.writeHead(200, { "Content-Type": body.stream ? "text/event-stream" : "application/json" });
          return; // never answers; the client must give up
        case "reset":
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          sse(res, { choices: [{ delta: { content: "partial " } }] });
          setTimeout(() => req.socket.destroy(), 20);
          return;
        case "truncated":
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          sse(res, { choices: [{ delta: { content: "cut " } }] });
          sse(res, { choices: [{ delta: { content: "off" } }] });
          return res.end(); // no finish_reason and no [DONE]
        default:
          break;
      }

      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        sse(res, { choices: [{ delta: { content: "Hello " } }] });
        sse(res, { choices: [{ delta: { content: "world" } }] });
        sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "Hello world" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    aborted: () => aborted,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
