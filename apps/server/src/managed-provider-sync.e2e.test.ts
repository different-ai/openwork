import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

type ProviderListTestItem = {
  id: string;
  models?: Record<string, unknown>;
};

type ProviderListTestBody = {
  all?: ProviderListTestItem[];
  providers?: ProviderListTestItem[] | Record<string, ProviderListTestItem>;
};

const HOST_TOKEN = "owt_provider_sync_host_token";
const CLIENT_TOKEN = "owt_provider_sync_client_token";
const stops: Array<() => void | Promise<void>> = [];
const dirs: string[] = [];

function hostAuth() {
  return { "x-openwork-host-token": HOST_TOKEN, "content-type": "application/json" };
}

function clientAuth() {
  return { authorization: `Bearer ${CLIENT_TOKEN}` };
}

function providerPayload() {
  return {
    revision: "sync-rev-1",
    providers: [
      {
        id: "lpr_den_nvidia",
        providerId: "nvidia",
        name: "NVIDIA",
        source: "models_dev",
        credentialKind: "api_key",
        providerConfig: { id: "nvidia", name: "NVIDIA", env: ["NVIDIA_API_KEY"], npm: "@ai-sdk/openai-compatible" },
        models: [
          { id: "deepseek-ai/deepseek-v4-flash", name: "DeepSeek V4 Flash", config: { id: "deepseek-ai/deepseek-v4-flash", limit: { context: 128000 }, experimental: true } },
          { id: "google/gemma-4-31b-it", name: "Gemma-4-31B-IT", config: { id: "google/gemma-4-31b-it" } },
        ],
        apiKey: "plain-server-secret",
        revision: "provider-rev-1",
      },
      {
        id: "llmProvider_den_openai",
        providerId: "openai",
        name: "OpenAI",
        source: "models_dev",
        credentialKind: "opencode_oauth",
        providerConfig: { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], npm: "@ai-sdk/openai" },
        models: [
          { id: "gpt-5.4", name: "GPT-5.4", config: { id: "gpt-5.4", experimental: { modes: { chat: true } }, knowledge: "2026-01" } },
          { id: "gpt-5.5", name: "GPT-5.5", config: { id: "gpt-5.5" } },
        ],
        opencodeAuth: JSON.stringify({ type: "oauth", access: "access-secret", refresh: "refresh-secret", expires: 9 }),
        revision: "provider-rev-2",
      },
    ],
  };
}

async function boot(options: { failAuth?: boolean; failAuthPath?: string; failAuthDeletePath?: string; failAuthDeletePathOnce?: string; providerListShape?: "all" | "providers-array" | "providers-object"; connected?: string[] } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "openwork-managed-provider-workspace-"));
  const stores = mkdtempSync(join(tmpdir(), "openwork-managed-provider-stores-"));
  dirs.push(workspace, stores);
  process.env.OPENWORK_TOKEN_STORE = join(stores, "tokens.json");

  const authCalls: Array<{ method: string; path: string; body: unknown }> = [];
  const failedDeletePaths = new Set<string>();
  const opencode = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/auth/")) {
        const body = request.method === "DELETE" ? null : await request.json();
        authCalls.push({ method: request.method, path: url.pathname, body });
        const shouldFailDeleteOnce = request.method === "DELETE" && url.pathname === options.failAuthDeletePathOnce && !failedDeletePaths.has(url.pathname);
        if (shouldFailDeleteOnce) failedDeletePaths.add(url.pathname);
        if (options.failAuth || url.pathname === options.failAuthPath || (request.method === "DELETE" && url.pathname === options.failAuthDeletePath) || shouldFailDeleteOnce) {
          return Response.json({ error: "bad plain-server-secret access-secret refresh-secret" }, { status: 500 });
        }
        return Response.json({ ok: true });
      }
      if (url.pathname === "/config/providers") {
        const providers = [
          {
            id: "lpr_den_nvidia",
            name: "NVIDIA",
            source: "custom",
            models: {
              "deepseek-ai/deepseek-v4-flash": { id: "deepseek-ai/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
              "google/gemma-4-31b-it": { id: "google/gemma-4-31b-it", name: "Gemma-4-31B-IT" },
            },
          },
          {
            id: "openai",
            name: "OpenAI",
            source: "config",
            models: {
              "gpt-5.4": { id: "gpt-5.4", name: "GPT-5.4" },
              "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" },
              "gpt-4o": { id: "gpt-4o", name: "GPT-4o" },
              "gpt-5.4-fast": { id: "gpt-5.4-fast", name: "GPT-5.4 Fast" },
              "o4-mini": { id: "o4-mini", name: "o4-mini" },
            },
          },
        ];
        if (options.providerListShape === "providers-array") {
          return Response.json({
            default: "openai",
            providers,
          });
        }
        if (options.providerListShape === "providers-object") {
          return Response.json({
            default: "openai",
            providers: Object.fromEntries(providers.map((provider) => [provider.id, provider])),
          });
        }
        return Response.json({
          all: providers,
          connected: options.connected ?? ["lpr_den_nvidia", "openai"],
          default: { "lpr_den_nvidia": "deepseek-ai/deepseek-v4-flash", openai: "gpt-5.4" },
        });
      }
      return Response.json({ ok: true });
    },
  });
  stops.push(() => opencode.stop(true));

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspace, workspaceType: "local", preset: "starter", baseUrl: `http://127.0.0.1:${opencode.port}` }],
    authorizedRoots: [workspace],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, workspace, authCalls };
}

