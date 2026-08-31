import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import {
  eventually,
  needs,
  queryDenDatabase,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import {
  bootCloudModelInfra,
  CLOUD_MODEL_INFRA_GATEWAY_KEY,
} from "../../worlds/cloud-model-infra.ts";
import { bootCloudModelInfraWorker } from "../../worlds/cloud-model-infra-worker.ts";

const WORKER_WORKSPACE = "/tmp/openwork-cloud-model-infra-worker";

const PROVIDER_KEY = "cloud-model-infra-witness";
const PROVIDER_NAME = "Cloud Model Infra Witness";
const MODEL_ID = "cloud-model-infra-witness-model";
const MODEL_NAME = "Infra Witness Model";
const PROVIDER_ENV = "CLOUD_INFRA_WITNESS_API_KEY";
const WITNESS_API_KEY = `wsk-${randomBytes(16).toString("hex")}`;
const REPLY_MARKER = "MODEL_CREATION_VERIFIED";
const REQUEST_TIMEOUT_MS = 15_000;

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
  commands: ["bun"],
  placement: "local",
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `cloud model infrastructure verification skipped — needs: ${missingRequirements.join(", ")}`
  : "a Den-created model materializes onto a real cloud worker runtime and answers through remote-session capabilities";

interface WitnessRequest {
  path: string;
  model: string;
  authorized: boolean;
  bodyText: string;
}

interface ModelWitness extends AsyncDisposable {
  baseUrl: string;
  requests: WitnessRequest[];
}

interface RequestLedger extends AsyncDisposable {
  url: string;
  requests: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Valid Den typeid: prefix plus a 26-char lowercase Crockford suffix whose first char keeps the 128-bit bound. */
function denId(prefix: string): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = randomBytes(26);
  let suffix = "";
  for (let index = 0; index < 26; index += 1) {
    const byte = bytes[index] ?? 0;
    suffix += index === 0 ? String(byte % 8) : alphabet[byte % 32];
  }
  return `${prefix}_${suffix}`;
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { ...auth(session), "x-openwork-org-id": orgId };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function listenOnFreePort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The witness server did not bind a TCP port.");
  return address.port;
}

/**
 * Deterministic OpenAI-compatible model provider. It records every request,
 * enforces the exact witness credential, and streams a fixed reply
 * containing REPLY_MARKER so runtime execution is observable without any
 * real provider.
 */
async function startModelWitness(): Promise<ModelWitness> {
  const requests: WitnessRequest[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    if (request.method === "GET" && path.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      let rawBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        rawBody += chunk;
      });
      request.on("end", () => {
        let model = "";
        try {
          const parsed: unknown = JSON.parse(rawBody);
          if (isRecord(parsed) && typeof parsed.model === "string") model = parsed.model;
        } catch {
          model = "";
        }
        const authorized = request.headers.authorization === `Bearer ${WITNESS_API_KEY}`;
        requests.push({ path, model, authorized, bodyText: rawBody });
        if (!authorized) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "invalid witness credential" } }));
          return;
        }
        const chunks = [
          { id: "chatcmpl-infra", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "chatcmpl-infra", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `${REPLY_MARKER}: the created model executed this turn.` }, finish_reason: null }] },
          { id: "chatcmpl-infra", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `unexpected witness path ${path}` } }));
  });
  const port = await listenOnFreePort(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    async [Symbol.asyncDispose]() {
      await closeServer(server);
    },
  };
}

/**
 * Daytona request ledger: DAYTONA_API_URL points here, so the assertion
 * "the healthy-worker path never calls the Daytona SDK" is observable —
 * any unexpected call is recorded and answered with HTTP 500.
 */
async function startDaytonaLedger(): Promise<RequestLedger> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? ""}`);
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "the cloud model infra world must not reach the Daytona API" }));
  });
  const port = await listenOnFreePort(server);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async [Symbol.asyncDispose]() {
      await closeServer(server);
    },
  };
}

interface WorkerRuntime {
  openworkUrl: string;
  clientToken: string;
  hostToken: string;
}

function workerClientHeaders(runtime: WorkerRuntime): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${runtime.clientToken}`,
  };
}

function workerHostHeaders(runtime: WorkerRuntime): Record<string, string> {
  return {
    Accept: "application/json",
    "x-openwork-host-token": runtime.hostToken,
  };
}

