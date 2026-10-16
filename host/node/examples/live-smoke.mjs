// @ts-check
// OPTIONAL live smoke test. It spends real tokens against a real provider and is never run
// by CI. It refuses to run unless you opt in explicitly:
//
//   FX_LIVE_SMOKE=1 OPENAI_API_KEY=... FX_LIVE_MODEL=gpt-4o-mini npm run example:live
//
// The key is read here, in the example, and handed to Easy-LLM's adapter. The host package
// itself never reads credentials or the environment.

import * as easyLlm from "@easy-llm/llm";

import { createFxRuntime } from "../src/index.js";

if (process.env.FX_LIVE_SMOKE !== "1") {
  process.stderr.write("live smoke test skipped: set FX_LIVE_SMOKE=1 to run it (this calls a real provider and costs tokens)\n");
  process.exit(0);
}
const key = process.env.OPENAI_API_KEY;
const model = process.env.FX_LIVE_MODEL;
if (!key || !model) {
  process.stderr.write("set OPENAI_API_KEY and FX_LIVE_MODEL to run the live smoke test\n");
  process.exit(2);
}

const runtime = await createFxRuntime({ easyLlm });
const provider = easyLlm.createOpenAIAdapter(key, process.env.FX_LIVE_BASE_URL);
const result = await runtime.execute(
  {
    v: 1,
    model,
    messages: [{ role: "user", parts: [{ type: "text", text: "Reply with the single word: ready" }] }],
    correlation: { request_id: "00112233445566778899aabbccddeeff" },
    budget_ms: 30_000,
  },
  { provider, mode: "stream" },
);
process.stdout.write(`${JSON.stringify(result.report.outcome, null, 2)}\n`);
process.stdout.write(`host ${JSON.stringify(result.host)}\n`);
process.exit(result.report.outcome.type === "completed" ? 0 : 1);
