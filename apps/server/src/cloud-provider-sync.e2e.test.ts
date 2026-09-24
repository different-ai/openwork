import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnvService } from "./env-file.js";
import { CloudProviderSync } from "./cloud-provider-sync.js";
import { openworkRuntimeConfigFilePath } from "./openwork-runtime-config.js";
import { clearEnginePoolForConfig, setEnginePoolForConfig, type EnginePool, type RolloverOutcome } from "./engine-pool.js";
import { readOpenworkWorkspaceConfig, writeOpenworkWorkspaceConfig } from "./openwork-workspace-config-store.js";
import {
  readGlobalRuntimeOpencodeConfig,
  readRuntimeOpencodeConfig,
  runtimeProviderMap,
  writeGlobalRuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const clientToken = "owt_cloud_provider_client";
/** Stub reload that reports the engine applied the change in place. */
const reloadedInPlace = async (): Promise<RolloverOutcome> => ({ action: "reloaded_in_place" });
const hostToken = "owt_cloud_provider_host";
const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
const previousEnvStore = process.env.OPENWORK_ENV_STORE;
const previousInterval = process.env.OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS;
const previousReloadRetry = process.env.OPENWORK_ENGINE_RELOAD_RETRY_MS;

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

// Declares credential env vars but carries no credential: materialization
// must skip it — and must say so in status.skippedProviders instead of
// dropping it silently.
function buildProviderWithoutCredential(): FakeProvider {
  return {
    id: "lpr_nocred",
    providerId: "anthropic",
    name: "No Credential Provider",
    source: "custom",
    updatedAt: "2026-08-04T10:00:00.000Z",
    providerConfig: {
      env: ["NOCRED_PROVIDER_API_KEY"],
      npm: "@ai-sdk/anthropic",
    },
    apiKey: "",
    apiKeys: null,
    models: [{ id: "nocred-model", name: "No Cred Model", config: {} }],
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
  if (previousReloadRetry === undefined) delete process.env.OPENWORK_ENGINE_RELOAD_RETRY_MS;
  else process.env.OPENWORK_ENGINE_RELOAD_RETRY_MS = previousReloadRetry;
});

describe("cloud provider sync gateway", () => {
  for (const mode of ["sync", "offline sync", "cold cleanup"]) {
    test(`forged provider import baselines never confer cleanup ownership during ${mode}`, async () => {
      const root = await createRoot();
      const config = serverConfig(root, "https://engine.example.test");
      const forgedIds = ["lpr_00000000000000000000000001", "ipr_00000000000000000000000002", "openwork"];
      // Personal auth already exists in the engine, not in the server env store.
      // Even a full-length lpr ID must not migrate without its scoped binding.
      const personal = { id: "openai", npm: "@ai-sdk/openai", env: ["PERSONAL_MISSING_API_KEY"] };
      const providers = Object.fromEntries(forgedIds.map((id) => [id, personal]));
      await writeGlobalRuntimeOpencodeConfig(config, () => ({ provider: providers }));
      await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ provider: providers }));
      const baseline = { cloudImports: {
        providers: Object.fromEntries(forgedIds.map((id) => [id, { cloudProviderId: id }])),
        marketplaces: { mkp_keep: { name: "Keep" } },
      } };
      await writeOpenworkWorkspaceConfig(config, "ws_1", () => baseline);
      expect(await readOpenworkWorkspaceConfig(config, "ws_1")).toEqual(baseline);
      const env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
      await env.upsertMany([{ key: "LPR_00001_API_KEY", value: "orphan-fixture-key" }]);
      const envBefore = await env.list();
      const provider = buildProvider([{ id: "model-a", name: "Model A", config: {} }]);
      const engineAuth = new Map(forgedIds.map((id) => [id, "personal-fixture-auth"]));
      const engineRequests: string[] = [];
      const ownershipSnapshots: unknown[] = [];
      const fetchImpl = Object.assign(async (
        input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const url = new URL(String(input));
        // Observe the ledger before apply/sweep can clear retired IDs, including
        // the restore-before-fetch write on a failed sync.
        ownershipSnapshots.push((await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__")).providerIds);
        if (url.hostname === "den.example.test") {
          if (mode === "offline sync") throw new Error("fixture offline");
          if (url.pathname === "/v1/inference-providers") return Response.json({ inferenceProviders: [] });
          return Response.json(url.pathname === "/v1/llm-providers"
            ? { llmProviders: [provider] } : { llmProvider: provider });
        }
        engineRequests.push(`${init?.method} ${url.pathname}`);
        const id = decodeURIComponent(url.pathname.slice("/auth/".length));
        if (init?.method === "DELETE") engineAuth.delete(id);
        if (init?.method === "PUT") engineAuth.set(id, "synced-fixture-auth");
        return Response.json(true);
      }, { preconnect: globalThis.fetch.preconnect });
      const sync = new CloudProviderSync({ config, env, fetchImpl, reloadEngine: reloadedInPlace });
      stops.push(() => sync.stop());
      if (mode !== "cold cleanup") {
        await sync.setSession({ baseUrl: "https://den.example.test", token: "fixture-session", orgId: "org_fixture" });
        expect((await sync.run("baseline-regression")).status).toBe(mode === "sync" ? "applied" : "failed");
        expect((await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__")).providerIds)
          .toEqual(mode === "sync" ? [provider.id] : []);
        for (const id of forgedIds) {
          expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))[id]).toEqual(personal);
          expect(runtimeProviderMap(await readRuntimeOpencodeConfig(config, "ws_1"))[id]).toEqual(personal);
        }
        // A collaborator can write another baseline after sync removes it.
        await writeOpenworkWorkspaceConfig(config, "ws_1", () => baseline);
      }
      await sync.clearSession();
      for (const id of forgedIds) {
        expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))[id]).toEqual(personal);
        expect(runtimeProviderMap(await readRuntimeOpencodeConfig(config, "ws_1"))[id]).toEqual(personal);
        expect(engineAuth.get(id)).toBe("personal-fixture-auth");
        expect(engineRequests).not.toContain(`DELETE /auth/${id}`);
        for (const snapshot of ownershipSnapshots) expect(snapshot).not.toContain(id);
      }
      if (mode !== "cold cleanup") expect(ownershipSnapshots.length).toBeGreaterThan(0);
      expect(await env.list()).toEqual(envBefore);
      expect(await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__"))
        .toEqual({ providerIds: [], envHashes: {} });
      expect(await readOpenworkWorkspaceConfig(config, "__managed_provider_auth__:workspace:ws_1\u0000endpoint:https://engine.example.test"))
        .toEqual({ providerIds: [] });
      expect((await readOpenworkWorkspaceConfig(config, "ws_1")).cloudImports)
        .toEqual({ providers: {}, marketplaces: baseline.cloudImports.marketplaces });
    });
  }

  for (const ownership of ["persisted sync", "scoped legacy binding"]) {
    test(`cold cleanup retires ${ownership} providers and removes only proven Cloud credentials`, async () => {
      const root = await createRoot();
      const config = serverConfig(root, "https://engine.example.test");
      const env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
      const id = "lpr_00000000000000000000000003";
      const envName = "LPR_00003_OPENAI_API_KEY";
      const provider = {
        ...buildProvider([{ id: "model-a", name: "Model A", config: {} }]),
        id,
        providerConfig: { id: "openai", npm: "@ai-sdk/openai", env: [envName] },
      };
      const engineRequests: string[] = [];
      let offline = false;
      const fetchImpl = Object.assign(async (
        input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const url = new URL(String(input));
        if (url.hostname === "den.example.test") {
          if (offline) throw new Error("fixture offline");
          if (url.pathname === "/v1/inference-providers") return Response.json({ inferenceProviders: [] });
          return Response.json(url.pathname === "/v1/llm-providers"
            ? { llmProviders: [provider] } : { llmProvider: provider });
        }
        engineRequests.push(`${init?.method} ${url.pathname}`);
        return Response.json(true);
      }, { preconnect: globalThis.fetch.preconnect });
      if (ownership === "persisted sync") {
        const sync = new CloudProviderSync({ config, env, fetchImpl, reloadEngine: reloadedInPlace });
        stops.push(() => sync.stop());
        await sync.setSession({ baseUrl: "https://den.example.test", token: "fixture-session", orgId: "org_fixture" });
        expect((await sync.run("genuine-ownership")).status).toBe("applied");
        const ledger = await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__");
        expect(ledger.providerIds).toEqual([id]);
        expect(Object.keys(expectRecord(ledger.envHashes, "owned env hashes"))).toEqual([envName]);
        expect(engineRequests).toContain(`PUT /auth/${id}`);
        sync.stop();
      } else {
        await env.upsertMany([{ key: envName, value: "legacy-fixture-key" }]);
        await writeGlobalRuntimeOpencodeConfig(config, () => ({
          provider: { [id]: { id: "openai", npm: "@ai-sdk/openai", env: [envName] } },
        }));
        expect(await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__")).toEqual({});
      }
      const globalProviders = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config));
      await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ provider: { [id]: globalProviders[id] } }));
      expect(await readOpenworkWorkspaceConfig(config, "ws_1")).toEqual({});
      offline = true;
      engineRequests.length = 0;
      const envBefore = await env.list();
      const coldEnv = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
      // New config and sync objects discard both in-memory ownership caches.
      const cold = new CloudProviderSync({ config: serverConfig(root, "https://engine.example.test"), env: coldEnv,
        fetchImpl, reloadEngine: reloadedInPlace });
      stops.push(() => cold.stop());
      await cold.clearSession();
      expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))[id]).toBeUndefined();
      expect(runtimeProviderMap(await readRuntimeOpencodeConfig(config, "ws_1"))[id]).toBeUndefined();
      expect(await coldEnv.list()).toEqual(ownership === "persisted sync" ? [] : envBefore);
      expect(engineRequests).toEqual([`DELETE /auth/${id}`]);
      expect(await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__"))
        .toEqual({ providerIds: [], envHashes: {} });
    });
  }

  test("same-identity full delivery preserves providers on a busy engine; a new identity still cleans up", async () => {
    const root = await createRoot();
    const provider = buildProvider([{ id: "model-a", name: "Model A", config: {} }]);
    let busy = false;
    const engineRequests: string[] = [];
    const engine = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      engineRequests.push(`${request.method} ${path}`);
      if (path === "/session/status") return Response.json(busy ? { ses_live: { type: "busy" } } : {});
      return Response.json(true);
    } });
    stops.push(() => engine.stop(true));
    const den = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      const org = request.headers.get("x-openwork-legacy-org-id");
      if (path === "/v1/me/desktop-config") return org === "org_b"
        ? Response.json({ error: "denied" }, { status: 401 }) : Response.json({});
      if (org === "org_b") return Response.json({ error: "not_found" }, { status: 404 });
      if (path === "/v1/inference-providers") return Response.json({ inferenceProviders: [] });
      return Response.json(path === "/v1/llm-providers" ? { llmProviders: [provider] } : { llmProvider: provider });
    } });
    stops.push(() => den.stop(true));
    const config = serverConfig(root, `http://127.0.0.1:${engine.port}`);
    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;
    const put = (path: string, orgId: string) => fetch(`${base}${path}`, {
      method: "PUT", headers: hostHeaders(),
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${den.port}`, token: "den-token", orgId }),
    });
    expect((await put("/den-session", "org_a")).status).toBe(204);
    await waitForLastRun(base, "applied");
    const readEnv = () => new EnvService({ path: process.env.OPENWORK_ENV_STORE }).list();
    const envBefore = await readEnv();
    const configBefore = await readFile(openworkRuntimeConfigFilePath(config), "utf8");
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_test).toBeDefined();
    expect(envBefore.some((entry) => entry.key === "TEST_PROVIDER_API_KEY")).toBe(true);
    busy = true;
    engineRequests.length = 0;

    // Early identity delivery does not authorize Cloud resources or replace
    // materialized ownership. Policy failure cannot reject the local identity.
    for (const org of ["org_a", "org_a", "org_b"]) {
      expect((await put("/den-session/identity", org)).status).toBe(204);
      expect(await runSync(base, "suspended")).toEqual({ status: "no_session" });
    }
    expect((await put("/den-session", "org_a")).status).toBe(204);
    expect(await runSync(base, "resumed")).toEqual({ status: "noop" });
    expect(await readEnv()).toEqual(envBefore);
    expect(await readFile(openworkRuntimeConfigFilePath(config), "utf8")).toBe(configBefore);
    expect(engineRequests.filter((request) => !request.startsWith("GET "))).toEqual([]);

    expect((await put("/den-session/identity", "org_b")).status).toBe(204);
    expect((await put("/den-session", "org_b")).status).toBe(204);
    await waitForLastRun(base, "failed");
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_test).toBeUndefined();
    expect(await readEnv()).toEqual([]);
    expect(engineRequests).toContain("DELETE /auth/lpr_test");
    expect(engineRequests).toContain("POST /instance/dispose");

    expect((await put("/den-session", "org_a")).status).toBe(204);
    await waitForLastRun(base, "applied");
    expect((await put("/den-session/identity", "org_a")).status).toBe(204);
    expect((await fetch(`${base}/den-session`, { method: "DELETE", headers: hostHeaders() })).status).toBe(204);
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_test).toBeUndefined();
    expect(await readEnv()).toEqual([]);
  });

  for (const resumeOrg of ["org_a", "org_b"]) {
    test(`suspension during apply retains the actual owner, not the pending session, before resuming ${resumeOrg}`, async () => {
      const root = await createRoot();
      const config = serverConfig(root, "https://engine.example.test");
      const provider = buildProvider([{ id: "model-a", name: "Model A", config: {} }]);
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reloads = 0;
      let holdAuth = true;
      const fetchImpl = Object.assign(async (
        input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const url = new URL(String(input));
        if (url.hostname === "den.example.test" && url.pathname === "/v1/inference-providers") return Response.json({ inferenceProviders: [] });
        if (url.hostname === "den.example.test") return Response.json(url.pathname === "/v1/llm-providers"
          ? { llmProviders: [provider] } : { llmProvider: provider });
        if (init?.method === "PUT" && holdAuth) {
          reached.resolve();
          await release.promise;
        }
        return Response.json(true);
      }, { preconnect: globalThis.fetch.preconnect });
      const env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
      const sync = new CloudProviderSync({ config, env, fetchImpl, engineBusy: async () => true,
        reloadEngine: async () => { reloads += 1; return reloadedInPlace(); }, intervalMs: 3_600_000 });
      stops.push(() => sync.stop());
      const session = { baseUrl: "https://den.example.test", token: "token-a", orgId: "org_a" };
      try {
        await sync.setSession(session);
        await Promise.race([reached.promise, Bun.sleep(1_000).then(() => { throw new Error("Apply did not reach auth delivery"); })]);
        expect((await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__")).materializationContextHash).toBeUndefined();
        const pendingB = sync.setSession({ ...session, orgId: "org_b" });
        const suspended = sync.suspend();
        holdAuth = false;
        release.resolve();
        await Promise.all([pendingB, suspended]);
        expect((await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__")).materializationContextHash)
          .toBe(createHash("sha256").update(`${session.baseUrl}\u0000${session.orgId}\u0000${session.token}`).digest("hex"));
        await sync.suspend();
        expect(reloads).toBe(0);
        expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_test).toBeDefined();
        const before = await env.list();
        await sync.setSession({ ...session, orgId: resumeOrg });
        expect((await sync.run("resumed")).status).toBe("applied");
        expect((await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__")).materializationContextHash)
          .toBe(createHash("sha256").update(`${session.baseUrl}\u0000${resumeOrg}\u0000${session.token}`).digest("hex"));
        if (resumeOrg === "org_a") expect(await env.list()).toEqual(before);
        else expect((await env.list()).map(({ key, value }) => ({ key, value })))
          .toEqual(before.map(({ key, value }) => ({ key, value })));
        expect(reloads).toBe(resumeOrg === "org_a" ? 0 : 1);
      } finally {
        holdAuth = false;
        release.resolve();
      }
    });
  }

  test("early identity cancels a previous provider fetch and stays dormant across timer ticks", async () => {
    const root = await createRoot();
    process.env.OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS = "20";
    process.env.OPENWORK_ENGINE_RELOAD_RETRY_MS = "20";
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const provider = buildProvider([{ id: "model-a", name: "Model A", config: {} }]);
    const denRequests: string[] = [];
    const den = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const org = request.headers.get("x-openwork-legacy-org-id");
        denRequests.push(`${org} ${path}`);
        if (path === "/v1/me/desktop-config") return Response.json({ allowCustomProviders: false });
        if (path === "/v1/inference-providers") return Response.json({ inferenceProviders: [] });
        if (path === "/v1/llm-providers") {
          if (org === "org_old") {
            reached.resolve();
            await release.promise;
          }
          return Response.json({ llmProviders: [provider] });
        }
        return Response.json({ llmProvider: provider });
      },
    });
    stops.push(() => den.stop(true));
    const engineRequests: string[] = [];
    const engine = Bun.serve({ port: 0, fetch(request) {
      engineRequests.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({});
    } });
    stops.push(() => engine.stop(true));
    const config = serverConfig(root, `http://127.0.0.1:${engine.port}`);
    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;
    const put = (path: string, orgId: string) => fetch(`${base}${path}`, {
      method: "PUT", headers: hostHeaders(),
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${den.port}`, token: "den-token", orgId }),
    });
    try {
      expect((await put("/den-session", "org_old")).status).toBe(204);
      await Promise.race([reached.promise, Bun.sleep(1_000).then(() => { throw new Error("Old provider fetch did not start"); })]);
      expect((await put("/den-session/identity", "org_new")).status).toBe(204);
      // This succeeds while the old Den response is still held: delivery does
      // not depend on the obsolete provider service or the engine recovering.
      release.resolve();
      const baseline = [...engineRequests];
      await Bun.sleep(80);
      expect(await runSync(base, "not-ready")).toEqual({ status: "no_session" });
      expect(denRequests.filter((path) => path.includes("llm-providers"))).toEqual(["org_old /v1/llm-providers"]);
      expect(engineRequests).toEqual(baseline);
      expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))).toEqual({});
      expect(await new EnvService({ path: process.env.OPENWORK_ENV_STORE }).list()).toEqual([]);
      expect((await responseRecord(await fetch(`${base}/cloud-provider-sync/status`, { headers: clientHeaders() }), "status")))
        .toMatchObject({ hasSession: false, providers: [], lastRun: null });
      expect((await put("/den-session", "org_new")).status).toBe(204);
      // Join delivery, then force the same no-op a 20 ms timer can complete before
      // a status observer wakes. lastRun is not history; assert durable effects.
      expect(await runSync(base, "identity-ready"))
        .toMatchObject({ status: expect.stringMatching(/^(applied|noop)$/) });
      expect(await runSync(base, "after-ready")).toEqual({ status: "noop" });
      expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_test).toBeDefined();
      expect((await new EnvService({ path: process.env.OPENWORK_ENV_STORE }).list())
        .map(({ key, value }) => ({ key, value })))
        .toEqual([{ key: "TEST_PROVIDER_API_KEY", value: provider.apiKey }]);
      expect(engineRequests).toContain("PUT /auth/lpr_test");
      expect(denRequests).toContain("org_new /v1/llm-providers/lpr_test/connect");
    } finally {
      release.resolve();
    }
  });

  test("joins concurrent runs, keeps identical sessions inert, and runs one latest-session trailing pass", async () => {
    const root = await createRoot();
    let markFirstListReached: () => void = () => undefined;
    const firstListReached = new Promise<void>((resolve) => {
      markFirstListReached = resolve;
    });
    let releaseFirstList: () => void = () => undefined;
    const firstListReleased = new Promise<void>((resolve) => {
      releaseFirstList = resolve;
    });
    let markSecondListReached: () => void = () => undefined;
    const secondListReached = new Promise<void>((resolve) => {
      markSecondListReached = resolve;
    });
    let releaseSecondList: () => void = () => undefined;
    const secondListReleased = new Promise<void>((resolve) => {
      releaseSecondList = resolve;
    });
    const listOrgIds: string[] = [];
    let listRequestsInFlight = 0;
    let maxListRequestsInFlight = 0;
    const den = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/v1/llm-providers") {
          if (url.pathname === "/v1/me/desktop-config") return Response.json({});
          return Response.json({ error: "not_found" }, { status: 404 });
        }
        listOrgIds.push(request.headers.get("x-openwork-legacy-org-id") ?? "");
        const listIndex = listOrgIds.length;
        listRequestsInFlight += 1;
        maxListRequestsInFlight = Math.max(maxListRequestsInFlight, listRequestsInFlight);
        try {
          if (listIndex === 1) {
            markFirstListReached();
            await firstListReleased;
          } else if (listIndex === 2) {
            markSecondListReached();
            await secondListReleased;
          }
          return Response.json({ llmProviders: [] });
        } finally {
          listRequestsInFlight -= 1;
        }
      },
    });
    stops.push(() => den.stop(true));
    const config = serverConfig(root, "https://engine.example.test");
    config.workspaces = [];
    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;
    const putSession = (orgId: string) => fetch(`${base}/den-session`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${den.port}`,
        token: "den-token",
        orgId,
      }),
    });

    try {
      expect((await putSession("org_first")).status).toBe(204);
      await firstListReached;
      expect((await putSession("org_first")).status).toBe(204);
      const sameContextRuns = [runSync(base, "app_launch"), runSync(base, "app_resume")];

      const changedSessionResponse = putSession("org_changed");
      await Bun.sleep(25);
      expect(listOrgIds).toEqual(["org_first"]);
      expect(maxListRequestsInFlight).toBe(1);

      releaseFirstList();
      const changedSession = await changedSessionResponse;
      expect({ status: changedSession.status, body: await changedSession.text() }).toEqual({ status: 204, body: "" });
      // The replacement session fires its own sync pass; hold its Den list open
      // so both explicit runs deterministically join that active pass.
      await secondListReached;
      const changedContextRuns = [runSync(base, "sign_in"), runSync(base, "focus")];
      await Bun.sleep(25);
      releaseSecondList();
      const results = await Promise.all([...sameContextRuns, ...changedContextRuns]);
      expect(results.map((result) => result.status)).toEqual(["no_session", "no_session", "applied", "applied"]);
      expect(listOrgIds).toEqual(["org_first", "org_changed"]);
      expect(maxListRequestsInFlight).toBe(1);

      expect((await putSession("org_changed")).status).toBe(204);
      await Bun.sleep(25);
      expect(listOrgIds).toEqual(["org_first", "org_changed"]);
    } finally {
      releaseFirstList();
      releaseSecondList();
    }
  });

  test("quarantines the old organization before a failing new-organization sync", async () => {
    const root = await createRoot();
    const provider: FakeProvider = {
      ...buildProvider([{ id: "model-context", name: "Context model", config: {} }]),
      id: "lpr_context",
      name: "Context provider",
      apiKey: "sk-org-a",
      providerConfig: {
        env: ["CONTEXT_PROVIDER_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
      },
    };
    const config = serverConfig(root, "https://engine.example.test");
    let engineBusy = false;
    let reloads = 0;
    const fetchImpl = Object.assign(async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const url = new URL(String(input));
      if (url.hostname === "den.example.test") {
        const orgId = new Headers(init?.headers).get("x-openwork-legacy-org-id");
        if (orgId === "org_b") return Response.json({ error: "not_found" }, { status: 404 });
        if (url.pathname === "/v1/llm-providers") return Response.json({ llmProviders: [provider] });
        if (url.pathname === `/v1/llm-providers/${provider.id}/connect`) {
          return Response.json({ llmProvider: provider });
        }
      }
      if (url.hostname === "engine.example.test" && url.pathname === `/auth/${provider.id}`) {
        return Response.json(true);
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }, { preconnect: globalThis.fetch.preconnect });
    const env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
    const sync = new CloudProviderSync({
      config,
      env,
      fetchImpl,
      engineBusy: async () => engineBusy,
      reloadEngine: async () => {
        reloads += 1;
        return reloadedInPlace();
      },
      intervalMs: 3_600_000,
    });
    stops.push(() => sync.stop());

    await sync.setSession({
      baseUrl: "https://den.example.test",
      token: "token-a",
      orgId: "org_a",
    });
    expect((await sync.run("org-a")).status).toBe("applied");
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_context).toBeDefined();
    expect((await env.list()).some((entry) => entry.key === "CONTEXT_PROVIDER_API_KEY")).toBe(true);
    expect(reloads).toBe(1);

    engineBusy = true;
    await sync.setSession({
      baseUrl: "https://den.example.test",
      token: "token-b",
      orgId: "org_b",
    });
    expect((await sync.run("org-b")).status).toBe("failed");

    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_context).toBeUndefined();
    expect((await env.list()).some((entry) => entry.key === "CONTEXT_PROVIDER_API_KEY")).toBe(false);
    expect(sync.status().providers).toEqual([]);
    expect(sync.status().lastRun?.message).toBe("den_request_failed_404");
    expect(reloads).toBe(2);
  });

  test("re-seeding an unchanged credential to a replaced engine generation does not reload again", async () => {
    // Regression: after every rollover the next sync pass found a new
    // generation scope, re-delivered the same key, counted it as a credential
    // change and forced another standby — a loop bounded only by the sync
    // cadence. Only a rotated value may reload.
    const root = await createRoot();
    const provider = buildProvider([{ id: "model-a", name: "Model A", config: {} }]);
    const config = serverConfig(root, "http://127.0.0.1:39999");
    let generationId = "generation-one";
    const pool = {
      connections: () => [{
        generationId,
        role: "primary",
        baseUrl: "http://127.0.0.1:39999",
        username: "engine-user",
        password: "engine-pass",
      }],
    } as unknown as EnginePool;
    setEnginePoolForConfig(config, pool);
    stops.push(() => clearEnginePoolForConfig(config));
    let reloads = 0;
    const authPuts: string[] = [];
    const fetchImpl = Object.assign(async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const url = new URL(String(input));
      if (url.hostname === "den.example.test") {
        if (url.pathname === "/v1/llm-providers") return Response.json({ llmProviders: [provider] });
        if (url.pathname === `/v1/llm-providers/${provider.id}/connect`) return Response.json({ llmProvider: provider });
      }
      if (url.host === "127.0.0.1:39999" && url.pathname === `/auth/${provider.id}` && init?.method === "PUT") {
        authPuts.push(generationId);
        return Response.json(true);
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }, { preconnect: globalThis.fetch.preconnect });
    const env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
    const sync = new CloudProviderSync({
      config,
      env,
      fetchImpl,
      engineBusy: async () => false,
      reloadEngine: async () => {
        reloads += 1;
        // A reload flips the pool onto a fresh generation.
        generationId = `generation-${reloads + 1}`;
        return { action: "rolled_over", generationId, drainingSessions: 0 };
      },
      intervalMs: 3_600_000,
    });
    stops.push(() => sync.stop());
    await sync.setSession({ baseUrl: "https://den.example.test", token: "token-a", orgId: "org_a" });

    // First materialization: provider config is new, so one reload is right.
    expect((await sync.run("sign_in")).status).toBe("applied");
    expect(reloads).toBe(1);
    expect(authPuts).toEqual(["generation-one"]);

    // The new generation has no applied auth yet: the key is re-delivered but
    // its value did not change, so nothing may reload.
    expect((await sync.run("new_chat")).status).toBe("noop");
    expect(authPuts).toEqual(["generation-one", "generation-2"]);
    expect(reloads).toBe(1);
    expect((await sync.run("interval")).status).toBe("noop");
    expect(reloads).toBe(1);
    expect(authPuts).toHaveLength(2);

    // A genuinely rotated credential still reloads exactly once.
    provider.apiKey = "sk-test-provider-rotated";
    expect((await sync.run("interval")).status).toBe("applied");
    expect(reloads).toBe(2);
    expect(authPuts).toEqual(["generation-one", "generation-2", "generation-2"]);
  });

  test("defers a reload while a generation drains and retries it once", async () => {
    process.env.OPENWORK_ENGINE_RELOAD_RETRY_MS = "50";
    const root = await createRoot();
    const provider = buildProvider([{ id: "model-a", name: "Model A", config: {} }]);
    const config = serverConfig(root, "https://engine.example.test");
    let draining = true;
    let reloads = 0;
    const fetchImpl = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = new URL(String(input));
      if (url.hostname === "den.example.test") {
        if (url.pathname === "/v1/llm-providers") return Response.json({ llmProviders: [provider] });
        if (url.pathname === `/v1/llm-providers/${provider.id}/connect`) return Response.json({ llmProvider: provider });
      }
      if (url.hostname === "engine.example.test" && url.pathname === `/auth/${provider.id}`) return Response.json(true);
      return Response.json({ error: "not_found" }, { status: 404 });
    }, { preconnect: globalThis.fetch.preconnect });
    const sync = new CloudProviderSync({
      config,
      env: new EnvService({ path: process.env.OPENWORK_ENV_STORE }),
      fetchImpl,
      engineBusy: async () => draining,
      reloadEngine: async () => { reloads += 1; return reloadedInPlace(); },
      intervalMs: 3_600_000,
    });
    stops.push(() => sync.stop());
    await sync.setSession({ baseUrl: "https://den.example.test", token: "token-a", orgId: "org_a" });

    const result = await Promise.race([
      sync.run("sign_in"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sync run timed out")), 5_000)),
    ]);
    expect(result.status).toBe("applied");
    expect(sync.status().lastRun?.detail?.reloadDeferred).toBe(true);
    expect(sync.status().reloadPending).toBe(true);
    expect(reloads).toBe(0);

    draining = false;
    for (let attempt = 0; attempt < 100 && reloads !== 1; attempt += 1) await Bun.sleep(10);
    expect(reloads).toBe(1);
    expect(sync.status().reloadPending).toBe(false);
    await Bun.sleep(100);
    expect(reloads).toBe(1);

    // A new early identity must also cancel a reload owed by the old one,
    // without sweeping credentials into an engine that is not ready yet.
    draining = true;
    provider.apiKey = "sk-rotated-before-identity";
    expect((await sync.run("rotation")).status).toBe("applied");
    expect(sync.status().reloadPending).toBe(true);
    const env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
    const before = await env.list();
    await sync.suspend();
    draining = false;
    await Bun.sleep(100);
    expect(reloads).toBe(1);
    expect(await env.list()).toEqual(before);
    expect(await sync.run("not-ready")).toEqual({ status: "no_session" });
    await sync.setSession({ baseUrl: "https://den.example.test", token: "token-b", orgId: "org_b" });
    expect((await sync.run("ready")).status).toBe("applied");
    expect(reloads).toBeGreaterThan(1);
  });

  test("materializes providers before the first workspace exists and finishes setup later", async () => {
    const root = await createRoot();
    const config = serverConfig(root, "https://engine.example.test");
    config.workspaces = [];
    let reloads = 0;
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
    const den = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/llm-providers") {
          return Response.json({
            llmProviders: [buildProvider([{ id: "model-a", name: "Model A", config: {} }])],
          });
        }
        if (url.pathname === "/v1/inference-providers") return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({
          llmProvider: buildProvider([{ id: "model-a", name: "Model A", config: {} }]),
        });
      },
    });
    stops.push(() => den.stop(true));
    const sync = new CloudProviderSync({
      config,
      env: new EnvService({ path: process.env.OPENWORK_ENV_STORE }),
      reloadEngine: async () => {
        reloads += 1;
        return reloadedInPlace();
      },
      intervalMs: 3_600_000,
    });
    stops.push(() => sync.stop());

    sync.setSession({
      baseUrl: `http://127.0.0.1:${den.port}`,
      token: "den-token",
      orgId: "org_test",
    });
    expect((await sync.run("before-workspace")).status).toBe("applied");
    expect(sync.status().lastRun?.status).toBe("applied");
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_test).toBeDefined();
    expect(reloads).toBe(0);
    expect(engineRequests).toEqual([]);

    config.workspaces.push({
      id: "ws_1",
      name: "Workspace",
      path: root,
      preset: "starter",
      workspaceType: "local",
      baseUrl: `http://127.0.0.1:${engine.port}`,
    });
    expect(await sync.run("workspace-created")).toEqual({ status: "applied" });
    expect(reloads).toBe(1);
    expect(engineRequests).toContain("PUT /auth/lpr_test");
  });

  test("preserves disabled Fast metadata and reconciles an unchanged catalog after serializer upgrade", async () => {
    const root = await createRoot();
    const config = serverConfig(root, "https://engine.example.test");
    config.workspaces = [];
    const provider = buildProvider([{ id: "model", name: "Model", config: {
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      experimental: { modes: { fast: { provider: { body: { service_tier: "priority" } } } } },
    } }]);
    provider.providerConfig.npm = "@ai-sdk/openai";
    await writeGlobalRuntimeOpencodeConfig(config, () => ({ provider: { lpr_test: {
      models: { model: { id: "model", name: "Model" } },
    } } }));
    const sync = new CloudProviderSync({
      config, env: new EnvService({ path: process.env.OPENWORK_ENV_STORE }), reloadEngine: reloadedInPlace,
      fetchImpl: Object.assign(async (input: URL | RequestInfo) => {
        const { pathname } = new URL(String(input));
        if (pathname === "/v1/inference-providers") return Response.json({ inferenceProviders: [] });
        return Response.json(pathname.endsWith("/connect")
          ? { llmProvider: provider } : { llmProviders: [provider] });
      }, { preconnect: () => {} }),
    });
    stops.push(() => sync.stop());
    await sync.setSession({ baseUrl: "https://den.example.test", token: "synthetic", orgId: "org_test" });
    expect((await sync.run()).status).toBe("applied");
    expect(sync.status().providers[0]?.modelConfigVersion).toBe(2);
    const written = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_test;
    const model = expectRecord(expectRecord(written.models, "serialized models").model, "serialized model");
    expect(model.variants).toEqual({ __openwork_catalog_fast_v1: {
      disabled: true, openworkNativeFast: 1, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    } });
    expect(JSON.stringify(written)).not.toContain('"experimental"');
    expect((await sync.run()).status).toBe("noop");
  });

  test("skips a per-member provider that needs the member's key", async () => {
    const root = await createRoot();
    const config = serverConfig(root, "https://engine.example.test");
    config.workspaces = [];
    const provider = buildProvider([{ id: "model-a", name: "Model A", config: {} }]);
    const den = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/llm-providers") {
          return Response.json({ llmProviders: [provider] });
        }
        if (url.pathname === "/v1/inference-providers") return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({
          llmProvider: {
            ...provider,
            apiKey: null,
            apiKeys: null,
            memberCredential: { state: "missing" },
          },
        });
      },
    });
    stops.push(() => den.stop(true));
    const sync = new CloudProviderSync({
      config,
      env: new EnvService({ path: process.env.OPENWORK_ENV_STORE }),
      reloadEngine: reloadedInPlace,
      intervalMs: 3_600_000,
    });
    stops.push(() => sync.stop());

    sync.setSession({
      baseUrl: `http://127.0.0.1:${den.port}`,
      token: "den-token",
      orgId: "org_test",
    });
    expect((await sync.run("needs-key")).status).toBe("applied");
    expect(sync.status().providers).toEqual([]);
    expect(sync.status().skippedProviders).toEqual([{
      cloudProviderId: provider.id,
      providerId: provider.id,
      name: provider.name,
      reason: "needs_key",
    }]);
  });

  test("backward compatibility: Gateway inventory continuity, strict failures, and legacy isolation", async () => {
    const root = await createRoot();
    const config = serverConfig(root, "https://engine.example.test");
    let gatewayKey = `ow_gw_${Buffer.alloc(32, 1).toString("base64url")}`;
    const groupSuffix = "00000000000000000000000001";
    const setSuffix = "00000000000000000000000002";
    const modelSuffix = "00000000000000000000000003";
    const modelId = `gwm_${groupSuffix}_${setSuffix}_${modelSuffix}`;
    const pendingSetId = "gcs_00000000000000000000000004";
    const pendingModelId = `gwm_${groupSuffix}_${pendingSetId.slice(4)}_${modelSuffix}`;
    const pendingModels = [{
      id: pendingModelId, name: "Assigned pending model", config: { id: pendingModelId },
      upstreamModelId: "assigned-upstream", modelGroupId: `gmg_${groupSuffix}`, modelGroupName: "Assigned models",
      credentialSetId: pendingSetId, credentialSetName: "Personal Google",
    }];
    const pendingAuthUrl = `https://den.example.test/v1/inference-providers/ipr_pending/oauth/start?credentialSetId=${pendingSetId}`;
    const gatewayBaseUrl = "https://inference.example.test/api/v1/providers/ipr_ready";
    const llmProvider = buildProvider([{ id: "model-a", name: "Model A", config: {} }]);
    let additionalLegacyProvider: FakeProvider | undefined;
    const readyGateway = {
      id: "ipr_ready",
      providerId: "anthropic",
      name: "Team Anthropic",
      source: "openwork_gateway",
      credentialMode: "org",
      credentialStatus: "ready",
      status: "active",
      authUrl: null,
      authorizationRequests: [{ credentialSetId: pendingSetId, name: "Personal Google", authUrl: pendingAuthUrl, models: pendingModels }],
      modelIds: ["claude-sonnet", "unassigned-upstream"],
      updatedAt: "2026-08-20T00:00:00.000Z",
      providerConfig: {
        env: ["IPR_READY_ANTHROPIC_API_KEY"],
        npm: "@ai-sdk/anthropic",
        api: gatewayBaseUrl,
        options: { baseURL: gatewayBaseUrl },
      },
      models: [{
        id: modelId, name: "Claude Sonnet", config: { id: modelId, name: "Claude Sonnet", headers: { "x-openwork-gateway-request-model": modelId } },
        upstreamModelId: "claude-sonnet",
        modelGroupId: `gmg_${groupSuffix}`, modelGroupName: "Team models",
        credentialSetId: `gcs_${setSuffix}`, credentialSetName: "Organization key",
      }],
    };
    const pendingGateway = {
      ...readyGateway,
      id: "ipr_pending",
      name: "Member Google",
      providerId: "google",
      credentialMode: "member",
      credentialStatus: "member_auth_required",
      authUrl: pendingAuthUrl,
      authorizationRequests: [{ credentialSetId: pendingSetId, name: "Personal Google", authUrl: pendingAuthUrl, models: pendingModels }],
      models: [],
      modelIds: [],
      providerConfig: { env: ["IPR_PENDING_GOOGLE_GENERATIVE_AI_API_KEY"], npm: "@ai-sdk/google" },
    };
    let inferenceListResponse: (() => Response) | undefined = () => new Response(null, { status: 404 });
    let failure: { path: string; respond: () => Response } | undefined;
    const session = { baseUrl: "https://den.example.test", token: "den-token", orgId: "org_test" };
    let activeSession = session;
    let gatewayBeforeFetch: boolean | undefined;
    let beforeFetch: (() => Promise<void>) | undefined;
    let busy = false;
    let reloads = 0;
    const denPaths: string[] = [];
    const engineRequests: string[] = [];
    const fetchImpl = Object.assign(async (
      input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const url = new URL(String(input));
      if (url.origin === "https://engine.example.test") {
        engineRequests.push(`${init?.method} ${url.pathname}`);
        return Response.json(true);
      }
      expect(url.origin).toBe(new URL(activeSession.baseUrl).origin);
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${activeSession.token}`);
      expect(new Headers(init?.headers).get("x-openwork-legacy-org-id")).toBe(activeSession.orgId);
      expect(new Headers(init?.headers).get("x-openwork-org-id")).toBe(activeSession.orgId);
      if (gatewayBeforeFetch !== undefined) {
        expect((await env.list()).some((entry) => entry.key === "IPR_READY_ANTHROPIC_API_KEY")).toBe(gatewayBeforeFetch);
      }
      if (beforeFetch) await beforeFetch();
      const path = `${url.pathname}${url.search}`;
      denPaths.push(path);
      if (failure?.path === path) return failure.respond();
      if (path === "/v1/llm-providers") return Response.json({
        llmProviders: activeSession.orgId === session.orgId
          ? [llmProvider, ...(additionalLegacyProvider ? [additionalLegacyProvider] : [])] : [],
      });
      if (path === `/v1/llm-providers/${llmProvider.id}/connect`) return Response.json({ llmProvider });
      if (additionalLegacyProvider && path === `/v1/llm-providers/${additionalLegacyProvider.id}/connect`) {
        return Response.json({ llmProvider: additionalLegacyProvider });
      }
      if (path === "/v1/inference-providers?scope=usable") {
        return inferenceListResponse?.() ?? Response.json({ inferenceProviders: [readyGateway, pendingGateway] });
      }
      if (path === `/v1/inference-providers/${readyGateway.id}/connect`) {
        return Response.json({
          inferenceProvider: { ...readyGateway, apiKey: gatewayKey, apiKeys: { IPR_READY_ANTHROPIC_API_KEY: gatewayKey } },
        });
      }
      throw new Error(`Unexpected Den request: ${path}`);
    }, { preconnect: globalThis.fetch.preconnect });
    const env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
    const newSync = () => {
      const sync = new CloudProviderSync({
        config: serverConfig(root, "https://engine.example.test"),
        env,
        fetchImpl,
        engineBusy: async () => busy,
        reloadEngine: async () => { reloads += 1; return reloadedInPlace(); },
        intervalMs: 3_600_000,
      });
      stops.push(() => sync.stop());
      return sync;
    };
    let sync = newSync();
    await sync.setSession(session);
    expect((await sync.run("old-den-first-sync")).status).toBe("applied");
    expect(sync.status().providers.map((entry) => entry.cloudProviderId)).toEqual(["lpr_test"]);
    expect(denPaths.sort()).toEqual([
      "/v1/inference-providers?scope=usable", "/v1/llm-providers", "/v1/llm-providers/lpr_test/connect",
    ]);
    for (const code of [405, 501]) {
      inferenceListResponse = () => new Response(null, { status: code });
      expect(await sync.run(`legacy-only-${code}`)).toEqual({ status: "noop" });
      expect(sync.status().providers.map((entry) => entry.cloudProviderId)).toEqual(["lpr_test"]);
    }
    inferenceListResponse = undefined;
    expect((await sync.run("gateway")).status).toBe("applied");
    expect(denPaths).toContain("/v1/inference-providers?scope=usable");
    expect(denPaths).toContain(`/v1/inference-providers/${readyGateway.id}/connect`);
    expect(denPaths).not.toContain(`/v1/inference-providers/${pendingGateway.id}/connect`);

    const status = sync.status();
    expect(status.providers.map((entry) => entry.cloudProviderId)).toEqual(["ipr_ready", "lpr_test"]);
    expect(status.providers.map((entry) => entry.providerId)).toEqual(["ipr_ready", "lpr_test"]);
    expect(status.providers[0]).toMatchObject({
      sourceProviderId: "anthropic",
      name: "Team Anthropic",
      source: "openwork_gateway",
      modelIds: [modelId],
    });
    expect(status.providers[1]?.source).toBe("custom");
    expect(status.skippedProviders).toEqual([{
      cloudProviderId: "ipr_ready",
      providerId: "ipr_ready",
      credentialSetId: pendingSetId,
      name: "Team Anthropic / Personal Google",
      reason: "member_auth_required",
      models: pendingModels,
    }, {
      cloudProviderId: "ipr_pending",
      providerId: "ipr_pending",
      credentialSetId: pendingSetId,
      name: "Member Google / Personal Google",
      reason: "member_auth_required",
      models: pendingModels,
    }]);

    const runtimeProviders = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config));
    expect(Object.keys(runtimeProviders).sort()).toEqual(["ipr_ready", "lpr_test"]);
    const gatewayRuntime = expectRecord(runtimeProviders.ipr_ready, "gateway runtime provider");
    expect(gatewayRuntime.name).toBe("Team Anthropic");
    expect(gatewayRuntime.npm).toBe("@ai-sdk/anthropic");
    expect(gatewayRuntime.api).toBe(gatewayBaseUrl);
    expect(gatewayRuntime.models).toEqual({ [modelId]: { id: modelId, name: "Claude Sonnet", headers: { "x-openwork-gateway-request-model": modelId } } });
    expect(expectRecord(gatewayRuntime.options, "gateway options").baseURL).toBe(gatewayBaseUrl);
    expect(JSON.stringify(gatewayRuntime)).not.toContain(gatewayKey);
    const storedEnv = await env.list();
    expect(storedEnv.find((entry) => entry.key === "IPR_READY_ANTHROPIC_API_KEY")?.value).toBe(gatewayKey);
    expect(storedEnv.find((entry) => entry.key === "TEST_PROVIDER_API_KEY")?.value).toBe("sk-test-provider");
    expect(storedEnv.some((entry) => entry.key === "IPR_PENDING_GOOGLE_GENERATIVE_AI_API_KEY")).toBe(false);
    expect(storedEnv.some((entry) => entry.key === "GOOGLE_GENERATIVE_AI_API_KEY")).toBe(false);

    expect(engineRequests).toContain("PUT /auth/ipr_ready");
    expect(engineRequests).not.toContain("PUT /auth/ipr_pending");
    expect(JSON.stringify(runtimeProviders)).not.toContain(pendingModelId);
    expect(JSON.stringify(sync.status())).not.toContain("unassigned-upstream");
    const readState = async () => ({
      runtime: await readGlobalRuntimeOpencodeConfig(config),
      runtimeFile: await readFile(openworkRuntimeConfigFilePath(config), "utf8"),
      env: await env.list(),
      ownership: await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__"),
      engineRequests: [...engineRequests],
      reloads,
    });
    const lastKnownState = await readState();
    const contextHash = createHash("sha256").update(`${session.baseUrl}\u0000${session.orgId}\u0000${session.token}`).digest("hex");
    expect(lastKnownState.ownership.materializationContextHash).toBe(contextHash);
    expect(Object.keys(lastKnownState.ownership).sort()).toEqual(["envHashes", "materializationContextHash", "providerIds"]);
    for (const privateValue of [session.baseUrl, session.orgId, session.token, gatewayKey]) {
      expect(JSON.stringify(lastKnownState.ownership)).not.toContain(privateValue);
      expect(JSON.stringify(sync.status())).not.toContain(privateValue);
    }
    expect(JSON.stringify(sync.status())).not.toContain(contextHash);
    for (const endpoint of [
      { path: "/v1/inference-providers?scope=usable", invalid: "den_inference_provider_list_invalid_response", list: true },
      { path: `/v1/inference-providers/${readyGateway.id}/connect`, invalid: `den_inference_provider_connect_invalid_response_${readyGateway.id}`, list: false },
      { path: "/v1/llm-providers", invalid: "den_llm_provider_list_invalid_response", list: false },
      { path: `/v1/llm-providers/${llmProvider.id}/connect`, invalid: `den_llm_provider_connect_invalid_response_${llmProvider.id}`, list: false },
    ]) {
      // Even with no Gateway resource, legacy errors cannot become an empty
      // desired provider set and erase the last successfully owned providers.
      inferenceListResponse = endpoint.path.startsWith("/v1/llm-providers")
        ? () => new Response(null, { status: 404 }) : undefined;
      const httpStatuses = endpoint.list ? [401, 403, 500, 502, 503, 504] : [401, 403, 404, 405, 500, 501, 502, 503, 504];
      const cases = [
        ...httpStatuses.map((code) => ({
          respond: () => new Response(null, { status: code }), message: `den_request_failed_${code}`,
        })),
        { respond: () => new Response("not JSON"), message: "den_request_invalid_json" },
        { respond: () => Response.json(null), message: endpoint.invalid },
        { respond: () => Response.json({}), message: endpoint.invalid },
        { respond: () => Response.json({ inferenceProviders: [null], llmProviders: [null], inferenceProvider: {}, llmProvider: {} }), message: endpoint.invalid },
        { respond: () => { throw new Error("fixture offline"); }, message: "den_request_failed: fixture offline" },
      ];
      if (endpoint.path.startsWith("/v1/inference-providers")) {
        const malformedGateway = { ...readyGateway, models: [{ ...readyGateway.models[0], credentialSetId: undefined }] };
        cases.push({
          respond: () => Response.json({ inferenceProviders: [malformedGateway], inferenceProvider: malformedGateway }),
          message: endpoint.invalid,
        });
        const malformedPending = { ...readyGateway, authorizationRequests: [{
          credentialSetId: pendingSetId, name: "Personal Google", authUrl: pendingAuthUrl,
          models: [{ ...pendingModels[0], credentialSetId: `gcs_${setSuffix}` }],
        }] };
        cases.push({
          respond: () => Response.json({ inferenceProviders: [malformedPending], inferenceProvider: malformedPending }),
          message: endpoint.invalid,
        });
        if (!endpoint.list) cases.push({
          respond: () => Response.json({ inferenceProvider: {
            ...readyGateway, apiKey: "ow_inf_legacy-fixture", apiKeys: { IPR_READY_ANTHROPIC_API_KEY: "ow_inf_legacy-fixture" },
          } }),
          message: `den_inference_provider_unscoped_credentials_${readyGateway.id}`,
        });
      }
      for (const entry of cases) {
        failure = { path: endpoint.path, respond: entry.respond };
        expect(await sync.run(`${endpoint.path}: ${entry.message}`)).toEqual({ status: "failed", message: entry.message });
        expect(sync.status().lastRun?.status).toBe("failed");
        expect(sync.status().providers).toEqual(status.providers);
        expect(sync.status().skippedProviders).toEqual(status.skippedProviders);
        expect(await readState()).toEqual(lastKnownState);
      }
    }
    failure = undefined;
    for (const code of [404, 405, 501]) {
      inferenceListResponse = () => new Response("route unavailable", { status: code });
      const pathOffset = denPaths.length;
      expect(await sync.run(`gateway-unavailable-${code}`)).toEqual({
        status: "failed", message: "den_inference_provider_list_unavailable",
      });
      expect(sync.status().lastRun?.status).toBe("failed");
      expect(sync.status().providers).toEqual(status.providers);
      expect(sync.status().skippedProviders).toEqual(status.skippedProviders);
      expect(await readState()).toEqual(lastKnownState);
      expect(denPaths.slice(pathOffset).sort()).toEqual([
        "/v1/inference-providers?scope=usable", "/v1/llm-providers", "/v1/llm-providers/lpr_test/connect",
      ]);
      inferenceListResponse = undefined;
      expect(await sync.run("gateway-recovered-unchanged")).toEqual({ status: "noop" });
    }

    inferenceListResponse = () => Response.json({ inferenceProviders: [] });
    const revokeOffset = engineRequests.length;
    expect((await sync.run("gateway-authoritative-empty")).status).toBe("applied");
    expect(sync.status().providers.map((entry) => entry.cloudProviderId)).toEqual(["lpr_test"]);
    expect(sync.status().skippedProviders).toEqual([]);
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))).toEqual({ lpr_test: runtimeProviders.lpr_test });
    expect(await env.list()).toEqual(storedEnv.filter((entry) => entry.key !== "IPR_READY_ANTHROPIC_API_KEY"));
    expect((await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__")).providerIds).toEqual(["lpr_test"]);
    expect(await readFile(openworkRuntimeConfigFilePath(config), "utf8")).not.toContain('"ipr_ready"');
    expect(engineRequests.slice(revokeOffset)).toEqual(["DELETE /auth/ipr_ready"]);
    expect(await sync.run("gateway-empty-unchanged")).toEqual({ status: "noop" });
    inferenceListResponse = undefined;
    expect((await sync.run("gateway-restored")).status).toBe("applied");
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))).toEqual(runtimeProviders);
    expect((await env.list()).map(({ key, value }) => ({ key, value })))
      .toEqual(storedEnv.map(({ key, value }) => ({ key, value })));

    const legacyEnvName = "LPR_00005_API_KEY";
    additionalLegacyProvider = {
      ...llmProvider,
      id: "lpr_00000000000000000000000005",
      apiKey: "local-legacy-fixture-key",
      providerConfig: { ...llmProvider.providerConfig, env: [legacyEnvName] },
    };
    await env.upsertMany([{ key: legacyEnvName, value: additionalLegacyProvider.apiKey }]);
    expect((await sync.run("seed-mixed-legacy-gateway")).status).toBe("applied");
    sync.stop();
    await writeOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__", (current) => ({
      providerIds: current.providerIds,
      envHashes: Object.fromEntries(Object.entries(expectRecord(current.envHashes, "owned env hashes"))
        .filter(([key]) => key !== legacyEnvName)),
    }));
    const beforeUpgrade = await readState();
    expect(beforeUpgrade.ownership.materializationContextHash).toBeUndefined();
    expect(expectRecord(beforeUpgrade.ownership.envHashes, "legacy env hashes")[legacyEnvName]).toBeUndefined();
    sync = newSync();
    beforeFetch = async () => {
      expect(engineRequests).toEqual(beforeUpgrade.engineRequests);
      expect(reloads).toBe(beforeUpgrade.reloads);
      expect(await env.list()).toEqual(beforeUpgrade.env);
      expect(await readGlobalRuntimeOpencodeConfig(config)).toEqual(beforeUpgrade.runtime);
    };
    await sync.setSession(session);
    expect(await sync.run("mixed-legacy-gateway-metadata-upgrade")).toEqual({ status: "applied" });
    beforeFetch = undefined;
    expect(engineRequests.slice(beforeUpgrade.engineRequests.length).some((request) => request.startsWith("DELETE "))).toBe(false);
    expect(sync.status().lastRun?.detail).toMatchObject({
      providerStateChanged: false, envUpserts: 0, envDeletes: 0, cleanupRuntimeChanged: false, fileChanged: false,
    });
    expect(await readGlobalRuntimeOpencodeConfig(config)).toEqual(beforeUpgrade.runtime);
    expect(await readFile(openworkRuntimeConfigFilePath(config), "utf8")).toBe(beforeUpgrade.runtimeFile);
    expect(await env.list()).toEqual(beforeUpgrade.env);
    expect((await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__")).materializationContextHash).toBe(contextHash);
    additionalLegacyProvider = undefined;
    expect((await sync.run("retire-mixed-legacy-fixture")).status).toBe("applied");

    for (const cold of [
      { name: "same-context", session, provenance: true, retain: true },
      { name: "other-org", session: { ...session, orgId: "org_other" }, provenance: true, retain: false },
      { name: "other-token", session: { ...session, token: "other-den-token" }, provenance: true, retain: false },
      { name: "other-control-plane", session: { ...session, baseUrl: "https://other-den.example.test" }, provenance: true, retain: false },
      { name: "legacy-ownership", session, provenance: false, retain: false },
    ]) {
      for (const code of [404, 405, 501]) {
        sync.stop();
        if (!cold.provenance) {
          await writeOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__", (current) => ({
            providerIds: current.providerIds, envHashes: current.envHashes,
          }));
        }
        const before = await readState();
        expect(runtimeProviderMap(before.runtime).ipr_ready).toBeDefined();
        sync = newSync();
        expect(sync.status().hasSession).toBe(false);
        activeSession = cold.session;
        gatewayBeforeFetch = !cold.provenance || cold.retain;
        busy = true;
        inferenceListResponse = () => new Response(null, { status: code });
        await sync.setSession(cold.session);
        expect(await sync.run(`cold-first-${cold.name}-gateway-unavailable-${code}`)).toEqual(cold.retain
          ? { status: "failed", message: "den_inference_provider_list_unavailable" }
          : { status: "applied" });
        gatewayBeforeFetch = undefined;
        expect((await env.list()).some((entry) => entry.key === "IPR_READY_ANTHROPIC_API_KEY")).toBe(cold.retain);
        expect(sync.status().lastRun?.status).toBe(cold.retain ? "failed" : "applied");
        expect(sync.status().lastRun?.message).toBe(cold.retain ? "den_inference_provider_list_unavailable" : undefined);
        if (cold.retain) {
          expect(await readState()).toEqual(before);
        } else {
          const providerIds = cold.session.orgId === session.orgId ? ["lpr_test"] : [];
          expect(Object.keys(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)))).toEqual(providerIds);
          expect((await env.list()).map((entry) => entry.key)).toEqual(providerIds.length > 0 ? ["TEST_PROVIDER_API_KEY"] : []);
          expect(await readFile(openworkRuntimeConfigFilePath(config), "utf8")).not.toContain('"ipr_ready"');
          const ownership = await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__");
          expect(ownership.providerIds).toEqual(providerIds);
          if (providerIds.length === 0) expect(ownership).toEqual({ providerIds: [], envHashes: {} });
          else expect(ownership.materializationContextHash)
            .toBe(createHash("sha256").update(`${cold.session.baseUrl}\u0000${cold.session.orgId}\u0000${cold.session.token}`).digest("hex"));
          expect(engineRequests.slice(before.engineRequests.length).filter((request) => request.startsWith("DELETE ")).sort())
            .toEqual(cold.provenance ? ["DELETE /auth/ipr_ready", "DELETE /auth/lpr_test"] : ["DELETE /auth/ipr_ready"]);
          expect(reloads).toBe(before.reloads + (cold.provenance ? 1 : 0));
          if (!cold.provenance) {
            expect(await env.list()).toEqual(before.env.filter((entry) => entry.key !== "IPR_READY_ANTHROPIC_API_KEY"));
            expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_test)
              .toEqual(runtimeProviderMap(before.runtime).lpr_test);
          }
          expect(await sync.run("legacy-compatibility-unchanged")).toEqual({ status: "noop" });
        }
        busy = false;
        activeSession = session;
        inferenceListResponse = undefined;
        await sync.setSession(session);
        expect((await sync.run("restore-verified-gateway-context")).status).toBe("applied");
      }
    }
    gatewayKey = `ow_gw_${Buffer.alloc(32, 2).toString("base64url")}`;
    readyGateway.name = "Updated Team Anthropic";
    inferenceListResponse = undefined;
    expect(await sync.run("gateway-retry-with-changes")).toEqual({ status: "applied" });
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).ipr_ready.name).toBe(readyGateway.name);
    expect((await env.list()).find((entry) => entry.key === "IPR_READY_ANTHROPIC_API_KEY")?.value).toBe(gatewayKey);
    expect(await sync.run("gateway-retry-unchanged")).toEqual({ status: "noop" });

    for (const cleanup of ["org-switch", "sign-out"]) {
      const before = await readState();
      sync.stop();
      sync = newSync();
      inferenceListResponse = () => new Response(null, { status: 404 });
      await sync.setSession(session);
      expect((await sync.run("recovered-context-gateway-before-cleanup")).status).toBe("failed");
      expect(await readState()).toEqual(before);
      busy = true;
      await sync.suspend();
      if (cleanup === "org-switch") {
        activeSession = { ...session, orgId: "org_other" };
        await sync.setSession(activeSession);
        expect((await sync.run(cleanup)).status).toBe("applied");
      } else {
        await sync.clearSession();
        expect(await sync.run(cleanup)).toEqual({ status: "no_session" });
      }
      expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))).toEqual({});
      expect(await env.list()).toEqual([]);
      expect(await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__"))
        .toEqual({ providerIds: [], envHashes: {} });
      expect(engineRequests.slice(before.engineRequests.length).sort()).toEqual(["DELETE /auth/ipr_ready", "DELETE /auth/lpr_test"]);
      expect(reloads).toBe(before.reloads + 1);
      if (cleanup === "org-switch") {
        busy = false;
        activeSession = session;
        inferenceListResponse = undefined;
        await sync.setSession(session);
        expect((await sync.run("gateway-after-org-switch")).status).toBe("applied");
      }
    }
    expect(denPaths.some((path) => path.startsWith("/v1/llm-providers/ipr_"))).toBe(false);
  });

  test("preserves a scoped local Desktop credential through upgrades, restarts, and provider revocation", async () => {
    const root = await createRoot();
    const credentialKey = "LPR_00004_OPENAI_API_KEY";
    const localSecret = "sk-local-fallback-never-cloud-owned";
    const provider: FakeProvider = {
      ...buildProvider([{ id: "allowed-local-model", name: "Allowed Local Model", config: {} }]),
      id: "lpr_00000000000000000000000004",
      providerId: "openai",
      source: "models_dev",
      name: "Local Credential Provider",
      apiKey: "",
      apiKeys: null,
      providerConfig: {
        id: "openai",
        env: [credentialKey],
        npm: "@ai-sdk/openai",
      },
    };
    const legacyProvider = {
      ...provider.providerConfig,
      name: provider.name,
      models: { "allowed-local-model": { id: "allowed-local-model", name: "Allowed Local Model" } },
    };
    const session = { baseUrl: "https://den.example.test", token: "den-token", orgId: "org-local-fallback" };
    let granted = true;
    const denTraffic: Array<{ url: string; body: string | null }> = [];
    const engineAuth = new Map<string, string>();
    const fetchImpl = Object.assign(async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? init.body : null;
      if (url.hostname === "den.example.test") {
        denTraffic.push({ url: url.toString(), body });
        const allowed = granted && new Headers(init?.headers).get("x-openwork-org-id") === session.orgId;
        if (url.pathname === "/v1/llm-providers") return Response.json({ llmProviders: allowed ? [provider] : [] });
        if (allowed && url.pathname === `/v1/llm-providers/${provider.id}/connect`) {
          return Response.json({ llmProvider: provider });
        }
      }
      if (url.hostname === "engine.example.test" && url.pathname.startsWith("/auth/")) {
        const id = decodeURIComponent(url.pathname.slice("/auth/".length));
        if (init?.method === "DELETE") engineAuth.delete(id);
        if (init?.method === "PUT") {
          const auth = expectRecord(JSON.parse(body ?? "null"), "engine auth");
          if (typeof auth.key !== "string") throw new Error("Expected engine credential");
          engineAuth.set(id, auth.key);
        }
        return Response.json(true);
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }, { preconnect: globalThis.fetch.preconnect });
    const config = serverConfig(root, "https://engine.example.test");
    let env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
    const newSync = () => {
      const sync = new CloudProviderSync({
        config: serverConfig(root, "https://engine.example.test"),
        env,
        fetchImpl,
        reloadEngine: reloadedInPlace,
        intervalMs: 3_600_000,
      });
      stops.push(() => sync.stop());
      return sync;
    };
    let sync = newSync();
    const expectConnected = async (envHashes: Record<string, unknown> = {}) => {
      expect(sync.status().providers.map((entry) => entry.cloudProviderId)).toEqual([provider.id]);
      expect(sync.status().providers[0]?.modelIds).toEqual(["allowed-local-model"]);
      expect(sync.status().skippedProviders).toEqual([]);
      expect(sync.status().lastRun?.detail?.envUpserts).toBe(0);
      expect(sync.status().lastRun?.detail?.envDeletes).toBe(0);
      const runtimeProvider = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))[provider.id];
      expect(runtimeProvider).toEqual(legacyProvider);
      expect(runtimeProviderMap(await readRuntimeOpencodeConfig(config, "ws_1"))[provider.id]).toBeUndefined();
      expect(JSON.stringify(runtimeProvider)).not.toContain(localSecret);
      expect(JSON.stringify(sync.status())).not.toContain(localSecret);
      expect(JSON.stringify(denTraffic)).not.toContain(localSecret);
      expect(engineAuth.get(provider.id)).toBe(localSecret);
      expect((await env.list()).find((entry) => entry.key === credentialKey)?.value).toBe(localSecret);
      const ownership = await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__");
      expect(ownership.providerIds).toEqual([provider.id]);
      expect(ownership.envHashes).toEqual(envHashes);
      expect(JSON.stringify(ownership)).not.toContain(localSecret);
    };
    const expectRetired = async () => {
      expect(sync.status().providers).toEqual([]);
      expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))[provider.id]).toBeUndefined();
      expect(runtimeProviderMap(await readRuntimeOpencodeConfig(config, "ws_1"))[provider.id]).toBeUndefined();
      expect(await readFile(openworkRuntimeConfigFilePath(config), "utf8")).not.toContain(provider.id);
      expect(engineAuth.has(provider.id)).toBe(false);
      expect((await env.list()).find((entry) => entry.key === credentialKey)?.value).toBe(localSecret);
    };

    await sync.setSession(session);
    await sync.run("initial-missing");
    expect(sync.status().providers).toEqual([]);
    expect(sync.status().skippedProviders).toEqual([{
      cloudProviderId: provider.id,
      providerId: provider.id,
      name: provider.name,
      reason: "missing_credentials",
    }]);

    await env.upsertMany([{ key: "UNRELATED_API_KEY", value: "sk-unrelated" }]);
    await sync.run("mismatched-local-key");
    expect(sync.status().providers).toEqual([]);
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))[provider.id]).toBeUndefined();

    await env.upsertMany([{ key: credentialKey, value: localSecret }]);
    await writeGlobalRuntimeOpencodeConfig(config, () => ({ provider: { [provider.id]: legacyProvider } }));
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ provider: { [provider.id]: legacyProvider } }));
    expect(await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__"))
      .toEqual({ providerIds: [], envHashes: {} });
    sync.stop();
    env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
    sync = newSync();
    await sync.setSession(session);
    expect((await sync.run("legacy-local-key-upgrade")).status).toBe("applied");
    await expectConnected();
    expect((await sync.run("unchanged-local-key")).status).toBe("noop");
    await expectConnected();

    sync.stop();
    env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
    sync = newSync();
    await sync.setSession(session);
    expect((await sync.run("restart-with-local-key")).status).toBe("applied");
    await expectConnected();

    granted = false;
    expect((await sync.run("provider-revoked")).status).toBe("applied");
    await expectRetired();
    expect((await sync.run("still-revoked-with-local-key")).status).toBe("noop");
    await expectRetired();

    granted = true;
    expect((await sync.run("provider-grant-restored")).status).toBe("applied");
    await expectConnected();
    await sync.clearSession();
    await expectRetired();
    expect(await sync.run("signed-out-with-local-key")).toEqual({ status: "no_session" });

    await sync.setSession(session);
    await sync.run("restore-with-local-key");
    await expectConnected();
    await sync.setSession({ ...session, orgId: "org-other" });
    await sync.run("different-organization-with-local-key");
    await expectRetired();
    await sync.setSession(session);
    await sync.run("restore-allowed-organization");
    await expectConnected();

    await env.delete(credentialKey);
    expect((await sync.run("local-key-removed")).status).toBe("applied");
    expect(sync.status().providers).toEqual([]);
    expect(sync.status().skippedProviders[0]?.reason).toBe("missing_credentials");
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))[provider.id]).toBeUndefined();
    expect(engineAuth.has(provider.id)).toBe(false);
    expect((await env.list()).find((entry) => entry.key === "UNRELATED_API_KEY")?.value).toBe("sk-unrelated");

    provider.apiKey = "sk-cloud-supplied-fixture";
    expect((await sync.run("cloud-key-supplied")).status).toBe("applied");
    const cloudOwnership = await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__");
    const cloudHashes = expectRecord(cloudOwnership.envHashes, "Cloud credential hashes");
    expect(Object.keys(cloudHashes)).toEqual([credentialKey]);
    expect(engineAuth.get(provider.id)).toBe(provider.apiKey);
    provider.apiKey = "";
    expect((await sync.run("cloud-credential-withdrawn")).status).toBe("applied");
    expect(sync.status().providers).toEqual([]);
    expect(sync.status().skippedProviders[0]?.reason).toBe("missing_credentials");
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))[provider.id]).toBeUndefined();
    expect((await env.list()).some((entry) => entry.key === credentialKey)).toBe(false);
    expect(engineAuth.has(provider.id)).toBe(false);

    provider.apiKey = "sk-cloud-supplied-fixture";
    expect((await sync.run("cloud-credential-restored")).status).toBe("applied");
    await env.upsertMany([{ key: credentialKey, value: localSecret }]);
    provider.apiKey = "";
    sync.stop();
    env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
    sync = newSync();
    await sync.setSession(session);
    expect((await sync.run("restart-with-locally-replaced-cloud-key")).status).toBe("applied");
    await expectConnected(cloudHashes);
    await sync.clearSession();
    await expectRetired();
  });

  test("moves the org credential an earlier release stored under the bare catalog name and never touches a member's different value", async () => {
    const root = await createRoot();
    // A models.dev provider: Den stores the declared name but the connect
    // payload delivers the provider-scoped runtime name (LPR_<row tail>_<name>).
    const catalogProviderId = "lpr_01kx4t3amgendr682dmp6120jv";
    const declaredEnv = "OPENAI_API_KEY";
    const scopedEnv = `LPR_120JV_${declaredEnv}`;
    const orgCredential = "test-only-organization-credential";
    const userCredential = "test-only-users-own-credential";
    const stored: FakeProvider = {
      id: catalogProviderId,
      providerId: "openai",
      name: "Organization OpenAI",
      source: "models_dev",
      updatedAt: "2026-09-01T00:00:00.000Z",
      providerConfig: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: [declaredEnv] },
      apiKey: orgCredential,
      apiKeys: null,
      models: [{ id: "assigned-model", name: "Assigned model", config: {} }],
    };
    const runtime: FakeProvider = { ...stored, providerConfig: { ...stored.providerConfig, env: [scopedEnv] } };
    const fetchImpl = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = new URL(String(input));
      if (url.hostname === "den.example.test") {
        if (url.pathname === "/v1/llm-providers") return Response.json({ llmProviders: [stored] });
        if (url.pathname === `/v1/llm-providers/${catalogProviderId}/connect`) {
          return Response.json({ llmProvider: runtime });
        }
      }
      if (url.hostname === "engine.example.test" && url.pathname.startsWith("/auth/")) return Response.json(true);
      return Response.json({ error: "not_found" }, { status: 404 });
    }, { preconnect: globalThis.fetch.preconnect });
    const config = serverConfig(root, "https://engine.example.test");
    const env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
    const envValues = async () => new Map((await env.list()).map((entry) => [entry.key, entry.value]));
    const session = { baseUrl: "https://den.example.test", token: "den-token", orgId: "org-env-upgrade" };
    const newSync = () => {
      const sync = new CloudProviderSync({ config, env, fetchImpl, reloadEngine: reloadedInPlace, intervalMs: 3_600_000 });
      stops.push(() => sync.stop());
      return sync;
    };

    // The previous release wrote the org credential under the bare catalog
    // name; the app was then upgraded, so nothing in memory owns that key.
    await env.upsertMany([{ key: declaredEnv, value: orgCredential }]);
    let sync = newSync();
    await sync.setSession(session);
    expect((await sync.run("first-sync-after-upgrade")).status).toBe("applied");
    const afterUpgrade = await envValues();
    expect(afterUpgrade.get(scopedEnv)).toBe(orgCredential);
    expect(afterUpgrade.has(declaredEnv)).toBe(false);
    expect((await sync.run("steady")).status).toBe("noop");

    // A member's own key under the bare name has a different value: a
    // restart-then-sync must leave it alone.
    sync.stop();
    await env.upsertMany([{ key: declaredEnv, value: userCredential }]);
    sync = newSync();
    await sync.setSession(session);
    expect((await sync.run("restart")).status).toBe("applied");
    const afterRestart = await envValues();
    expect(afterRestart.get(declaredEnv)).toBe(userCredential);
    expect(afterRestart.get(scopedEnv)).toBe(orgCredential);
    expect((await sync.run("steady-with-own-key")).status).toBe("noop");
    expect(afterRestart.get(declaredEnv)).toBe(userCredential);
  });

  test("materializes Den providers globally, reconciles changes, and sweeps the session", async () => {
    const root = await createRoot();
    process.env.OPENWORK_ENGINE_RELOAD_RETRY_MS = "20";
    const engineRequests: string[] = [];
    const engine = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        engineRequests.push(`${request.method} ${url.pathname}`);
        // An idle engine: the reload guard's busy probe reads /session/status,
        // and a catch-all {ok:true} body parses as a non-idle session, which
        // would silently defer every reload in this test.
        if (request.method === "GET" && url.pathname === "/session/status") {
          return Response.json({});
        }
        return Response.json({ ok: true });
      },
    });
    stops.push(() => engine.stop(true));

    let denFailure = false;
    let policyFailure = false;
    let denProviders = [
      buildProvider([
        { id: "model-z", name: "Model Z", config: { reasoning: true } },
        { id: "model-a", name: "Model A", config: { family: "test" } },
      ]),
      buildProviderWithoutCredential(),
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
        // This fixture isolates provider-catalog outages; policy verification
        // remains available when the provider service fails.
        if (url.pathname === "/v1/me/desktop-config") return policyFailure
          ? Response.json({ error: "denied" }, { status: 401 }) : Response.json({});
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
    // Simulate an upgrade/restart after an older process persisted the cloud
    // credential. The next sync sees the same value, performs no upsert, and
    // must still reclaim ownership so logout removes it.
    await new EnvService({ path: process.env.OPENWORK_ENV_STORE }).upsertMany([
      { key: "TEST_PROVIDER_API_KEY", value: "sk-test-provider" },
    ]);

    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;

    const capabilitiesResponse = await fetch(`${base}/capabilities`, { headers: clientHeaders() });
    expect(capabilitiesResponse.status).toBe(200);
    expect((await responseRecord(capabilitiesResponse, "capabilities")).providerSync).toBe(true);

    expect(await runSync(base, "before-session")).toEqual({ status: "no_session" });

    const identity = {
      baseUrl: `http://127.0.0.1:${den.port}`,
      token: "den-token",
      orgId: "org_test",
    };
    const deliverIdentity = (body = identity, headers: Record<string, string> = hostHeaders()) => fetch(`${base}/den-session/identity`, {
      method: "PUT", headers, body: JSON.stringify(body),
    });
    for (const headers of [{}, clientHeaders(), { ...hostHeaders(), "x-openwork-host-token": "wrong" }]) {
      expect((await deliverIdentity(identity, headers)).status).toBe(401);
    }
    for (const body of [{ ...identity, baseUrl: "file:///tmp/den" }, { ...identity, token: "" }]) {
      expect((await deliverIdentity(body)).status).toBe(400);
    }
    expect(denRequests).toEqual([]);
    config.readOnly = true;
    expect((await deliverIdentity()).status).toBe(403);
    config.readOnly = false;
    policyFailure = true;
    expect((await deliverIdentity()).status).toBe(204);
    expect(await runSync(base, "policy-is-optional")).toEqual({ status: "no_session" });
    policyFailure = false;
    const env = new EnvService({ path: process.env.OPENWORK_ENV_STORE });
    const envBefore = await env.list();
    const providersBefore = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config));
    const fileBefore = await readFile(openworkRuntimeConfigFilePath(config), "utf8").catch(() => null);
    const engineBefore = [...engineRequests];
    expect((await deliverIdentity()).status).toBe(204);
    await Bun.sleep(80);
    expect(await runSync(base, "identity-is-not-ready")).toEqual({ status: "no_session" });
    expect(denRequests).toEqual([]);
    expect((await readGlobalRuntimeOpencodeConfig(config)).managedPolicy).toBeUndefined();
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))).toEqual(providersBefore);
    expect(await env.list()).toEqual(envBefore);
    expect(await readFile(openworkRuntimeConfigFilePath(config), "utf8").catch(() => null)).toBe(fileBefore);
    expect(engineRequests).toEqual(engineBefore);

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
    // The credential-less provider is skipped — loudly, with a reason.
    expect(firstStatus.skippedProviders).toEqual([{
      cloudProviderId: "lpr_nocred",
      providerId: "lpr_nocred",
      name: "No Credential Provider",
      reason: "missing_credentials",
    }]);
    // The idle engine accepted the reload, so no reload is still owed.
    expect(firstStatus.reloadPending).toBe(false);
    expect(engineRequests.indexOf("PUT /auth/lpr_test")).toBeLessThan(
      engineRequests.indexOf("POST /instance/dispose"),
    );

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
    // A matching import baseline alone does not prove server ownership.
    expect(workspaceProviders.lpr_stale).toEqual({ id: "stale", name: "Stale", env: ["STALE_KEY"] });
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
    // The skipped provider left the Den grant list, so the skip entry clears.
    expect(updatedStatus.skippedProviders).toEqual([]);

    denProviders = [];
    expect(await runSync(base, "provider-removed")).toEqual({ status: "applied" });
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config)).lpr_test).toBeUndefined();
    expect(await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__"))
      .toEqual({ providerIds: [], envHashes: {} });
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
      reloadPending: false,
      skippedProviders: [],
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
