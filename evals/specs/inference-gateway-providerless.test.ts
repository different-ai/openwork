import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { eventually, localMysqlIsRunning, needs, queryDenDatabase, server, SkipError, test } from "@openwork/testkit";

/**
 * Provider-less Gateway routes, end to end:
 *
 *   admin  ── POST /v1/inference-providers (anthropic, granted member only) ──▶ den-api
 *   admin  ── POST /v1/inference-providers (openai, everyone) ───────────────▶ den-api
 *   member ── GET  {gateway}/api/v1/models ─────────────▶ every granted model, both providers
 *   member ── POST {gateway}/api/v1/messages ───────────▶ fake Anthropic /v1/messages
 *   member ── POST {gateway}/api/v1/chat/completions ───▶ fake OpenAI /v1/chat/completions
 *   member ── POST {gateway}/api/v1/responses ──────────▶ fake OpenAI /v1/responses
 *
 * No provider id is in any of those paths: the gateway picks the provider from
 * the gwm_ model alias. Each fake upstream only accepts its own provider's key,
 * so a request routed to the wrong provider fails loudly. Den, the gateway and
 * both upstreams share one machine and one scratch MySQL database; run it with
 * OPENWORK_WORLD_PLACE=local on a workstation or inside a Daytona sandbox.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REQUEST_TIMEOUT_MS = 30_000;
const GATEWAY_BOOT_TIMEOUT_MS = 120_000;
// Mirrors the key @openwork/testkit hands den-api; encrypted columns only decrypt when both services agree.
const DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890";
const ANTHROPIC_UPSTREAM_KEY = "sk-ant-fake-providerless-upstream-key";
const OPENAI_UPSTREAM_KEY = "sk-openai-fake-providerless-upstream-key";
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const OPENAI_MODEL = "gpt-4o-mini";
// The gateway commits streaming responses after RESPONSE_START_MS; the slow fake provider answers after SLOW_PROVIDER_MS.
const RESPONSE_START_MS = 1_000;
const SLOW_PROVIDER_MS = 3_000;
const ALIAS_PATTERN = /^gwm_[0-7][0-9a-hjkmnp-tv-z]{25}_[0-7][0-9a-hjkmnp-tv-z]{25}_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("Could not allocate a loopback port."))));
    });
  });
}

// --- Fake upstreams --------------------------------------------------------

interface UpstreamRequestRecord {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeUpstreams extends AsyncDisposable {
  baseUrl: string;
  requests: UpstreamRequestRecord[];
}

/** One loopback server playing both providers; each route accepts only its own provider's key. */
async function startFakeUpstreams(): Promise<FakeUpstreams> {
  const requests: UpstreamRequestRecord[] = [];
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const httpServer: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value ?? "";
      }
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (isRecord(parsed)) body = parsed;
      } catch {
        // keep an empty body; the assertions below catch it
      }
      requests.push({ method: request.method ?? "", path: request.url ?? "", headers, body });
      const model = typeof body.model === "string" ? body.model : "unknown";

      if (request.method === "POST" && request.url === "/v1/messages") {
        if (headers["x-api-key"] !== ANTHROPIC_UPSTREAM_KEY) return json(response, 401, { type: "error", error: { type: "authentication_error", message: "wrong anthropic key" } });
        const prompt = Array.isArray(body.messages) && isRecord(body.messages[0]) ? body.messages[0].content : null;
        if (body.stream === true && (prompt === "slow" || prompt === "slow-overloaded")) {
          // A provider that takes longer to start answering than the gateway's response-start window.
          setTimeout(() => {
            if (response.destroyed) return;
            if (prompt === "slow-overloaded") return json(response, 529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
            const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end([
              event("message_start", { message: { id: "msg_slow", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 11, output_tokens: 0 } } }),
              event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
              event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "anthropic slow ok" } }),
              event("content_block_stop", { index: 0 }),
              event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
              event("message_stop", {}),
            ].join(""));
          }, SLOW_PROVIDER_MS);
          return;
        }
        return json(response, 200, {
          id: "msg_providerless", type: "message", role: "assistant", model, stop_reason: "end_turn",
          content: [{ type: "text", text: "anthropic ok" }], usage: { input_tokens: 11, output_tokens: 7 },
        });
      }
      if (request.method === "POST" && (request.url === "/v1/chat/completions" || request.url === "/v1/responses")) {
        if (headers.authorization !== `Bearer ${OPENAI_UPSTREAM_KEY}`) return json(response, 401, { error: { message: "wrong openai key", type: "invalid_request_error" } });
        if (request.url === "/v1/chat/completions") {
          return json(response, 200, {
            id: "chatcmpl_providerless", object: "chat.completion", created: 1767225600, model,
            choices: [{ index: 0, message: { role: "assistant", content: "openai chat ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 },
          });
        }
        return json(response, 200, {
          id: "resp_providerless", object: "response", created_at: 1767225600, status: "completed", model,
          output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "openai responses ok", annotations: [] }] }],
          usage: { input_tokens: 17, output_tokens: 3, total_tokens: 20 },
        });
      }
      json(response, 404, { error: { message: `no route ${request.method} ${request.url}` } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) throw new Error("The fake upstream did not bind a port.");
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async [Symbol.asyncDispose]() {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

// --- Gateway process -------------------------------------------------------

async function startGateway(input: { port: number; databaseUrl: string; allowedOrigin: string }): Promise<AsyncDisposable & { baseUrl: string }> {
  const child: ChildProcess = spawn("pnpm", ["--dir", "ee/apps/gateway", "exec", "tsx", "src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GATEWAY_") && !key.startsWith("INFERENCE_"))),
      NODE_ENV: "test",
      OPENWORK_DEV_MODE: "1",
      NODE_OPTIONS: "--conditions=development",
      GATEWAY_PORT: String(input.port),
      GATEWAY_ENABLED: "true",
      DATABASE_URL: input.databaseUrl,
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY,
      GATEWAY_WEBHOOK_SECRET: "providerless-eval-webhook-secret",
      GATEWAY_PROXY_BASE_URL: `http://127.0.0.1:${input.port}`,
      GATEWAY_PUBLIC_BASE_URL: `http://127.0.0.1:${input.port}`,
      GATEWAY_EGRESS_ALLOWED_ORIGINS: input.allowedOrigin,
      GATEWAY_RESPONSE_START_MS: String(RESPONSE_START_MS),
      GATEWAY_RESPONSE_HEARTBEAT_MS: "1000",
      CORS_ORIGINS: "",
      OPENROUTER_UPSTREAM_URL: "https://openrouter.ai/api/v1",
      SENTRY_DSN: "",
      SENTRY_LOG_LEVEL: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logLines: string[] = [];
  const capture = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) logLines.push(line);
    if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const baseUrl = `http://127.0.0.1:${input.port}`;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) child.kill("SIGKILL");
  };
  try {
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error(`gateway exited with ${child.exitCode}. Log tail:\n${logLines.slice(-40).join("\n")}`);
      const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    }, { within: GATEWAY_BOOT_TIMEOUT_MS, intervalMs: 1_000, label: `gateway /ready at ${baseUrl}` });
  } catch (error) {
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nLog tail:\n${logLines.slice(-40).join("\n")}`);
  }
  return { baseUrl, async [Symbol.asyncDispose]() { await stop(); } };
}

// --- Den helpers -----------------------------------------------------------

async function organizationId(session: DenSession, organizationName: string): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const id = stringAt(organizations.find((entry) => entry.name === organizationName), "id");
  if (!result.response.ok || !id) throw new Error(`Finding the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  return id;
}

