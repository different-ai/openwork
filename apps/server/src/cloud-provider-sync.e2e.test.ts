import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnvService } from "./env-file.js";
import { readOpenworkWorkspaceConfig, writeOpenworkWorkspaceConfig } from "./openwork-workspace-config-store.js";
import {
  readGlobalRuntimeOpencodeConfig,
  readRuntimeOpencodeConfig,
  runtimeProviderMap,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const clientToken = "owt_cloud_provider_client";
const hostToken = "owt_cloud_provider_host";
const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
const previousEnvStore = process.env.OPENWORK_ENV_STORE;
const previousInterval = process.env.OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS;

type FakeModel = {
  id: string;
  name: string;
  config: Record<string, unknown>;
};

type FakeProvider = {
  id: string;
  providerId: string;
  name: string;
  source: string;
  updatedAt: string;
  providerConfig: Record<string, unknown>;
  apiKey: string;
  apiKeys: Record<string, string> | null;
  models: FakeModel[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected ${label}`);
  return value;
}

function clientHeaders() {
  return { authorization: `Bearer ${clientToken}`, "content-type": "application/json" };
}

function hostHeaders() {
  return { "x-openwork-host-token": hostToken, "content-type": "application/json" };
}

async function responseRecord(response: Response, label: string): Promise<Record<string, unknown>> {
  return expectRecord(await response.json(), label);
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwork-cloud-provider-sync-"));
  roots.push(root);
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.OPENWORK_ENV_STORE = join(root, "env.json");
  process.env.OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS = "3600000";
  return root;
}

function buildProvider(models: FakeModel[]): FakeProvider {
  return {
    id: "lpr_test",
    providerId: "openai-compatible",
    name: "Test provider",
    source: "custom",
    updatedAt: "2026-08-04T10:00:00.000Z",
    providerConfig: {
      env: ["TEST_PROVIDER_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://models.example.test/api/v1",
      options: { baseURL: "https://models.example.test/api/v1" },
      whitelist: ["allowed-model"],
      blacklist: ["blocked-model"],
    },
    apiKey: "sk-test-provider",
    apiKeys: null,
    models,
  };
}

function serverConfig(root: string, engineBaseUrl: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: clientToken,
    hostToken,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws_1",
      name: "Workspace",
      path: root,
      preset: "starter",
      workspaceType: "local",
      baseUrl: engineBaseUrl,
    }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

async function waitForLastRun(base: string, expectedStatus: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/cloud-provider-sync/status`, { headers: clientHeaders() });
    expect(response.status).toBe(200);
    const status = await responseRecord(response, "provider sync status");
    const lastRun = isRecord(status.lastRun) ? status.lastRun : null;
    if (lastRun?.status === expectedStatus) return status;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for provider sync status ${expectedStatus}`);
}

async function runSync(base: string, reason: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/cloud-provider-sync/run`, {
    method: "POST",
    headers: hostHeaders(),
    body: JSON.stringify({ reason }),
  });
  expect(response.status).toBe(200);
  return responseRecord(response, "provider sync run response");
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
  if (previousEnvStore === undefined) delete process.env.OPENWORK_ENV_STORE;
  else process.env.OPENWORK_ENV_STORE = previousEnvStore;
  if (previousInterval === undefined) delete process.env.OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS;
  else process.env.OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS = previousInterval;
});

