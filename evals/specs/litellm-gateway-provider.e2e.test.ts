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
 * LiteLLM as an AI Gateway provider, end to end, in its three key modes:
 *
 *   desktop/app ── ow_gw_ key + gwm_ alias ──▶ gateway ── LiteLLM key ──▶ LiteLLM proxy ──▶ model
 *
 *   1. One organization key   every member's request reaches LiteLLM with the shared key;
 *                             OpenWork prices it from LiteLLM's synced prices.
 *   2. Each person's own key  a member pastes their key once; their requests carry it;
 *                             OpenWork records tokens but no cost.
 *   3. OpenWork creates keys  with the admin key, OpenWork finds each member in LiteLLM by
 *                             email and creates their keys; nobody pastes anything.
 *
 * The LiteLLM proxy here is a loopback fake that keeps users, teams and keys
 * like LiteLLM v1.97 and records which key each chat request used. Where real
 * LiteLLM is surprising, the fake copies it (checked against a v1.97 proxy):
 * admin routes answer a valid non-admin key with 401, and /v1/models lists
 * every model for a key without a team while chat enforces the owner's list. Den, the
 * gateway and the fake share one machine and one scratch MySQL database; run
 * with OPENWORK_WORLD_PLACE=local (locally or inside a Daytona sandbox).
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REQUEST_TIMEOUT_MS = 30_000;
const GATEWAY_BOOT_TIMEOUT_MS = 120_000;
// Mirrors the key @openwork/testkit hands den-api; encrypted columns only decrypt when both services agree.
const DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890";
const ORG_KEY = "sk-litellm-org-000000000000";
const ADMIN_KEY = "sk-litellm-admin-0000000000";
const ALICE_KEY = "sk-litellm-alice-0000000000";
const CAROL_KEY = "sk-litellm-carol-0000000000";
const PLAIN_KEY = "sk-litellm-plain-0000000000";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Json | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function recordAt(record: Json | null | undefined, key: string): Json {
  const value = record?.[key];
  return isRecord(value) ? value : {};
}

