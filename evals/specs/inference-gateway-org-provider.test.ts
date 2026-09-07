import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import {
  eventually,
  localMysqlIsRunning,
  needs,
  queryDenDatabase,
  server,
  SkipError,
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
 * reaches it through `settings.upstreamBaseUrl` plus the operator's exact-origin
 * INFERENCE_EGRESS_ALLOWED_ORIGINS in BOTH processes. Den and inference share
 * one ephemeral MySQL database. Run co-located on a workstation or inside an
 * existing Daytona sandbox (OPENWORK_WORLD_PLACE=local, no attached Den URL).
 * Host-driven Daytona server() does not expose a DB handle or place this HTTP
 * witness remotely; it is a fixture gap, not missing Daytona authentication.
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
const FAKE_GOOGLE_KEY = "fake-google-upstream-key-never-leaves-the-server";
const GATEWAY_KEY_PREFIX = "ow_inf_";
const UPSTREAM_INPUT_TOKENS = 25;
const UPSTREAM_OUTPUT_TOKENS = 42;
const UPSTREAM_REQUEST_ID = "req_fake_anthropic_0001";

const execFileAsync = promisify(execFile);
const OPENCODE_BIN = process.env.OPENWORK_EVAL_OPENCODE_BIN?.trim()
  || join(REPO_ROOT, "apps/desktop/resources/sidecars", process.platform === "win32" ? "opencode.exe" : "opencode");

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
  holdNextResponse(): () => void;
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
  let heldResponse: Promise<void> | null = null;
  let releaseResponse: (() => void) | null = null;
  const httpServer: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value ?? "";
      }
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method ?? "", path: request.url ?? "", headers, body });
      const barrier = heldResponse;
      heldResponse = null;
      if (barrier) await barrier;

      const google = request.url?.startsWith("/v1beta/models/") === true;
      if (google ? headers["x-goog-api-key"] !== FAKE_GOOGLE_KEY : headers["x-api-key"] !== FAKE_UPSTREAM_KEY) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
        return;
      }
      if (request.method !== "POST" || (!google && request.url !== "/v1/messages")) {
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
      response.end(google ? `data: ${JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "gateway ok" }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: UPSTREAM_INPUT_TOKENS, candidatesTokenCount: UPSTREAM_OUTPUT_TOKENS, totalTokenCount: UPSTREAM_INPUT_TOKENS + UPSTREAM_OUTPUT_TOKENS },
      })}\n\n` : anthropicSseBody(model));
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
    holdNextResponse() {
      heldResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
      return () => releaseResponse?.();
    },
    async [Symbol.asyncDispose]() {
      releaseResponse?.();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

// --- Inference app -------------------------------------------------------

interface InferenceApp extends AsyncDisposable {
  baseUrl: string;
}

async function startInferenceApp(input: { port: number; databaseUrl: string; allowedOrigin: string }): Promise<InferenceApp> {
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
      INFERENCE_EGRESS_ALLOWED_ORIGINS: input.allowedOrigin,
      SENTRY_DSN: "",
      SENTRY_LOG_LEVEL: "off",
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

/** Read the stable fixture model and its public price through Den's catalog API. */
async function catalogModel(admin: DenSession, orgId: string, providerId: string, modelId: string) {
  const result = await denFetch(admin, `/v1/llm-provider-catalog/${encodeURIComponent(providerId)}`, {
    headers: orgHeaders(admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.provider) ? result.body.provider : null;
  const models = provider && Array.isArray(provider.models) ? provider.models.filter(isRecord) : [];
  const model = models.find((entry) => entry.id === modelId);
  const config = isRecord(model?.config) ? model.config : null;
  const cost = isRecord(config?.cost) ? config.cost : null;
  if (!result.response.ok || !config || typeof cost?.input !== "number" || typeof cost.output !== "number") {
    throw new Error(`The ${providerId} catalog entry was unavailable (HTTP ${result.response.status}): ${result.text.slice(0, 300)}`);
  }
  return { modelId, config, costMicroUsd: Math.round(UPSTREAM_INPUT_TOKENS * cost.input + UPSTREAM_OUTPUT_TOKENS * cost.output) };
}

async function createInferenceProvider(
  admin: DenSession,
  orgId: string,
  input: { name: string; modelId: string; upstreamBaseUrl: string; providerId?: "google"; access: { allMembers: true } | { memberIds: string[] } },
): Promise<{ id: string; body: Record<string, unknown>; text: string }> {
  const result = await denFetch(admin, "/v1/inference-providers", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({
      name: input.name,
      providerId: input.providerId ?? "anthropic",
      modelIds: [input.modelId],
      credential: { kind: "api_key", secret: input.providerId === "google" ? FAKE_GOOGLE_KEY : FAKE_UPSTREAM_KEY },
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

/** Raw protocol probe for denial/status assertions; native SDK calls run below. */
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

// Use the installed native OpenCode's bundled SDK, not a handcrafted fetch with
// an extra Bearer header that could hide broken x-api-key/x-goog-api-key auth.
async function nativeAdapterCall(input: { id: string; config: Record<string, unknown>; apiKeys: Record<string, string>; modelId: string; modelConfig: Record<string, unknown> }) {
  const root = await mkdtemp(join(tmpdir(), "inference-native-sdk-"));
  try {
    const result = await execFileAsync(OPENCODE_BIN, ["run", "--pure", "--format", "json", "--title", "Gateway adapter probe", "--model", `${input.id}/${input.modelId}`, "ping"], {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.env.PATH, HOME: root,
        XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          enabled_providers: [input.id], share: "disabled", permission: { "*": "deny" },
          provider: { [input.id]: {
            npm: input.config.npm, api: input.config.api, env: input.config.env, options: input.config.options,
            models: { [input.modelId]: { name: input.modelId, limit: input.modelConfig.limit, cost: input.modelConfig.cost } },
          } },
        }),
        ...input.apiKeys,
      },
    });
    expect(result.stdout.includes(FAKE_UPSTREAM_KEY)).toBe(false);
    expect(result.stdout.includes(FAKE_GOOGLE_KEY)).toBe(false);
    expect(Object.values(input.apiKeys).some((key) => `${result.stdout}${result.stderr}`.includes(key))).toBe(false);
    const events = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line): unknown => JSON.parse(line)).filter(isRecord);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "text" && isRecord(event.part) && event.part.text === "gateway ok")).toBe(true);
    expect(events.some((event) => event.type === "step_finish")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("an org inference provider routes native member requests with the org credential and finalizes write-ahead usage", { timeout: 600_000 }, async ({ evidence, place }) => {
  needs({ commands: ["pnpm", OPENCODE_BIN] });
  if (place.kind !== "local" || process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) {
    throw new SkipError("co-located Den, inference, upstream and scratch MySQL required; run this spec inside the prepared Daytona sandbox with OPENWORK_WORLD_PLACE=local and no OPENWORK_EVAL_DEN_API_URL (host-driven remote DB/upstream fixture not implemented)");
  }
  if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306");
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const organizationName = `Inference Gateway ${runId}`;

  await using upstream = await startFakeAnthropicUpstream();
  const inferencePort = await freeLoopbackPort();
  const gatewayOrigin = `http://127.0.0.1:${inferencePort}`;

  await using den = await server({
    place,
    web: false,
    env: { INFERENCE_PROXY_BASE_URL: gatewayOrigin, INFERENCE_EGRESS_ALLOWED_ORIGINS: upstream.baseUrl },
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

  await using inference = await startInferenceApp({ port: inferencePort, databaseUrl, allowedOrigin: upstream.baseUrl });
  expect(inference.baseUrl).toBe(gatewayOrigin);

  const orgId = await organizationId(den.admin, organizationName);
  const grantedMemberId = await memberIdByEmail(den.admin, orgId, granted.email);
  const outsiderMemberId = await memberIdByEmail(den.admin, orgId, outsider.email);
  // Stable, non-reasoning models with prices in both Den's catalog and inference's snapshot.
  const anthropicModel = await catalogModel(den.admin, orgId, "anthropic", "claude-3-haiku-20240307");
  const { modelId } = anthropicModel;

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
  // Same machine but a different origin is not covered by the operator exception.
  const deniedOrigin = upstream.baseUrl.replace("127.0.0.1", "localhost");
  const unapproved = await denFetch(den.admin, "/v1/inference-providers", {
    method: "POST", headers: orgHeaders(den.admin, orgId),
    body: JSON.stringify({ name: "Unapproved local origin", providerId: "anthropic", modelIds: [modelId],
      credential: { kind: "api_key", secret: FAKE_UPSTREAM_KEY }, allMembers: true,
      settings: { upstreamBaseUrl: `${deniedOrigin}/v1` },
    }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(unapproved.response.status).toBe(400);
  expect(isRecord(unapproved.body) ? unapproved.body.error : null).toBe("invalid_settings");
  expect(unapproved.text.includes(FAKE_UPSTREAM_KEY)).toBe(false);
  expect(upstream.requests).toHaveLength(0);

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
  const grantedEnv = Array.isArray(grantedConfig?.env) ? grantedConfig.env : [];
  expect(grantedEnv).toHaveLength(1);
  const envName: unknown = grantedEnv[0];
  if (typeof envName !== "string") throw new Error("Connect did not declare a credential env binding.");
  expect(envName).toMatch(/^IPR_[A-Z0-9]+_ANTHROPIC_API_KEY$/);
  expect(envName).not.toBe("ANTHROPIC_API_KEY");
  expect(Object.keys(grantedApiKeys ?? {})).toEqual([envName]);
  expect(stringAt(grantedApiKeys, envName) === grantedKey).toBe(true);
  expect(createdConfig?.env).toEqual(grantedEnv);
  expect(grantedConnect.text.includes(FAKE_UPSTREAM_KEY)).toBe(false);
  evidence.recordAssertionEvidence(
    "The granted member receives the gateway URL and an OpenWork inference key, never the org's upstream key",
    `GET /connect returned HTTP ${grantedConnect.status} with options.baseURL=${stringAt(grantedOptions, "baseURL")}, apiKey prefix ${grantedKey.slice(0, GATEWAY_KEY_PREFIX.length)}, apiKeys[${envName}] equal to apiKey, and no upstream secret in the body.`,
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
  const release = upstream.holdNextResponse();
  const relay = gatewayMessages({ gatewayBaseUrl: scopedGatewayUrl, apiKey: grantedKey, model: modelId });
  let pendingId = "";
  try {
    await eventually(() => upstream.requests.length === 1, { within: 10_000, intervalMs: 50, label: "upstream reached while response held" });
    const pendingRows = await queryDenDatabase(databaseUrl, "SELECT id, organization_id, org_membership_id, openwork_request_id, completed_at, status, usage_source, cost_micro_usd FROM inference_request_logs WHERE inference_provider_id = ?", [scoped.id]);
    expect(pendingRows).toHaveLength(1);
    const pending = pendingRows.filter(isRecord)[0];
    if (!pending) throw new Error("Upstream was reached before the write-ahead row existed.");
    pendingId = stringAt(pending, "id");
    expect(pendingId).not.toBe("");
    expect(pending.organization_id).toBe(orgId);
    expect(pending.org_membership_id).toBe(grantedMemberId);
    expect(pending.openwork_request_id).toBe(upstream.requests[0]?.headers["x-openwork-request-id"]);
    expect(pending.completed_at).toBeNull();
    expect(pending.status).toBeNull();
    expect(pending.usage_source).toBe("missing");
    expect(pending.cost_micro_usd).toBeNull();
  } finally {
    release();
    // Consume the response even when a write-ahead assertion fails.
    await relay;
  }
  const relayed = await relay;
  expect(relayed.status).toBe(200);
  expect(relayed.text).toContain("message_start");
  expect(relayed.text).toContain(`"output_tokens":${UPSTREAM_OUTPUT_TOKENS}`);
  expect(relayed.requestId).not.toBe("");
  expect(relayed.text.includes(FAKE_UPSTREAM_KEY)).toBe(false);
  expect(relayed.text.includes(grantedKey)).toBe(false);
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
      "SELECT id, organization_id, completed_at, cost_micro_usd, metadata, route, protocol, outcome, status, stream, usage_source, input_tokens, output_tokens, total_tokens, requested_model, upstream_model, upstream_host, upstream_path, upstream_provider_id, upstream_request_id, openwork_request_id, org_membership_id, inference_provider_id FROM inference_request_logs WHERE inference_provider_id = ?",
      [scoped.id],
    ),
    { within: LOG_ROW_TIMEOUT_MS, intervalMs: 500, label: `completed inference_request_logs row for ${scoped.id}`, until: (rows) => rows.some((row) => isRecord(row) && row.completed_at != null) },
  );
  const logRow = logRows.filter(isRecord)[0] ?? null;
  if (!logRow) throw new Error("No inference_request_logs row was written.");
  expect(logRows).toHaveLength(1);
  expect(logRow.id).toBe(pendingId);
  expect(logRow.organization_id).toBe(orgId);
  expect(logRow.inference_provider_id).toBe(scoped.id);
  expect(logRow.completed_at).not.toBeNull();
  expect(logRow.cost_micro_usd).not.toBeNull();
  expect(Number(logRow.cost_micro_usd)).toBe(anthropicModel.costMicroUsd);
  const metadata: unknown = typeof logRow.metadata === "string" ? JSON.parse(logRow.metadata) : logRow.metadata;
  expect(isRecord(metadata) ? metadata.cost_source : null).toBe("catalog_estimate");
  expect(JSON.stringify(logRows).includes(FAKE_UPSTREAM_KEY)).toBe(false);
  expect(JSON.stringify(logRows).includes(grantedKey)).toBe(false);
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
    "One write-ahead row is finalized with the route, protocol, member, stream usage and catalog cost",
    `Before releasing the upstream response, ${pendingId} existed with NULL completed_at/status/cost. The same row finalized for ${scoped.id}: route=${String(logRow.route)}, protocol=${String(logRow.protocol)}, outcome=${String(logRow.outcome)}, usage_source=${String(logRow.usage_source)}, input_tokens=${String(logRow.input_tokens)}, output_tokens=${String(logRow.output_tokens)}, cost_micro_usd=${String(logRow.cost_micro_usd)}, upstream_request_id=${String(logRow.upstream_request_id)}, org_membership_id=${String(logRow.org_membership_id)}.`,
    logRows.length === 1
      && logRow.route === "org_provider"
      && logRow.protocol === "anthropic_messages"
      && Number(logRow.input_tokens) === UPSTREAM_INPUT_TOKENS
      && Number(logRow.output_tokens) === UPSTREAM_OUTPUT_TOKENS
      && logRow.id === pendingId
      && Number(logRow.cost_micro_usd) === anthropicModel.costMicroUsd
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
  expect(outsiderKey === grantedKey).toBe(false);
  expect(outsiderShared.text.includes(FAKE_UPSTREAM_KEY)).toBe(false);
  const sharedConfig = isRecord(outsiderShared.provider?.providerConfig) ? outsiderShared.provider.providerConfig : null;
  const sharedEnv = Array.isArray(sharedConfig?.env) ? sharedConfig.env : [];
  expect(sharedEnv).toHaveLength(1);
  expect(sharedEnv).not.toEqual(grantedEnv);
  expect(sharedEnv[0]).toMatch(/^IPR_[A-Z0-9]+_ANTHROPIC_API_KEY$/);

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
      "SELECT outcome, error_code, org_membership_id FROM inference_request_logs WHERE inference_provider_id = ? AND outcome = 'rejected' AND completed_at IS NOT NULL",
      [scoped.id],
    ),
    { within: LOG_ROW_TIMEOUT_MS, intervalMs: 500, label: `rejected inference_request_logs row for ${scoped.id}`, until: (rows) => rows.length >= 1 },
  );
  const rejectedRow = rejectedRows.filter(isRecord)[0] ?? null;
  expect(rejectedRows).toHaveLength(1);
  expect(rejectedRow?.error_code).toBe("provider_access_denied");
  expect(rejectedRow?.org_membership_id).toBe(outsiderMemberId);
  const unknownRows = await queryDenDatabase(databaseUrl, "SELECT id FROM inference_request_logs WHERE inference_provider_id = ?", [unknownId]);
  expect(unknownRows).toHaveLength(0);
  const okRowsAfter = await queryDenDatabase(databaseUrl, "SELECT id FROM inference_request_logs WHERE inference_provider_id = ? AND outcome = 'ok'", [scoped.id]);
  expect(okRowsAfter).toHaveLength(1);

  // Den's approval alone is insufficient: inference independently needs the
  // exact operator exception. This process trusts a different origin only.
  await using blockedInference = await startInferenceApp({ port: await freeLoopbackPort(), databaseUrl, allowedOrigin: deniedOrigin });
  const blocked = await gatewayMessages({ gatewayBaseUrl: `${blockedInference.baseUrl}/api/v1/providers/${scoped.id}`, apiKey: grantedKey, model: modelId });
  expect(blocked.status).toBe(502);
  expect(blocked.errorCode).toBe("provider_misconfigured");
  expect(blocked.text.includes(FAKE_UPSTREAM_KEY)).toBe(false);
  expect(upstream.requests).toHaveLength(upstreamRequestsBeforeDenials);
  evidence.recordAssertionEvidence("Both services require the exact operator-approved origin", "Den rejected localhost at the approved port; an inference process trusting only localhost rejected Den's 127.0.0.1 destination without contacting upstream.", true);

  const googleModel = await catalogModel(den.admin, orgId, "google", "gemini-2.0-flash");
  const google = await createInferenceProvider(den.admin, orgId, {
    name: "Gemini via gateway", providerId: "google", modelId: googleModel.modelId,
    upstreamBaseUrl: `${upstream.baseUrl}/v1beta`, access: { memberIds: [grantedMemberId] },
  });
  expect(google.text.includes(FAKE_GOOGLE_KEY)).toBe(false);
  for (const native of [
    { id: scoped.id, model: anthropicModel, npm: "@ai-sdk/anthropic", header: "x-api-key", secret: FAKE_UPSTREAM_KEY, protocol: "anthropic_messages", path: "/v1/messages" },
    { id: google.id, model: googleModel, npm: "@ai-sdk/google", header: "x-goog-api-key", secret: FAKE_GOOGLE_KEY, protocol: "google_generate_content", path: `/v1beta/models/${googleModel.modelId}:streamGenerateContent` },
  ]) {
    const connection = await connect(granted, orgId, native.id);
    expect(connection.status).toBe(200);
    expect(connection.text.includes(FAKE_UPSTREAM_KEY)).toBe(false);
    expect(connection.text.includes(FAKE_GOOGLE_KEY)).toBe(false);
    const config = isRecord(connection.provider?.providerConfig) ? connection.provider.providerConfig : null;
    const apiKeys = isRecord(connection.provider?.apiKeys) ? connection.provider.apiKeys : null;
    if (!config || !apiKeys) throw new Error("Native SDK connect payload is missing config or credential bindings.");
    const key = stringAt(connection.provider, "apiKey");
    expect(key.startsWith(GATEWAY_KEY_PREFIX)).toBe(true);
    expect(key === grantedKey).toBe(true);
    expect(config.npm).toBe(native.npm);
    expect(config.api).toBe(`${gatewayOrigin}/api/v1/providers/${native.id}`);
    expect(isRecord(config.options) ? config.options.baseURL : null).toBe(config.api);
    const bindings = Object.entries(apiKeys);
    expect(bindings).toHaveLength(1);
    expect(config.env).toEqual(bindings.map(([name]) => name));
    expect(bindings.every(([name, value]) => /^IPR_[A-Z0-9]+_(?:ANTHROPIC_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY)$/.test(name) && value === key)).toBe(true);
    const before = upstream.requests.length;
    await nativeAdapterCall({ id: native.id, config, apiKeys: Object.fromEntries(bindings.map(([name]) => [name, key])), modelId: native.model.modelId, modelConfig: native.model.config });
    const sdkRequests = upstream.requests.slice(before);
    expect(sdkRequests).toHaveLength(1);
    const sdkRequest = sdkRequests[0];
    if (!sdkRequest) throw new Error("Native SDK never reached upstream.");
    const url = new URL(sdkRequest.path, upstream.baseUrl);
    expect(url.origin).toBe(upstream.baseUrl);
    expect(url.pathname).toBe(native.path);
    expect(sdkRequest.method).toBe("POST");
    expect(sdkRequest.headers[native.header] === native.secret).toBe(true);
    expect(sdkRequest.headers.authorization).toBeUndefined();
    expect(headersContain(sdkRequests, GATEWAY_KEY_PREFIX)).toBe(false);
    expect(sdkRequest.path.includes(key)).toBe(false);
    expect(sdkRequest.body.includes(key)).toBe(false);
    expect(url.searchParams.has("key")).toBe(false);
    expect(sdkRequest.headers["x-openwork-request-id"]).toBeTruthy();
    if (native.protocol === "google_generate_content") {
      expect(url.searchParams.get("alt")).toBe("sse");
      expect(sdkRequest.headers["x-api-key"]).toBeUndefined();
    } else {
      expect(sdkRequest.headers["anthropic-version"]).toBe("2023-06-01");
      expect(sdkRequest.headers["x-goog-api-key"]).toBeUndefined();
    }
    const sdkRows = await eventually(() => queryDenDatabase(databaseUrl,
      "SELECT organization_id, org_membership_id, inference_provider_id, protocol, outcome, status, usage_source, input_tokens, output_tokens, cost_micro_usd, completed_at FROM inference_request_logs WHERE openwork_request_id = ?",
      [sdkRequest.headers["x-openwork-request-id"]]),
    { within: LOG_ROW_TIMEOUT_MS, intervalMs: 500, label: `${native.npm} finalized usage`, until: (rows) => rows.some((row) => isRecord(row) && row.completed_at != null) });
    expect(sdkRows).toHaveLength(1);
    const row = sdkRows.filter(isRecord)[0];
    expect(row).toMatchObject({ organization_id: orgId, org_membership_id: grantedMemberId, inference_provider_id: native.id,
      protocol: native.protocol, outcome: "ok", usage_source: "stream" });
    expect(Number(row?.status)).toBe(200);
    expect(Number(row?.input_tokens)).toBe(UPSTREAM_INPUT_TOKENS);
    expect(Number(row?.output_tokens)).toBe(UPSTREAM_OUTPUT_TOKENS);
    expect(row?.cost_micro_usd).not.toBeNull();
    expect(Number(row?.cost_micro_usd)).toBe(native.model.costMicroUsd);
    evidence.recordAssertionEvidence(`${native.npm} native adapter authenticates without a masking Bearer header`, "Installed OpenCode decoded the gateway stream into gateway ok; one correctly routed upstream call used only the organization credential, and one finalized row retained the exact member/provider identity, usage and catalog cost.", true);
  }
  // Bounded rollup/retention, late arrivals and idempotence belong to the
  // dedicated inference-gateway-accounting.test.ts; leave these fresh rows intact.
});
