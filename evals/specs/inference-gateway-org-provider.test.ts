import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import {
  eventually,
  localMysqlIsRunning,
  queryDenDatabase,
  server,
  test,
} from "@openwork/testkit";

/**
 * Inference gateway, org provider route (plan §3 #1–#4, §5.2):
 *
 *   admin  ── POST /v1/inference-providers ──▶ den-api  (stores the upstream key server-side)
 *   member ── GET  …/:ipr/connect ───────────▶ den-api  (gateway URL + ow_inf_ key, never the upstream key)
 *   member ── POST {gateway}/api/v1/providers/:ipr/messages ──▶ inference ──▶ fake Anthropic upstream /v1/messages
 *                                                                  └── one inference_request_logs row
 *
 * The upstream is a loopback HTTP server owned by this spec; the provider
 * reaches it through `settings.upstreamBaseUrl` (plan §4.1 "upstream base
 * override"). Den and the inference app share one ephemeral MySQL database.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REQUEST_TIMEOUT_MS = 30_000;
const INFERENCE_BOOT_TIMEOUT_MS = 120_000;
const LOG_ROW_TIMEOUT_MS = 15_000;
// Mirrors the constant @openwork/testkit hands den-api (packages/env/src/den.ts).
// Encrypted columns (credential secrets, ow_inf_ keys) only decrypt when both
// services use the same key; a mismatch surfaces as 502 provider_credential_invalid.
const DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890";
const FAKE_UPSTREAM_KEY = "sk-ant-fake-upstream-key-never-leaves-the-server";
const GATEWAY_KEY_PREFIX = "ow_inf_";
const UPSTREAM_INPUT_TOKENS = 25;
const UPSTREAM_OUTPUT_TOKENS = 42;
const UPSTREAM_REQUEST_ID = "req_fake_anthropic_0001";

const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !localPlacement
  ? "Inference gateway org provider skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
  : !mysqlOpen
    ? "Inference gateway org provider skipped — needs MySQL on 127.0.0.1:3306"
    : "an org inference provider routes member requests through the gateway with the org credential and logs one usage row";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { ...auth(session), "x-openwork-org-id": orgId };
}

function stringAt(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
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

// --- Fake Anthropic upstream ---------------------------------------------

interface UpstreamRequestRecord {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

interface FakeAnthropicUpstream extends AsyncDisposable {
  baseUrl: string;
  requests: UpstreamRequestRecord[];
}

function anthropicSseBody(model: string): string {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { id: "msg_fake_1", type: "message", role: "assistant", model, content: [], usage: { input_tokens: UPSTREAM_INPUT_TOKENS, output_tokens: 1 } },
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "gateway ok" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: UPSTREAM_OUTPUT_TOKENS } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
}

async function startFakeAnthropicUpstream(): Promise<FakeAnthropicUpstream> {
  const requests: UpstreamRequestRecord[] = [];
  const httpServer: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value ?? "";
      }
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method ?? "", path: request.url ?? "", headers, body });

      if (headers["x-api-key"] !== FAKE_UPSTREAM_KEY) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/messages") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no route ${request.method} ${request.url}` } }));
        return;
      }
      let model = "unknown";
      try {
        const parsed: unknown = JSON.parse(body);
        if (isRecord(parsed) && typeof parsed.model === "string") model = parsed.model;
      } catch {
        // non-JSON body: keep the placeholder model
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "request-id": UPSTREAM_REQUEST_ID,
      });
      response.end(anthropicSseBody(model));
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) throw new Error("The fake Anthropic upstream did not bind a port.");
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

// --- Inference app -------------------------------------------------------

interface InferenceApp extends AsyncDisposable {
  baseUrl: string;
}

async function startInferenceApp(input: { port: number; databaseUrl: string }): Promise<InferenceApp> {
  const child: ChildProcess = spawn("pnpm", ["--dir", "ee/apps/inference", "exec", "tsx", "src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: "--conditions=development",
      PORT: String(input.port),
      DATABASE_URL: input.databaseUrl,
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY,
      INFERENCE_WEBHOOK_SECRET: "inference-gateway-eval-webhook-secret",
      INFERENCE_PROXY_BASE_URL: `http://127.0.0.1:${input.port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logLines: string[] = [];
  const capture = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) logLines.push(line);
    }
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
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) child.kill("SIGKILL");
  };

  try {
    await eventually(async () => {
      if (child.exitCode !== null) {
        throw new Error(`inference exited with ${child.exitCode}. Log tail:\n${logLines.slice(-40).join("\n")}`);
      }
      const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    }, { within: INFERENCE_BOOT_TIMEOUT_MS, intervalMs: 1_000, label: `inference /ready at ${baseUrl}` });
  } catch (error) {
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nLog tail:\n${logLines.slice(-40).join("\n")}`);
  }

  return {
    baseUrl,
    async [Symbol.asyncDispose]() {
      await stop();
    },
  };
}

// --- Den helpers ---------------------------------------------------------

async function organizationId(session: DenSession, organizationName: string): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: auth(session), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const organization = organizations.find((entry) => entry.name === organizationName);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function memberIdByEmail(admin: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(admin, "/v1/org", { headers: orgHeaders(admin, orgId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const members = isRecord(result.body) && Array.isArray(result.body.members) ? result.body.members.filter(isRecord) : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  const id = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding member ${email} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

/** A model id that exists in the live models.dev catalog for `anthropic`; den-api validates modelIds against it. */
async function firstCatalogModelId(admin: DenSession, orgId: string, providerId: string): Promise<string> {
  const result = await denFetch(admin, `/v1/llm-provider-catalog/${encodeURIComponent(providerId)}`, {
    headers: orgHeaders(admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.provider) ? result.body.provider : null;
  const models = provider && Array.isArray(provider.models) ? provider.models.filter(isRecord) : [];
  const modelId = stringAt(models[0] ?? null, "id");
  if (!result.response.ok || !modelId) {
    throw new Error(`The ${providerId} catalog entry was unavailable (HTTP ${result.response.status}): ${result.text.slice(0, 300)}`);
  }
  return modelId;
}

async function createInferenceProvider(
  admin: DenSession,
  orgId: string,
  input: { name: string; modelId: string; upstreamBaseUrl: string; access: { allMembers: true } | { memberIds: string[] } },
): Promise<{ id: string; body: Record<string, unknown>; text: string }> {
  const result = await denFetch(admin, "/v1/inference-providers", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({
      name: input.name,
      providerId: "anthropic",
      modelIds: [input.modelId],
      credential: { kind: "api_key", secret: FAKE_UPSTREAM_KEY },
      settings: { upstreamBaseUrl: input.upstreamBaseUrl },
      ...input.access,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.inferenceProvider) ? result.body.inferenceProvider : null;
  const id = stringAt(provider, "id");
  if (result.response.status !== 201 || !provider || !id) {
    throw new Error(`Creating inference provider ${input.name} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return { id, body: provider, text: result.text };
}

async function connect(session: DenSession, orgId: string, inferenceProviderId: string) {
  const result = await denFetch(session, `/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}/connect`, {
    headers: orgHeaders(session, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.inferenceProvider) ? result.body.inferenceProvider : null;
  return { status: result.response.status, text: result.text, provider, error: isRecord(result.body) ? stringAt(result.body, "error") : "" };
}

/**
 * The exact request `@ai-sdk/anthropic` makes: `${options.baseURL}/messages`
 * (its default baseURL already ends in `/v1`, and so does the override).
 */
async function gatewayMessages(input: { gatewayBaseUrl: string; apiKey: string; model: string }) {
  const response = await fetch(`${input.gatewayBaseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: input.model, max_tokens: 32, stream: true, messages: [{ role: "user", content: "ping" }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let errorCode = "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error)) errorCode = stringAt(parsed.error, "code");
  } catch {
    // streaming bodies are not JSON
  }
  return { status: response.status, text, errorCode, requestId: response.headers.get("x-openwork-request-id") ?? "" };
}

function headersContain(requests: UpstreamRequestRecord[], needle: string): boolean {
  return requests.some((request) => Object.values(request.headers).some((value) => value.includes(needle)));
}

/** Same shape as the real id, different last character: a well-formed typeid that names no row. */
function siblingProviderId(id: string): string {
  const last = id.at(-1);
  return `${id.slice(0, -1)}${last === "0" ? "1" : "0"}`;
}

test.skipIf(!localPlacement || !mysqlOpen)(title, { timeout: 600_000 }, async ({ evidence, place }) => {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const organizationName = `Inference Gateway ${runId}`;

  await using upstream = await startFakeAnthropicUpstream();
  const inferencePort = await freeLoopbackPort();
  const gatewayOrigin = `http://127.0.0.1:${inferencePort}`;

  await using den = await server({
    place,
    web: false,
    env: { INFERENCE_PROXY_BASE_URL: gatewayOrigin },
    org: {
      name: organizationName,
      admin: { name: "Gateway Admin" },
      members: { granted: { name: "Granted Member" }, outsider: { name: "Outsider Member" } },
    },
  });
  const databaseUrl = den.database?.url;
  if (!databaseUrl) throw new Error("The local Den did not expose its ephemeral database URL.");
  const granted = den.members.granted;
  const outsider = den.members.outsider;
  if (!granted || !outsider) throw new Error("The local Den did not provision both members.");

  await using inference = await startInferenceApp({ port: inferencePort, databaseUrl });
  expect(inference.baseUrl).toBe(gatewayOrigin);

  const orgId = await organizationId(den.admin, organizationName);
  const grantedMemberId = await memberIdByEmail(den.admin, orgId, granted.email);
  const modelId = await firstCatalogModelId(den.admin, orgId, "anthropic");

  // --- Admin creates the scoped provider; the credential never echoes back. ---
  const scoped = await createInferenceProvider(den.admin, orgId, {
    name: "Anthropic via gateway (scoped)",
    modelId,
    upstreamBaseUrl: `${upstream.baseUrl}/v1`,
    access: { memberIds: [grantedMemberId] },
  });
  const scopedGatewayUrl = `${gatewayOrigin}/api/v1/providers/${scoped.id}`;
  const createdConfig = isRecord(scoped.body.providerConfig) ? scoped.body.providerConfig : null;
  const createdOptions = createdConfig && isRecord(createdConfig.options) ? createdConfig.options : null;
  expect(scoped.id.startsWith("ipr_")).toBe(true);
  expect(scoped.body.source).toBe("openwork_gateway");
  expect(scoped.body.credentialStatus).toBe("ready");
  expect(stringAt(createdConfig, "api")).toBe(scopedGatewayUrl);
  expect(stringAt(createdOptions, "baseURL")).toBe(scopedGatewayUrl);
  expect(scoped.text.includes(FAKE_UPSTREAM_KEY)).toBe(false);
  evidence.recordAssertionEvidence(
    "An admin creates a gateway provider whose config points at the gateway and never echoes the upstream key",
    `POST /v1/inference-providers returned 201 for ${scoped.id} (source=${String(scoped.body.source)}, credentialStatus=${String(scoped.body.credentialStatus)}); providerConfig.api and options.baseURL were ${scopedGatewayUrl}; the response text did not contain the upstream secret.`,
    scoped.body.source === "openwork_gateway"
      && stringAt(createdConfig, "api") === scopedGatewayUrl
      && stringAt(createdOptions, "baseURL") === scopedGatewayUrl
      && !scoped.text.includes(FAKE_UPSTREAM_KEY),
  );

  // Rejected settings: the upstream override must be a clean http(s) URL.
  const badSettings = await denFetch(den.admin, "/v1/inference-providers", {
    method: "POST",
    headers: orgHeaders(den.admin, orgId),
    body: JSON.stringify({
      name: "Bad upstream",
      providerId: "anthropic",
      modelIds: [modelId],
      credential: { kind: "api_key", secret: FAKE_UPSTREAM_KEY },
      settings: { upstreamBaseUrl: "ftp://files.example/v1" },
      allMembers: true,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(badSettings.response.status).toBe(400);
  expect(isRecord(badSettings.body) ? badSettings.body.error : null).toBe("invalid_settings");

  // --- Distinct resource: gateway providers do not appear in /v1/llm-providers. ---
  const llmList = await denFetch(den.admin, "/v1/llm-providers?scope=manageable", {
    headers: orgHeaders(den.admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const llmProviders = isRecord(llmList.body) && Array.isArray(llmList.body.llmProviders) ? llmList.body.llmProviders.filter(isRecord) : [];
  const llmIds = llmProviders.map((entry) => stringAt(entry, "id"));
  expect(llmList.response.status).toBe(200);
  expect(llmIds).not.toContain(scoped.id);
  expect(llmIds.some((id) => id.startsWith("ipr_"))).toBe(false);
  expect(llmList.text.includes(FAKE_UPSTREAM_KEY)).toBe(false);
  evidence.recordAssertionEvidence(
    "Gateway providers are a distinct resource from llm_provider rows",
    `GET /v1/llm-providers?scope=manageable returned ${llmProviders.length} row(s) and none carried the ipr_ id ${scoped.id}; a malformed settings.upstreamBaseUrl was rejected with HTTP ${badSettings.response.status} invalid_settings.`,
    !llmIds.includes(scoped.id) && badSettings.response.status === 400,
  );

  // --- Granted member connects: gateway URL + ow_inf_ key, no upstream key. ---
  const grantedConnect = await connect(granted, orgId, scoped.id);
  const grantedConfig = grantedConnect.provider && isRecord(grantedConnect.provider.providerConfig) ? grantedConnect.provider.providerConfig : null;
  const grantedOptions = grantedConfig && isRecord(grantedConfig.options) ? grantedConfig.options : null;
  const grantedKey = stringAt(grantedConnect.provider, "apiKey");
  const grantedApiKeys = grantedConnect.provider && isRecord(grantedConnect.provider.apiKeys) ? grantedConnect.provider.apiKeys : null;
  expect(grantedConnect.status).toBe(200);
  expect(stringAt(grantedConfig, "api")).toBe(scopedGatewayUrl);
  expect(stringAt(grantedOptions, "baseURL")).toBe(scopedGatewayUrl);
  expect(stringAt(grantedConfig, "npm")).toBe("@ai-sdk/anthropic");
  expect(grantedKey.startsWith(GATEWAY_KEY_PREFIX)).toBe(true);
  expect(stringAt(grantedApiKeys, "ANTHROPIC_API_KEY")).toBe(grantedKey);
  expect(grantedConnect.text.includes(FAKE_UPSTREAM_KEY)).toBe(false);
  evidence.recordAssertionEvidence(
    "The granted member receives the gateway URL and an OpenWork inference key, never the org's upstream key",
    `GET /connect returned HTTP ${grantedConnect.status} with options.baseURL=${stringAt(grantedOptions, "baseURL")}, apiKey prefix ${grantedKey.slice(0, GATEWAY_KEY_PREFIX.length)}, apiKeys.ANTHROPIC_API_KEY equal to apiKey, and no upstream secret in the body.`,
    grantedConnect.status === 200
      && stringAt(grantedOptions, "baseURL") === scopedGatewayUrl
      && grantedKey.startsWith(GATEWAY_KEY_PREFIX)
      && !grantedConnect.text.includes(FAKE_UPSTREAM_KEY),
  );

  // Negative half: the outsider has no access → connect is 403 and no key is minted for it.
  const outsiderConnect = await connect(outsider, orgId, scoped.id);
  expect(outsiderConnect.status).toBe(403);
  expect(outsiderConnect.error).toBe("forbidden");
  expect(outsiderConnect.text.includes(GATEWAY_KEY_PREFIX)).toBe(false);
  expect(outsiderConnect.text.includes(FAKE_UPSTREAM_KEY)).toBe(false);

  // --- Granted member calls the gateway; the fake upstream sees the org key only. ---
  const relayed = await gatewayMessages({ gatewayBaseUrl: scopedGatewayUrl, apiKey: grantedKey, model: modelId });
  expect(relayed.status).toBe(200);
  expect(relayed.text).toContain("message_start");
  expect(relayed.text).toContain(`"output_tokens":${UPSTREAM_OUTPUT_TOKENS}`);
  expect(relayed.requestId).not.toBe("");
  expect(upstream.requests).toHaveLength(1);
  const forwarded = upstream.requests[0];
  if (!forwarded) throw new Error("The fake upstream recorded no request.");
  expect(forwarded.method).toBe("POST");
  expect(forwarded.path).toBe("/v1/messages");
  expect(forwarded.headers["x-api-key"]).toBe(FAKE_UPSTREAM_KEY);
  expect(forwarded.headers.authorization).toBeUndefined();
  expect(forwarded.headers["anthropic-version"]).toBe("2023-06-01");
  expect(forwarded.headers["x-openwork-request-id"]).toBe(relayed.requestId);
  expect(headersContain(upstream.requests, GATEWAY_KEY_PREFIX)).toBe(false);
  expect(forwarded.body.includes(GATEWAY_KEY_PREFIX)).toBe(false);
  const forwardedBody: unknown = JSON.parse(forwarded.body);
  expect(isRecord(forwardedBody) ? forwardedBody.model : null).toBe(modelId);
  evidence.recordAssertionEvidence(
    "The gateway forwards to the org's upstream with the org credential and without the member's OpenWork key",
    `POST ${scopedGatewayUrl}/messages returned HTTP ${relayed.status} and streamed the upstream SSE; the fake upstream saw exactly one ${forwarded.method} ${forwarded.path} with x-api-key equal to the org secret, no authorization header, anthropic-version preserved, and no ow_inf_ value in any header or the body.`,
    relayed.status === 200
      && forwarded.headers["x-api-key"] === FAKE_UPSTREAM_KEY
      && forwarded.headers.authorization === undefined
      && !headersContain(upstream.requests, GATEWAY_KEY_PREFIX),
  );

  // --- One inference_request_logs row with parsed Anthropic SSE usage. ---
  const logRows = await eventually(
    () => queryDenDatabase(
      databaseUrl,
      "SELECT route, protocol, outcome, status, stream, usage_source, input_tokens, output_tokens, total_tokens, requested_model, upstream_model, upstream_host, upstream_path, upstream_provider_id, upstream_request_id, openwork_request_id, org_membership_id, inference_provider_id FROM inference_request_logs WHERE inference_provider_id = ?",
      [scoped.id],
    ),
    { within: LOG_ROW_TIMEOUT_MS, intervalMs: 500, label: `inference_request_logs row for ${scoped.id}`, until: (rows) => rows.length >= 1 },
  );
  const logRow = logRows.filter(isRecord)[0] ?? null;
  if (!logRow) throw new Error("No inference_request_logs row was written.");
  expect(logRows).toHaveLength(1);
  expect(logRow.route).toBe("org_provider");
  expect(logRow.protocol).toBe("anthropic_messages");
  expect(logRow.outcome).toBe("ok");
  expect(Number(logRow.status)).toBe(200);
  expect(Number(logRow.stream)).toBe(1);
  expect(logRow.usage_source).toBe("stream");
  expect(Number(logRow.input_tokens)).toBe(UPSTREAM_INPUT_TOKENS);
  expect(Number(logRow.output_tokens)).toBe(UPSTREAM_OUTPUT_TOKENS);
  expect(Number(logRow.total_tokens)).toBe(UPSTREAM_INPUT_TOKENS + UPSTREAM_OUTPUT_TOKENS);
  expect(logRow.requested_model).toBe(modelId);
  expect(logRow.upstream_model).toBe(modelId);
  expect(logRow.upstream_provider_id).toBe("anthropic");
  expect(logRow.upstream_host).toBe("127.0.0.1");
  expect(logRow.upstream_path).toBe("/v1/messages");
  expect(logRow.upstream_request_id).toBe(UPSTREAM_REQUEST_ID);
  expect(logRow.openwork_request_id).toBe(relayed.requestId);
  expect(logRow.org_membership_id).toBe(grantedMemberId);
  evidence.recordAssertionEvidence(
    "One request-log row records the route, protocol, member, and usage parsed from the upstream stream",
    `inference_request_logs holds exactly one row for ${scoped.id}: route=${String(logRow.route)}, protocol=${String(logRow.protocol)}, outcome=${String(logRow.outcome)}, usage_source=${String(logRow.usage_source)}, input_tokens=${String(logRow.input_tokens)}, output_tokens=${String(logRow.output_tokens)}, upstream_request_id=${String(logRow.upstream_request_id)}, org_membership_id=${String(logRow.org_membership_id)}.`,
    logRows.length === 1
      && logRow.route === "org_provider"
      && logRow.protocol === "anthropic_messages"
      && Number(logRow.input_tokens) === UPSTREAM_INPUT_TOKENS
      && Number(logRow.output_tokens) === UPSTREAM_OUTPUT_TOKENS
      && logRow.org_membership_id === grantedMemberId,
  );

  // --- Negative halves at the gateway. ---
  // The outsider gets a key through an org-wide provider, then is denied on the scoped one.
  const shared = await createInferenceProvider(den.admin, orgId, {
    name: "Anthropic via gateway (org-wide)",
    modelId,
    upstreamBaseUrl: `${upstream.baseUrl}/v1`,
    access: { allMembers: true },
  });
  const outsiderShared = await connect(outsider, orgId, shared.id);
  const outsiderKey = stringAt(outsiderShared.provider, "apiKey");
  expect(outsiderShared.status).toBe(200);
  expect(outsiderKey.startsWith(GATEWAY_KEY_PREFIX)).toBe(true);
  expect(outsiderKey).not.toBe(grantedKey);

  const upstreamRequestsBeforeDenials = upstream.requests.length;
  const denied = await gatewayMessages({ gatewayBaseUrl: scopedGatewayUrl, apiKey: outsiderKey, model: modelId });
  expect(denied.status).toBe(403);
  expect(denied.errorCode).toBe("provider_access_denied");

  const unknownId = siblingProviderId(scoped.id);
  const missing = await gatewayMessages({ gatewayBaseUrl: `${gatewayOrigin}/api/v1/providers/${unknownId}`, apiKey: grantedKey, model: modelId });
  expect(missing.status).toBe(404);
  expect(missing.errorCode).toBe("provider_not_found");

  const forged = await gatewayMessages({ gatewayBaseUrl: scopedGatewayUrl, apiKey: `${GATEWAY_KEY_PREFIX}forged_${runId}`, model: modelId });
  expect(forged.status).toBe(401);
  expect(forged.errorCode).toBe("invalid_api_key");

  expect(upstream.requests).toHaveLength(upstreamRequestsBeforeDenials);
  evidence.recordAssertionEvidence(
    "Members without access, unknown providers, and forged keys never reach the upstream",
    `With a valid key from the org-wide provider ${shared.id}, the outsider got HTTP ${denied.status} ${denied.errorCode} on ${scoped.id}; a well-formed unknown id got HTTP ${missing.status} ${missing.errorCode}; a forged ow_inf_ key got HTTP ${forged.status} ${forged.errorCode}; the fake upstream request count stayed at ${upstreamRequestsBeforeDenials}.`,
    denied.status === 403
      && denied.errorCode === "provider_access_denied"
      && missing.status === 404
      && forged.status === 401
      && upstream.requests.length === upstreamRequestsBeforeDenials,
  );

  // The denial is logged as rejected against the scoped provider; nothing is logged for the unknown id.
  const rejectedRows = await eventually(
    () => queryDenDatabase(
      databaseUrl,
      "SELECT outcome, error_code, org_membership_id FROM inference_request_logs WHERE inference_provider_id = ? AND outcome = 'rejected'",
      [scoped.id],
    ),
    { within: LOG_ROW_TIMEOUT_MS, intervalMs: 500, label: `rejected inference_request_logs row for ${scoped.id}`, until: (rows) => rows.length >= 1 },
  );
  const rejectedRow = rejectedRows.filter(isRecord)[0] ?? null;
  expect(rejectedRows).toHaveLength(1);
  expect(rejectedRow?.error_code).toBe("provider_access_denied");
  expect(rejectedRow?.org_membership_id).not.toBe(grantedMemberId);
  const unknownRows = await queryDenDatabase(databaseUrl, "SELECT id FROM inference_request_logs WHERE inference_provider_id = ?", [unknownId]);
  expect(unknownRows).toHaveLength(0);
  const okRowsAfter = await queryDenDatabase(databaseUrl, "SELECT id FROM inference_request_logs WHERE inference_provider_id = ? AND outcome = 'ok'", [scoped.id]);
  expect(okRowsAfter).toHaveLength(1);
});
