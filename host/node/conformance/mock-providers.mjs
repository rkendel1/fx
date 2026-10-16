// @ts-check
// One local HTTP server that speaks the wire format of each Easy-LLM adapter's endpoint
// (OpenAI, OpenRouter, Anthropic, Google, Ollama), so the *real* adapters run unmodified
// against it. The behavior of a request is chosen by the model name, which is the scenario
// name. No credentials, no external network.
//
// The wire formats here are what the adapters in the pinned Easy-LLM commit parse. They are
// reconstructed from the adapters' own parsing code and public API shapes, not recorded from
// the live services: a passing run proves how the adapter behaves on that format, not that the
// service sends it. The manifest keeps that distinction (`evidence: "mock-server"`).
// Scenarios are defined in scenarios.mjs; this file only renders them.

import http from "node:http";

/**
 * @typedef {"openai" | "openrouter" | "anthropic" | "google" | "ollama"} ProviderId
 *
 * @typedef {object} Scenario
 * @property {{ status: number, headers?: Record<string, string>, body?: string, message?: string }} [http] an error response
 * @property {"hang" | "reset"} [before] never answer, or destroy the connection, before any response
 * @property {string[]} [text] text deltas (a collected response joins them)
 * @property {string} [json] a raw body for a collected (non-streaming) response
 * @property {"natural" | "length" | "filter" | "tools" | "unknown" | "none"} [finish] which finish reason the provider reports
 *   (`none` omits every terminal marker)
 * @property {"ok" | "partial" | "malformed" | "none"} [usage] usage metadata: complete, partly invalid, invalid, absent
 * @property {string[]} [garbage] raw lines injected after the first text delta
 * @property {string[]} [late] text written after the terminal marker
 * @property {"end" | "hang" | "reset" | "drip"} [tail] what happens after the scripted writes (default `end`);
 *   `drip` keeps writing text until the client goes away
 * @property {"zero-bytes"} [empty] a successful stream carrying no bytes at all
 * @property {{ id: string, name: string, args: string }} [toolCall] a tool call the provider returns although none was offered
 *
 * @typedef {object} Seen
 * @property {ProviderId} provider
 * @property {string} scenario
 * @property {boolean} stream
 * @property {string} path
 * @property {Record<string, any>} body
 * @property {Record<string, string | undefined>} headers
 * @property {boolean} closed the client dropped the connection before the server finished its response
 */

/** Provider-native finish reasons for each scenario finish. `undefined` means the provider has no such value. */
export const NATIVE_FINISH = /** @type {const} */ ({
  openai: { natural: "stop", length: "length", filter: "content_filter", tools: "tool_calls", unknown: "provider_made_this_up" },
  openrouter: { natural: "stop", length: "length", filter: "content_filter", tools: "tool_calls", unknown: "provider_made_this_up" },
  anthropic: { natural: "end_turn", length: "max_tokens", filter: "refusal", tools: "tool_use", unknown: "provider_made_this_up" },
  google: { natural: "STOP", length: "MAX_TOKENS", filter: "SAFETY", tools: undefined, unknown: "provider_made_this_up" },
  ollama: { natural: "stop", length: "length", filter: undefined, tools: undefined, unknown: "provider_made_this_up" },
});

const USAGE = { input: 5, output: 2 };

