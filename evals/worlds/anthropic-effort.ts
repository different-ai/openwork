import { createServer } from "node:http";
import { catalogModelVariants } from "@openwork/types/cloud-model-fast";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { close, isRecord, listen, readBody } from "./openwork-server-cli.ts";

/** Real app and pinned engine; only the Anthropic HTTP endpoint is synthetic. */
export async function anthropicEffort(seed: Seed) {
  await using setup = new AsyncDisposableStack();
  const engine = resolveEvalEngine();
  const requests: { model: unknown; effort: unknown }[] = [];
  const prompt = "EFFORT_WITNESS: Reply with Effort received.";
  const providerId = "gateway-anthropic";
  const modelId = "gateway-model-1";
  const witness = createServer((request, response) => {
    void (async () => {
      const body: unknown = JSON.parse(await readBody(request));
      if (!isRecord(body)) throw new Error("Expected Anthropic request object");
      if (Array.isArray(body.tools) && body.tools.length && JSON.stringify(body.messages).includes("EFFORT_WITNESS")) {
        requests.push({ model: body.model, effort: isRecord(body.output_config) ? body.output_config.effort : null });
      }
      const message = { id: "msg_effort_witness", type: "message", role: "assistant", model: modelId,
        content: [{ type: "text", text: "Effort received." }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4 } };
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(message));
        return;
      }
      const events = [
        { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Effort received." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
        { type: "message_stop" },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    })().catch(error => { response.writeHead(500); response.end(String(error)); });
  });
  const url = await listen(witness);
  setup.defer(() => close(witness));
  const mock = seed.mock({ isolatedProcessEnv: true });
  const workspacePath = seed.tmpPath("anthropic-effort");
  const app = await seed.appWeb({ name: "anthropic-effort", workspacePath, mocks: { agent: mock } });
  const workspace = await seed.workspace(app, workspacePath);
  const config = { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }] };
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, { provider: { [providerId]: {
    npm: "@ai-sdk/anthropic", name: "Anthropic gateway",
    options: { baseURL: `${url}/v1`, apiKey: "synthetic-anthropic-key" },
    models: { [modelId]: { name: "Claude Opus 5.5", reasoning: true,
      variants: catalogModelVariants(config, "@ai-sdk/anthropic") } },
  } } }, engine);
  const session = await seed.session(app, { title: "Anthropic effort" });
  const resources = setup.move();
  return { app, engine, session, prompt, providerId, modelId, requests: () => [...requests],
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
}
