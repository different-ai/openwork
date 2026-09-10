import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { EnvService } from "./env-file.js";
import { callExperimentalExtensionAction } from "./extensions/index.js";
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
  status: z.enum(["available", "missing", "invalid", "unreadable"]),
  connectEnabled: z.boolean(),
  cloudMcpPresent: z.boolean(),
}).passthrough();

const gatedCallSchema = z.object({
  ok: z.literal(false),
  error: z.literal("use_openwork_cloud"),
  message: z.string(),
  nextAction: z.object({
    code: z.string().optional(),
    stage: z.string().optional(),
    recommendedAction: z.string().optional(),
    tool: z.string().optional(),
    arguments: z.object({ query: z.string() }).optional(),
  }),
}).passthrough();

type ActionItem = z.infer<typeof actionSchema>;

const previousEnv = {
  runtimeDb: process.env.OPENWORK_RUNTIME_DB,
  googleClientSecret: process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  legacyGoogleClientSecret: process.env.OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  tokenBrokerUrl: process.env.OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL,
  legacyTokenBrokerUrl: process.env.GOOGLE_WORKSPACE_TOKEN_BROKER_URL,
  plaintextVault: process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT,
  devMode: process.env.OPENWORK_DEV_MODE,
};

const nativeFetch = globalThis.fetch;
const externalRequests: string[] = [];
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

async function boot(withLegacyData = false) {
  const root = await mkdtemp(join(tmpdir(), "openwork-connect-gating-"));
  dirs.push(root);
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config = serverConfig(root);
  const legacyFiles = new Map<string, string>();
  if (withLegacyData) {
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "retired-test-secret";
    process.env.OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "retired-test-secret";
    process.env.OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL = "https://broker.example.test/token";
    process.env.GOOGLE_WORKSPACE_TOKEN_BROKER_URL = "https://broker.example.test/token";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.OPENWORK_DEV_MODE = "1";
    const directory = join(root, "extensions", "google-workspace");
    await mkdir(directory, { recursive: true });
    legacyFiles.set(join(directory, "oauth.dev-plaintext.json"), JSON.stringify({
      version: 2,
      activeAccountId: "legacy-account",
      accounts: [{
        account: { sub: "legacy-account", email: "legacy@example.test" },
        scopes: ["openid", "https://www.googleapis.com/auth/calendar.readonly"],
        token: { accessToken: "retired-access-token", refreshToken: "retired-refresh-token", expiresAt: 0 },
      }],
    }));
    legacyFiles.set(join(directory, "oauth.vault"), "retired-encrypted-vault");
    legacyFiles.set(join(root, "extensions", "vault.key"), "retired-vault-key");
    for (const [path, bytes] of legacyFiles) await writeFile(path, bytes);
  }
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, config, root, legacyFiles };
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

async function listActions(base: string, extensionId = ""): Promise<ActionItem[]> {
  const response = await fetch(`${base}/experimental/extensions/actions?extensionId=${encodeURIComponent(extensionId)}`, { headers: clientHeaders() });
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

async function callLegacyAction(base: string, action = "calendar_list_events"): Promise<Response> {
  return fetch(`${base}/experimental/extensions/call`, {
    method: "POST",
    headers: clientJsonHeaders(),
    body: JSON.stringify({
      extensionId: "google-workspace",
      action,
      args: {
        timeMin: "2026-01-01T00:00:00.000Z",
        timeMax: "2026-01-02T00:00:00.000Z",
      },
      context: {},
    }),
  });
}

beforeEach(() => {
  clearLegacyGoogleWorkspaceEnv();
  externalRequests.length = 0;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname !== "127.0.0.1") {
      externalRequests.push(url.toString());
      throw new Error("Unexpected external request in local Google retirement test");
    }
    return nativeFetch(input, init);
  }, { preconnect: nativeFetch.preconnect });
});

afterEach(async () => {
  globalThis.fetch = nativeFetch;
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
  restoreEnv("OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT", previousEnv.plaintextVault);
  restoreEnv("OPENWORK_DEV_MODE", previousEnv.devMode);
});