/** @param {import("node:http").ServerResponse} res @param {unknown} chunk */
const sse = (res, chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
/** @param {import("node:http").ServerResponse} res @param {unknown} chunk */
const ndjson = (res, chunk) => res.write(`${JSON.stringify(chunk)}\n`);

/**
 * @param {ProviderId} provider
 * @param {Scenario} s
 */
function nativeFinish(provider, s) {
  if (s.finish === undefined || s.finish === "none") return undefined;
  return NATIVE_FINISH[provider][s.finish];
}

/**
 * @param {Scenario} s
 * @returns {Record<string, any> | string | undefined} OpenAI-style usage object
 */
function openAiUsage(s) {
  switch (s.usage) {
    case "ok":
      return { prompt_tokens: USAGE.input, completion_tokens: USAGE.output, total_tokens: USAGE.input + USAGE.output };
    case "partial":
      return { prompt_tokens: USAGE.input, completion_tokens: "two", total_tokens: null };
    case "malformed":
      return { prompt_tokens: -1, completion_tokens: "many", total_tokens: { n: 1 } };
    default:
      return undefined;
  }
}

/** @param {Scenario} s */
function anthropicUsage(s) {
  switch (s.usage) {
    case "ok":
      return { input_tokens: USAGE.input, output_tokens: USAGE.output };
    case "partial":
      return { input_tokens: USAGE.input, output_tokens: "two" };
    case "malformed":
      return { input_tokens: -1, output_tokens: "many" };
    default:
      return undefined;
  }
}

/** @param {Scenario} s */
function googleUsage(s) {
  switch (s.usage) {
    case "ok":
      return { promptTokenCount: USAGE.input, candidatesTokenCount: USAGE.output, totalTokenCount: USAGE.input + USAGE.output };
    case "partial":
      return { promptTokenCount: USAGE.input, candidatesTokenCount: "two", totalTokenCount: null };
    case "malformed":
      return { promptTokenCount: -1, candidatesTokenCount: "many", totalTokenCount: { n: 1 } };
    default:
      return undefined;
  }
}

/**
 * The collected (non-streaming) response body for a provider.
 * @param {ProviderId} provider
 * @param {Scenario} s
 * @returns {string}
 */
function collectedBody(provider, s) {
  if (s.json !== undefined) return s.json;
  const text = (s.text ?? []).join("");
  const finish = nativeFinish(provider, s);
  switch (provider) {
    case "openai":
    case "openrouter": {
      const usage = openAiUsage(s);
      return JSON.stringify({
        choices: [
          {
            message: {
              content: text,
              ...(s.toolCall && {
                tool_calls: [{ id: s.toolCall.id, type: "function", function: { name: s.toolCall.name, arguments: s.toolCall.args } }],
              }),
            },
            ...(finish !== undefined && { finish_reason: finish }),
          },
        ],
        ...(usage && { usage }),
      });
    }
    case "anthropic": {
      const usage = anthropicUsage(s);
      return JSON.stringify({
        content: [
          { type: "text", text },
          ...(s.toolCall ? [{ type: "tool_use", id: s.toolCall.id, name: s.toolCall.name, input: JSON.parse(s.toolCall.args) }] : []),
        ],
        ...(finish !== undefined && { stop_reason: finish }),
        ...(usage && { usage }),
      });
    }
    case "google": {
      const usage = googleUsage(s);
      return JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text },
                ...(s.toolCall ? [{ function_call: { name: s.toolCall.name, args: JSON.parse(s.toolCall.args) } }] : []),
              ],
            },
            ...(finish !== undefined && { finishReason: finish }),
          },
        ],
        ...(usage && { usageMetadata: usage }),
      });
    }
    case "ollama":
      return JSON.stringify({ response: text, done: true, ...(finish !== undefined && { done_reason: finish }) });
  }
}

/**
 * Writes the scripted stream. Returns once the scripted part is written.
 * @param {ProviderId} provider
 * @param {Scenario} s
 * @param {import("node:http").ServerResponse} res
 */
function writeStream(provider, s, res) {
  const text = s.text ?? [];
  const finish = nativeFinish(provider, s);
  const garbage = s.garbage ?? [];
  const late = s.late ?? [];
  /** @type {(line: string) => void} */
  const raw = (line) => void res.write(`${line}\n`);

  switch (provider) {
    case "openai":
    case "openrouter": {
      const usage = openAiUsage(s);
      text.forEach((piece, index) => {
        sse(res, { choices: [{ delta: { content: piece } }] });
        if (index === 0) garbage.forEach(raw);
      });
      if (s.toolCall) {
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: s.toolCall.id, function: { name: s.toolCall.name, arguments: s.toolCall.args } }] } }] });
      }
      if (finish !== undefined) sse(res, { choices: [{ delta: {}, finish_reason: finish }] });
      if (usage) sse(res, { choices: [], usage });
      if (finish !== undefined) res.write("data: [DONE]\n\n");
      late.forEach((piece) => sse(res, { choices: [{ delta: { content: piece } }] }));
      return;
    }
    case "anthropic": {
      const usage = anthropicUsage(s);
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: usage ? { input_tokens: USAGE.input } : {} } })}\n\n`);
      text.forEach((piece, index) => {
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } })}\n\n`,
        );
        if (index === 0) garbage.forEach(raw);
      });
      if (finish !== undefined) {
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: finish }, ...(usage && { usage: { output_tokens: USAGE.output } }) })}\n\n`,
        );
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      }
      late.forEach((piece) =>
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } })}\n\n`),
      );
      return;
    }
    case "google": {
      const usage = googleUsage(s);
      text.forEach((piece, index) => {
        ndjson(res, { candidates: [{ content: { parts: [{ text: piece }] } }] });
        if (index === 0) garbage.forEach(raw);
      });
      // The final chunk of a real stream carries the finish reason and usage; the adapter does not read them.
      ndjson(res, {
        candidates: [{ content: { parts: [] }, ...(finish !== undefined && { finishReason: finish }) }],
        ...(usage && { usageMetadata: usage }),
      });
      late.forEach((piece) => ndjson(res, { candidates: [{ content: { parts: [{ text: piece }] } }] }));
      return;
    }
    case "ollama": {
      text.forEach((piece, index) => {
        ndjson(res, { response: piece, done: false });
        if (index === 0) garbage.forEach(raw);
      });
      if (finish !== undefined) ndjson(res, { response: "", done: true, done_reason: finish });
      late.forEach((piece) => ndjson(res, { response: piece, done: false }));
      return;
    }
  }
}

