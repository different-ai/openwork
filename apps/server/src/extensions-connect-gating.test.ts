import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const CLIENT_TOKEN = "owt_connect_client_token";
const HOST_TOKEN = "owt_connect_host_token";

const actionSchema = z.object({
  extensionId: z.string(),
  action: z.string(),
}).passthrough();

const actionsResponseSchema = z.object({
  ok: z.literal(true),
  schemaVersion: z.literal(1),
  actions: z.array(actionSchema),
}).passthrough();

const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
}).passthrough();

const connectStateResponseSchema = z.object({
  ok: z.literal(true),
  schemaVersion: z.literal(1),
  connectEnabled: z.boolean(),
  cloudMcpPresent: z.boolean(),
  googleWorkspace: z.object({ legacyConfigured: z.boolean() }),
}).passthrough();

const issuedTokenSchema = z.object({
  token: z.string(),
}).passthrough();

const gatedCallSchema = z.object({
  ok: z.literal(false),
  error: z.literal("use_openwork_cloud"),
  message: z.string(),
}).passthrough();

const googleWorkspaceStatusSchema = z.object({
  configured: z.boolean(),
  missing: z.array(z.string()),
  connected: z.boolean(),
  connect: z.object({
    enabled: z.literal(true),
    cloudMcpPresent: z.boolean(),
    guidance: z.string(),
  }).optional(),
}).passthrough();

const googleWorkspaceStatusActionSchema = z.object({
  ok: z.literal(true),
  extensionId: z.literal("google-workspace"),
  action: z.literal("status"),
  result: googleWorkspaceStatusSchema,
}).passthrough();

const generatedImageActionSchema = z.object({
  ok: z.literal(true),
  extensionId: z.literal("openai-image-generation"),
  action: z.literal("image_generate"),
  path: z.string(),
  result: z.object({
    path: z.string(),
    bytes: z.number(),
    model: z.string(),
    workspaceId: z.string(),
  }).passthrough(),
  context: z.record(z.string(), z.unknown()),
}).passthrough();

type ActionItem = z.infer<typeof actionSchema>;

const previousEnv = {
  runtimeDb: process.env.OPENWORK_RUNTIME_DB,
  googleClientSecret: process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  legacyGoogleClientSecret: process.env.OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  tokenBrokerUrl: process.env.OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL,
  legacyTokenBrokerUrl: process.env.GOOGLE_WORKSPACE_TOKEN_BROKER_URL,
  openAiApiKey: process.env.OPENAI_API_KEY,
};
const previousFetch = globalThis.fetch;

const stops: Array<() => void | Promise<void>> = [];
const dirs: string[] = [];

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "string") process.env[key] = value;
  else delete process.env[key];
}

function clearLegacyGoogleWorkspaceEnv() {
  delete process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET;
  delete process.env.OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET;
  delete process.env.OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL;
  delete process.env.GOOGLE_WORKSPACE_TOKEN_BROKER_URL;
}

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-connect-gating-"));
  dirs.push(root);
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config = serverConfig(root);
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, config };
}

function clientHeaders() {
  return { authorization: `Bearer ${CLIENT_TOKEN}` };
}

function clientJsonHeaders() {
  return { ...clientHeaders(), "content-type": "application/json" };
}

function hostJsonHeaders() {
  return { "x-openwork-host-token": HOST_TOKEN, "content-type": "application/json" };
}

async function issueViewerToken(base: string): Promise<string> {
  const response = await fetch(`${base}/tokens`, {
    method: "POST",
    headers: hostJsonHeaders(),
    body: JSON.stringify({ scope: "viewer", label: "extension-action-test" }),
  });
  expect(response.status).toBe(201);
  return (await readSchema(response, issuedTokenSchema)).token;
}

async function readSchema<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  return schema.parse(body);
}

async function listActions(base: string): Promise<ActionItem[]> {
  const response = await fetch(`${base}/experimental/extensions/actions`, { headers: clientHeaders() });
  expect(response.status).toBe(200);
  return (await readSchema(response, actionsResponseSchema)).actions;
}

function actionKeys(actions: ActionItem[]): string[] {
  return actions.map((action) => `${action.extensionId}/${action.action}`).sort();
}