describe("Cloud-only Google Workspace extension retirement", () => {
  for (const withLegacyData of [false, true]) {
    for (const connectEnabled of [undefined, false, true]) {
      test(`never lists or executes local Google actions with legacy data=${withLegacyData}, Connect=${connectEnabled}`, async () => {
        const { base, legacyFiles } = await boot(withLegacyData);
        if (connectEnabled !== undefined) {
          expect((await putConnectState(base, { connectEnabled })).status).toBe(200);
        }
        expect(actionKeys(await listActions(base))).toEqual([
          "openai-image-generation/image_generate",
          "openai-image-generation/status",
          "openwork-cloud-uploads/drive_upload_file",
          "openwork-cloud-uploads/gmail_create_draft_with_attachments",
        ]);
        // A stale installed client can still request the retired extension id directly.
        expect(await listActions(base, "google-workspace")).toEqual([]);
        for (const action of [
          "status", "calendar_list_events", "calendar_create_event", "gmail_create_draft",
          "gmail_create_reply_draft", "gmail_list_messages", "gmail_get_message",
          "gmail_download_attachment", "drive_search_files", "drive_read_file", "drive_update_file",
          "chat_list_spaces", "chat_list_messages", "chat_send_message", "connect", "disconnect", "unknown",
        ]) {
          const response = await callLegacyAction(base, action);
          expect(response.status).toBe(200);
          const body = await readSchema(response, gatedCallSchema);
          expect(body.nextAction.recommendedAction).toBe("Connect OpenWork Cloud");
          expect(body.message).toContain("local credentials cannot be used");
          expect(body).not.toHaveProperty("connected");
          expect(body).not.toHaveProperty("result");
        }
        const state = await readSchema(
          await fetch(`${base}/experimental/connect/state`, { headers: clientHeaders() }),
          connectStateResponseSchema,
        );
        expect(state).not.toHaveProperty("googleWorkspace");
        expect(externalRequests).toEqual([]);
        for (const [path, bytes] of legacyFiles) expect(await readFile(path, "utf8")).toBe(bytes);
      });
    }
  }

  test("returns the exact Cloud health next action rather than inferring Google authorization", async () => {
    const { base, config } = await boot(true);
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: { ...current.mcp, "openwork-cloud": { type: "remote", url: "https://cloud.example.test/mcp/agent" } },
    }));
    const stateSchema = z.object({
      cloudHealth: z.object({
        firstFailure: z.object({ code: z.string(), stage: z.string(), recommendedAction: z.string() }),
      }),
    });
    const state = await readSchema(await fetch(`${base}/experimental/connect/state`, { headers: clientHeaders() }), stateSchema);
    const result = await readSchema(await callLegacyAction(base), gatedCallSchema);
    expect(result.nextAction).toEqual(state.cloudHealth.firstFailure);
    expect(result.message).not.toContain("Google Workspace is connected");
    expect(externalRequests).toEqual([]);
  });

  test("missing snapshot never falls back to stored local OAuth or invents a member connection status", async () => {
    const { config, root } = await boot(true);
    const result = gatedCallSchema.parse(await callExperimentalExtensionAction(
      config,
      new EnvService({ path: join(root, "env.json") }),
      { extensionId: "google-workspace", action: "calendar_list_events", args: {} },
    ));
    expect(result.nextAction).toEqual({ recommendedAction: "Open Settings > Library > Connections to check your Cloud connections, or Settings > Debug to diagnose OpenWork Cloud agent access for this workspace." });
    expect(result).not.toHaveProperty("connected");
    expect(externalRequests).toEqual([]);
  });

  test("validates and round-trips the persisted connect state route", async () => {
    const { base, root } = await boot();
    const initialState = await readSchema(
      await fetch(`${base}/experimental/connect/state`, { headers: clientHeaders() }),
      connectStateResponseSchema,
    );
    expect(initialState).toMatchObject({ status: "missing", connectEnabled: false });

    const statePath = join(root, "connect-state.json");
    await writeFile(statePath, "{not valid json", "utf8");
    const invalidState = await readSchema(
      await fetch(`${base}/experimental/connect/state`, { headers: clientHeaders() }),
      connectStateResponseSchema,
    );
    expect(invalidState).toMatchObject({ status: "invalid", connectEnabled: false });

    await rm(statePath);
    await mkdir(statePath);
    const unreadableState = await readSchema(
      await fetch(`${base}/experimental/connect/state`, { headers: clientHeaders() }),
      connectStateResponseSchema,
    );
    expect(unreadableState).toMatchObject({ status: "unreadable", connectEnabled: false });
    await rm(statePath, { recursive: true });

    const badType = await putConnectState(base, { connectEnabled: "true" });
    expect(badType.status).toBe(400);
    expect((await readSchema(badType, apiErrorSchema)).code).toBe("invalid_payload");

    const extraKey = await putConnectState(base, { connectEnabled: true, extra: false });
    expect(extraKey.status).toBe(400);

    const put = await putConnectState(base, { connectEnabled: true });
    expect(put.status).toBe(200);
    const putState = await readSchema(put, connectStateResponseSchema);
    expect(putState.status).toBe("available");
    expect(putState.connectEnabled).toBe(true);
    expect(putState.cloudMcpPresent).toBe(false);
    expect(putState).not.toHaveProperty("googleWorkspace");

    const get = await fetch(`${base}/experimental/connect/state`, { headers: clientHeaders() });
    expect(get.status).toBe(200);
    const getState = await readSchema(get, connectStateResponseSchema);
    expect(getState.status).toBe("available");
    expect(getState.connectEnabled).toBe(putState.connectEnabled);
    expect(getState.cloudMcpPresent).toBe(putState.cloudMcpPresent);
    expect(getState).not.toHaveProperty("googleWorkspace");
  });
});
