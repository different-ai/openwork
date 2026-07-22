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

type ActionItem = z.infer<typeof actionSchema>;

const previousEnv = {
  runtimeDb: process.env.OPENWORK_RUNTIME_DB,
  googleClientSecret: process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  legacyGoogleClientSecret: process.env.OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  tokenBrokerUrl: process.env.OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL,
  legacyTokenBrokerUrl: process.env.GOOGLE_WORKSPACE_TOKEN_BROKER_URL,
};

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
});

describe("Connect-aware legacy extension gating", () => {
  test("defaults to unchanged legacy extension behavior when no connect state file exists", async () => {
    const { base } = await boot();

    expectAllActions(await listActions(base));
    await expectLegacyCallPassesThrough(base);
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
    expect(cloudBody.message).toContain("agent access needs attention for this workspace");
    expect(cloudBody.message).not.toContain("not ready");
    expect(cloudBody.message).not.toContain("Repair and test");
    expect(cloudBody.message).toContain("Settings > Connect");

    const cloudStatus = await readSchema(
      await fetch(`${base}/experimental/google-workspace/status`, { headers: clientHeaders() }),
      googleWorkspaceStatusSchema,
    );
    expect(cloudStatus.connect).toEqual({
      enabled: true,
      cloudMcpPresent: false,
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
    expect(getState.connectEnabled).toBe(putState.connectEnabled);
    expect(getState.cloudMcpPresent).toBe(putState.cloudMcpPresent);
    expect(getState.googleWorkspace).toEqual(putState.googleWorkspace);
  });
});
