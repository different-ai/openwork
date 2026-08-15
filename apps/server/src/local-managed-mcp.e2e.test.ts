import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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
