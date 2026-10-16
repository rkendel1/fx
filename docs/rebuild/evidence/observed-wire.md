# Observed wire behavior of the built binary

Captured on 2026-10-16 from `./zig-out/bin/fx` built at commit `255c6cf` (Debug), using the loopback fake in [../tools/fake_gateway.py](../tools/fake_gateway.py). Credentials were the placeholder string `placeholder`; the fake records only whether an `Authorization` header was present. Session identifiers are omitted.

This is the strongest form of evidence in the decomposition: it shows what the binary actually sends and accepts, independently of what the source appears to do.

## Reproduce

```bash
python3 docs/rebuild/tools/fake_gateway.py 43197 /tmp/wire.jsonl tool &
cd "$(mktemp -d)" && echo hello > a.txt
HOME=$(mktemp -d) AI_GATEWAY_API_KEY=placeholder \
  FX_GATEWAY_BASE_URL=http://127.0.0.1:43197 \
  FX_GATEWAY_CHAT_URL=http://127.0.0.1:43197/v3/ai/language-model \
  /path/to/repo/zig-out/bin/fx ask --json "list files"
```

`FX_GATEWAY_CHAT_URL` is honored only because it is loopback HTTP with an explicit port (`src/builtins/gateway.zig:752-758`, `src/gateway/client.zig:1779-1795`). A non-loopback override is silently replaced by `https://ai-gateway.vercel.sh/v3/ai/language-model`.

## Result

stdout (one JSON object, schema from `src/core/cli/cli_ask.zig:3433-3518`):

```json
{"output":"hello from fake","exit_code":0,"model":"zai/glm-5.2","session_id":"<omitted>","steps":1,"tool_calls":[{"name":"list_files","status":"success"}]}
```

stderr carried ANSI tool-progress lines (`● Listing .`), which is the documented behavior of JSON mode (progress on stderr, parseable stdout).

Two POST requests reached the fake, both to `/v3/ai/language-model`, both with an `Authorization` header.

## Request headers (both requests)

```json
{
  "user-agent": "fx/0.0.4",
  "content-type": "application/json",
  "HTTP-Referer": "https://github.com/vercel-labs/fx",
  "X-Title": "fx",
  "ai-gateway-protocol-version": "0.0.1",
  "ai-language-model-specification-version": "4",
  "ai-language-model-id": "zai/glm-5.2",
  "ai-language-model-streaming": "true",
  "x-session-id": "<session id>",
  "x-session-affinity": "<same session id>"
}
```

No `x-vercel-ai-gateway-team` header was sent because the placeholder credential carries no team (`src/gateway/client.zig:1459-1494`).

## Request body shape

Top-level keys: `prompt`, `tools`, `toolChoice`, `headers`.

- `headers: {"user-agent":"fx/0.0.4"}` inside the body appears only because the model is `zai/glm-5.2` (`finalizeAgentRequestBody`, `src/builtins/gateway.zig:258-273`).
- `toolChoice: {"type":"auto"}`.
- `tools`: 26 entries. 25 are `{"type":"function","name","description","inputSchema"}`; one is a provider-executed tool:

  ```json
  {"type":"provider","id":"gateway.perplexity_search","name":"perplexity_search","args":{"maxResults":10,"maxTokens":4096}}
  ```

  Tool names in advertisement order: `read_file, glob_files, grep_files, list_files, file_info, semantic_search, edit_file, write_file, delete_file, rename_file, copy_file, create_folder, terminal, subagent, skill, install_skill, mcp_search_tools, mcp_select_tool, mcp_features, memory, ask_user_question, open_file, web_fetch, perplexity_search, read_tool_result, vision`.
- `prompt`: seven `{"role":"system","content":"<string>"}` messages (5,451 / 440 / 89 / 248 / 509 / 790 / 62 bytes in an empty workspace; the third grows to about 25 KB inside this repository because it carries project instructions), followed by the conversation:

```json
{"role":"user","content":[{"type":"text","text":"list files"}]}
```

Second request, after the tool round trip, appends:

```json
{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_1","toolName":"list_files","input":{"path":"."}}]}
{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_1","toolName":"list_files","output":{"type":"text","value":".:\n- a.txt\n"}}]}
```

This is the Vercel AI SDK `LanguageModelV3` prompt format (specification version 4), served by Vercel AI Gateway at `/v3/ai/language-model`. It is **not** the OpenAI chat-completions format. The `parseGatewayCompletion` parser for `choices[0].message.tool_calls` in `src/core/gateway/gateway_json.zig:762-842` has no production caller.

## Stream accepted

The fake answered the first request with:

```text
data: {"type":"tool-input-start","id":"call_1","toolName":"list_files"}
data: {"type":"tool-input-delta","id":"call_1","delta":"{\"path\":\".\"}"}
data: {"type":"tool-input-end","id":"call_1"}
data: {"type":"tool-call","toolCallId":"call_1","toolName":"list_files","input":"{\"path\":\".\"}"}
data: {"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool_calls"},"usage":{"inputTokens":{"total":20},"outputTokens":{"total":5}}}
data: [DONE]
```

and the second with `stream-start`, `text-start`, `text-delta`, `text-end`, `finish` (`unified:"stop"`), `[DONE]`. Both were accepted. Notes:

- `input` arrived as a JSON **string** and was re-sent in history as a JSON **object**: fx normalizes argument representation (`client.zig:2966-3080`).
- `finish` is the authoritative terminal event; fx returns on it without waiting for `[DONE]` (`client.zig:3205-3233`, test `consumeSseStream returns immediately after valid finish without waiting for done`).
- The proposal (`tool-call`) was executed only after fx's own admission and permission pipeline (auto mode, read-only tool). The model output was treated as a proposal, consistent with the target principle.

## What this evidence pins down for the rebuild

1. The current inference contract on the wire is AI SDK `LanguageModelV3`. Any replacement must preserve the *semantics* listed above (roles, part kinds, provider-executed tools, finish vocabulary, usage) but not this encoding, which belongs to the provider boundary.
2. `fx ask --json` already works end-to-end against a deterministic loopback fake, so conformance and regression fixtures need no paid model or Vercel account.
3. Credential delivery, model naming (`provider/model` slugs), attribution headers and session-affinity headers are all transport concerns that FX currently owns and Easy-LLM must own after the rebuild.
