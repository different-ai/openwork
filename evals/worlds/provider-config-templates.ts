import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import type { Seed } from "@openwork/env";
import { bootManagedOpenworkServer, close, isRecord, listen, readBody, sendJson, sendStream } from "./openwork-server-cli.ts";

const key = "synthetic-template-provider-key";
const answer = "The configured provider answered.";
const model = "fixture-model";
const legacyShapes = ["compatible-options", "compatible-api", "azure-options", "azure-api"];

/** Real managed V2, real local env/config APIs, deterministic Den legacy wire
 * inventory and inference. No renderer state, paid provider or engine config stub. */
export async function providerConfigTemplates(seed: Seed) {
  const scratch = seed.tmpPath("provider-config-templates");
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  const requests: { path: string; bearer: boolean; azure: boolean; model: unknown }[] = [];
  let origin = "";
  const legacy = () => legacyShapes.map(shape => ({
    id: `lpr_fixture_${shape.replaceAll("-", "_")}`, providerId: shape, source: "custom", name: shape,
    providerConfig: { npm: shape.startsWith("azure") ? "@ai-sdk/azure" : "@ai-sdk/openai-compatible", env: ["FIXTURE_API_KEY"],
      ...(shape.endsWith("options") ? { options: { baseURL: origin + (shape.startsWith("azure") ? "/openai/v1" : "/v1") } }
        : { api: origin + (shape.startsWith("azure") ? "/openai/v1" : "/v1") }) },
    models: [{ id: model, name: shape, config: { tool_call: true, limit: { context: 32000, output: 1024 } } }],
  }));
  const remoteBlocked = ["lpr_fixture_remote-env", "lpr_fixture_remote-file", "lpr_fixture_remote-other"];
  await writeFile(join(scratch, "outside-sentinel"), "synthetic-private-file", { mode: 0o600 });
  const inventory = () => [...legacy(), {
    id: "lpr_fixture_remote-stored", providerId: "lpr_fixture_remote-stored", source: "custom", name: "Stored user endpoint",
    providerConfig: { npm: "@ai-sdk/openai-compatible", env: ["FIXTURE_API_KEY", "TEMPLATE_PROVIDER_URL"], options: { baseURL: "{env:TEMPLATE_PROVIDER_URL}" } },
    models: [{ id: model, name: "Stored user endpoint", config: { tool_call: true, limit: { context: 32000, output: 1024 } } }],
  }, ...remoteBlocked.map(id => ({
    id, providerId: id, source: "custom", name: id,
    providerConfig: { npm: "@ai-sdk/openai-compatible", env: ["FIXTURE_API_KEY", "OTHER_PROVIDER_API_KEY"], options: id.endsWith("env")
      ? { baseURL: `${origin}/v1/{env:PROCESS_ONLY_PROVIDER_SECRET}` }
      : id.endsWith("other") ? { baseURL: `${origin}/v1/{env:OTHER_PROVIDER_API_KEY}` }
      : { baseURL: `${origin}/v1`, apiKey: `{file:${join(scratch, "outside-sentinel")}}` } },
    models: [{ id: model, name: id, config: { tool_call: true, limit: { context: 32000, output: 1024 } } }],
  }))];
  const mock = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/v1/llm-providers") return sendJson(response, 200, { llmProviders: inventory() });
    const provider = inventory().find(p => url.pathname === `/v1/llm-providers/${p.id}/connect`);
    if (provider) return sendJson(response, 200, { llmProvider: { ...provider,
      ...(provider.id === "lpr_fixture_remote-stored" ? { apiKey: null, apiKeys: { FIXTURE_API_KEY: key, TEMPLATE_PROVIDER_URL: `${origin}/v1` } } : { apiKey: key }),
    } });
    if (url.pathname === "/v1/inference-providers") return sendJson(response, 200, { inferenceProviders: [] });
    if (!url.pathname.endsWith("/chat/completions") && !url.pathname.endsWith("/responses")) return sendJson(response, 404, { error: "not_found" });
    const raw = await readBody(request);
    const body: unknown = raw ? JSON.parse(raw) : {};
    const selectedModel = isRecord(body) ? body.model : undefined;
    requests.push({ path: url.pathname, bearer: request.headers.authorization === `Bearer ${key}`, azure: request.headers["api-key"] === key, model: selectedModel });
    if (url.pathname.endsWith("/chat/completions")) return sendStream(response, [
      { id: "chatcmpl-fixture", object: "chat.completion.chunk", model: selectedModel, choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] },
      { id: "chatcmpl-fixture", object: "chat.completion.chunk", model: selectedModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]);
    if (url.pathname.endsWith("/responses")) {
      const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] };
      const completed = { id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: selectedModel, output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const [sequence_number, event] of [
        { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: answer },
        { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: answer },
        { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: completed },
      ].entries()) response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
      response.end(); return;
    }
    sendJson(response, 404, { error: "unexpected_fixture_request" });
  });
  origin = await listen(mock);
  let managed: Awaited<ReturnType<typeof bootManagedOpenworkServer>> | undefined;
  const token = "fixture-local-owner";
  try {
    managed = await bootManagedOpenworkServer({ scratch, workspace, token, sink: () => undefined,
      env: { OPENWORK_ENGINE_V2_PREVIEW: "chat", OPENWORK_DISABLE_FREE_INFERENCE: "1", PROCESS_ONLY_PROVIDER_SECRET: "synthetic-process-private",
        ...(process.env.OPENWORK_TEST_OPENCODE2 ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_TEST_OPENCODE2 } : {}) } });
    const call = async (path: string, method = "GET", body?: unknown, host = true) => {
      const response = await fetch(`${managed?.base}${path}`, { method,
        headers: { authorization: `Bearer ${token}`, ...(host ? { "x-openwork-host-token": `${token}-host` } : {}), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
      const text = await response.text();
      if (!response.ok) throw new Error(`Provider fixture ${method} ${path}: HTTP ${response.status}`);
      const json: unknown = text ? JSON.parse(text) : {};
      return isRecord(json) ? json : {};
    };
    // The helper waits for v1 readiness. A cold Linux runner can still be
    // downloading or starting v2, so wait for that prerequisite before sync.
    const bootDeadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < bootDeadline) {
      const status = await call("/experimental/engine-v2-preview/status");
      if (status.running === true) { ready = true; break; }
      if (status.lastError) throw new Error("The fixture's native v2 engine failed to start");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("The fixture's native v2 engine did not become ready within 90 seconds");
    await call("/den-session", "PUT", { baseUrl: origin, token: "synthetic-den-session", orgId: "org_fixture" });
    const sync = await call("/cloud-provider-sync/run", "POST", { reason: "manual" });
    if (sync.status === "failed") throw new Error(`Fixture Den sync failed: ${String(sync.message)}`);
    await call("/env", "PUT", { entries: [{ key: "TEMPLATE_PROVIDER_URL", value: `${origin}/v1` }, { key: "TEMPLATE_PROVIDER_API_KEY", value: key }, { key: "OTHER_PROVIDER_API_KEY", value: "synthetic-unrelated-private" }] });
    const local = (options: Record<string, unknown>) => ({ npm: "@ai-sdk/openai-compatible", env: ["TEMPLATE_PROVIDER_API_KEY"], options,
      models: { [model]: { name: "Local model", tool_call: true, limit: { context: 32000, output: 1024 } } } });
    const patch = await call("/runtime-config/providers", "PATCH", { provider: {
      "fixture-env": local({ baseURL: "{env:TEMPLATE_PROVIDER_URL}", apiKey: "{env:TEMPLATE_PROVIDER_API_KEY}" }),
      "fixture-mutated": local({ baseURL: `${origin}/v1`, apiKey: "{env:TEMPLATE_PROVIDER_API_KEY}" }),
      "fixture-missing": local({ baseURL: "{env:MISSING_PROVIDER_ENDPOINT}", apiKey: "{env:TEMPLATE_PROVIDER_API_KEY}" }),
    } });
    if (typeof patch.runtimeConfigPath !== "string") throw new Error("Missing runtime config path");
    const configDirectory = dirname(patch.runtimeConfigPath);
    await writeFile(join(configDirectory, "fixture-endpoint"), `${origin}/v1\n`, { mode: 0o600 });
    await writeFile(join(configDirectory, "fixture-key"), `${key}\n`, { mode: 0o600 });
    await call("/runtime-config/providers", "PATCH", { provider: {
      "fixture-file": local({ baseURL: "{file:fixture-endpoint}", apiKey: "{file:fixture-key}" }),
    } });
    // This collaborator-capable route can change global providers but must not
    // grant machine ownership, including when it reuses an approved local ID.
    const untrusted = local({ baseURL: `${origin}/v1/{env:PROCESS_ONLY_PROVIDER_SECRET}`, apiKey: "{env:TEMPLATE_PROVIDER_API_KEY}" });
    await call(`/workspace/${managed.workspaceId}/config`, "PATCH", { opencode: { provider: {
      "fixture-collaborator": untrusted, "fixture-mutated": untrusted,
    } } }, false);
    const blocked = [...remoteBlocked, "fixture-collaborator", "fixture-mutated"];
    const mount = `/workspace/${managed.workspaceId}/opencode2/api`;
    const ids = ["fixture-env", "fixture-file", "lpr_fixture_remote-stored", ...legacy().map(p => p.id)];
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const status = await call("/experimental/engine-v2-preview/status");
      const mirrored = Array.isArray(status.mirroredProviderIds) ? status.mirroredProviderIds : [];
      const skipped = Array.isArray(status.skippedProviderIds) ? status.skippedProviderIds : [];
      if (status.running === true && ids.every(id => mirrored.includes(id) || skipped.includes(id))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return {
      ids, model, answer, key, blocked, legacyIds: legacy().map(provider => provider.id),
      status: () => call("/experimental/engine-v2-preview/status"),
      catalog: () => call(`${mount}/model`),
      async chat(providerId: string) {
        const before = requests.length;
        const created = await call(`${mount}/session`, "POST", { title: "Configured model" });
        const id = isRecord(created.data) && typeof created.data.id === "string" ? created.data.id : null;
        if (!id) throw new Error("Native session was not created");
        await call(`${mount}/session/${id}/model`, "POST", { model: { providerID: providerId, id: model } });
        await call(`${mount}/session/${id}/prompt`, "POST", { text: "Say hello" });
        let messages = await call(`${mount}/session/${id}/message`);
        const until = Date.now() + 30_000;
        while (Date.now() < until && !JSON.stringify(messages).includes(answer) && !JSON.stringify(messages).includes('"outcome":"failed"')) {
          await new Promise(resolve => setTimeout(resolve, 100)); messages = await call(`${mount}/session/${id}/message`);
        }
        const status = await call("/experimental/engine-v2-preview/status");
        const skipped = Array.isArray(status.skippedProviderIds) && status.skippedProviderIds.includes(providerId);
        return { messages, requests: requests.slice(before), answered: JSON.stringify(messages).includes(answer), skipped, diagnostic: status.lastError, mirrored: status.mirroredProviderIds };
      },
      async [Symbol.asyncDispose]() { await managed?.stop(); await close(mock); await rm(scratch, { recursive: true, force: true }); },
    };
  } catch (error) {
    await managed?.stop(); await close(mock); await rm(scratch, { recursive: true, force: true }); throw error;
  }
}