async function workerJson(
  runtime: WorkerRuntime,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${runtime.openworkUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

interface McpToolResult {
  isError: boolean;
  text: string;
  payload: Record<string, unknown>;
}

function parseMcpToolResult(result: unknown): McpToolResult {
  if (!isRecord(result)) throw new Error(`MCP tools/call returned a non-object result: ${JSON.stringify(result)}`);
  const content = Array.isArray(result.content) ? result.content.filter(isRecord) : [];
  const text = content
    .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
    .filter((entry) => entry.length > 0)
    .join("\n");
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) payload = parsed;
  } catch {
    payload = {};
  }
  return { isError: result.isError === true, text, payload };
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 20 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);

  // ── Deterministic witnesses: model provider + Daytona request ledger ──
  await using witness = await startModelWitness();
  await using daytonaLedger = await startDaytonaLedger();
  await using stack = new AsyncDisposableStack();

  // ── A fresh Cloud-enabled Den whose Daytona endpoint is the ledger ──
  const world = await bootCloudModelInfra(stack, place, { daytonaApiUrl: daytonaLedger.url });
  const databaseUrl = world.den.database?.url;
  if (!databaseUrl) throw new Error("The cloud model infra world did not expose its ephemeral database.");
  const admin = world.admin;
  const orgId = world.org.id;

  // ── A real worker runtime: source-first openwork-server + managed engine ──
  const workerWorldName = `cloud-model-infra-worker-${process.pid}`;
  const worker = await bootCloudModelInfraWorker(stack, {
    name: workerWorldName,
    workspace: WORKER_WORKSPACE,
    replace: true,
  });
  expect(worker.reused).toBe(false);
  const workerManifest = worker.manifest;
  const runtime: WorkerRuntime = {
    openworkUrl: workerManifest.openworkUrl,
    clientToken: workerManifest.token,
    hostToken: workerManifest.hostToken,
  };
  await eventually(
    async () => (await fetch(workerManifest.healthUrl).catch(() => null))?.ok === true,
    { within: 90_000, intervalMs: 1_000, label: "worker openwork-server healthy" },
  );
  // Provider materialization requires the managed engine, not only the HTTP
  // server: gate on the engine config mount before Den ever probes it.
  await eventually(
    async () => {
      const config = await workerJson(runtime, "/opencode/config", workerClientHeaders(runtime)).catch(() => null);
      return config !== null && config.status === 200 && isRecord(config.body);
    },
    { within: 180_000, intervalMs: 2_000, label: "managed OpenCode engine attached" },
  );
  evidence.recordAssertionEvidence(
    "The world provides a genuine worker runtime",
    `A source-first openwork-server (${runtime.openworkUrl}) answered /health and its managed OpenCode engine served /opencode/config.`,
    true,
  );

  // ── Boundary 1: Den model creation over REST ──
  const createResult = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({
      name: PROVIDER_NAME,
      source: "custom",
      customConfig: {
        id: PROVIDER_KEY,
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        env: [PROVIDER_ENV],
        api: witness.baseUrl,
        models: [{ id: MODEL_ID, name: MODEL_NAME }],
      },
      apiKey: WITNESS_API_KEY,
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const createdProvider = isRecord(createResult.body) && isRecord(createResult.body.llmProvider)
    ? createResult.body.llmProvider
    : {};
  const llmProviderId = typeof createdProvider.id === "string" ? createdProvider.id : "";
  expect(createResult.response.status, createResult.text.slice(0, 500)).toBe(201);
  expect(llmProviderId).toMatch(/^lpr_/);
  expect(createdProvider.hasApiKey).toBe(true);
  expect(createResult.text).not.toContain(WITNESS_API_KEY);
  const providerModels = await queryDenDatabase(
    databaseUrl,
    "SELECT model_id FROM llm_provider_model WHERE llm_provider_id = ? ORDER BY model_id",
    [llmProviderId],
  );
  const modelRows = providerModels.filter(isRecord).map((row) => row.model_id);
  expect(modelRows).toEqual([MODEL_ID]);
  evidence.recordAssertionEvidence(
    "Model creation persists exactly the requested provider and model",
    `POST /v1/llm-providers returned 201 for ${llmProviderId} with hasApiKey=true, the durable model rows are ${JSON.stringify(modelRows)}, and the response never echoed the raw credential.`,
    createResult.response.status === 201
      && /^lpr_/.test(llmProviderId)
      && createdProvider.hasApiKey === true
      && !createResult.text.includes(WITNESS_API_KEY),
  );

  // ── Attach the member-owned cloud worker at the database seam ──
  const userRows = await queryDenDatabase(
    databaseUrl,
    "SELECT id FROM `user` WHERE email = ? LIMIT 1",
    [admin.email],
  );
  const adminUserId = userRows.filter(isRecord).map((row) => row.id).find((id) => typeof id === "string");
  if (typeof adminUserId !== "string" || adminUserId.length === 0) {
    throw new Error(`Could not resolve the admin user id for ${admin.email}.`);
  }
  const workerId = denId("wrk");
  await queryDenDatabase(
    databaseUrl,
    `INSERT INTO worker
      (id, org_id, created_by_user_id, name, description, destination, status,
       image_version, workspace_path, sandbox_backend, last_heartbeat_at, last_active_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'cloud', 'healthy', NULL, NULL, 'cloud-instance', NULL, NULL, NOW(3), NOW(3))`,
    [workerId, orgId, adminUserId, "Cloud Model Infra Worker"],
  );
  const tokenRows: ReadonlyArray<readonly [string, string]> = [
    ["client", runtime.clientToken],
    ["host", runtime.hostToken],
    ["activity", randomBytes(32).toString("hex")],
  ];
  for (const [scope, token] of tokenRows) {
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO worker_token (id, worker_id, scope, token, created_at, revoked_at) VALUES (?, ?, ?, ?, NOW(3), NULL)",
      [denId("wkt"), workerId, scope, token],
    );
  }
  await queryDenDatabase(
    databaseUrl,
    `INSERT INTO daytona_sandbox
      (id, worker_id, sandbox_id, workspace_volume_id, data_volume_id,
       signed_preview_url, signed_preview_url_expires_at, region, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL 12 HOUR), NULL, NOW(3), NOW(3))`,
    [denId("dts"), workerId, `sbx-cloud-model-infra-${process.pid}`, "vol-workspace", "vol-data", runtime.openworkUrl],
  );

  const instance = await eventually(
    async () => denFetch(admin, "/v1/cloud/instance", {
      headers: orgHeaders(admin, orgId),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
    {
      within: 60_000,
      intervalMs: 2_000,
      label: "seeded cloud worker resolves ready",
      until: (result) => result.response.ok && isRecord(result.body) && result.body.status === "ready",
    },
  );
  const workerCountRows = await queryDenDatabase(
    databaseUrl,
    "SELECT COUNT(*) AS workers FROM worker WHERE org_id = ? AND created_by_user_id = ?",
    [orgId, adminUserId],
  );
  const workerCount = workerCountRows.filter(isRecord).map((row) => Number(row.workers))[0] ?? 0;
  expect(workerCount).toBe(1);
  evidence.recordAssertionEvidence(
    "The member's cloud runtime is the seeded worker, not a new provisioning run",
    `GET /v1/cloud/instance reported ${JSON.stringify(instance.body)} while exactly ${workerCount} worker row exists for the member and the Daytona ledger stayed empty (${daytonaLedger.requests.length} requests).`,
    isRecord(instance.body) && instance.body.status === "ready" && workerCount === 1 && daytonaLedger.requests.length === 0,
  );

  // ── Boundary 2: gateway resolve triggers real materialization ──
  const resolve = await eventually(
    async () => denFetch(admin, "/v1/cloud/gateway/resolve", {
      headers: { ...orgHeaders(admin, orgId), "x-openwork-gateway-key": CLOUD_MODEL_INFRA_GATEWAY_KEY },
      signal: AbortSignal.timeout(30_000),
    }),
    {
      within: 180_000,
      intervalMs: 3_000,
      label: "gateway resolve with applied provider materialization",
      until: (result) => {
        if (!result.response.ok || !isRecord(result.body)) return false;
        if (result.body.status !== "ready") return false;
        const sync = result.body.providerSync;
        return sync === undefined || (isRecord(sync) && sync.status !== "degraded");
      },
    },
  );
  const resolveBody = isRecord(resolve.body) ? resolve.body : {};
  expect(resolveBody.status).toBe("ready");
  expect(resolveBody.url).toBe(runtime.openworkUrl);
  expect(resolveBody.clientToken).toBe(runtime.clientToken);
  expect(resolveBody.hostToken).toBe(runtime.hostToken);
  expect(resolve.text).not.toContain(WITNESS_API_KEY);

  const envEntry = await workerJson(runtime, `/env/${PROVIDER_ENV}`, workerHostHeaders(runtime));
  const envValue = isRecord(envEntry.body) && isRecord(envEntry.body.item) ? envEntry.body.item.value : null;
  expect(envEntry.status).toBe(200);
  expect(envValue).toBe(WITNESS_API_KEY);
  const runtimeProviders = await workerJson(runtime, "/runtime-config/providers", workerHostHeaders(runtime));
  const runtimeProviderMap = isRecord(runtimeProviders.body) && isRecord(runtimeProviders.body.provider)
    ? runtimeProviders.body.provider
    : {};
  const materializedProvider = isRecord(runtimeProviderMap[llmProviderId]) ? runtimeProviderMap[llmProviderId] : {};
  expect(materializedProvider.npm).toBe("@ai-sdk/openai-compatible");
  expect(materializedProvider.api).toBe(witness.baseUrl);
  evidence.recordAssertionEvidence(
    "Gateway resolve materialized the created model onto the worker",
    `Resolve returned ready with the seeded preview URL and worker tokens plus providerSync=${JSON.stringify(resolveBody.providerSync ?? null)}; the worker env store now holds ${PROVIDER_ENV} and /runtime-config/providers contains ${llmProviderId} pointing at the witness endpoint.`,
    resolveBody.url === runtime.openworkUrl
      && envValue === WITNESS_API_KEY
      && materializedProvider.npm === "@ai-sdk/openai-compatible"
      && materializedProvider.api === witness.baseUrl,
  );

  // ── Boundary 3: the engine itself discovers the created model ──
  const engineConfig = await eventually(
    async () => workerJson(runtime, "/opencode/config", workerClientHeaders(runtime)),
    {
      within: 90_000,
      intervalMs: 2_000,
      label: "engine config lists the materialized provider",
      until: (result) => {
        if (result.status !== 200 || !isRecord(result.body)) return false;
        const providers = isRecord(result.body.provider) ? result.body.provider : {};
        const entry = providers[llmProviderId];
        if (!isRecord(entry)) return false;
        const models = isRecord(entry.models) ? entry.models : {};
        return isRecord(models[MODEL_ID]);
      },
    },
  );
  const engineProviders = isRecord(engineConfig.body) && isRecord(engineConfig.body.provider)
    ? engineConfig.body.provider
    : {};
  const managedEntries = Object.keys(engineProviders).filter((key) => key === llmProviderId);
  expect(managedEntries).toHaveLength(1);
  evidence.recordAssertionEvidence(
    "The OpenCode engine discovers the created provider and model",
    `GET /opencode/config exposes exactly one ${llmProviderId} provider entry whose models include ${MODEL_ID}.`,
    managedEntries.length === 1,
  );

  // ── Boundary 4: remote-session capabilities execute the created model ──
  const mintResult = await denFetch(admin, "/v1/mcp/token", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const mcpToken = isRecord(mintResult.body) && typeof mintResult.body.token === "string" ? mintResult.body.token : "";
  expect(mintResult.response.ok, mintResult.text.slice(0, 500)).toBe(true);
  expect(mcpToken.length).toBeGreaterThan(0);
  let requestId = 0;
  const callTool = async (
    token: string,
    name: "search_capabilities" | "execute_capability",
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const response = await fetch(`${world.den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`MCP tools/call failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
    const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error(`MCP tools/call returned no SSE data frame: ${raw.slice(0, 500)}`);
    const payload: unknown = JSON.parse(dataLine.slice(5));
    if (!isRecord(payload)) throw new Error(`MCP tools/call returned a non-object frame: ${raw.slice(0, 500)}`);
    if (payload.error) throw new Error(`MCP tools/call returned JSON-RPC error: ${JSON.stringify(payload.error)}`);
    return payload.result;
  };

  const search = parseMcpToolResult(await callTool(mcpToken, "search_capabilities", { query: "remote session" }));
  expect(search.isError).toBe(false);
  expect(search.text).toContain("remote-session:create");

  const prompt = "Reply with the deterministic infrastructure marker.";
  let sessionId = "";
  let sessionWorkspaceId = "";
  await eventually(
    async () => {
      const created = parseMcpToolResult(await callTool(mcpToken, "execute_capability", {
        name: "remote-session:create",
        body: {
          title: "Cloud model infra verification",
          prompt,
          model: { providerId: llmProviderId, modelId: MODEL_ID },
        },
      }));
      if (created.isError || typeof created.payload.sessionId !== "string") return false;
      sessionId = created.payload.sessionId;
      sessionWorkspaceId = typeof created.payload.workspaceId === "string" ? created.payload.workspaceId : "";
      return sessionId.length > 0 && sessionWorkspaceId.length > 0;
    },
    { within: 120_000, intervalMs: 3_000, label: "remote-session:create succeeded on the worker runtime" },
  );

  const finalRead = await eventually(
    async () => parseMcpToolResult(await callTool(mcpToken, "execute_capability", {
      name: "remote-session:read",
      body: { sessionId },
    })),
    {
      within: 180_000,
      intervalMs: 3_000,
      label: "remote-session:read observes the deterministic model reply",
      until: (read) => {
        if (read.isError) return false;
        return read.payload.status === "idle" && String(read.payload.finalAssistantText ?? "").includes(REPLY_MARKER);
      },
    },
  );
  expect(finalRead.text).not.toContain(WITNESS_API_KEY);

  const modelRequests = witness.requests.filter((request) => request.model === MODEL_ID);
  const unauthorizedRequests = witness.requests.filter((request) => !request.authorized);
  const promptRequests = modelRequests.filter((request) => request.bodyText.includes(prompt));
  expect(modelRequests.length).toBeGreaterThanOrEqual(1);
  expect(promptRequests.length).toBeGreaterThanOrEqual(1);
  expect(unauthorizedRequests).toEqual([]);

  const sessionsList = await workerJson(
    runtime,
    `/workspace/${encodeURIComponent(sessionWorkspaceId)}/opencode/session`,
    workerClientHeaders(runtime),
  );
  const sessionItems = Array.isArray(sessionsList.body)
    ? sessionsList.body.filter(isRecord)
    : [];
  const listedSession = sessionItems.find((item) => item.id === sessionId);
  expect(listedSession, `session ${sessionId} missing from the worker session list`).toBeDefined();
  evidence.recordAssertionEvidence(
    "The created model executes a real remote session end to end",
    `remote-session:create/read ran session ${sessionId} to idle with a reply containing ${REPLY_MARKER}; the witness observed ${modelRequests.length} request(s) for ${MODEL_ID} (${promptRequests.length} carrying the prompt, ${unauthorizedRequests.length} unauthorized), and the worker session list the web UI renders contains the session.`,
    modelRequests.length >= 1
      && promptRequests.length >= 1
      && unauthorizedRequests.length === 0
      && listedSession !== undefined,
  );

  // ── Authorization boundary: a read-only MCP token cannot create ──
  const readOnlyMint = await denFetch(admin, "/v1/mcp/token", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const readOnlyToken = isRecord(readOnlyMint.body) && typeof readOnlyMint.body.token === "string"
    ? readOnlyMint.body.token
    : "";
  expect(readOnlyToken.length).toBeGreaterThan(0);
  const denied = parseMcpToolResult(await callTool(readOnlyToken, "execute_capability", {
    name: "remote-session:create",
    body: { title: "Denied session" },
  }));
  expect(denied.isError).toBe(true);
  expect(denied.text).toContain("mcp:write");
  evidence.recordAssertionEvidence(
    "Session creation requires the write scope",
    `A default read-only MCP token was refused by remote-session:create with: ${denied.text.slice(0, 200)}`,
    denied.isError && denied.text.includes("mcp:write"),
  );

  // ── Idempotency and infrastructure hygiene ──
  const secondResolve = await denFetch(admin, "/v1/cloud/gateway/resolve", {
    headers: { ...orgHeaders(admin, orgId), "x-openwork-gateway-key": CLOUD_MODEL_INFRA_GATEWAY_KEY },
    signal: AbortSignal.timeout(30_000),
  });
  const secondResolveBody = isRecord(secondResolve.body) ? secondResolve.body : {};
  const secondSync = secondResolveBody.providerSync;
  expect(secondResolveBody.status).toBe("ready");
  expect(secondSync === undefined || (isRecord(secondSync) && secondSync.status !== "degraded")).toBe(true);
  const configAfterSecondResolve = await workerJson(runtime, "/opencode/config", workerClientHeaders(runtime));
  const providersAfterSecondResolve = isRecord(configAfterSecondResolve.body) && isRecord(configAfterSecondResolve.body.provider)
    ? Object.keys(configAfterSecondResolve.body.provider).filter((key) => key.startsWith("lpr_"))
    : [];
  expect(providersAfterSecondResolve).toEqual([llmProviderId]);
  expect(daytonaLedger.requests, `unexpected Daytona SDK traffic: ${JSON.stringify(daytonaLedger.requests)}`).toEqual([]);
  evidence.recordAssertionEvidence(
    "Re-resolving is idempotent and the Daytona API is never touched",
    `A second gateway resolve stayed ready without degradation, the engine still lists exactly ${JSON.stringify(providersAfterSecondResolve)}, and the Daytona request ledger recorded zero calls for the entire run.`,
    providersAfterSecondResolve.length === 1 && daytonaLedger.requests.length === 0,
  );
});