describe("cloud provider sync gateway", () => {
  test("materializes Den providers globally, reconciles changes, and sweeps the session", async () => {
    const root = await createRoot();
    const engineRequests: string[] = [];
    const engine = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        engineRequests.push(`${request.method} ${url.pathname}`);
        return Response.json({ ok: true });
      },
    });
    stops.push(() => engine.stop(true));

    let denFailure = false;
    let denProviders = [
      buildProvider([
        { id: "model-z", name: "Model Z", config: { reasoning: true } },
        { id: "model-a", name: "Model A", config: { family: "test" } },
      ]),
    ];
    const denRequests: Array<{ path: string; authorization: string | null; orgId: string | null }> = [];
    const den = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        denRequests.push({
          path: url.pathname,
          authorization: request.headers.get("authorization"),
          orgId: request.headers.get("x-openwork-legacy-org-id"),
        });
        if (denFailure) return Response.json({ error: "unavailable" }, { status: 503 });
        if (url.pathname === "/v1/llm-providers") return Response.json({ llmProviders: denProviders });
        const match = url.pathname.match(/^\/v1\/llm-providers\/([^/]+)\/connect$/);
        const provider = match ? denProviders.find((entry) => entry.id === decodeURIComponent(match[1] ?? "")) : null;
        return provider
          ? Response.json({ llmProvider: provider })
          : Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    stops.push(() => den.stop(true));

    const config = serverConfig(root, `http://127.0.0.1:${engine.port}`);
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      provider: {
        lpr_stale: { id: "stale", name: "Stale", env: ["STALE_KEY"] },
        local_provider: { id: "local", name: "Local" },
      },
    }));
    await writeOpenworkWorkspaceConfig(config, "ws_1", () => ({
      cloudImports: {
        providers: { lpr_stale: { cloudProviderId: "lpr_stale" } },
        marketplaces: { mkp_keep: { name: "Keep" } },
      },
    }));

    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;

    const capabilitiesResponse = await fetch(`${base}/capabilities`, { headers: clientHeaders() });
    expect(capabilitiesResponse.status).toBe(200);
    expect((await responseRecord(capabilitiesResponse, "capabilities")).providerSync).toBe(true);

    expect(await runSync(base, "before-session")).toEqual({ status: "no_session" });

    const sessionResponse = await fetch(`${base}/den-session`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${den.port}`,
        token: "den-token",
        orgId: "org_test",
      }),
    });
    expect(sessionResponse.status).toBe(204);

    const firstStatus = await waitForLastRun(base, "applied");
    expect(firstStatus.hasSession).toBe(true);
    const statusProviders = Array.isArray(firstStatus.providers) ? firstStatus.providers : [];
    expect(statusProviders).toHaveLength(1);
    const statusProvider = expectRecord(statusProviders[0], "materialized provider status");
    expect(statusProvider).toMatchObject({
      cloudProviderId: "lpr_test",
      providerId: "lpr_test",
      sourceProviderId: "openai-compatible",
      name: "Test provider",
      source: "custom",
      updatedAt: "2026-08-04T10:00:00.000Z",
      modelIds: ["model-a", "model-z"],
    });
    expect(typeof statusProvider.importedAt).toBe("number");
    const firstImportedAt = statusProvider.importedAt;

    expect(denRequests.every((request) => request.authorization === "Bearer den-token")).toBe(true);
    expect(denRequests.every((request) => request.orgId === "org_test")).toBe(true);
    expect(denRequests.map((request) => request.path)).toContain("/v1/llm-providers/lpr_test/connect");

    const globalProviders = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config));
    const globalProvider = expectRecord(globalProviders.lpr_test, "global runtime provider");
    const globalModels = expectRecord(globalProvider.models, "global runtime provider models");
    expect(Object.keys(globalModels).sort()).toEqual(["model-a", "model-z"]);
    expect(expectRecord(globalModels["model-z"], "model-z runtime config").reasoning).toBe(true);
    expect((await new EnvService({ path: process.env.OPENWORK_ENV_STORE }).list()).find(
      (entry) => entry.key === "TEST_PROVIDER_API_KEY",
    )?.value).toBe("sk-test-provider");

    const workspaceProviders = runtimeProviderMap(await readRuntimeOpencodeConfig(config, "ws_1"));
    expect(workspaceProviders.lpr_stale).toBeUndefined();
    expect(workspaceProviders.local_provider).toBeDefined();
    const openwork = await readOpenworkWorkspaceConfig(config, "ws_1");
    const cloudImports = expectRecord(openwork.cloudImports, "workspace cloud imports");
    expect(cloudImports.providers).toEqual({});
    expect(cloudImports.marketplaces).toEqual({ mkp_keep: { name: "Keep" } });

    expect(await runSync(base, "idempotency")).toEqual({ status: "noop" });

    denProviders = [buildProvider([{ id: "model-b", name: "Model B", config: { tool_call: true } }])];
    expect(await runSync(base, "models-changed")).toEqual({ status: "applied" });
    const updatedGlobal = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config));
    expect(Object.keys(expectRecord(updatedGlobal.lpr_test, "updated global provider").models ?? {})).toEqual(["model-b"]);
    const updatedStatusResponse = await fetch(`${base}/cloud-provider-sync/status`, { headers: clientHeaders() });
    const updatedStatus = await responseRecord(updatedStatusResponse, "updated status");
    const updatedProviders = Array.isArray(updatedStatus.providers) ? updatedStatus.providers : [];
    expect(expectRecord(updatedProviders[0], "updated provider status").importedAt).toBe(firstImportedAt);

    denProviders = [];
    expect(await runSync(base, "provider-removed")).toEqual({ status: "applied" });
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_test).toBeUndefined();
    const removedStatusResponse = await fetch(`${base}/cloud-provider-sync/status`, { headers: clientHeaders() });
    expect((await responseRecord(removedStatusResponse, "removed status")).providers).toEqual([]);

    denProviders = [buildProvider([{ id: "model-c", name: "Model C", config: {} }])];
    expect(await runSync(base, "provider-restored")).toEqual({ status: "applied" });
    const deleteResponse = await fetch(`${base}/den-session`, { method: "DELETE", headers: hostHeaders() });
    expect(deleteResponse.status).toBe(204);
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_test).toBeUndefined();
    expect((await new EnvService({ path: process.env.OPENWORK_ENV_STORE }).list()).find(
      (entry) => entry.key === "TEST_PROVIDER_API_KEY",
    )).toBeUndefined();
    const clearedStatusResponse = await fetch(`${base}/cloud-provider-sync/status`, { headers: clientHeaders() });
    expect(await responseRecord(clearedStatusResponse, "cleared status")).toEqual({
      hasSession: false,
      lastRun: null,
      providers: [],
    });
    expect(engineRequests).toContain("DELETE /auth/lpr_test");
    expect(await runSync(base, "after-delete")).toEqual({ status: "no_session" });

    denFailure = true;
    const failedSessionResponse = await fetch(`${base}/den-session`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${den.port}`,
        token: "den-token",
        orgId: "org_test",
      }),
    });
    expect(failedSessionResponse.status).toBe(204);
    const failedRun = await runSync(base, "den-failure");
    expect(failedRun.status).toBe("failed");
    expect(typeof failedRun.message).toBe("string");
    const failedStatus = await waitForLastRun(base, "failed");
    const failedLastRun = expectRecord(failedStatus.lastRun, "failed last run");
    expect(failedLastRun.status).toBe("failed");
    expect(failedLastRun.message).toBe(failedRun.message);
  });
});
