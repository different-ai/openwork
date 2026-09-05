import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EnterpriseMcpClientError } from "@openwork/enterprise-mcp-client";

import { ApiError } from "./errors.js";
import {
  createLocalManagedMcpConnection,
  deleteLocalManagedMcp,
  listLocalManagedMcpConnectionsSafe,
  setLocalManagedMcpEnabled,
} from "./local-managed-mcp.js";
import { runtimeStorageDir } from "./runtime-db.js";
import { readRuntimeMcpConfig, runtimeMcpMap, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: () => void | Promise<void> };
type EngineRequest = { method: string; pathname: string; body: unknown };

const repoRoot = resolve(import.meta.dir, "../../..");
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (children.length) children.pop()?.kill();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("failed to allocate a free port");
  return port;
}

async function waitFor<T>(read: () => Promise<T | null>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

function startMockOpencode() {
  const requests: EngineRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      requests.push({ method: request.method, pathname: url.pathname, body });
      if (url.pathname === "/mcp" && request.method === "POST") {
        const name = typeof body === "object" && body !== null && "name" in body ? String(body.name) : "managed";
        return Response.json({ [name]: { status: "connected" } });
      }
      if (url.pathname === "/mcp" && request.method === "GET") return Response.json({});
      if (url.pathname === "/instance/dispose") return Response.json({ disposed: true });
      if (/^\/mcp\/[^/]+\/disconnect$/.test(url.pathname)) return Response.json({});
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop());
  return { server, requests };
}

async function startOAuthProvider(port: number): Promise<string> {
  const child = spawn("node", [join(repoRoot, "scripts/mock-oauth-mcp-server.mjs")], {
    env: {
      ...process.env,
      PORT: String(port),
      AUTO_APPROVE: "1",
      STRICT_REFRESH_TOKENS: "1",
      MOCK_ERROR_TOOL_NAME: "mock_provider_error",
    },
    stdio: "ignore",
  });
  children.push(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${baseUrl}/health`)).ok ? baseUrl : null, "OAuth MCP mock");
  return baseUrl;
}

type HandshakeFailure = "oauth-client-registration" | "mcp-discovery" | "mcp-initialize" | "unexpected-sdk-failure";

function startHandshakeFailureProvider(failure: HandshakeFailure): string {
  const nestedSecret = `${failure}-nested-secret`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = url.origin;
      if (url.pathname === "/.well-known/oauth-protected-resource"
        || url.pathname === "/.well-known/oauth-protected-resource/mcp"
        || url.pathname === "/mcp/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["mcp:read"],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server"
        || url.pathname === "/.well-known/oauth-authorization-server/mcp") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["mcp:read"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        if (failure === "oauth-client-registration") {
          return Response.json({
            error: "invalid_client_metadata",
            error_description: nestedSecret,
            client_secret: nestedSecret,
          }, { status: 400 });
        }
        if (failure === "unexpected-sdk-failure") {
          return Response.json({ client_id: 42 }, { status: 201 });
        }
        const body: unknown = await request.json();
        const redirectUris = typeof body === "object" && body !== null && "redirect_uris" in body
          && Array.isArray(body.redirect_uris)
          ? body.redirect_uris.filter((value): value is string => typeof value === "string")
          : [];
        return Response.json({
          client_id: "handshake-witness-client",
          client_id_issued_at: Math.floor(Date.now() / 1_000),
          token_endpoint_auth_method: "none",
          redirect_uris: redirectUris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "mcp:read",
        }, { status: 201 });
      }
      if (url.pathname === "/authorize" && request.method === "GET") {
        const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("code", "handshake-witness-code");
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        return new Response(null, { status: 302, headers: { location: callback.toString() } });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        return Response.json({
          access_token: "handshake-witness-access-token",
          refresh_token: "handshake-witness-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "mcp:read",
        });
      }
      if (url.pathname === "/mcp") {
        if (request.headers.get("authorization") !== "Bearer handshake-witness-access-token") {
          return Response.json({ error: "missing_token" }, {
            status: 401,
            headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` },
          });
        }
        const body: unknown = await request.json().catch(() => null);
        const method = typeof body === "object" && body !== null && "method" in body ? body.method : null;
        const id = typeof body === "object" && body !== null && "id" in body ? body.id : null;
        if (method === "server/discover" && failure === "mcp-discovery") {
          return Response.json({
            error: "provider_discovery_failed",
            cause: { client_secret: nestedSecret },
          }, { status: 503 });
        }
        if (method === "initialize") {
          if (failure === "mcp-initialize") {
            return Response.json({
              error: "provider_initialize_failed",
              cause: { client_secret: nestedSecret },
            }, { status: 503 });
          }
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "handshake-witness", version: "1.0.0" },
            },
          });
        }
        if (method === "notifications/initialized") return new Response(null, { status: 202 });
        if (method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id, result: { tools: [] } });
        }
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop());
  return `http://127.0.0.1:${server.port}`;
}