/**
 * Where a request goes: the provider it targets and the model (scenario) it names.
 * @param {string} url
 * @param {Record<string, any>} body
 * @returns {{ provider: ProviderId, model: string, stream: boolean } | undefined}
 */
function route(url, body) {
  const path = new URL(url, "http://mock").pathname;
  const match = /^\/(openai|openrouter|anthropic|google|ollama)(\/.*)$/.exec(path);
  if (!match) return undefined;
  const provider = /** @type {ProviderId} */ (match[1]);
  const rest = match[2];
  switch (provider) {
    case "openai":
    case "openrouter":
      return rest === "/chat/completions" ? { provider, model: String(body.model), stream: body.stream === true } : undefined;
    case "anthropic":
      return rest === "/messages" ? { provider, model: String(body.model), stream: body.stream === true } : undefined;
    case "google": {
      const google = /^\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(rest);
      return google ? { provider, model: decodeURIComponent(google[1]), stream: google[2] === "streamGenerateContent" } : undefined;
    }
    case "ollama":
      return rest === "/api/generate" ? { provider, model: String(body.model), stream: body.stream === true } : undefined;
  }
}

/**
 * @param {Record<string, Scenario>} scenarios
 * @returns {Promise<{
 *   base: (provider: ProviderId) => string,
 *   deadBase: (provider: ProviderId) => string,
 *   requests: Seen[],
 *   close: () => Promise<void>,
 * }>}
 */
export async function startProviderMocks(scenarios) {
  /** @type {Seen[]} */
  const requests = [];

  const server = http.createServer((req, res) => {
    let rawBody = "";
    req.on("data", (piece) => (rawBody += piece));
    req.on("end", () => {
      /** @type {Record<string, any>} */
      let body = {};
      try {
        body = JSON.parse(rawBody || "{}");
      } catch {
        body = {};
      }
      const target = route(req.url ?? "", body);
      if (!target) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: `no mock route for ${req.url}` } }));
      }
      const scenario = scenarios[target.model];
      /** @type {Seen} */
      const seen = {
        provider: target.provider,
        scenario: target.model,
        stream: target.stream,
        path: new URL(req.url ?? "", "http://mock").pathname,
        body,
        headers: {
          authorization: req.headers.authorization,
          "x-api-key": /** @type {string | undefined} */ (req.headers["x-api-key"]),
        },
        closed: false,
      };
      requests.push(seen);
      res.on("close", () => {
        if (!res.writableEnded) seen.closed = true;
      });
      if (!scenario) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: `unknown scenario ${target.model}` } }));
      }

      if (scenario.before === "hang") {
        res.writeHead(200, { "Content-Type": target.stream ? "text/event-stream" : "application/json" });
        return; // headers sent, nothing else
      }
      if (scenario.before === "reset") {
        req.socket.destroy();
        return;
      }
      if (scenario.http) {
        const { status, headers = {}, body: errorBody, message = "mock failure" } = scenario.http;
        res.writeHead(status, { "Content-Type": errorBody === undefined ? "application/json" : "text/html", ...headers });
        return res.end(errorBody ?? (target.provider === "ollama" ? JSON.stringify({ error: message }) : JSON.stringify({ error: { message } })));
      }

      if (!target.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(collectedBody(target.provider, scenario));
      }

      res.writeHead(200, { "Content-Type": target.provider === "google" || target.provider === "ollama" ? "application/x-ndjson" : "text/event-stream" });
      if (scenario.empty === "zero-bytes") return res.end();
      writeStream(target.provider, scenario, res);
      switch (scenario.tail ?? "end") {
        case "end":
          return res.end();
        case "hang":
          return;
        case "reset":
          return void setTimeout(() => req.socket.destroy(), 20);
        case "drip": {
          // Keep producing after the client may have gone: late events a host must not surface.
          const timer = setInterval(() => {
            if (res.destroyed || res.writableEnded) return clearInterval(timer);
            writeStream(target.provider, { text: ["late "], finish: "none" }, res);
          }, 10);
          res.on("close", () => clearInterval(timer));
          return;
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${address.port}`;

  // A port that was open a moment ago and is now closed: connection refused, deterministically.
  const dead = http.createServer();
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", () => resolve(undefined)));
  const deadPort = /** @type {import("node:net").AddressInfo} */ (dead.address()).port;
  await new Promise((resolve) => dead.close(() => resolve(undefined)));
  const deadOrigin = `http://127.0.0.1:${deadPort}`;

  /** @type {(origin: string, provider: ProviderId) => string} */
  const baseFor = (root, provider) => {
    switch (provider) {
      case "openai":
      case "openrouter":
        return `${root}/${provider}`;
      case "anthropic":
        return `${root}/anthropic`;
      case "google":
        return `${root}/google`;
      case "ollama":
        return `${root}/ollama`;
    }
  };
  return {
    base: (provider) => baseFor(origin, provider),
    deadBase: (provider) => baseFor(deadOrigin, provider),
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
