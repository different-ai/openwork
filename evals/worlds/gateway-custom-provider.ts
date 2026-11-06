import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { Seed } from "@openwork/env";
import { gatewayEnvironment, startAcmeGateway } from "../../worlds/lib/acme-gateway.ts";
import { enableOrganizationCapabilities, seededOrganizationId } from "./organization-capabilities.ts";
import { isRecord } from "./library.ts";

/** Listed by the mock with OpenRouter-style details; models.dev's OpenRouter list has the same id. */
export const MATCHED_MODEL = "openai/gpt-4o-mini";
/** Listed with an id only and unknown to models.dev, so it needs settings. */
export const UNMATCHED_MODEL = "acme/house-reasoner-7";
/** Not listed: the admin adds it through the full settings form. */
export const CUSTOM_MODEL = "acme/house-chat-2";
/** Listed only after `listNewModel()`, for Re-fetch models on the manage screen. */
export const NEW_MODEL = "openai/gpt-4o";
export const MOCK_REPLY = "Acme OpenAI-compatible provider is working.";

/**
 * A deterministic OpenAI-compatible provider: `GET /v1/models` (OpenRouter
 * style, readable without a key like OpenRouter's) and
 * `POST /v1/chat/completions` (only with the one right Bearer key, 401
 * otherwise). Every completion request is recorded.
 */
async function startOpenAiCompatibleUpstream(stack: AsyncDisposableStack) {
  const key = `sk-acme-${randomUUID()}`;
  const completions: { model: string; authenticated: boolean }[] = [];
  const modelListRequests: { authenticated: boolean }[] = [];
  let newModelListed = false;
  const detailed = (id: string, name: string, context: number) => ({
    id, canonical_slug: id, name, created: 1_721_260_800, context_length: context,
    architecture: { modality: "text+image->text", input_modalities: ["text", "image"], output_modalities: ["text"] },
    pricing: { prompt: "0.00000015", completion: "0.0000006" },
    top_provider: { context_length: context, max_completion_tokens: 16_384, is_moderated: false },
    supported_parameters: ["tools", "tool_choice", "response_format", "temperature", "max_tokens"],
  });
  const upstream = createServer(async (request, response) => {
    try {
      const path = request.url?.split("?")[0];
      const authenticated = request.headers.authorization === `Bearer ${key}`;
      if (request.method === "GET" && path === "/v1/models") {
        modelListRequests.push({ authenticated });
        // A real provider takes a moment; long enough for the "Fetching models" line to be seen.
        await delay(1500);
        const data: unknown[] = [detailed(MATCHED_MODEL, "OpenAI: GPT-4o-mini", 128_000), { id: UNMATCHED_MODEL, object: "model", owned_by: "acme" }];
        if (newModelListed) data.push(detailed(NEW_MODEL, "OpenAI: GPT-4o", 128_000));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
        return;
      }
      if (request.method !== "POST" || path !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const model = isRecord(body) && typeof body.model === "string" ? body.model : "";
      completions.push({ model, authenticated });
      if (!authenticated) {
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }));
        return;
      }
      const id = `chatcmpl-${randomUUID()}`;
      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      if (isRecord(body) && body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: MOCK_REPLY }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id, object: "chat.completion", created: 1, model,
        choices: [{ index: 0, message: { role: "assistant", content: MOCK_REPLY }, finish_reason: "stop" }], usage,
      }));
    } catch { response.writeHead(400).end(); }
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  stack.defer(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("OpenAI-compatible upstream did not bind.");
  return { baseUrl: `http://127.0.0.1:${address.port}`, key, completions, modelListRequests, listNewModel() { newModelListed = true; } };
}

/**
 * Custom OpenAI-compatible providers in AI Gateway: a real Den (with
 * `gatewayCustomProviders` still off for the organization), a real AI Gateway,
 * and a mock OpenAI-compatible provider the operator allowlisted
 * (GATEWAY_EGRESS_ALLOWED_ORIGINS, read by both Den and the gateway). The
 * owner is signed in on AI Gateway › Add a provider; one member can use
 * whatever the owner shares with everyone.
 */
export async function gatewayCustomProviderWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startOpenAiCompatibleUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud" };
    const den = stack.use(await seed.den({ env, org: { name: "Custom provider proof", admin: { name: "Gateway owner" }, members: { member: { name: "Gateway member" } } } }));
    if (!den.database) throw new Error("The custom provider world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const organizationId = await seededOrganizationId(seed, den.admin);
    const member = den.members.member;
    if (!member) throw new Error("The custom provider world needs its member.");
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway/providers/new", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den,
      web,
      organizationId,
      upstream,
      /** Turns the feature on for the seeded organization, as OpenWork staff would in /admin. */
      enableCustomProviders: () => enableOrganizationCapabilities(seed, den.admin, { gatewayCustomProviders: true }, organizationId),
      /** Den's discovery route, as the signed-in owner (probe.api is read-only). */
      discover: (body: Record<string, unknown>) => seed.api(den.admin, "/v1/inference-providers/custom/discover-models", { method: "POST", body: JSON.stringify(body) }),
      providers: () => seed.api(den.admin, "/v1/inference-providers?scope=manageable"),
      /**
       * What a member's OpenWork does to chat with a shared model: fetch the
       * provider connection (issued Gateway key and models), then send one
       * OpenAI chat completion through AI Gateway with that key.
       */
      async memberChat(providerId: string, modelId: string, modelName: string) {
        const connected = await seed.api(member, `/v1/inference-providers/${providerId}/connect`);
        const provider = isRecord(connected.body) && isRecord(connected.body.inferenceProvider) ? connected.body.inferenceProvider : undefined;
        const apiKey = typeof provider?.apiKey === "string" ? provider.apiKey : "";
        const models = Array.isArray(provider?.models) ? provider.models.filter(isRecord) : [];
        // Members see Gateway aliases; the provider's own id is in the alias's saved config (or, failing that, its name).
        const model = models.find((entry) => Object.values(entry).includes(modelId) || (isRecord(entry.config) && entry.config.id === modelId)) ?? models.find((entry) => entry.name === modelName);
        if (!connected.response.ok || !apiKey || typeof model?.id !== "string") {
          return { connectStatus: connected.response.status, modelIds: models.map((entry) => `${String(entry.id)} (${String(entry.name)})`), status: 0, text: "" };
        }
        const response = await fetch(`${gateway.baseUrl}/api/v1/providers/${providerId}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: model.id, max_tokens: 32, messages: [{ role: "user", content: "Say hello from the custom provider." }] }),
          signal: AbortSignal.timeout(60_000),
        });
        return { connectStatus: connected.response.status, modelIds: models.map((entry) => `${String(entry.id)} (${String(entry.name)})`), status: response.status, text: await response.text() };
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