function createConfig(input: {
  port: number;
  workspaceRoot: string;
  engineBaseUrl: string;
  vaultKey: Uint8Array;
}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: input.port,
    token: "owt_local_managed_test",
    hostToken: "owh_local_managed_test",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws_managed",
      name: "Managed OAuth Workspace",
      path: input.workspaceRoot,
      preset: "starter",
      workspaceType: "local",
      baseUrl: input.engineBaseUrl,
    }],
    authorizedRoots: [input.workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    localManagedMcpVaultKey: async () => input.vaultKey,
  };
}

function clientHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function connectGateway(runtimeConfig: Record<string, unknown>): Promise<Client> {
  const url = new URL(String(runtimeConfig.url));
  const headers = runtimeConfig.headers as Record<string, string>;
  const client = new Client({ name: "openwork-managed-mcp-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

describe("OpenWork-managed local MCP OAuth gateway", () => {
  test("leaves ordinary MCP fallbacks usable when no managed vault exists", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-local-managed-mcp-fallback-"));
    roots.push(workspaceRoot);
    const config = createConfig({
      port: await freePort(),
      workspaceRoot,
      engineBaseUrl: "http://127.0.0.1:1",
      vaultKey: randomBytes(32),
    });
    config.configPath = join(workspaceRoot, "server.json");
    config.localManagedMcpVaultKey = async () => {
      throw new Error("vault key should not be requested");
    };

    expect(await setLocalManagedMcpEnabled(config, "ws_managed", "ordinary", false)).toBe(false);
    expect(await deleteLocalManagedMcp(config, "ws_managed", "ordinary")).toBe(false);
    expect(existsSync(join(runtimeStorageDir(config), "local-managed-mcp-vault.json"))).toBe(false);
  });

  test("rolls back a new managed connection when the initial OAuth handshake fails", async () => {
    const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
    const previousDevMode = process.env.OPENWORK_DEV_MODE;
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-local-managed-mcp-rollback-"));
    roots.push(workspaceRoot);
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    process.env.OPENWORK_DEV_MODE = "1";

    try {
      const engine = startMockOpencode();
      const unavailableProviderPort = await freePort();
      const config = createConfig({
        port: await freePort(),
        workspaceRoot,
        engineBaseUrl: `http://127.0.0.1:${engine.server.port}`,
        vaultKey: randomBytes(32),
      });
      const server = await startServer(config);
      stops.push(() => server.stop());
      const openworkBaseUrl = `http://127.0.0.1:${server.port}`;

      const created = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/managed`, {
        method: "POST",
        headers: clientHeaders(config.token),
        body: JSON.stringify({
          name: "unreachable-oauth",
          url: `http://127.0.0.1:${unavailableProviderPort}/mcp`,
          oauth: { applicationType: "native", requestedScopes: ["mcp:read"] },
        }),
      });
      expect(created.status).toBe(502);
      expect(await created.json()).toMatchObject({
        code: "managed_mcp_connection_failed",
        message: "OpenWork could not connect to this MCP server. Check its OAuth settings and availability, then try again.",
      });

      const status = await fetch(
        `${openworkBaseUrl}/workspace/ws_managed/mcp/unreachable-oauth/managed`,
        { headers: clientHeaders(config.token) },
      );
      expect(status.status).toBe(404);
      expect(await readRuntimeMcpConfig(config, "ws_managed", "unreachable-oauth")).toBeNull();
    } finally {
      if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
      if (previousDevMode === undefined) delete process.env.OPENWORK_DEV_MODE;
      else process.env.OPENWORK_DEV_MODE = previousDevMode;
    }
  });

  test("returns safe connection errors for DCR and protocol negotiation failures", async () => {
    const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
    const previousDevMode = process.env.OPENWORK_DEV_MODE;
    const previousTelemetry = globalThis.__openworkDesktopTelemetry;
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-local-managed-mcp-handshake-errors-"));
    roots.push(workspaceRoot);
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    process.env.OPENWORK_DEV_MODE = "1";
    const captured: unknown[] = [];
    globalThis.__openworkDesktopTelemetry = {
      captureException: (error) => {
        captured.push(error);
        return true;
      },
    };

    try {
      const engine = startMockOpencode();
      const config = createConfig({
        port: await freePort(),
        workspaceRoot,
        engineBaseUrl: `http://127.0.0.1:${engine.server.port}`,
        vaultKey: randomBytes(32),
      });
      const server = await startServer(config);
      stops.push(() => server.stop());
      const openworkBaseUrl = `http://127.0.0.1:${server.port}`;
      const expectedMessage = "OpenWork could not connect to this MCP server. Check its OAuth settings and availability, then try again.";

      const registrationProvider = startHandshakeFailureProvider("oauth-client-registration");
      await createLocalManagedMcpConnection(config, {
        workspaceId: "ws_managed",
        name: "registration-failure",
        serverUrl: `${registrationProvider}/mcp`,
        oauth: { applicationType: "native", requestedScopes: ["mcp:read"] },
      });
      const reconnect = await fetch(
        `${openworkBaseUrl}/workspace/ws_managed/mcp/registration-failure/managed/connect`,
        { method: "POST", headers: clientHeaders(config.token) },
      );
      expect(reconnect.status).toBe(502);
      const reconnectBody = await reconnect.json();
      expect(reconnectBody).toEqual({
        code: "managed_mcp_connection_failed",
        message: expectedMessage,
      });
      expect(JSON.stringify(reconnectBody)).not.toContain("oauth-client-registration-nested-secret");
      const reconnectStatus = await fetch(
        `${openworkBaseUrl}/workspace/ws_managed/mcp/registration-failure/managed`,
        { headers: clientHeaders(config.token) },
      );
      expect(await reconnectStatus.json()).toMatchObject({
        status: "reconnect_required",
        lastError: expectedMessage,
        hasCredential: false,
      });

      const initializeProvider = startHandshakeFailureProvider("mcp-initialize");
      await createLocalManagedMcpConnection(config, {
        workspaceId: "ws_managed",
        name: "initialize-failure",
        serverUrl: `${initializeProvider}/mcp`,
        oauth: { applicationType: "native", requestedScopes: ["mcp:read"] },
      });
      const started = await fetch(
        `${openworkBaseUrl}/workspace/ws_managed/mcp/initialize-failure/managed/connect`,
        { method: "POST", headers: clientHeaders(config.token) },
      );
      expect(started.status).toBe(200);
      const startedBody: unknown = await started.json();
      if (typeof startedBody !== "object" || startedBody === null
        || !("authorizeUrl" in startedBody) || typeof startedBody.authorizeUrl !== "string") {
        throw new Error("Expected an OAuth authorization URL.");
      }
      expect(startedBody).toMatchObject({ status: "needs_auth" });
      const authorization = await fetch(startedBody.authorizeUrl, { redirect: "manual" });
      expect(authorization.status).toBe(302);
      const callback = await fetch(authorization.headers.get("location")!);
      expect(callback.status).toBe(502);
      const callbackBody = await callback.json();
      expect(callbackBody).toEqual({
        code: "managed_mcp_connection_failed",
        message: expectedMessage,
      });
      expect(JSON.stringify(callbackBody)).not.toContain("mcp-initialize-nested-secret");
      const callbackStatus = await fetch(
        `${openworkBaseUrl}/workspace/ws_managed/mcp/initialize-failure/managed`,
        { headers: clientHeaders(config.token) },
      );
      expect(await callbackStatus.json()).toMatchObject({
        status: "reconnect_required",
        lastError: expectedMessage,
        hasCredential: false,
      });

      const discoveryProvider = startHandshakeFailureProvider("mcp-discovery");
      await createLocalManagedMcpConnection(config, {
        workspaceId: "ws_managed",
        name: "discovery-failure",
        serverUrl: `${discoveryProvider}/mcp`,
        oauth: { applicationType: "native", requestedScopes: ["mcp:read"] },
      });
      const discoveryStarted = await fetch(
        `${openworkBaseUrl}/workspace/ws_managed/mcp/discovery-failure/managed/connect`,
        { method: "POST", headers: clientHeaders(config.token) },
      );
      expect(discoveryStarted.status).toBe(200);
      const discoveryStartedBody: unknown = await discoveryStarted.json();
      if (typeof discoveryStartedBody !== "object" || discoveryStartedBody === null
        || !("authorizeUrl" in discoveryStartedBody) || typeof discoveryStartedBody.authorizeUrl !== "string") {
        throw new Error("Expected an OAuth authorization URL.");
      }
      const discoveryAuthorization = await fetch(discoveryStartedBody.authorizeUrl, { redirect: "manual" });
      expect(discoveryAuthorization.status).toBe(302);
      const discoveryCallback = await fetch(discoveryAuthorization.headers.get("location")!);
      expect(discoveryCallback.status).toBe(502);
      const discoveryCallbackBody = await discoveryCallback.json();
      expect(discoveryCallbackBody).toEqual({
        code: "managed_mcp_connection_failed",
        message: expectedMessage,
      });
      expect(JSON.stringify(discoveryCallbackBody)).not.toContain("mcp-discovery-nested-secret");
      const discoveryStatus = await fetch(
        `${openworkBaseUrl}/workspace/ws_managed/mcp/discovery-failure/managed`,
        { headers: clientHeaders(config.token) },
      );
      expect(await discoveryStatus.json()).toMatchObject({
        status: "reconnect_required",
        lastError: expectedMessage,
        hasCredential: false,
      });
      expect(captured).toEqual([]);

      const internalProvider = startHandshakeFailureProvider("unexpected-sdk-failure");
      await createLocalManagedMcpConnection(config, {
        workspaceId: "ws_managed",
        name: "unexpected-sdk-failure",
        serverUrl: `${internalProvider}/mcp`,
        oauth: { applicationType: "native", requestedScopes: ["mcp:read"] },
      });
      const internalFailure = await fetch(
        `${openworkBaseUrl}/workspace/ws_managed/mcp/unexpected-sdk-failure/managed/connect`,
        { method: "POST", headers: clientHeaders(config.token) },
      );
      expect(internalFailure.status).toBe(500);
      expect(await internalFailure.json()).toEqual({
        code: "internal_error",
        message: "Unexpected server error",
      });
      expect(captured).toHaveLength(1);
      expect(captured[0]).toBeInstanceOf(EnterpriseMcpClientError);
      expect(captured[0]).not.toBeInstanceOf(ApiError);
      expect(captured[0]).toMatchObject({
        code: "MCP_CONNECTION_HANDSHAKE_FAILED",
        requestPhase: "mcp-discovery",
      });
    } finally {
      globalThis.__openworkDesktopTelemetry = previousTelemetry;
      if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
      if (previousDevMode === undefined) delete process.env.OPENWORK_DEV_MODE;
      else process.env.OPENWORK_DEV_MODE = previousDevMode;
    }
  }, 30_000);

  test("returns actionable input errors without persisting managed connections", async () => {
    const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
    const previousDevMode = process.env.OPENWORK_DEV_MODE;
    const previousAllowPrivateUrls = process.env.OPENWORK_ALLOW_PRIVATE_MCP_URLS;
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-local-managed-mcp-input-errors-"));
    roots.push(workspaceRoot);
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    delete process.env.OPENWORK_DEV_MODE;
    delete process.env.OPENWORK_ALLOW_PRIVATE_MCP_URLS;

    try {
      const engine = startMockOpencode();
      const config = createConfig({
        port: await freePort(),
        workspaceRoot,
        engineBaseUrl: `http://127.0.0.1:${engine.server.port}`,
        vaultKey: randomBytes(32),
      });
      const server = await startServer(config);
      stops.push(() => server.stop());
      const openworkBaseUrl = `http://127.0.0.1:${server.port}`;
      const cases = [
        { name: "malformed-url", url: "not-a-url", code: "managed_mcp_url_invalid", message: "not-a-url" },
        { name: "http-url", url: "http://example.com/mcp", code: "managed_mcp_url_not_allowed", message: "HTTPS" },
        {
          name: "unresolved-url",
          url: "https://managed-mcp-does-not-resolve.invalid/mcp",
          code: "managed_mcp_url_not_allowed",
          message: "resolve",
        },
      ];

      for (const input of cases) {
        const created = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/managed`, {
          method: "POST",
          headers: clientHeaders(config.token),
          body: JSON.stringify({ name: input.name, url: input.url, oauth: { applicationType: "native" } }),
        });
        expect(created.status).toBe(400);
        expect(await created.json()).toMatchObject({
          code: input.code,
          message: expect.stringContaining(input.message),
        });

        const list = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp`, {
          headers: clientHeaders(config.token),
        });
        expect(list.status).toBe(200);
        expect(JSON.stringify(await list.json())).not.toContain(`"name":"${input.name}"`);
        const status = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/${input.name}/managed`, {
          headers: clientHeaders(config.token),
        });
        expect(status.status).toBe(404);
      }
    } finally {
      if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
      if (previousDevMode === undefined) delete process.env.OPENWORK_DEV_MODE;
      else process.env.OPENWORK_DEV_MODE = previousDevMode;
      if (previousAllowPrivateUrls === undefined) delete process.env.OPENWORK_ALLOW_PRIVATE_MCP_URLS;
      else process.env.OPENWORK_ALLOW_PRIVATE_MCP_URLS = previousAllowPrivateUrls;
    }
  });

  test("owns OAuth, exposes provider tools to OpenCode, refreshes, survives restart, and disconnects", async () => {
    const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
    const previousDevMode = process.env.OPENWORK_DEV_MODE;
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-local-managed-mcp-"));
    roots.push(workspaceRoot);
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    process.env.OPENWORK_DEV_MODE = "1";

    try {
      const engine = startMockOpencode();
      const providerPort = await freePort();
      const providerBaseUrl = await startOAuthProvider(providerPort);
      const openworkPort = await freePort();
      const vaultKey = randomBytes(32);
      const config = createConfig({
        port: openworkPort,
        workspaceRoot,
        engineBaseUrl: `http://127.0.0.1:${engine.server.port}`,
        vaultKey,
      });
      const server = await startServer(config);
      stops.push(() => server.stop());
      const openworkBaseUrl = `http://127.0.0.1:${server.port}`;

      const created = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/managed`, {
        method: "POST",
        headers: clientHeaders(config.token),
        body: JSON.stringify({
          name: "mock-oauth",
          url: `${providerBaseUrl}/mcp`,
          oauth: { applicationType: "native", requestedScopes: ["mcp:read", "mcp:write"] },
        }),
      });
      expect(created.status).toBe(201);
      const started = await created.json() as { status: string; authorizeUrl?: string };
      expect(started.status).toBe("needs_auth");
      expect(started.authorizeUrl).toBeTruthy();

      const authorization = await fetch(started.authorizeUrl!, { redirect: "manual" });
      expect(authorization.status).toBe(302);
      const callbackUrl = authorization.headers.get("location");
      expect(callbackUrl).toStartWith(`${openworkBaseUrl}/mcp/oauth/callback`);
      const callback = await fetch(callbackUrl!);
      expect(callback.status).toBe(200);

      const status = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/mock-oauth/managed`, {
        headers: clientHeaders(config.token),
      });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ status: "connected", hasCredential: true, enabled: true });

      const firstRuntimeConfig = await readRuntimeMcpConfig(config, "ws_managed", "mock-oauth");
      expect(firstRuntimeConfig).toMatchObject({ type: "remote", enabled: true, oauth: false });
      expect(String(firstRuntimeConfig?.url)).toStartWith(`${openworkBaseUrl}/mcp/managed/ws_managed/mock-oauth`);
      expect(JSON.stringify(firstRuntimeConfig)).not.toContain(providerBaseUrl);
      expect(JSON.stringify(firstRuntimeConfig)).not.toContain("mock-access-");
      const unauthorizedGateway = await fetch(String(firstRuntimeConfig?.url), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(unauthorizedGateway.status).toBe(401);
      const engineRegistration = engine.requests.find((request) => request.pathname === "/mcp" && request.method === "POST");
      expect(engineRegistration?.body).toMatchObject({ name: "mock-oauth", config: firstRuntimeConfig });

      const firstClient = await connectGateway(firstRuntimeConfig!);
      expect((await firstClient.listTools()).tools.map((tool) => tool.name)).toContain("mock_echo");
      expect(await firstClient.callTool({ name: "mock_echo", arguments: { text: "through OpenWork" } }))
        .toMatchObject({ content: [{ type: "text", text: "through OpenWork" }] });
      await expect(firstClient.callTool({ name: "mock_provider_error", arguments: {} })).rejects.toThrow();
      const providerErrorStatus = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/mock-oauth/managed`, {
        headers: clientHeaders(config.token),
      });
      expect(await providerErrorStatus.json()).toMatchObject({ status: "connected", hasCredential: true });
      await firstClient.close();

      const expired = await fetch(`${providerBaseUrl}/admin/expire-access-tokens`, { method: "POST" });
      expect(expired.ok).toBe(true);
      const refreshClient = await connectGateway(firstRuntimeConfig!);
      expect((await refreshClient.listTools()).tools.map((tool) => tool.name)).toContain("mock_echo");
      await refreshClient.close();
      const providerRequests = await (await fetch(`${providerBaseUrl}/requests`)).json() as {
        requests: Array<{ path: string; grantType?: string }>;
      };
      expect(providerRequests.requests.some((request) => request.path === "/token" && request.grantType === "refresh_token")).toBe(true);

      await server.stop();
      stops.pop();
      const restartedConfig = createConfig({
        port: openworkPort,
        workspaceRoot,
        engineBaseUrl: `http://127.0.0.1:${engine.server.port}`,
        vaultKey,
      });
      const restartedServer = await startServer(restartedConfig);
      stops.push(() => restartedServer.stop());
      const restartedRuntimeConfig = await readRuntimeMcpConfig(restartedConfig, "ws_managed", "mock-oauth");
      expect(restartedRuntimeConfig).toMatchObject({ type: "remote", enabled: true, oauth: false });
      expect((restartedRuntimeConfig?.headers as Record<string, string>).Authorization)
        .not.toBe((firstRuntimeConfig?.headers as Record<string, string>).Authorization);
      const restartedClient = await connectGateway(restartedRuntimeConfig!);
      expect((await restartedClient.listTools()).tools.map((tool) => tool.name)).toContain("mock_echo");
      await restartedClient.close();

      const vaultText = await readFile(join(runtimeStorageDir(restartedConfig), "local-managed-mcp-vault.json"), "utf8");
      expect(vaultText).toContain('"algorithm":"aes-256-gcm"');
      expect(vaultText).not.toContain("mock-access-");
      expect(vaultText).not.toContain("refresh_token");
      expect(existsSync(join(runtimeStorageDir(restartedConfig), "local-managed-mcp-vault.key"))).toBe(false);

      const revoked = await fetch(`${providerBaseUrl}/admin/expire-oauth-tokens`, { method: "POST" });
      expect(revoked.ok).toBe(true);
      const revokedClient = await connectGateway(restartedRuntimeConfig!);
      await expect(revokedClient.listTools()).rejects.toThrow();
      await revokedClient.close();
      const revokedStatus = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/mock-oauth/managed`, {
        headers: clientHeaders(restartedConfig.token),
      });
      expect(await revokedStatus.json()).toMatchObject({ status: "reconnect_required", hasCredential: false });

      const disconnected = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/mock-oauth/auth`, {
        method: "DELETE",
        headers: clientHeaders(restartedConfig.token),
      });
      expect(disconnected.status).toBe(200);
      expect(await readRuntimeMcpConfig(restartedConfig, "ws_managed", "mock-oauth"))
        .toMatchObject({ enabled: false, oauth: false });

      const reconnect = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/mock-oauth/managed/connect`, {
        method: "POST",
        headers: clientHeaders(restartedConfig.token),
      });
      expect(reconnect.status).toBe(200);
      expect(await reconnect.json()).toMatchObject({ status: "needs_auth" });
      const reconnectStatus = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/mock-oauth/managed`, {
        headers: clientHeaders(restartedConfig.token),
      });
      expect(await reconnectStatus.json()).toMatchObject({ status: "needs_auth", enabled: true, hasCredential: false });
      expect(await readRuntimeMcpConfig(restartedConfig, "ws_managed", "mock-oauth"))
        .toMatchObject({ enabled: true, oauth: false });
      expect((await readdir(runtimeStorageDir(restartedConfig)))
        .some((entry) => entry.includes(".openwork-backup-"))).toBe(false);
    } finally {
      if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
      if (previousDevMode === undefined) delete process.env.OPENWORK_DEV_MODE;
      else process.env.OPENWORK_DEV_MODE = previousDevMode;
    }
  }, 60_000);

  test("quarantines and rebuilds the vault after a secure-storage key change, then reconnects", async () => {
    const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
    const previousDevMode = process.env.OPENWORK_DEV_MODE;
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-local-managed-mcp-rotation-"));
    roots.push(workspaceRoot);
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    process.env.OPENWORK_DEV_MODE = "1";

    try {
      const engine = startMockOpencode();
      const providerBaseUrl = await startOAuthProvider(await freePort());
      const openworkPort = await freePort();
      const config = createConfig({
        port: openworkPort,
        workspaceRoot,
        engineBaseUrl: `http://127.0.0.1:${engine.server.port}`,
        vaultKey: randomBytes(32),
      });
      const server = await startServer(config);
      stops.push(() => server.stop());
      const openworkBaseUrl = `http://127.0.0.1:${server.port}`;

      for (const name of ["mock-oauth", "mock-oauth-b"]) {
        const created = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/managed`, {
          method: "POST",
          headers: clientHeaders(config.token),
          body: JSON.stringify({
            name,
            url: `${providerBaseUrl}/mcp`,
            oauth: { applicationType: "native", requestedScopes: ["mcp:read"] },
          }),
        });
        expect(created.status).toBe(201);
        const started = await created.json() as { status: string; authorizeUrl?: string };
        expect(started.status).toBe("needs_auth");
        const authorization = await fetch(started.authorizeUrl!, { redirect: "manual" });
        expect(authorization.status).toBe(302);
        expect((await fetch(authorization.headers.get("location")!)).status).toBe(200);
      }

      await server.stop();
      stops.pop();

      const rotatedConfig = createConfig({
        port: openworkPort,
        workspaceRoot,
        engineBaseUrl: `http://127.0.0.1:${engine.server.port}`,
        vaultKey: randomBytes(32),
      });
      const storageDir = runtimeStorageDir(rotatedConfig);
      const reconnectCopy = "Secure storage on this device changed, so saved sign-ins were cleared. Reconnect to restore this connection.";
      const scanVaultForSecrets = async () => {
        const text = await readFile(join(storageDir, "local-managed-mcp-vault.json"), "utf8");
        expect(text).toContain('"schemaVersion":2');
        expect(text).not.toContain("mock-access-");
        expect(text).not.toContain("refresh_token");
        expect(text).not.toContain("client_secret");
        expect(text).not.toContain("clientSecret");
        expect(text).not.toContain("codeVerifier");
      };

      const safeList = await listLocalManagedMcpConnectionsSafe(rotatedConfig, "ws_managed");
      expect(safeList.available).toBe(true);
      expect(safeList.connections.map((connection) => connection.name)).toEqual(["mock-oauth", "mock-oauth-b"]);
      for (const connection of safeList.connections) {
        expect(connection).toMatchObject({
          status: "reconnect_required",
          hasCredential: false,
          lastError: reconnectCopy,
        });
      }
      expect(safeList.recovery).toMatchObject({ reason: "secure_storage_changed" });

      const backups = (await readdir(storageDir))
        .filter((entry) => entry.startsWith("local-managed-mcp-vault.json.openwork-backup-"));
      expect(backups).toHaveLength(1);
      expect(safeList.recovery?.quarantinedTo).toBe(backups[0]!);
      const backupValue = JSON.parse(await readFile(join(storageDir, backups[0]!), "utf8")) as {
        schemaVersion?: number;
        vault?: { algorithm?: string };
      };
      expect(backupValue.schemaVersion).toBe(2);
      expect(backupValue.vault?.algorithm).toBe("aes-256-gcm");
      await scanVaultForSecrets();

      const rotatedServer = await startServer(rotatedConfig);
      stops.push(() => rotatedServer.stop());

      // Engine boot-time tool discovery must not overwrite the recovery copy:
      // the gateway rejects, and the stored reconnect reason stays intact.
      const preReconnectRuntimeConfig = await readRuntimeMcpConfig(rotatedConfig, "ws_managed", "mock-oauth");
      const recoveredGatewayClient = await connectGateway(preReconnectRuntimeConfig!);
      await expect(recoveredGatewayClient.listTools()).rejects.toThrow();
      await recoveredGatewayClient.close();
      const afterDiscoveryFailure = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/mock-oauth/managed`, {
        headers: clientHeaders(rotatedConfig.token),
      });
      expect(await afterDiscoveryFailure.json()).toMatchObject({
        status: "reconnect_required",
        hasCredential: false,
        lastError: reconnectCopy,
      });
      const safeListAfterDiscoveryFailure = await listLocalManagedMcpConnectionsSafe(rotatedConfig, "ws_managed");
      expect(safeListAfterDiscoveryFailure.connections
        .find((connection) => connection.name === "mock-oauth")?.lastError).toBe(reconnectCopy);

      const reconnect = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/mock-oauth/managed/connect`, {
        method: "POST",
        headers: clientHeaders(rotatedConfig.token),
      });
      expect(reconnect.status).toBe(200);
      const restarted = await reconnect.json() as { status: string; authorizeUrl?: string };
      expect(restarted.status).toBe("needs_auth");
      expect(restarted.authorizeUrl).toBeTruthy();
      const reauthorization = await fetch(restarted.authorizeUrl!, { redirect: "manual" });
      expect(reauthorization.status).toBe(302);
      const callbackUrl = reauthorization.headers.get("location");
      expect(callbackUrl).toStartWith(`${openworkBaseUrl}/mcp/oauth/callback`);
      expect((await fetch(callbackUrl!)).status).toBe(200);

      const reconnected = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/mock-oauth/managed`, {
        headers: clientHeaders(rotatedConfig.token),
      });
      expect(await reconnected.json()).toMatchObject({ status: "connected", hasCredential: true, enabled: true });
      const second = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp/mock-oauth-b/managed`, {
        headers: clientHeaders(rotatedConfig.token),
      });
      expect(await second.json()).toMatchObject({
        status: "reconnect_required",
        hasCredential: false,
        lastError: reconnectCopy,
      });

      const runtimeConfig = await readRuntimeMcpConfig(rotatedConfig, "ws_managed", "mock-oauth");
      const gatewayClient = await connectGateway(runtimeConfig!);
      expect((await gatewayClient.listTools()).tools.map((tool) => tool.name)).toContain("mock_echo");
      await gatewayClient.close();

      const workspaceMcp = await fetch(`${openworkBaseUrl}/workspace/ws_managed/mcp`, {
        headers: clientHeaders(rotatedConfig.token),
      });
      expect(workspaceMcp.status).toBe(200);
      expect(await workspaceMcp.json()).toMatchObject({
        managedOAuthState: {
          available: true,
          recovery: { reason: "secure_storage_changed", quarantinedTo: backups[0]! },
        },
      });

      await scanVaultForSecrets();
      expect((await readdir(storageDir))
        .filter((entry) => entry.startsWith("local-managed-mcp-vault.json.openwork-backup-"))).toHaveLength(1);
    } finally {
      if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
      if (previousDevMode === undefined) delete process.env.OPENWORK_DEV_MODE;
      else process.env.OPENWORK_DEV_MODE = previousDevMode;
    }
  }, 60_000);

  test("serves the plaintext index read-only while secure storage is unavailable", async () => {
    const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
    const previousDevMode = process.env.OPENWORK_DEV_MODE;
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-local-managed-mcp-unavailable-"));
    roots.push(workspaceRoot);
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    process.env.OPENWORK_DEV_MODE = "1";

    try {
      const config = createConfig({
        port: await freePort(),
        workspaceRoot,
        engineBaseUrl: "http://127.0.0.1:1",
        vaultKey: randomBytes(32),
      });
      const created = await createLocalManagedMcpConnection(config, {
        workspaceId: "ws_managed",
        name: "offline-vault",
        serverUrl: `http://127.0.0.1:${await freePort()}/mcp`,
        oauth: {},
      });
      expect(created.status).toBe("needs_auth");

      const unavailableConfig = createConfig({
        port: config.port,
        workspaceRoot,
        engineBaseUrl: "http://127.0.0.1:1",
        vaultKey: randomBytes(32),
      });
      unavailableConfig.localManagedMcpVaultKey = async () => {
        throw new Error("secure storage locked");
      };

      const safeList = await listLocalManagedMcpConnectionsSafe(unavailableConfig, "ws_managed");
      expect(safeList.available).toBe(false);
      expect(safeList.recovery).toBeNull();
      expect(safeList.connections).toHaveLength(1);
      expect(safeList.connections[0]).toMatchObject({
        name: "offline-vault",
        status: "needs_auth",
        hasCredential: false,
        enabled: true,
      });

      expect((await readdir(runtimeStorageDir(unavailableConfig)))
        .some((entry) => entry.includes(".openwork-backup-"))).toBe(false);

      const failure = await setLocalManagedMcpEnabled(unavailableConfig, "ws_managed", "offline-vault", false)
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({ status: 503, code: "managed_mcp_secure_storage_unavailable" });
    } finally {
      if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
      if (previousDevMode === undefined) delete process.env.OPENWORK_DEV_MODE;
      else process.env.OPENWORK_DEV_MODE = previousDevMode;
    }
  });

  test("quarantines a legacy v1 vault it cannot decrypt and prunes orphaned gateway runtime entries", async () => {
    const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
    const previousDevMode = process.env.OPENWORK_DEV_MODE;
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-local-managed-mcp-v1-"));
    roots.push(workspaceRoot);
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    process.env.OPENWORK_DEV_MODE = "1";

    try {
      const config = createConfig({
        port: await freePort(),
        workspaceRoot,
        engineBaseUrl: "http://127.0.0.1:1",
        vaultKey: randomBytes(32),
      });
      const storageDir = runtimeStorageDir(config);
      await mkdir(storageDir, { recursive: true });

      const oldKey = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", oldKey, iv);
      cipher.setAAD(Buffer.from("openwork-local-managed-mcp-v1", "utf8"));
      const payload = JSON.stringify({
        schemaVersion: 1,
        connections: {
          [`${"ws_managed".length}:ws_managedlegacy-managed`]: { name: "legacy-managed" },
        },
      });
      const data = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
      await writeFile(join(storageDir, "local-managed-mcp-vault.json"), `${JSON.stringify({
        schemaVersion: 1,
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      })}\n`, "utf8");

      await writeRuntimeOpencodeConfig(config, "ws_managed", (current) => ({
        ...current,
        mcp: {
          ...runtimeMcpMap(current),
          "legacy-managed": {
            type: "remote",
            url: `http://127.0.0.1:${config.port}/mcp/managed/ws_managed/legacy-managed`,
            enabled: true,
            headers: { Authorization: "Bearer stale-gateway-token" },
            oauth: false,
          },
          "keep-remote": { type: "remote", url: "https://example.com/mcp", enabled: true },
        },
      }));

      const safeList = await listLocalManagedMcpConnectionsSafe(config, "ws_managed");
      expect(safeList.available).toBe(true);
      expect(safeList.connections).toEqual([]);
      expect(safeList.recovery).toMatchObject({ reason: "secure_storage_changed" });

      const backups = (await readdir(storageDir))
        .filter((entry) => entry.startsWith("local-managed-mcp-vault.json.openwork-backup-"));
      expect(backups).toHaveLength(1);
      expect(safeList.recovery?.quarantinedTo).toBe(backups[0]!);
      expect(JSON.parse(await readFile(join(storageDir, backups[0]!), "utf8"))).toMatchObject({
        schemaVersion: 1,
        algorithm: "aes-256-gcm",
      });

      const rebuilt = JSON.parse(await readFile(join(storageDir, "local-managed-mcp-vault.json"), "utf8")) as {
        schemaVersion?: number;
        index?: Record<string, unknown>;
        lastRecovery?: { quarantinedTo?: string };
      };
      expect(rebuilt.schemaVersion).toBe(2);
      expect(rebuilt.index).toEqual({});
      expect(rebuilt.lastRecovery?.quarantinedTo).toBe(backups[0]!);

      expect(await readRuntimeMcpConfig(config, "ws_managed", "legacy-managed")).toBeNull();
      expect(await readRuntimeMcpConfig(config, "ws_managed", "keep-remote")).toMatchObject({ type: "remote" });
    } finally {
      if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
      if (previousDevMode === undefined) delete process.env.OPENWORK_DEV_MODE;
      else process.env.OPENWORK_DEV_MODE = previousDevMode;
    }
  });
});