async function putConnectState(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/experimental/connect/state`, {
    method: "PUT",
    headers: hostJsonHeaders(),
    body: JSON.stringify(body),
  });
}

async function callCalendarListEvents(base: string): Promise<Response> {
  return fetch(`${base}/experimental/extensions/call`, {
    method: "POST",
    headers: clientJsonHeaders(),
    body: JSON.stringify({
      extensionId: "google-workspace",
      action: "calendar_list_events",
      args: {
        timeMin: "2026-01-01T00:00:00.000Z",
        timeMax: "2026-01-02T00:00:00.000Z",
      },
      context: {},
    }),
  });
}

async function callGoogleWorkspaceStatus(base: string): Promise<Response> {
  return fetch(`${base}/experimental/extensions/call`, {
    method: "POST",
    headers: clientJsonHeaders(),
    body: JSON.stringify({
      extensionId: "google-workspace",
      action: "status",
      args: {},
      context: {},
    }),
  });
}

async function expectLegacyCallPassesThrough(base: string) {
  const response = await callCalendarListEvents(base);
  expect(response.status).toBe(400);
  const body = await readSchema(response, apiErrorSchema);
  expect(body.code).toBe("google_workspace_not_connected");
}

function expectAllActions(actions: ActionItem[]) {
  expect(actions).toHaveLength(16);
  expect(actions.filter((action) => action.extensionId === "google-workspace")).toHaveLength(14);
  expect(actions.filter((action) => action.extensionId === "openai-image-generation")).toHaveLength(2);
}

function expectActionOrder(actions: ActionItem[]) {
  expect(actions.map((action) => `${action.extensionId}/${action.action}`)).toEqual([
    "google-workspace/status",
    "google-workspace/calendar_list_events",
    "google-workspace/gmail_create_draft",
    "google-workspace/gmail_create_reply_draft",
    "google-workspace/gmail_list_messages",
    "google-workspace/gmail_get_message",
    "google-workspace/gmail_download_attachment",
    "google-workspace/drive_search_files",
    "google-workspace/drive_read_file",
    "google-workspace/drive_update_file",
    "google-workspace/calendar_create_event",
    "google-workspace/chat_list_spaces",
    "google-workspace/chat_list_messages",
    "google-workspace/chat_send_message",
    "openai-image-generation/status",
    "openai-image-generation/image_generate",
  ]);
}

beforeEach(() => {
  clearLegacyGoogleWorkspaceEnv();
});

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  restoreEnv("OPENWORK_RUNTIME_DB", previousEnv.runtimeDb);
  restoreEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", previousEnv.googleClientSecret);
  restoreEnv("OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", previousEnv.legacyGoogleClientSecret);
  restoreEnv("OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL", previousEnv.tokenBrokerUrl);
  restoreEnv("GOOGLE_WORKSPACE_TOKEN_BROKER_URL", previousEnv.legacyTokenBrokerUrl);
  restoreEnv("OPENAI_API_KEY", previousEnv.openAiApiKey);
  globalThis.fetch = previousFetch;
});

describe("Connect-aware legacy extension gating", () => {
  test("defaults to unchanged legacy extension behavior when no connect state file exists", async () => {
    const { base } = await boot();

    const actions = await listActions(base);
    expectAllActions(actions);
    expectActionOrder(actions);
    await expectLegacyCallPassesThrough(base);
  });

  test("rejects viewer calls before parsing their request body", async () => {
    const { base } = await boot();
    const viewerToken = await issueViewerToken(base);

    const viewer = await fetch(`${base}/experimental/extensions/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
      body: "{not-json",
    });
    expect(viewer.status).toBe(403);
    expect(await readSchema(viewer, apiErrorSchema)).toEqual({
      code: "forbidden",
      message: "Viewer tokens cannot call extension actions",
    });

    const collaborator = await fetch(`${base}/experimental/extensions/call`, {
      method: "POST",
      headers: clientJsonHeaders(),
      body: "{not-json",
    });
    expect(collaborator.status).toBe(400);
    expect(await readSchema(collaborator, apiErrorSchema)).toEqual({
      code: "invalid_json",
      message: "Invalid JSON body",
    });
  });

  test("preserves image generation path at both the top level and in the result", async () => {
    process.env.OPENAI_API_KEY = "test-image-key";
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === "https://api.openai.com/v1/images/generations") {
          return new Response(JSON.stringify({
            data: [{ b64_json: Buffer.from("fake png bytes").toString("base64") }],
          }), { status: 200 });
        }
        return previousFetch(input, init);
      },
      { preconnect: previousFetch.preconnect },
    );
    const { base, config } = await boot();

    const response = await fetch(`${base}/experimental/extensions/call`, {
      method: "POST",
      headers: clientJsonHeaders(),
      body: JSON.stringify({
        extensionId: "openai-image-generation",
        action: "image_generate",
        args: { prompt: "A quiet lake", filename: "quiet-lake" },
        context: { directory: config.workspaces[0]?.path },
      }),
    });
    expect(response.status).toBe(200);
    const payload = await readSchema(response, generatedImageActionSchema);
    expect(payload.path).toBe("artifacts/quiet-lake.png");
    expect(payload.result.path).toBe(payload.path);
    expect(payload.context).toEqual({ directory: config.workspaces[0]?.path });
  });

  test("keeps legacy extension behavior unchanged when connectEnabled is false", async () => {
    const { base } = await boot();
    const put = await putConnectState(base, { connectEnabled: false });
    expect(put.status).toBe(200);

    expectAllActions(await listActions(base));
    await expectLegacyCallPassesThrough(base);
    const status = await readSchema(
      await fetch(`${base}/experimental/google-workspace/status`, { headers: clientHeaders() }),
      googleWorkspaceStatusSchema,
    );
    expect(status.connect).toBeUndefined();
  });

  test("keeps legacy extension behavior unchanged when legacy Google Workspace is configured", async () => {
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "test-secret";
    const { base } = await boot();
    const put = await putConnectState(base, { connectEnabled: true });
    expect(put.status).toBe(200);

    expectAllActions(await listActions(base));
    await expectLegacyCallPassesThrough(base);
    const status = await readSchema(
      await fetch(`${base}/experimental/google-workspace/status`, { headers: clientHeaders() }),
      googleWorkspaceStatusSchema,
    );
    expect(status.connect).toBeUndefined();
    const state = await readSchema(
      await fetch(`${base}/experimental/connect/state`, { headers: clientHeaders() }),
      connectStateResponseSchema,
    );
    expect(state.googleWorkspace.legacyConfigured).toBe(true);
  });

  test("gates only non-status Google Workspace actions when Connect is enabled without legacy config", async () => {
    const { base, config } = await boot();
    const put = await putConnectState(base, { connectEnabled: true });
    expect(put.status).toBe(200);

    const actions = await listActions(base);
    expect(actionKeys(actions)).toEqual([
      "google-workspace/status",
      "openai-image-generation/image_generate",
      "openai-image-generation/status",
    ]);

    const gated = await callCalendarListEvents(base);
    expect(gated.status).toBe(200);
    const gatedBody = await readSchema(gated, gatedCallSchema);
    expect(gatedBody.message).toContain("Settings > Connect");
    expect(gatedBody.message).toContain("Do not direct them to Settings > Extensions");

    const status = await readSchema(
      await fetch(`${base}/experimental/google-workspace/status`, { headers: clientHeaders() }),
      googleWorkspaceStatusSchema,
    );
    expect(status.connect).toEqual({
      enabled: true,
      cloudMcpPresent: false,
      guidance: gatedBody.message,
    });

    const statusAction = await readSchema(await callGoogleWorkspaceStatus(base), googleWorkspaceStatusActionSchema);
    expect(statusAction.result.connect).toEqual(status.connect);

    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: {
        ...current.mcp,
        "openwork-cloud": { type: "remote", url: "https://cloud.example/mcp" },
      },
    }));

    const cloudGated = await callCalendarListEvents(base);
    const cloudBody = await readSchema(cloudGated, gatedCallSchema);
    expect(cloudBody.message).toContain("call search_capabilities");
    expect(cloudBody.message).toContain("execute_capability");
    expect(cloudBody.message).toContain("Settings > Connect");

    const cloudStatus = await readSchema(
      await fetch(`${base}/experimental/google-workspace/status`, { headers: clientHeaders() }),
      googleWorkspaceStatusSchema,
    );
    expect(cloudStatus.connect).toEqual({
      enabled: true,
      cloudMcpPresent: true,
      guidance: cloudBody.message,
    });
  });

  test("validates and round-trips the persisted connect state route", async () => {
    const { base } = await boot();
    const badType = await putConnectState(base, { connectEnabled: "true" });
    expect(badType.status).toBe(400);
    expect((await readSchema(badType, apiErrorSchema)).code).toBe("invalid_payload");

    const extraKey = await putConnectState(base, { connectEnabled: true, extra: false });
    expect(extraKey.status).toBe(400);

    const put = await putConnectState(base, { connectEnabled: true });
    expect(put.status).toBe(200);
    const putState = await readSchema(put, connectStateResponseSchema);
    expect(putState.connectEnabled).toBe(true);
    expect(putState.cloudMcpPresent).toBe(false);
    expect(putState.googleWorkspace.legacyConfigured).toBe(false);

    const get = await fetch(`${base}/experimental/connect/state`, { headers: clientHeaders() });
    expect(get.status).toBe(200);
    const getState = await readSchema(get, connectStateResponseSchema);
    expect(getState).toEqual(putState);
  });
});
