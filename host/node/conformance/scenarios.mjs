// @ts-check
// The provider behaviors the mock server can play, by name. A request names its scenario as
// the model. Each scenario is rendered in every provider's own wire format by
// mock-providers.mjs, so one name means "the same situation" on all five endpoints.

/** @typedef {import("./mock-providers.mjs").Scenario} Scenario */

/** @type {Record<string, Scenario>} */
export const SCENARIOS = {
  // A complete answer in two deltas, with the provider's natural finish and usage 5/2.
  ok: { text: ["Hello ", "world"], finish: "natural", usage: "ok" },
  // The same answer, but the provider reports a different finish reason.
  length: { text: ["cut"], finish: "length" },
  filter: { text: ["x"], finish: "filter" },
  unknown: { text: ["x"], finish: "unknown" },
  // The provider says it stopped to call tools, but returns no tool call.
  "claims-tools": { text: ["x"], finish: "tools" },
  // A successful response that carries no bytes, and one that carries only a terminal marker.
  "empty-body": { empty: "zero-bytes" },
  "empty-terminal": { text: [], finish: "natural" },
  // The stream (or response) ends with output but without any terminal evidence.
  "no-finish": { text: ["cut ", "off"], finish: "none" },
  // A collected response that parses but is not a response: no choices, no content, no reason.
  "wrong-shape": { json: "{}" },
  // A collected response that is not JSON at all.
  "not-json": { json: "{not json" },
  // Unparseable lines in the middle of a stream that otherwise completes.
  garbage: { text: ["a ", "b"], finish: "natural", garbage: ["data: {nope", "zzz"] },
  // Text written after the provider's terminal marker.
  late: { text: ["a "], finish: "natural", late: ["LATE"] },
  // Usage metadata: absent, partly invalid, invalid.
  "usage-none": { text: ["a"], finish: "natural" },
  "usage-partial": { text: ["a"], finish: "natural", usage: "partial" },
  "usage-invalid": { text: ["a"], finish: "natural", usage: "malformed" },
  // A provider that returns a tool call although the request offered none.
  "tool-call": { text: ["a"], finish: "natural", toolCall: { id: "call_1", name: "rm", args: '{"path":"/"}' } },
  // HTTP errors.
  "http-401": { http: { status: 401, message: "bad key" } },
  "http-403": { http: { status: 403, message: "no access" } },
  "http-404": { http: { status: 404, message: "no such model" } },
  "http-429": { http: { status: 429, headers: { "Retry-After": "3" }, message: "slow down" } },
  "http-429-bad-retry": { http: { status: 429, headers: { "Retry-After": "soon" }, message: "slow down" } },
  "http-429-no-retry": { http: { status: 429, message: "slow down" } },
  // The category must come from the status, never from words in the message.
  "http-500": { http: { status: 500, message: "rate limit exceeded 429 unauthorized 401" } },
  "http-502-html": { http: { status: 502, body: "<html>bad gateway</html>" } },
  // Connection behavior.
  "reset-before-response": { before: "reset" },
  "reset-mid-stream": { text: ["part "], finish: "none", tail: "reset" },
  hang: { before: "hang" },
  // A stream that stops producing: the client must give up, and what the server writes afterwards must not surface.
  drip: { text: ["Hello "], finish: "none", tail: "drip" },
};
