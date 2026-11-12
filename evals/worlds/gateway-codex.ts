import { createServer } from "node:http";
import type { Seed } from "@openwork/env";
import { denFetch } from "@openwork/behaviors";
import { gatewayEnvironment, record, seedAcmeGateway, startAcmeGateway, startAcmeUpstream } from "../../worlds/lib/acme-gateway.ts";
import { isRecord } from "./library.ts";

export const OPENAI_MOCK_MODEL = "gpt-5-mini";
export const OPENAI_MOCK_REPLY = "OpenAI Responses mock is working.";

export type OpenAiMockRequest = { model: string; stream: boolean; tools: string[]; reasoning: unknown; include: unknown; inputIds: number; clientMetadata: boolean };

/**
 * An OpenAI upstream for one model: the Responses API, streamed, always answering OPENAI_MOCK_REPLY
 * with an encrypted reasoning item. It only accepts its own key and model, and records what it got.
 */
async function startOpenAiUpstream(stack: AsyncDisposableStack) {
  const key = crypto.randomUUID();
  const requests: OpenAiMockRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || !request.url?.split("?")[0]?.endsWith("/responses")) { response.writeHead(404).end(); return; }
      if (request.headers.authorization !== `Bearer ${key}`) { response.writeHead(401).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!record(body)) { response.writeHead(400).end(); return; }
      const model = typeof body.model === "string" ? body.model : "";
      requests.push({
        model,
        stream: body.stream === true,
        tools: Array.isArray(body.tools) ? body.tools.filter(record).map((tool) => `${String(tool.type)}:${String(tool.name ?? "")}`) : [],
        reasoning: body.reasoning,
        include: body.include,
        inputIds: Array.isArray(body.input) ? body.input.filter((item) => record(item) && item.type !== "reasoning" && "id" in item).length : 0,
        clientMetadata: "client_metadata" in body,
      });
      if (model !== OPENAI_MOCK_MODEL) { response.writeHead(400).end(); return; }
      const reasoning = { type: "reasoning", id: "rs_mock", summary: [], encrypted_content: "encrypted-mock" };
      const message = { type: "message", id: "msg_mock", status: "completed", role: "assistant", content: [{ type: "output_text", text: OPENAI_MOCK_REPLY, annotations: [] }] };
      const usage = { input_tokens: 30, output_tokens: 8, total_tokens: 38, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } };
      const base = { id: "resp_mock", object: "response", created_at: 1, model };
      response.writeHead(200, { "content-type": "text/event-stream" });
      let sequence = 0;
      for (const event of [
        { type: "response.created", response: { ...base, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        { type: "response.output_item.added", output_index: 1, item: { ...message, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: "msg_mock", output_index: 1, content_index: 0, delta: OPENAI_MOCK_REPLY },
        { type: "response.output_item.done", output_index: 1, item: message },
        { type: "response.completed", response: { ...base, status: "completed", output: [reasoning, message], usage } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
      response.end();
    } catch { response.writeHead(400).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  stack.defer(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OpenAI mock did not bind.");
  return { baseUrl: `http://127.0.0.1:${address.port}`, key, requests };
}

/**
 * The Codex CLI through the AI Gateway: a real Den (cloud) and AI
 * Gateway with two providers every member may use: OpenAI (a Responses mock, passed through) and
 * Anthropic (the Acme mock, translated). Member API keys are on and allowed; the owner is signed in
 * on My Library › Models.
 */
export async function gatewayCodexWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const anthropic = await startAcmeUpstream(stack);
    const openai = await startOpenAiUpstream(stack);
    const gateway = await gatewayEnvironment(anthropic.baseUrl);
    const env = { ...gateway.env, GATEWAY_EGRESS_ALLOWED_ORIGINS: `${anthropic.baseUrl},${openai.baseUrl}`, DEN_DEPLOYMENT: "cloud" };
    const den = stack.use(await seed.den({ env, org: { name: "Codex proof", admin: { name: "Codex owner" } } }));
    if (!den.database) throw new Error("The Codex world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const claude = await seedAcmeGateway(den.admin, anthropic);
    const orgHeaders = { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": claude.orgId };
    const created = await denFetch(den.admin, "/v1/inference-providers", {
      method: "POST", headers: orgHeaders,
      body: JSON.stringify({ name: "OpenAI", providerId: "openai", modelIds: [OPENAI_MOCK_MODEL], credential: { kind: "api_key", secret: openai.key }, settings: { upstreamBaseUrl: `${openai.baseUrl}/v1` }, allMembers: true }),
    });
    const provider = isRecord(created.body) && isRecord(created.body.inferenceProvider) ? created.body.inferenceProvider : undefined;
    if (created.response.status !== 201 || typeof provider?.id !== "string") throw new Error(`OpenAI provider creation failed: HTTP ${created.response.status}`);
    const connected = await denFetch(den.admin, `/v1/inference-providers/${provider.id}/connect`, { headers: orgHeaders });
    if (!connected.response.ok) throw new Error(`OpenAI provider not usable: HTTP ${connected.response.status}`);
    const allowed = await seed.api(den.admin, "/v1/org/ai-gateway-settings", { method: "PUT", body: JSON.stringify({ memberApiKeys: true }) });
    if (!allowed.response.ok) throw new Error(`Allowing 3rd party tools failed: HTTP ${allowed.response.status}`);
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/library?show=models", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den,
      web,
      gatewayUrl: gateway.baseUrl,
      claude,
      openaiRequests: () => [...openai.requests],
      anthropicRequests: () => [...anthropic.requests],
      /** A request as Codex sends it: the key from its auth command as a bearer token. */
      async callAsCodex(key: string, url: string, body?: unknown) {
        const response = await fetch(url, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer ${key}`, originator: "codex_exec", ...(body === undefined ? { accept: "*/*" } : { "content-type": "application/json", accept: "text/event-stream" }) },
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
