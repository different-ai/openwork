import { createServer } from "node:http";
import type { Seed } from "@openwork/env";
import { denFetch } from "@openwork/behaviors";
import { gatewayEnvironment, record, seedAcmeGateway, startAcmeGateway, startAcmeUpstream } from "../../worlds/lib/acme-gateway.ts";
import { isRecord } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export const DEEPSEEK_MOCK_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_MOCK_REPLY = "DeepSeek mock is working.";

/**
 * An OpenAI-compatible upstream for one DeepSeek model: Chat Completions, JSON or streamed, always
 * answering DEEPSEEK_MOCK_REPLY. It only accepts its own key and model.
 */
async function startDeepSeekUpstream(stack: AsyncDisposableStack) {
  const key = crypto.randomUUID();
  const requests: { model: string; stream: boolean; tools: number }[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || !request.url?.split("?")[0]?.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
      if (request.headers.authorization !== `Bearer ${key}`) { response.writeHead(401).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const model = record(body) && typeof body.model === "string" ? body.model : "";
      const stream = record(body) && body.stream === true;
      requests.push({ model, stream, tools: record(body) && Array.isArray(body.tools) ? body.tools.length : 0 });
      if (model !== DEEPSEEK_MOCK_MODEL) { response.writeHead(400).end(); return; }
      const usage = { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 };
      if (stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of [
          { id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: DEEPSEEK_MOCK_REPLY }, finish_reason: null }] },
          { id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [], usage },
        ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: "chatcmpl-mock", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: DEEPSEEK_MOCK_REPLY }, finish_reason: "stop" }], usage,
      }));
    } catch { response.writeHead(400).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  stack.defer(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("DeepSeek mock did not bind.");
  return { baseUrl: `http://127.0.0.1:${address.port}`, key, requests };
}

/**
 * Claude Code through the AI Gateway (part of `gatewayMemberApiKeys`): a real Den (cloud) and AI
 * Gateway with two providers every member may use: Anthropic (the Acme mock, Messages) and DeepSeek
 * (an OpenAI-compatible mock, Chat Completions). Member API keys are on and allowed; the owner is
 * signed in on My Library › Models.
 */
export async function gatewayClaudeCodeWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const anthropic = await startAcmeUpstream(stack);
    const deepseek = await startDeepSeekUpstream(stack);
    const gateway = await gatewayEnvironment(anthropic.baseUrl);
    const env = { ...gateway.env, GATEWAY_EGRESS_ALLOWED_ORIGINS: `${anthropic.baseUrl},${deepseek.baseUrl}`, DEN_DEPLOYMENT: "cloud" };
    const den = stack.use(await seed.den({ env, org: { name: "Claude Code proof", admin: { name: "Claude Code owner" } } }));
    if (!den.database) throw new Error("The Claude Code world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const claude = await seedAcmeGateway(den.admin, anthropic);
    const orgHeaders = { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": claude.orgId };
    const created = await denFetch(den.admin, "/v1/inference-providers", {
      method: "POST", headers: orgHeaders,
      body: JSON.stringify({ name: "DeepSeek", providerId: "deepseek", modelIds: [DEEPSEEK_MOCK_MODEL], credential: { kind: "api_key", secret: deepseek.key }, settings: { upstreamBaseUrl: `${deepseek.baseUrl}/v1` }, allMembers: true }),
    });
    const provider = isRecord(created.body) && isRecord(created.body.inferenceProvider) ? created.body.inferenceProvider : undefined;
    if (created.response.status !== 201 || typeof provider?.id !== "string") throw new Error(`DeepSeek provider creation failed: HTTP ${created.response.status}`);
    const connected = await denFetch(den.admin, `/v1/inference-providers/${provider.id}/connect`, { headers: orgHeaders });
    if (!connected.response.ok) throw new Error(`DeepSeek provider not usable: HTTP ${connected.response.status}`);
    await enableOrganizationCapabilities(seed, den.admin, { gatewayMemberApiKeys: true });
    const allowed = await seed.api(den.admin, "/v1/org/ai-gateway-settings", { method: "PUT", body: JSON.stringify({ memberApiKeys: true }) });
    if (!allowed.response.ok) throw new Error(`Allowing 3rd party tools failed: HTTP ${allowed.response.status}`);
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/library?show=models", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den,
      web,
      gatewayUrl: gateway.baseUrl,
      claude,
      deepseekRequests: () => [...deepseek.requests],
      async createApiKey(name: string): Promise<string> {
        const result = await seed.api(den.admin, "/v1/org/ai-gateway/api-keys/mine", { method: "POST", body: JSON.stringify({ name }) });
        const key = isRecord(result.body) ? result.body.key : null;
        if (!result.response.ok || typeof key !== "string") throw new Error(`Creating the API key failed: HTTP ${result.response.status}`);
        return key;
      },
      /** A request as Claude Code sends it: the key as a bearer token (ANTHROPIC_AUTH_TOKEN) and anthropic-version. */
      async callAsClaudeCode(key: string, url: string, body?: unknown) {
        const response = await fetch(url, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01", ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: response.status, json, text };
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