function readManagedProviderMetadata(workspace: string) {
  const openworkConfig = JSON.parse(readFileSync(join(workspace, ".opencode", "openwork.json"), "utf8")) as {
    managedProviders?: { applied?: string[]; revoked?: string[]; revision?: string };
  };
  return openworkConfig.managedProviders ?? {};
}

beforeEach(() => {
  delete process.env.OPENWORK_TOKEN_STORE;
});

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.OPENWORK_TOKEN_STORE;
});

describe("managed provider sync runtime route", () => {
  test("requires host token and rejects client bearer tokens", async () => {
    const { base } = await boot();
    const unauthenticated = await fetch(`${base}/managed-providers/sync`, { method: "POST", body: JSON.stringify(providerPayload()) });
    expect(unauthenticated.status).toBe(401);

    const issued = await fetch(`${base}/tokens`, { method: "POST", headers: hostAuth(), body: JSON.stringify({ scope: "owner" }) });
    const body = (await issued.json()) as { token: string };
    const ownerBearer = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" },
      body: JSON.stringify(providerPayload()),
    });
    expect(ownerBearer.status).toBe(401);
  });

  test("applies API key and OAuth providers idempotently without response leakage", async () => {
    const { base, workspace, authCalls } = await boot();
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${base}/managed-providers/sync`, {
        method: "POST",
        headers: hostAuth(),
        body: JSON.stringify(providerPayload()),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "applied", providerCount: 2, revision: "sync-rev-1" });
      expect(JSON.stringify(body)).not.toContain("plain-server-secret");
      expect(JSON.stringify(body)).not.toContain("refresh-secret");
    }

    const config = readFileSync(join(workspace, "opencode.jsonc"), "utf8");
    expect(config.match(/lpr_den_nvidia/g)?.length).toBe(1);
    expect(config.match(/"openai"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(config).toContain("gpt-5.4");
    expect(config).toContain("gpt-5.5");
    expect(config).toContain("deepseek-ai/deepseek-v4-flash");
    expect(config).toContain("google/gemma-4-31b-it");
    expect(config).not.toContain("gpt-4o");
    expect(config).not.toContain("gpt-5.4-fast");
    expect(config).not.toContain("o4-mini");
    expect(config).toContain('"experimental": true');
    expect(config).not.toContain('"modes"');
    expect(config).not.toContain('"knowledge"');
    expect(config).not.toContain("plain-server-secret");
    expect(authCalls).toHaveLength(4);
    expect(authCalls[0]?.method).toBe("PUT");
    expect(authCalls[0]?.path).toBe("/auth/lpr_den_nvidia");
    expect(authCalls[0]?.body).toEqual({ type: "api", key: "plain-server-secret" });
    expect(authCalls[1]?.method).toBe("PUT");
    expect(authCalls[1]?.path).toBe("/auth/openai");
    expect(authCalls[1]?.body).toEqual({ type: "oauth", access: "access-secret", refresh: "refresh-secret", expires: 9 });
  });

  test("filters managed OAuth provider-list models to Den-selected config models", async () => {
    const { base } = await boot();
    const sync = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(providerPayload()),
    });
    expect(sync.status).toBe(200);

    const response = await fetch(`${base}/workspace/ws_1/opencode/config/providers`, { headers: clientAuth() });
    expect(response.status).toBe(200);
    const body = await response.json() as ProviderListTestBody;
    const providers = Array.isArray(body.all) ? body.all : [];
    const openai = providers.find((provider) => provider?.id === "openai");
    const nvidia = providers.find((provider) => provider?.id === "lpr_den_nvidia");

    expect(Object.keys(openai?.models ?? {}).sort()).toEqual(["gpt-5.4", "gpt-5.5"]);
    expect(Object.keys(openai?.models ?? {})).not.toContain("gpt-4o");
    expect(Object.keys(openai?.models ?? {})).not.toContain("gpt-5.4-fast");
    expect(Object.keys(openai?.models ?? {})).not.toContain("o4-mini");
    expect(Object.keys(nvidia?.models ?? {}).sort()).toEqual(["deepseek-ai/deepseek-v4-flash", "google/gemma-4-31b-it"]);
    expect(JSON.stringify(body)).not.toContain("plain-server-secret");
    expect(JSON.stringify(body)).not.toContain("refresh-secret");
  });

  test("keeps Den-managed config providers visible when OpenCode connected list is empty", async () => {
    const { base } = await boot({ connected: [] });
    const sync = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(providerPayload()),
    });
    expect(sync.status).toBe(200);

    const response = await fetch(`${base}/workspace/ws_1/opencode/config/providers`, { headers: clientAuth() });
    expect(response.status).toBe(200);
    const body = await response.json() as ProviderListTestBody & { connected?: string[] };

    expect(body.connected?.sort()).toEqual(["lpr_den_nvidia", "openai"]);
  });

  test("filters managed OAuth provider-list models for live providers-array responses", async () => {
    const { base } = await boot({ providerListShape: "providers-array" });
    const sync = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(providerPayload()),
    });
    expect(sync.status).toBe(200);

    const response = await fetch(`${base}/workspace/ws_1/opencode/config/providers`, { headers: clientAuth() });
    expect(response.status).toBe(200);
    const body = await response.json() as ProviderListTestBody;
    const providers = Array.isArray(body.providers) ? body.providers : [];
    const openai = providers.find((provider) => provider?.id === "openai");
    const nvidia = providers.find((provider) => provider?.id === "lpr_den_nvidia");

    expect(Object.keys(openai?.models ?? {}).sort()).toEqual(["gpt-5.4", "gpt-5.5"]);
    expect(Object.keys(openai?.models ?? {})).not.toContain("gpt-4o");
    expect(Object.keys(openai?.models ?? {})).not.toContain("gpt-5.4-fast");
    expect(Object.keys(openai?.models ?? {})).not.toContain("o4-mini");
    expect(Object.keys(nvidia?.models ?? {}).sort()).toEqual(["deepseek-ai/deepseek-v4-flash", "google/gemma-4-31b-it"]);
    expect(JSON.stringify(body)).not.toContain("plain-server-secret");
    expect(JSON.stringify(body)).not.toContain("refresh-secret");
  });

  test("filters managed OAuth provider-list models for providers-object responses", async () => {
    const { base } = await boot({ providerListShape: "providers-object" });
    const sync = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(providerPayload()),
    });
    expect(sync.status).toBe(200);

    const response = await fetch(`${base}/workspace/ws_1/opencode/config/providers`, { headers: clientAuth() });
    expect(response.status).toBe(200);
    const body = await response.json() as ProviderListTestBody;
    const providers = !Array.isArray(body.providers) && body.providers ? body.providers : {};
    const openai = providers.openai;
    const nvidia = providers.lpr_den_nvidia;

    expect(Object.keys(openai?.models ?? {}).sort()).toEqual(["gpt-5.4", "gpt-5.5"]);
    expect(Object.keys(openai?.models ?? {})).not.toContain("gpt-4o");
    expect(Object.keys(openai?.models ?? {})).not.toContain("gpt-5.4-fast");
    expect(Object.keys(openai?.models ?? {})).not.toContain("o4-mini");
    expect(Object.keys(nvidia?.models ?? {}).sort()).toEqual(["deepseek-ai/deepseek-v4-flash", "google/gemma-4-31b-it"]);
    expect(JSON.stringify(body)).not.toContain("plain-server-secret");
    expect(JSON.stringify(body)).not.toContain("refresh-secret");
  });

  test("sanitizes OpenCode auth apply failures", async () => {
    const { base, workspace } = await boot({ failAuth: true });
    const response = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(providerPayload()),
    });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.status).toBe("failed");
    expect(JSON.stringify(body)).not.toContain("plain-server-secret");
    expect(JSON.stringify(body)).not.toContain("access-secret");
    expect(JSON.stringify(body)).not.toContain("refresh-secret");
    expect(body.reason).toBe("Managed provider sync failed");
    const configPath = join(workspace, "opencode.jsonc");
    expect(existsSync(configPath) ? readFileSync(configPath, "utf8") : "").not.toContain("lpr_den_nvidia");
  });

  test("authoritatively removes revoked managed providers from config, auth, and provider lists", async () => {
    const { base, workspace, authCalls } = await boot();
    const fullPayload = providerPayload();
    const initial = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(fullPayload),
    });
    expect(initial.status).toBe(200);

    const nvidiaOnlyPayload = { revision: "sync-rev-2", providers: [fullPayload.providers[0]] };
    const update = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(nvidiaOnlyPayload),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual({ status: "applied", providerCount: 1, revision: "sync-rev-2" });

    const config = readFileSync(join(workspace, "opencode.jsonc"), "utf8");
    expect(config).toContain("lpr_den_nvidia");
    expect(config).not.toContain('"openai"');
    expect(config).not.toContain("gpt-5.4");

    const response = await fetch(`${base}/workspace/ws_1/opencode/config/providers`, { headers: clientAuth() });
    expect(response.status).toBe(200);
    const body = await response.json() as ProviderListTestBody & { connected?: string[] };
    const providers = Array.isArray(body.all) ? body.all : [];
    expect(providers.some((provider) => provider.id === "openai")).toBe(false);
    expect(body.connected ?? []).not.toContain("openai");

    expect(authCalls.some((call) => call.method === "DELETE" && call.path === "/auth/openai")).toBe(true);
  });

  test("empty sync removes all managed providers", async () => {
    const { base, workspace } = await boot();
    const initial = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(providerPayload()),
    });
    expect(initial.status).toBe(200);

    const empty = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify({ revision: "sync-empty", providers: [] }),
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ status: "applied", providerCount: 0, revision: "sync-empty" });

    const config = readFileSync(join(workspace, "opencode.jsonc"), "utf8");
    expect(config).not.toContain("lpr_den_nvidia");
    expect(config).not.toContain('"openai"');
  });

  test("failure on a later provider removes auth written earlier in the same attempt", async () => {
    const { base, workspace, authCalls } = await boot({ failAuthPath: "/auth/openai" });
    const response = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(providerPayload()),
    });
    expect(response.status).toBe(502);
    const configPath = join(workspace, "opencode.jsonc");
    expect(existsSync(configPath) ? readFileSync(configPath, "utf8") : "").not.toContain("lpr_den_nvidia");
    expect(authCalls.some((call) => call.method === "PUT" && call.path === "/auth/lpr_den_nvidia")).toBe(true);
    expect(authCalls.some((call) => call.method === "DELETE" && call.path === "/auth/lpr_den_nvidia")).toBe(true);
  });

  test("stale auth deletion failure does not restore config that references stale providers", async () => {
    const { base, workspace, authCalls } = await boot({ failAuthDeletePath: "/auth/openai" });
    const fullPayload = providerPayload();
    const initial = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(fullPayload),
    });
    expect(initial.status).toBe(200);

    const nvidiaOnlyPayload = { revision: "sync-rev-2", providers: [fullPayload.providers[0]] };
    const update = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(nvidiaOnlyPayload),
    });

    expect(update.status).toBe(502);
    const body = await update.json();
    expect(body).toMatchObject({ status: "failed", providerCount: 1, revision: "sync-rev-2" });
    const config = readFileSync(join(workspace, "opencode.jsonc"), "utf8");
    expect(config).toContain("lpr_den_nvidia");
    expect(config).not.toContain('"openai"');
    expect(config).not.toContain("gpt-5.4");
    const metadata = readManagedProviderMetadata(workspace);
    expect(metadata.applied?.sort()).toEqual(["lpr_den_nvidia", "openai"]);
    expect(metadata.revoked).toContain("openai");
    expect(authCalls.some((call) => call.method === "DELETE" && call.path === "/auth/openai")).toBe(true);
  });

  test("retries stale auth deletion after a previous deletion failure", async () => {
    const { base, workspace, authCalls } = await boot({ failAuthDeletePathOnce: "/auth/openai" });
    const fullPayload = providerPayload();
    const initial = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(fullPayload),
    });
    expect(initial.status).toBe(200);

    const nvidiaOnlyPayload = { revision: "sync-rev-2", providers: [fullPayload.providers[0]] };
    const firstUpdate = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(nvidiaOnlyPayload),
    });
    expect(firstUpdate.status).toBe(502);
    expect(readManagedProviderMetadata(workspace).applied?.sort()).toEqual(["lpr_den_nvidia", "openai"]);

    const retry = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(nvidiaOnlyPayload),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: "applied", providerCount: 1, revision: "sync-rev-2" });

    const deleteAttempts = authCalls.filter((call) => call.method === "DELETE" && call.path === "/auth/openai");
    expect(deleteAttempts).toHaveLength(2);
    const metadata = readManagedProviderMetadata(workspace);
    expect(metadata.applied).toEqual(["lpr_den_nvidia"]);
    expect(metadata.revoked).toContain("openai");
  });
});
