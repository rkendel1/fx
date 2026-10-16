// @ts-check
// A local OpenAI-compatible endpoint that answers each request with the next scripted reply.
// For the offline agent example and the Chip tests: it needs no credentials and no network
// beyond 127.0.0.1, and it records what it was asked so a test can read the requests back.

import http from "node:http";

/**
 * @typedef {{ text: string, finish?: "stop" | null } | { status: number, headers?: Record<string, string> } | { hang: true }} Reply
 * @typedef {{ stream: boolean, model: string, body: Record<string, any> }} Seen
 */

/**
 * @param {Reply[]} replies consumed in order, one per request
 * @returns {Promise<{ url: string, requests: Seen[], closedByClient: () => number, close: () => Promise<void> }>}
 */
export async function startSequenceServer(replies) {
  const queue = [...replies];
  /** @type {Seen[]} */
  const requests = [];
  let closed = 0;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (piece) => (raw += piece));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ stream: body.stream === true, model: body.model, body });
      res.on("close", () => {
        if (!res.writableEnded) closed += 1;
      });
      const reply = queue.shift();
      if (!reply) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify({ error: { message: "the script ran out of replies" } }));
      }
      if ("hang" in reply) {
        res.writeHead(200, { "Content-Type": body.stream ? "text/event-stream" : "application/json" });
        return; // never answers; the client must give up
      }
      if ("status" in reply) {
        res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
        return void res.end(JSON.stringify({ error: { message: "scripted failure" } }));
      }
      const finish = reply.finish === undefined ? "stop" : reply.finish;
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.text } }] })}\n\n`);
        if (finish !== null) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
          res.write("data: [DONE]\n\n");
        }
        return void res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: reply.text }, ...(finish !== null && { finish_reason: finish }) }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      );
      return undefined;
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    closedByClient: () => closed,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
