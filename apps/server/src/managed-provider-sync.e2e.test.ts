import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const HOST_TOKEN = "owt_provider_sync_host_token";
const CLIENT_TOKEN = "owt_provider_sync_client_token";
const stops: Array<() => void | Promise<void>> = [];
const dirs: string[] = [];

function hostAuth() {
  return { "x-openwork-host-token": HOST_TOKEN, "content-type": "application/json" };
}

function providerPayload() {
  return {
    revision: "sync-rev-1",
    providers: [
      {
        id: "llmProvider_den_anthropic",
        providerId: "anthropic",
        name: "Anthropic",
        source: "models_dev",
        credentialKind: "api_key",
        providerConfig: { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], npm: "@ai-sdk/anthropic" },
        models: [{ id: "claude", name: "Claude", config: { id: "claude", limit: { context: 200000 } } }],
        apiKey: "sk-server-secret",
        revision: "provider-rev-1",
      },
      {
        id: "llmProvider_den_openai",
        providerId: "openai",
        name: "OpenAI",
        source: "models_dev",
        credentialKind: "opencode_oauth",
        providerConfig: { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], npm: "@ai-sdk/openai" },
        models: [{ id: "gpt-5", name: "GPT-5", config: { id: "gpt-5" } }],
        opencodeAuth: JSON.stringify({ type: "oauth", access: "access-secret", refresh: "refresh-secret", expires: 9 }),
        revision: "provider-rev-2",
      },
    ],
  };
}

async function boot(options: { failAuth?: boolean } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "openwork-managed-provider-workspace-"));
  const stores = mkdtempSync(join(tmpdir(), "openwork-managed-provider-stores-"));
  dirs.push(workspace, stores);
  process.env.OPENWORK_TOKEN_STORE = join(stores, "tokens.json");

  const authCalls: unknown[] = [];
  const opencode = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/auth/")) {
        authCalls.push(await request.json());
        if (options.failAuth) return Response.json({ error: "bad sk-server-secret" }, { status: 500 });
        return Response.json({ ok: true });
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
      expect(JSON.stringify(body)).not.toContain("sk-server-secret");
      expect(JSON.stringify(body)).not.toContain("refresh-secret");
    }

    const config = readFileSync(join(workspace, "opencode.jsonc"), "utf8");
    expect(config.match(/llmProvider_den_anthropic/g)?.length).toBe(1);
    expect(config.match(/"openai"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(config).not.toContain("sk-server-secret");
    expect(authCalls).toHaveLength(4);
    expect(JSON.stringify(authCalls[0])).toContain("sk-server-secret");
    expect(JSON.stringify(authCalls[1])).toContain("refresh-secret");
  });

  test("sanitizes OpenCode auth apply failures", async () => {
    const { base } = await boot({ failAuth: true });
    const response = await fetch(`${base}/managed-providers/sync`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify(providerPayload()),
    });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.status).toBe("failed");
    expect(JSON.stringify(body)).not.toContain("sk-server-secret");
  });
});