async function memberIdByEmail(admin: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(admin, "/v1/org", { headers: orgHeaders(admin, orgId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const members = isRecord(result.body) && Array.isArray(result.body.members) ? result.body.members.filter(isRecord) : [];
  const id = stringAt(members.find((entry) => isRecord(entry.user) && entry.user.email === email), "id");
  if (!result.response.ok || !id) throw new Error(`Finding member ${email} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  return id;
}

async function createProvider(admin: DenSession, orgId: string, input: {
  name: string; providerId: "anthropic" | "openai"; modelId: string; secret: string; upstreamBaseUrl: string;
  access: { allMembers: true } | { memberIds: string[] };
}): Promise<string> {
  const result = await denFetch(admin, "/v1/inference-providers", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({
      name: input.name, providerId: input.providerId, modelIds: [input.modelId],
      credential: { kind: "api_key", secret: input.secret },
      settings: { upstreamBaseUrl: input.upstreamBaseUrl },
      ...input.access,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const id = stringAt(isRecord(result.body) && isRecord(result.body.inferenceProvider) ? result.body.inferenceProvider : null, "id");
  if (result.response.status !== 201 || !id) throw new Error(`Creating ${input.name} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  return id;
}

/** The member's ow_gw_ key and the gwm_ alias Den hands out for this provider. */
async function connect(session: DenSession, orgId: string, inferenceProviderId: string): Promise<{ key: string; alias: string }> {
  const result = await denFetch(session, `/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}/connect`, {
    headers: orgHeaders(session, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.inferenceProvider) ? result.body.inferenceProvider : null;
  const models = Array.isArray(provider?.models) ? provider.models.filter(isRecord) : [];
  const key = stringAt(provider, "apiKey");
  const alias = stringAt(models[0], "id");
  if (result.response.status !== 200 || !key || !alias) throw new Error(`Connecting to ${inferenceProviderId} failed: HTTP ${result.response.status}`);
  return { key, alias };
}

// --- Gateway calls, shaped like the official SDKs' requests -----------------

interface GatewayResult { status: number; body: Record<string, unknown>; errorCode: string; requestId: string }

async function gatewayCall(url: string, init: { method?: string; headers: Record<string, string>; body?: unknown }): Promise<GatewayResult> {
  const response = await fetch(url, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? init.headers : { "content-type": "application/json", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) body = parsed;
  } catch {
    // non-JSON bodies leave body empty
  }
  const errorCode = isRecord(body.error) ? stringAt(body.error, "code") : "";
  return { status: response.status, body, errorCode, requestId: response.headers.get("x-openwork-request-id") ?? "" };
}

/** Anthropic SDK: baseURL {gateway}/api, x-api-key, POST /v1/messages. */
function anthropicMessages(gateway: string, key: string, model: string) {
  return gatewayCall(`${gateway}/api/v1/messages`, {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: { model, max_tokens: 32, messages: [{ role: "user", content: "ping" }] },
  });
}

/** OpenAI SDK: baseURL {gateway}/api/v1, Bearer key. */
function openAiChat(gateway: string, key: string, model: string) {
  return gatewayCall(`${gateway}/api/v1/chat/completions`, {
    headers: { authorization: `Bearer ${key}` },
    body: { model, messages: [{ role: "user", content: "ping" }] },
  });
}

function openAiResponses(gateway: string, key: string, model: string) {
  return gatewayCall(`${gateway}/api/v1/responses`, { headers: { authorization: `Bearer ${key}` }, body: { model, input: "ping" } });
}

function listModels(gateway: string, key: string) {
  return gatewayCall(`${gateway}/api/v1/models`, { headers: { authorization: `Bearer ${key}` } });
}

function listedModels(result: GatewayResult) {
  return Array.isArray(result.body.data) ? result.body.data.filter(isRecord) : [];
}

test("provider-less Gateway routes list and invoke every granted model across providers by alias alone", { timeout: 600_000 }, async ({ evidence, place }) => {
  needs({ commands: ["pnpm"] });
  if (place.kind !== "local" || process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) {
    throw new SkipError("co-located Den, gateway, fake upstreams and scratch MySQL required; run with OPENWORK_WORLD_PLACE=local (locally or inside a Daytona sandbox) and no OPENWORK_EVAL_DEN_API_URL");
  }
  if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306");
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const organizationName = `Providerless Gateway ${runId}`;

  await using upstream = await startFakeUpstreams();
  const gatewayPort = await freeLoopbackPort();
  const gateway = `http://127.0.0.1:${gatewayPort}`;

  await using den = await server({
    place,
    web: false,
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql",
      GATEWAY_ENABLED: "true",
      GATEWAY_PROXY_BASE_URL: gateway,
      GATEWAY_PUBLIC_BASE_URL: gateway,
      GATEWAY_EGRESS_ALLOWED_ORIGINS: upstream.baseUrl,
    },
    org: {
      name: organizationName,
      admin: { name: "Gateway Admin" },
      members: { granted: { name: "Granted Member" }, outsider: { name: "Outsider Member" } },
    },
  });
  const databaseUrl = den.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("An isolated testkit scratch database is required.");
  const granted = den.members.granted;
  const outsider = den.members.outsider;
  if (!granted || !outsider) throw new Error("The local Den did not provision both members.");

  await using gatewayApp = await startGateway({ port: gatewayPort, databaseUrl, allowedOrigin: upstream.baseUrl });
  expect(gatewayApp.baseUrl).toBe(gateway);

  // --- Dummy providers: Anthropic for one member, OpenAI for everyone. ---
  const orgId = await organizationId(den.admin, organizationName);
  const grantedMemberId = await memberIdByEmail(den.admin, orgId, granted.email);
  const anthropicId = await createProvider(den.admin, orgId, {
    name: "Dummy Anthropic", providerId: "anthropic", modelId: ANTHROPIC_MODEL, secret: ANTHROPIC_UPSTREAM_KEY,
    upstreamBaseUrl: `${upstream.baseUrl}/v1`, access: { memberIds: [grantedMemberId] },
  });
  const openaiId = await createProvider(den.admin, orgId, {
    name: "Dummy OpenAI", providerId: "openai", modelId: OPENAI_MODEL, secret: OPENAI_UPSTREAM_KEY,
    upstreamBaseUrl: `${upstream.baseUrl}/v1`, access: { allMembers: true },
  });
  const anthropicGrant = await connect(granted, orgId, anthropicId);
  const openaiGrant = await connect(granted, orgId, openaiId);
  // One Gateway key per member per organization covers every provider.
  expect(openaiGrant.key).toBe(anthropicGrant.key);
  const key = anthropicGrant.key;
  const anthropicAlias = anthropicGrant.alias;
  const openaiAlias = openaiGrant.alias;
  expect(anthropicAlias).toMatch(ALIAS_PATTERN);
  expect(openaiAlias).toMatch(ALIAS_PATTERN);
  const outsiderKey = (await connect(outsider, orgId, openaiId)).key;
  expect(outsiderKey).not.toBe(key);

  // --- GET /api/v1/models: every granted model, across providers, in the OpenAI shape. ---
  const listed = await listModels(gateway, key);
  expect(listed.status).toBe(200);
  expect(listed.body.object).toBe("list");
  const models = listedModels(listed);
  expect(models.map((model) => stringAt(model, "id")).sort()).toEqual([anthropicAlias, openaiAlias].sort());
  const anthropicEntry = models.find((model) => model.id === anthropicAlias);
  const openaiEntry = models.find((model) => model.id === openaiAlias);
  expect(anthropicEntry).toMatchObject({ object: "model", owned_by: "anthropic", openwork: { provider_id: anthropicId, provider_name: "Dummy Anthropic", upstream_model_id: ANTHROPIC_MODEL } });
  expect(openaiEntry).toMatchObject({ object: "model", owned_by: "openai", openwork: { provider_id: openaiId, provider_name: "Dummy OpenAI", upstream_model_id: OPENAI_MODEL } });
  expect(typeof anthropicEntry?.created === "number" && anthropicEntry.created > 1_700_000_000).toBe(true);
  const outsiderListed = await listModels(gateway, outsiderKey);
  expect(outsiderListed.status).toBe(200);
  expect(listedModels(outsiderListed).map((model) => stringAt(model, "id"))).toEqual([openaiAlias]);
  expect(upstream.requests).toHaveLength(0);
  evidence.recordAssertionEvidence(
    "GET /api/v1/models lists each member's granted models across providers",
    `The granted member's key listed ${models.length} models (anthropic ${anthropicId} and openai ${openaiId}) with owned_by and openwork.provider_id set; the outsider's key listed only the OpenAI model; no upstream was contacted.`,
    models.length === 2 && listedModels(outsiderListed).length === 1,
  );

  // --- Invoke each model with no provider in the path. ---
  const messages = await anthropicMessages(gateway, key, anthropicAlias);
  expect(messages.status).toBe(200);
  expect(messages.body.content).toEqual([{ type: "text", text: "anthropic ok" }]);
  const chat = await openAiChat(gateway, key, openaiAlias);
  expect(chat.status).toBe(200);
  expect(isRecord(chat.body) && Array.isArray(chat.body.choices) && isRecord(chat.body.choices[0]) ? chat.body.choices[0].message : null)
    .toEqual({ role: "assistant", content: "openai chat ok" });
  const responses = await openAiResponses(gateway, key, openaiAlias);
  expect(responses.status).toBe(200);
  expect(responses.body.status).toBe("completed");

  expect(upstream.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
    "POST /v1/messages", "POST /v1/chat/completions", "POST /v1/responses",
  ]);
  const [anthropicUpstream, chatUpstream, responsesUpstream] = upstream.requests;
  // Each provider's own server-held key, and the alias swapped for the upstream model name.
  expect(anthropicUpstream?.headers["x-api-key"] === ANTHROPIC_UPSTREAM_KEY).toBe(true);
  expect(anthropicUpstream?.headers.authorization).toBeUndefined();
  expect(anthropicUpstream?.headers["anthropic-version"]).toBe("2023-06-01");
  expect(anthropicUpstream?.body.model).toBe(ANTHROPIC_MODEL);
  expect(chatUpstream?.headers.authorization === `Bearer ${OPENAI_UPSTREAM_KEY}`).toBe(true);
  expect(chatUpstream?.body.model).toBe(OPENAI_MODEL);
  expect(responsesUpstream?.headers.authorization === `Bearer ${OPENAI_UPSTREAM_KEY}`).toBe(true);
  expect(responsesUpstream?.body.model).toBe(OPENAI_MODEL);
  for (const request of upstream.requests) {
    expect(Object.values(request.headers).some((value) => value.includes(key))).toBe(false);
  }
  evidence.recordAssertionEvidence(
    "POST /api/v1/{messages,chat/completions,responses} route by alias to the owning provider",
    `Three calls with no provider id reached the fake upstream as POST /v1/messages (x-api-key = Anthropic key, model ${ANTHROPIC_MODEL}), POST /v1/chat/completions and POST /v1/responses (Bearer OpenAI key, model ${OPENAI_MODEL}). The member's ow_gw_ key never reached an upstream.`,
    true,
  );

  // --- Usage is logged against the right provider for each call. ---
  const logRows = await eventually(async () => {
    const rows = await queryDenDatabase(databaseUrl,
      "SELECT requested_model, upstream_model, gateway_provider_id, org_membership_id, protocol, outcome, status, input_tokens, output_tokens, completed_at FROM gateway_request_logs WHERE organization_id = ? ORDER BY started_at",
      [orgId]);
    return rows.length === 3 && rows.every((row) => isRecord(row) && row.completed_at !== null) ? rows : false;
  }, { within: 15_000, intervalMs: 250, label: "three completed gateway_request_logs rows" });
  expect(logRows).toEqual([
    expect.objectContaining({ requested_model: anthropicAlias, upstream_model: ANTHROPIC_MODEL, gateway_provider_id: anthropicId, org_membership_id: grantedMemberId, protocol: "anthropic_messages", outcome: "ok", status: 200, input_tokens: 11, output_tokens: 7 }),
    expect.objectContaining({ requested_model: openaiAlias, upstream_model: OPENAI_MODEL, gateway_provider_id: openaiId, protocol: "openai_chat", outcome: "ok", status: 200, input_tokens: 13, output_tokens: 5 }),
    expect.objectContaining({ requested_model: openaiAlias, upstream_model: OPENAI_MODEL, gateway_provider_id: openaiId, protocol: "openai_responses", outcome: "ok", status: 200, input_tokens: 17, output_tokens: 3 }),
  ]);
  evidence.recordAssertionEvidence("Each provider-less call writes one completed usage row for its provider", JSON.stringify(logRows), true);

  // --- Rejections never reach an upstream. ---
  const before = upstream.requests.length;
  const wrongProtocol = await anthropicMessages(gateway, key, openaiAlias);
  expect([wrongProtocol.status, wrongProtocol.errorCode]).toEqual([400, "unsupported_model_endpoint"]);
  const wrongProtocolReverse = await openAiChat(gateway, key, anthropicAlias);
  expect([wrongProtocolReverse.status, wrongProtocolReverse.errorCode]).toEqual([400, "unsupported_model_endpoint"]);
  const rawModel = await openAiChat(gateway, key, OPENAI_MODEL);
  expect([rawModel.status, rawModel.errorCode]).toEqual([400, "invalid_gateway_model"]);
  const unknownAlias = await openAiChat(gateway, key, `${openaiAlias.slice(0, -1)}${openaiAlias.endsWith("0") ? "1" : "0"}`);
  expect([unknownAlias.status, unknownAlias.errorCode]).toEqual([404, "model_not_found"]);
  // The outsider can see the alias's provider exists but holds no grant for it.
  const outsiderAnthropic = await anthropicMessages(gateway, outsiderKey, anthropicAlias);
  expect(outsiderAnthropic.status).toBe(403);
  const noKey = await gatewayCall(`${gateway}/api/v1/chat/completions`, { headers: {}, body: { model: openaiAlias, messages: [] } });
  expect(noKey.status).toBe(401);
  expect(upstream.requests).toHaveLength(before);
  evidence.recordAssertionEvidence(
    "Provider-less routes reject wrong-protocol, raw, unknown and ungranted models without contacting an upstream",
    `OpenAI alias on /messages and Anthropic alias on /chat/completions: 400 unsupported_model_endpoint; raw "${OPENAI_MODEL}": 400 invalid_gateway_model; unknown alias: 404 model_not_found; outsider on the Anthropic alias: HTTP ${outsiderAnthropic.status} (${outsiderAnthropic.errorCode}); no key: 401. Upstream request count stayed at ${before}.`,
    upstream.requests.length === before,
  );

  // --- The provider-scoped routes still work unchanged. ---
  const scoped = await gatewayCall(`${gateway}/api/v1/providers/${anthropicId}/messages`, {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: { model: anthropicAlias, max_tokens: 32, messages: [{ role: "user", content: "ping" }] },
  });
  expect(scoped.status).toBe(200);
  const scopedList = await gatewayCall(`${gateway}/api/v1/providers/${openaiId}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
  expect(scopedList.status).toBe(200);
  expect(listedModels(scopedList).map((model) => stringAt(model, "id"))).toEqual([openaiAlias]);
  expect(upstream.requests).toHaveLength(before + 1);

  // --- A slow provider: stream headers are committed early, so a proxy in front never times out (524). ---
  const streamMessages = async (content: string) => {
    const started = Date.now();
    const response = await fetch(`${gateway}/api/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: anthropicAlias, max_tokens: 32, stream: true, messages: [{ role: "user", content }] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const headersAfterMs = Date.now() - started;
    return { response, headersAfterMs, text: await response.text() };
  };
  const slow = await streamMessages("slow");
  expect(slow.response.status).toBe(200);
  expect(slow.headersAfterMs).toBeLessThan(SLOW_PROVIDER_MS - 500);
  expect(slow.response.headers.get("content-type")).toContain("text/event-stream");
  expect(slow.text.startsWith(": processing\n\n")).toBe(true);
  expect(slow.text).toContain("anthropic slow ok");
  expect(slow.text).toContain("event: message_stop");
  const overloaded = await streamMessages("slow-overloaded");
  expect(overloaded.response.status).toBe(200);
  expect(overloaded.headersAfterMs).toBeLessThan(SLOW_PROVIDER_MS - 500);
  expect(overloaded.text).toContain(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`);
  expect(overloaded.text).not.toContain("message_stop");
  const slowRows = await eventually(async () => {
    const rows = await queryDenDatabase(databaseUrl,
      "SELECT status, outcome, output_tokens, completed_at FROM gateway_request_logs WHERE organization_id = ? AND stream = 1 ORDER BY started_at",
      [orgId]);
    return rows.length === 2 && rows.every((row) => isRecord(row) && row.completed_at !== null) ? rows : false;
  }, { within: 15_000, intervalMs: 250, label: "two completed streaming gateway_request_logs rows" });
  expect(slowRows).toEqual([
    expect.objectContaining({ status: 200, outcome: "ok", output_tokens: 7 }),
    expect.objectContaining({ status: 529, outcome: "upstream_error" }),
  ]);
  evidence.recordAssertionEvidence(
    "A slow Anthropic provider gets early stream headers on the provider-less route",
    `With the provider silent for ${SLOW_PROVIDER_MS} ms and a ${RESPONSE_START_MS} ms window, headers arrived after ${slow.headersAfterMs} ms and ${overloaded.headersAfterMs} ms. The success relayed the full Anthropic stream after a heartbeat; the 529 became one Anthropic error event (overloaded_error). Usage rows keep the provider's real status: ${JSON.stringify(slowRows)}.`,
    true,
  );
});