function rowsAt(record: Json | null | undefined, key: string): Json[] {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
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

// --- Fake LiteLLM proxy ------------------------------------------------------

interface FakeKey { value: string; token: string; userId: string | null; teamId: string | null; alias: string | null; metadata: Json; createdAt: string; generated: Json }
interface ChatRecord { key: string; model: string }

interface FakeLiteLlm extends AsyncDisposable {
  baseUrl: string;
  users: Map<string, { email: string; teams: string[]; models: string[] }>;
  keys: FakeKey[];
  chats: ChatRecord[];
  generated: Json[];
  openworkKeys(): FakeKey[];
}

const TEAMS: Record<string, string[]> = { "t-research": ["gpt-4o", "claude-sonnet"], "t-design": ["gemini-pro"] };
const ALL_MODELS = ["gpt-4o", "claude-sonnet", "gemini-pro", "text-embed"];

async function startFakeLiteLlm(): Promise<FakeLiteLlm> {
  const users = new Map<string, { email: string; teams: string[]; models: string[] }>();
  const keys: FakeKey[] = [];
  const chats: ChatRecord[] = [];
  const generated: Json[] = [];
  let sequence = 0;
  const addKey = (key: Omit<FakeKey, "token" | "createdAt">) => {
    sequence += 1;
    keys.push({ ...key, token: `hash${String(sequence).padStart(4, "0")}${"0".repeat(56)}`, createdAt: new Date(Date.UTC(2026, 0, sequence)).toISOString() });
  };
  addKey({ value: ORG_KEY, userId: null, teamId: null, alias: "openwork-shared", metadata: {}, generated: {} });
  addKey({ value: ADMIN_KEY, userId: null, teamId: null, alias: null, metadata: {}, generated: {} });
  addKey({ value: PLAIN_KEY, userId: null, teamId: null, alias: "plain", metadata: {}, generated: {} });
  const isAdmin = (value: string) => value === ADMIN_KEY;
  // What LiteLLM lists on /v1/models: a key without a team sees every model.
  const modelsFor = (key: FakeKey) => {
    if (key.value === ORG_KEY) return ["gpt-4o", "claude-sonnet", "text-embed"];
    if (key.value === PLAIN_KEY) return ["gpt-4o"];
    if (key.teamId) return TEAMS[key.teamId] ?? [];
    return ALL_MODELS;
  };
  // What LiteLLM actually serves: a key without a team is held to its owner's own list.
  const callableFor = (key: FakeKey) => {
    const owner = !key.teamId && key.userId ? users.get(key.userId) : undefined;
    return owner?.models.length ? owner.models : modelsFor(key);
  };
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const httpServer: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: Json = {};
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (isRecord(parsed)) body = parsed;
      } catch {
        // an empty body; routes below reject what they need
      }
      const url = new URL(request.url ?? "/", "http://fake");
      const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      const key = keys.find((entry) => entry.value === bearer);
      if (!key) return json(response, 401, { error: { message: "Invalid key", code: "401" } });
      const admin = isAdmin(key.value);
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /v1/models") return json(response, 200, { object: "list", data: modelsFor(key).map((id) => ({ id, object: "model" })) });
      if (route === "POST /v1/chat/completions") {
        const model = stringAt(body, "model");
        if (!callableFor(key).includes(model)) return json(response, 403, { error: { message: `user not allowed to access model ${model}` } });
        chats.push({ key: key.value, model });
        return json(response, 200, {
          id: "chatcmpl-litellm", object: "chat.completion", created: 1767225600, model,
          choices: [{ index: 0, message: { role: "assistant", content: "litellm ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
        });
      }
      if (route === "GET /model_group/info") {
        return json(response, 200, { data: modelsFor(key).map((id) => ({
          model_group: id, mode: id === "text-embed" ? "embedding" : "chat", max_input_tokens: 128000, max_output_tokens: 8000,
          input_cost_per_token: 0.000002, output_cost_per_token: 0.00001, supports_function_calling: true,
        })) });
      }
      if (route === "GET /key/info") {
        if (admin) return json(response, 404, { error: { message: "Key not found in database" } });
        return json(response, 200, { info: { team_id: key.teamId, user_id: key.userId, models: [] } });
      }
      if (!admin) return json(response, 401, { error: { message: "Only proxy admin can call this route" } });
      if (route === "GET /user/info") {
        const userId = url.searchParams.get("user_id") ?? "";
        const user = users.get(userId);
        return user ? json(response, 200, { user_id: userId, user_info: { user_id: userId, models: user.models, teams: user.teams } }) : json(response, 404, { error: { message: "User not found" } });
      }
      if (route === "GET /team/list") return json(response, 200, Object.entries(TEAMS).map(([team_id, models]) => ({ team_id, team_alias: team_id.slice(2), models })));
      if (route === "GET /user/list") {
        const fragment = (url.searchParams.get("user_email") ?? "").toLowerCase();
        return json(response, 200, { users: [...users].filter(([, user]) => user.email.toLowerCase().includes(fragment))
          .map(([user_id, user]) => ({ user_id, user_email: user.email, teams: user.teams, models: user.models })) });
      }
      if (route === "GET /key/list") {
        const userId = url.searchParams.get("user_id");
        return json(response, 200, { keys: keys.filter((entry) => entry.userId === userId).map((entry) => ({
          token: entry.token, key_alias: entry.alias, team_id: entry.teamId, models: [], metadata: entry.metadata, created_at: entry.createdAt, ...entry.generated,
        })) });
      }
      if (route === "POST /key/generate") {
        generated.push(body);
        const value = `sk-litellm-issued-${String(++sequence).padStart(6, "0")}`;
        addKey({ value, userId: stringAt(body, "user_id") || null, teamId: stringAt(body, "team_id") || null, alias: stringAt(body, "key_alias") || null, metadata: recordAt(body, "metadata"), generated: body });
        return json(response, 200, { key: value, token_id: keys.at(-1)?.token });
      }
      if (route === "POST /key/delete") {
        const wanted = new Set(Array.isArray(body.keys) ? body.keys.map(String) : []);
        const gone = keys.filter((entry) => wanted.has(entry.token));
        for (const entry of gone) keys.splice(keys.indexOf(entry), 1);
        return gone.length ? json(response, 200, { deleted_keys: gone.map((entry) => entry.token) }) : json(response, 404, { error: { message: "No keys found" } });
      }
      return json(response, 404, { error: { message: `no route ${route}` } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) throw new Error("The fake LiteLLM proxy did not bind a port.");
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    users, keys, chats, generated,
    // Matches what OpenWork names the keys it creates. The org key above is excluded.
    openworkKeys: () => keys.filter((entry) => entry.alias?.startsWith("openwork-om_")),
    async [Symbol.asyncDispose]() {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

// --- Gateway process ---------------------------------------------------------

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
      GATEWAY_WEBHOOK_SECRET: "litellm-eval-webhook-secret",
      GATEWAY_PROXY_BASE_URL: `http://127.0.0.1:${input.port}`,
      GATEWAY_PUBLIC_BASE_URL: `http://127.0.0.1:${input.port}`,
      GATEWAY_EGRESS_ALLOWED_ORIGINS: input.allowedOrigin,
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

// --- Den and gateway helpers -------------------------------------------------

async function organizationId(session: DenSession, organizationName: string): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const id = stringAt(rowsAt(isRecord(result.body) ? result.body : null, "orgs").find((entry) => entry.name === organizationName), "id");
  if (!result.response.ok || !id) throw new Error(`Finding the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  return id;
}

async function memberIdByEmail(admin: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(admin, "/v1/org", { headers: orgHeaders(admin, orgId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const id = stringAt(rowsAt(isRecord(result.body) ? result.body : null, "members").find((entry) => isRecord(entry.user) && entry.user.email === email), "id");
  if (!result.response.ok || !id) throw new Error(`Finding member ${email} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  return id;
}

async function den(session: DenSession, orgId: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const result = await denFetch(session, path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: orgHeaders(session, orgId),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
  });
  return { status: result.response.status, body: isRecord(result.body) ? result.body : {}, text: result.text };
}

/** What the desktop app syncs for a member: their single ow_gw_ key and the gwm_ aliases they may use. */
async function connect(session: DenSession, orgId: string, providerId: string) {
  const result = await den(session, orgId, `/v1/inference-providers/${encodeURIComponent(providerId)}/connect`);
  const provider = recordAt(result.body, "inferenceProvider");
  return {
    status: result.status,
    key: stringAt(provider, "apiKey"),
    models: rowsAt(provider, "models").map((model) => ({ alias: stringAt(model, "id"), upstream: stringAt(model, "upstreamModelId"), group: stringAt(model, "modelGroupName") })),
    authorizationRequests: rowsAt(provider, "authorizationRequests").length,
  };
}

/** The OpenAI-compatible call the desktop makes: one Gateway key, a gwm_ alias, no provider in the path. */
async function chat(gateway: string, key: string, alias: string) {
  const response = await fetch(`${gateway}/api/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: alias, messages: [{ role: "user", content: "ping" }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, content: isRecord(body) && Array.isArray(body.choices) && isRecord(body.choices[0]) ? stringAt(recordAt(body.choices[0], "message"), "content") : "" };
}

async function lastLogRow(databaseUrl: string, providerId: string): Promise<Json> {
  const row = await eventually(async () => {
    const rows = await queryDenDatabase(databaseUrl,
      "SELECT upstream_model, status, input_tokens, output_tokens, cost_micro_usd, JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.spend_tracking')) AS spend_tracking, completed_at FROM gateway_request_logs WHERE gateway_provider_id = ? ORDER BY started_at DESC LIMIT 1",
      [providerId]);
    const row = rows[0];
    return isRecord(row) && row.completed_at !== null ? row : false;
  }, { within: 15_000, intervalMs: 250, label: `completed request log for ${providerId}` });
  if (!row) throw new Error(`No completed request log for ${providerId}.`);
  return row;
}

test("an owner connects the team's LiteLLM proxy three ways, and each member's requests reach LiteLLM with the right key", { timeout: 900_000 }, async ({ evidence, place }) => {
  needs({ commands: ["pnpm"] });
  if (place.kind !== "local" || process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) {
    throw new SkipError("co-located Den, gateway, fake LiteLLM and scratch MySQL required; run with OPENWORK_WORLD_PLACE=local (locally or inside a Daytona sandbox) and no OPENWORK_EVAL_DEN_API_URL");
  }
  if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306");
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const organizationName = `LiteLLM Gateway ${runId}`;

  await using litellm = await startFakeLiteLlm();
  const gatewayPort = await freeLoopbackPort();
  const gateway = `http://127.0.0.1:${gatewayPort}`;
  await using denServer = await server({
    place,
    web: false,
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql",
      GATEWAY_ENABLED: "true",
      GATEWAY_PROXY_BASE_URL: gateway,
      GATEWAY_PUBLIC_BASE_URL: gateway,
      // A private LiteLLM is reachable only through an operator-approved origin.
      GATEWAY_EGRESS_ALLOWED_ORIGINS: litellm.baseUrl,
    },
    org: {
      name: organizationName,
      admin: { name: "Gateway Owner" },
      members: { alice: { name: "Alice Rivera" }, bob: { name: "Bob Chen" }, carol: { name: "Carol Diaz" } },
    },
  });
  const databaseUrl = denServer.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("An isolated testkit scratch database is required.");
  const { alice, bob, carol } = denServer.members;
  if (!alice || !bob || !carol) throw new Error("The local Den did not provision every member.");
  await using gatewayApp = await startGateway({ port: gatewayPort, databaseUrl, allowedOrigin: litellm.baseUrl });
  expect(gatewayApp.baseUrl).toBe(gateway);
  const owner = denServer.admin;
  const orgId = await organizationId(owner, organizationName);
  const aliceId = await memberIdByEmail(owner, orgId, alice.email);
  const bobId = await memberIdByEmail(owner, orgId, bob.email);
  const carolId = await memberIdByEmail(owner, orgId, carol.email);
  // Alice exists in LiteLLM (two teams, plus a laptop key with a $10 budget); Bob does not.
  litellm.users.set("alice", { email: alice.email.toUpperCase(), teams: ["t-research", "t-design"], models: [] });
  // Carol is in no team and may only call claude-sonnet.
  litellm.users.set("carol", { email: carol.email, teams: [], models: ["claude-sonnet"] });
  litellm.keys.push({ value: CAROL_KEY, token: `caroltoken${"0".repeat(54)}`, userId: "carol", teamId: null, alias: "carol-laptop", metadata: {}, createdAt: "2025-12-02T00:00:00.000Z", generated: {} });
  litellm.keys.push({ value: ALICE_KEY, token: `alicetoken${"0".repeat(54)}`, userId: "alice", teamId: "t-research", alias: "alice-laptop", metadata: { owner: "it" }, createdAt: "2025-12-01T00:00:00.000Z", generated: { max_budget: 10, tpm_limit: 1000 } });

  // --- 1. One organization key ------------------------------------------------
  const shared = await den(owner, orgId, "/v1/inference-providers/litellm", { body: { name: "LiteLLM (shared key)", baseUrl: litellm.baseUrl, mode: "org", apiKey: ORG_KEY, allMembers: true } });
  expect(shared.status).toBe(201);
  const sharedId = stringAt(recordAt(shared.body, "inferenceProvider"), "id");
  const sharedStatus = recordAt(recordAt(shared.body, "inferenceProvider"), "litellm");
  expect(sharedStatus).toMatchObject({ mode: "org", spendTracking: true, modelCount: 2 });
  expect(shared.text).not.toContain(ORG_KEY);
  const aliceShared = await connect(alice, orgId, sharedId);
  expect(aliceShared.models.map((model) => model.upstream).sort()).toEqual(["claude-sonnet", "gpt-4o"]);
  const gatewayKey = aliceShared.key;
  expect(gatewayKey.startsWith("ow_gw_")).toBe(true);
  const sharedModel = aliceShared.models.find((model) => model.upstream === "gpt-4o");
  const sharedCall = await chat(gateway, gatewayKey, sharedModel?.alias ?? "");
  expect(sharedCall).toEqual({ status: 200, content: "litellm ok" });
  expect(litellm.chats.at(-1)).toEqual({ key: ORG_KEY, model: "gpt-4o" });
  const sharedLog = await lastLogRow(databaseUrl, sharedId);
  // 1000 input tokens at $2/M + 100 output tokens at $10/M, from LiteLLM's synced prices.
  expect(sharedLog).toMatchObject({ upstream_model: "gpt-4o", status: 200, input_tokens: 1000, output_tokens: 100, cost_micro_usd: 3000 });
  evidence.recordAssertionEvidence(
    "with one organization key, a member's request reaches LiteLLM with the shared key and is priced",
    `Sync found 2 chat models (the embedding model is skipped). Alice called gpt-4o with her ow_gw_ key; LiteLLM saw the organization key; OpenWork logged 1000/100 tokens at ${String(sharedLog.cost_micro_usd)} micro-USD. The key never appeared in a Den response.`,
    true,
  );

  // --- 2. Each person's own key -----------------------------------------------
  const notAdmin = await den(owner, orgId, "/v1/inference-providers/litellm", { body: { name: "LiteLLM (not admin)", baseUrl: litellm.baseUrl, mode: "member", apiKey: PLAIN_KEY, memberIds: [aliceId] } });
  expect(notAdmin.status).toBe(409);
  expect(notAdmin.body).toMatchObject({ error: "litellm_not_admin" });
  const personal = await den(owner, orgId, "/v1/inference-providers/litellm", { body: { name: "LiteLLM (personal keys)", baseUrl: `${litellm.baseUrl}/v1`, mode: "member", apiKey: ADMIN_KEY, memberIds: [aliceId, carolId] } });
  expect(personal.status).toBe(201);
  const personalId = stringAt(recordAt(personal.body, "inferenceProvider"), "id");
  const before = await connect(alice, orgId, personalId);
  expect(before.models).toEqual([]);
  expect(before.authorizationRequests).toBe(1);
  const pasted = await den(alice, orgId, `/v1/inference-providers/${personalId}/litellm/member-key`, { method: "PUT", body: { apiKey: ALICE_KEY } });
  expect(pasted.status).toBe(200);
  expect(pasted.body).toMatchObject({ connected: true, modelGroupName: "LiteLLM · research", modelIds: ["claude-sonnet", "gpt-4o"] });
  const after = await connect(alice, orgId, personalId);
  expect(after.key).toBe(gatewayKey);
  expect(after.models.map((model) => model.upstream).sort()).toEqual(["claude-sonnet", "gpt-4o"]);
  const personalCall = await chat(gateway, gatewayKey, after.models.find((model) => model.upstream === "claude-sonnet")?.alias ?? "");
  expect(personalCall.status).toBe(200);
  expect(litellm.chats.at(-1)).toEqual({ key: ALICE_KEY, model: "claude-sonnet" });
  const personalLog = await lastLogRow(databaseUrl, personalId);
  expect(personalLog).toMatchObject({ input_tokens: 1000, output_tokens: 100, cost_micro_usd: null, spend_tracking: "disabled" });
  const bobPaste = await den(bob, orgId, `/v1/inference-providers/${personalId}/litellm/member-key`, { method: "PUT", body: { apiKey: ALICE_KEY } });
  expect(bobPaste.status).toBe(403);
  // Carol's key has no team. LiteLLM lists every model for it but serves only her own list.
  const carolPaste = await den(carol, orgId, `/v1/inference-providers/${personalId}/litellm/member-key`, { method: "PUT", body: { apiKey: CAROL_KEY } });
  expect(carolPaste.status).toBe(200);
  expect(carolPaste.body).toMatchObject({ connected: true, modelIds: ["claude-sonnet"] });
  const carolModels = await connect(carol, orgId, personalId);
  expect(carolModels.models.map((model) => model.upstream)).toEqual(["claude-sonnet"]);
  expect((await chat(gateway, carolModels.key, carolModels.models[0]?.alias ?? "")).status).toBe(200);
  expect(litellm.chats.at(-1)).toEqual({ key: CAROL_KEY, model: "claude-sonnet" });
  evidence.recordAssertionEvidence(
    "with each person's own key, Alice pastes hers once and her requests carry it; Bob, without access, cannot connect",
    `A non-admin key was refused as the admin key (litellm_not_admin). Before: no models and 1 connect request. After pasting, Alice joined "LiteLLM · research" with the same ow_gw_ key; LiteLLM saw her own key for claude-sonnet; OpenWork logged tokens with no cost (spend tracking disabled). Bob's paste: HTTP ${bobPaste.status}.`,
    true,
  );
  evidence.recordAssertionEvidence(
    "a key without a team gets only the models its owner may call, not LiteLLM's over-reported list",
    `LiteLLM lists 4 models for Carol's team-less key, but her LiteLLM user may only call claude-sonnet. OpenWork granted her exactly ["claude-sonnet"], and her call reached LiteLLM with her key.`,
    true,
  );

  // --- 3. OpenWork creates each person's key ---------------------------------
  const issued = await den(owner, orgId, "/v1/inference-providers/litellm", { body: { name: "LiteLLM (created keys)", baseUrl: litellm.baseUrl, mode: "issued", apiKey: ADMIN_KEY, memberIds: [aliceId, bobId] } });
  expect(issued.status).toBe(201);
  const issuedProvider = recordAt(issued.body, "inferenceProvider");
  const issuedId = stringAt(issuedProvider, "id");
  expect(recordAt(recordAt(issued.body, "sync"), "issued")).toMatchObject({ people: 1, keys: 2, notInLiteLlm: 1 });
  expect(rowsAt(recordAt(issuedProvider, "litellm"), "attention").map((entry) => [stringAt(entry, "email"), stringAt(entry, "reason")])).toEqual([[bob.email, "not_in_litellm"]]);
  expect(litellm.openworkKeys().map((key) => [key.userId, key.teamId]).sort()).toEqual([["alice", "t-design"], ["alice", "t-research"]]);
  for (const body of litellm.generated) {
    expect(body.allowed_routes).toEqual(["llm_api_routes"]);
    for (const limit of ["max_budget", "tpm_limit", "rpm_limit", "budget_duration"]) expect(body).not.toHaveProperty(limit);
  }
  const aliceIssued = await connect(alice, orgId, issuedId);
  expect(aliceIssued.authorizationRequests).toBe(0);
  expect(aliceIssued.models.map((model) => `${model.upstream} · ${model.group}`).sort()).toEqual(["claude-sonnet · LiteLLM · research", "gemini-pro · LiteLLM · design", "gpt-4o · LiteLLM · research"]);
  const designCall = await chat(gateway, gatewayKey, aliceIssued.models.find((model) => model.upstream === "gemini-pro")?.alias ?? "");
  expect(designCall.status).toBe(200);
  const designKey = litellm.openworkKeys().find((key) => key.teamId === "t-design");
  expect(litellm.chats.at(-1)).toEqual({ key: designKey?.value, model: "gemini-pro" });
  const bobIssued = await connect(bob, orgId, issuedId);
  expect([bobIssued.models.length, bobIssued.authorizationRequests]).toEqual([0, 1]);
  evidence.recordAssertionEvidence(
    "when OpenWork creates keys, Alice gets one per LiteLLM team without doing anything, and Bob is reported as not in LiteLLM",
    `OpenWork found Alice by email (case-insensitive) and created 2 keys (research, design), each limited to model calls with no budgets set. Her gemini-pro request reached LiteLLM with the design team key. Bob has no models and is listed as not_in_litellm.`,
    true,
  );

  // A LiteLLM admin adds Bob. The next time his app refreshes its providers, OpenWork creates his key.
  litellm.users.set("bob", { email: bob.email, teams: [], models: ["gemini-pro"] });
  const refreshed = await den(bob, orgId, "/v1/inference-providers");
  expect(refreshed.status).toBe(200);
  const bobReady = await eventually(async () => {
    const state = await connect(bob, orgId, issuedId);
    return state.models.length > 0 ? state : false;
  }, { within: 20_000, intervalMs: 500, label: "Bob's models after his first refresh" });
  if (!bobReady) throw new Error("Bob never got models.");
  expect(bobReady.models.map((model) => model.upstream)).toEqual(["gemini-pro"]);
  expect(bobReady.authorizationRequests).toBe(0);
  expect(litellm.openworkKeys().filter((key) => key.userId === "bob").map((key) => key.teamId)).toEqual([null]);
  evidence.recordAssertionEvidence(
    "once a LiteLLM admin adds Bob, his next app refresh gets him a key with no action from him",
    `Bob's provider list refresh started key creation in the background; within seconds he had gemini-pro (his own LiteLLM model list, not LiteLLM's over-reported listing for keys without a team) and no connect prompt.`,
    true,
  );

  const mirrored = await den(owner, orgId, `/v1/inference-providers/${issuedId}/litellm`, { method: "PATCH", body: { issueStrategy: "mirror", mirrorFallback: "error" } });
  expect(mirrored.status).toBe(200);
  const copy = litellm.generated.at(-1) ?? {};
  expect(copy).toMatchObject({ user_id: "alice", team_id: "t-research", allowed_routes: ["llm_api_routes"], metadata: { owner: "it" } });
  expect(copy).not.toHaveProperty("max_budget");
  expect(copy).not.toHaveProperty("tpm_limit");
  expect(litellm.openworkKeys().map((key) => key.teamId)).toEqual(["t-research"]);
  evidence.recordAssertionEvidence(
    "switching to copying existing keys mirrors Alice's laptop key without its budget",
    `The copy kept team t-research and the key's metadata, dropped the $10 budget and 1000 TPM limit, and replaced both team keys. OpenWork-made keys are never used as the source.`,
    true,
  );

  const removed = await den(owner, orgId, `/v1/inference-providers/${issuedId}`, { method: "DELETE" });
  expect(removed.status).toBe(204);
  expect(litellm.openworkKeys()).toHaveLength(0);
  expect(litellm.keys.some((key) => key.value === ALICE_KEY)).toBe(true);
  evidence.recordAssertionEvidence(
    "removing the provider deletes the keys OpenWork created in LiteLLM, and only those",
    `After DELETE: 0 OpenWork-created keys left; Alice's own laptop key and the organization key are untouched.`,
    true,
  );
});
