// @ts-check
// Pure translation between FX documents and Easy-LLM single-attempt values.
//
// No state, no I/O. The meaning of each field is defined by fx-core (the FX side) and by
// Easy-LLM's documented single-attempt API (the provider side); this file only maps names.

/**
 * @typedef {import("@easy-llm/llm").SingleAttemptRequest} SingleAttemptRequest
 * @typedef {import("@easy-llm/llm").SingleAttemptResult} SingleAttemptResult
 * @typedef {import("@easy-llm/llm").SingleAttemptStreamEvent} StreamEvent
 * @typedef {import("@easy-llm/llm").SingleAttemptFailure} Failure
 * @typedef {import("@easy-llm/llm").SingleAttemptToolCall} ToolCall
 * @typedef {import("@easy-llm/llm").LLMUsage} Usage
 */

/**
 * Builds the Easy-LLM request from a canonical, already validated FX request document.
 * Only text parts reach here: anything else was refused before the provider was invoked.
 * @param {any} doc the canonical request returned by the session
 * @param {AbortSignal} signal
 * @param {number | null | undefined} timeoutMs the FX attempt budget
 * @returns {SingleAttemptRequest}
 */
export function toSingleAttemptRequest(doc, signal, timeoutMs) {
  return {
    model: doc.model,
    messages: doc.messages.map((/** @type {any} */ message) => {
      const parts = message.parts.map((/** @type {any} */ part) => ({ type: "text", text: String(part.text) }));
      return {
        role: message.role,
        content: parts.length === 1 ? parts[0].text : parts,
      };
    }),
    signal,
    ...(typeof timeoutMs === "number" && { timeoutMs }),
  };
}

/**
 * @param {Usage | undefined} usage
 * @returns {Record<string, number> | undefined}
 */
function usageDoc(usage) {
  if (!usage) return undefined;
  /** @type {Record<string, number>} */
  const doc = {};
  if (usage.inputTokens !== undefined) doc.input_tokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) doc.output_tokens = usage.outputTokens;
  if (usage.cachedInputTokens !== undefined) doc.cache_read_tokens = usage.cachedInputTokens;
  if (usage.reasoningTokens !== undefined) doc.reasoning_tokens = usage.reasoningTokens;
  return Object.keys(doc).length > 0 ? doc : undefined;
}

/**
 * @param {Failure} failure
 * @returns {Record<string, unknown>} a protocol failure document
 */
export function failureDoc(failure) {
  return {
    kind: failure.kind,
    message: failure.message,
    observed: failure.delivery,
    ...(failure.status !== undefined && { status: failure.status }),
    ...(failure.retryAfterMs !== undefined && { retry_after_ms: failure.retryAfterMs }),
  };
}

/**
 * @param {ToolCall} call
 * @returns {Record<string, unknown>}
 */
function toolCallItem(call) {
  return {
    type: "tool_call",
    id: call.id,
    name: call.name,
    ...(call.argumentsJson !== undefined && { arguments_json: call.argumentsJson }),
  };
}

/**
 * The provider's results as a flat list of events, whichever call produced them. A
 * streamed attempt yields them one at a time; a collected attempt yields them at once.
 * @param {SingleAttemptResult} result
 * @returns {StreamEvent[]}
 */
export function resultToEvents(result) {
  if (!result.ok) return [{ type: "failed", ...result }];
  /** @type {StreamEvent[]} */
  const events = [];
  if (result.text !== "") events.push({ type: "text", text: result.text });
  for (const toolCall of result.toolCalls) events.push({ type: "tool_call", toolCall, issues: [] });
  const { ok: _ok, model, ...rest } = result;
  // A collected response is complete evidence only when the provider named a finish reason.
  // Without one the response could be anything that parsed (an empty object, a wrong shape),
  // and a finish is not invented for it: the executor reports an interrupted attempt.
  const terminal = result.finishReason !== undefined ? "provider_marker" : "unverified";
  events.push({ type: "done", ...rest, model, terminal });
  return events;
}

/**
 * Turns provider events into protocol commands, in order. Output before a failure is
 * fed first, so the executor sees the partial output the failure interrupted.
 * @param {StreamEvent[]} events
 * @returns {Record<string, unknown>[]}
 */
export function eventsToCommands(events) {
  /** @type {Record<string, unknown>[]} */
  const commands = [];
  /** @type {Record<string, unknown>[]} */
  let items = [];
  let ended = false;
  const flush = () => {
    if (items.length > 0 || ended) commands.push({ cmd: "feed", items, observed: "output_observed", ended });
    items = [];
    ended = false;
  };
  for (const event of events) {
    switch (event.type) {
      case "text":
        items.push({ type: "text", text: event.text });
        break;
      case "tool_call":
        items.push(toolCallItem(event.toolCall));
        break;
      case "done": {
        const usage = usageDoc(event.usage);
        items.push({
          type: "done",
          terminal: event.terminal === "provider_marker" ? "provider_marker" : "unverified",
          ...(usage && { usage }),
          ...(event.finishReason !== undefined && { finish_reason: event.finishReason }),
          ...("model" in event && typeof event.model === "string" && { model: event.model }),
        });
        ended = true;
        flush();
        break;
      }
      case "failed":
        flush();
        commands.push({ cmd: "feed_failure", failure: failureDoc(event.failure) });
        break;
    }
  }
  flush();
  return commands;
}
