// @ts-check
// A reproducible run of the whole path with a real Easy-LLM provider adapter:
//
//   FX request -> Rust executor (WebAssembly) -> Easy-LLM streamOnce -> the OpenAI adapter
//   -> a real HTTP request to a local mock endpoint -> the normalized FX outcome
//
// No credentials and no network are needed. The provider is chosen explicitly below; the
// runtime never routes. Run it with:   npm run build:wasm && npm install && npm run example:mock

import * as easyLlm from "@easy-llm/llm";

import { createFxRuntime } from "../src/index.js";
import { startMockServer } from "./mock-server.mjs";

const server = await startMockServer();
try {
  const runtime = await createFxRuntime({ easyLlm });

  // The provider is constructed by the caller. Its key never enters the FX request or report.
  const provider = easyLlm.createOpenAIAdapter("sk-mock-key-not-a-secret", server.url);

  const request = {
    v: 1,
    model: "gpt-mock",
    messages: [{ role: "user", parts: [{ type: "text", text: "Say hello." }] }],
    correlation: { request_id: "00112233445566778899aabbccddeeff" },
  };

  const result = await runtime.execute(request, {
    provider,
    mode: "stream",
    onEvent: (event) => process.stdout.write(`event  ${JSON.stringify(event)}\n`),
  });

  process.stdout.write(`\noutcome  ${JSON.stringify(result.report.outcome)}\n`);
  process.stdout.write(`terminal ${JSON.stringify(result.report.diagnostics.terminal)}\n`);
  process.stdout.write(`counts   starts=${result.report.diagnostics.starts} polls=${result.report.diagnostics.polls} closes=${result.report.diagnostics.closes}\n`);
  process.stdout.write(`host     ${JSON.stringify(result.host)}\n`);
  process.stdout.write(`http     ${server.requests.length} request(s) reached the endpoint\n`);
} finally {
  await server.close();
}
