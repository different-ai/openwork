import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONNECT_MCP_APP_HOST_CAPABILITY,
  CONNECT_MCP_APP_HOST_CAPABILITY_HEADER,
  CONNECT_MCP_SERVER_INDEX_URI,
  connectDirectMcpRuntimeName,
  connectMcpAppHostName,
  type OpenWorkConnectMcpServerIndex,
  readOpenWorkConnectMcpAppHostCatalog,
  readOpenWorkConnectMcpServerIndex,
  reconcileOpenWorkConnectMcpServers,
  refreshOpenWorkConnectMcpAppHostCatalog,
  writeOpenWorkConnectMcpAppHostAuthorization,
  writeOpenWorkConnectMcpAppHostCatalog,
} from "./connect-mcp-server-catalog.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;

afterEach(async () => {
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
});

async function fixtureConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "openwork-connect-mcp-servers-"));
  roots.push(root);
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test",
    hostToken: "host",
    configPath: join(root, "openwork.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "One", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

function indexFetcher(
  requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>,
  servers: Array<Partial<OpenWorkConnectMcpServerIndex["servers"][number]>> = [{
    connectionId: "emc_01k28e8q8pf8r9sff9mhyqxved",
    name: "Project Atlas",
    description: null,
    url: "https://api.openworklabs.com/mcp/agent/connections/emc_01k28e8q8pf8r9sff9mhyqxved",
  }],
) {
  return async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, headers: new Headers(init?.headers), body });
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { resources: {} } } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: 2,
      result: {
        contents: [{
          uri: CONNECT_MCP_SERVER_INDEX_URI,
          mimeType: "application/json",
          text: JSON.stringify({
            schemaVersion: "openwork.connect/mcp-servers/1",
            servers,
          }),
        }],
      },
    });
  };
}

describe("OpenWork Connect MCP server catalog", () => {
  test("reads the member catalog through an authenticated MCP resource", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const index = await readOpenWorkConnectMcpServerIndex({
      type: "remote",
      url: "https://api.openworklabs.com/mcp/agent",
      headers: { Authorization: "Bearer member-token" },
    }, "Bearer private-app-host-token", indexFetcher(requests));

    expect(index?.servers[0]?.name).toBe("Project Atlas");
    expect(requests.map((request) => request.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "resources/read",
    ]);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer private-app-host-token")).toBe(true);
    expect(requests.every((request) => request.headers.get(CONNECT_MCP_APP_HOST_CAPABILITY_HEADER)
      === CONNECT_MCP_APP_HOST_CAPABILITY)).toBe(true);
  });

  test("keeps hosted api-origin provider proxies on the credential-bound app gateway origin", async () => {
    const index = await readOpenWorkConnectMcpServerIndex({
      type: "remote",
      url: "https://app.openworklabs.com/api/den/mcp/agent",
    }, "Bearer private-app-host-token", indexFetcher([]));

    expect(index?.servers[0]?.url).toBe(
      "https://app.openworklabs.com/api/den/mcp/agent/connections/emc_01k28e8q8pf8r9sff9mhyqxved",
    );
  });

  test("reconciles only OpenWork-owned proxy entries and preserves user MCPs", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "openwork-cloud": { type: "remote", url: "https://api.openworklabs.com/mcp/agent" },
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "openwork-connect-stale": { type: "remote", url: "https://cloud.example/stale" },
      },
    }));
    const connectionId = "emc_01k28e8q8pf8r9sff9mhyqxved";
    const result = await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: {
        type: "remote",
        url: "https://api.openworklabs.com/mcp/agent",
        headers: { Authorization: "Bearer member-token" },
      },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([]),
    });

    const runtime = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(result).toEqual({
      status: "synced",
      appHostNames: [connectMcpAppHostName(connectionId)],
      directNames: [],
      removedNames: ["openwork-connect-stale"],
    });
    expect(runtime.mcp?.["openwork-cloud"]).toEqual({ type: "remote", url: "https://api.openworklabs.com/mcp/agent" });
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
    expect(runtime.mcp?.["openwork-connect-stale"]).toBeUndefined();
    expect(Object.keys(runtime.mcp ?? {}).some((name) => name.startsWith("openwork-connect-"))).toBe(false);
    expect(Object.keys(runtime.mcp ?? {}).some((name) => name.startsWith("openwork-direct-"))).toBe(false);
    expect(await readOpenWorkConnectMcpAppHostCatalog(config, "ws_1")).toEqual({
      schemaVersion: "openwork.connect/mcp-servers/1",
      servers: [{
        connectionId,
        name: "Project Atlas",
        description: null,
        url: `https://api.openworklabs.com/mcp/agent/connections/${connectionId}`,
        exposeDirectly: false,
      }],
    });
  });

  test("projects directly exposed connections into the model runtime with the member credential", async () => {
    const config = await fixtureConfig();
    const directId = "emc_01direct";
    const boundedId = "emc_01bounded";
    const direct = { connectionId: directId, name: "Linear (Engineering)" };
    const directName = connectDirectMcpRuntimeName(direct);
    expect(directName).toMatch(/^openwork-direct-linear-engineering-[0-9a-f]{6}$/);
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "openwork-direct-revoked-abc123": { type: "remote", url: "https://api.openworklabs.com/mcp/agent/connections/emc_01revoked" },
      },
    }));
    const cloudMcp = {
      type: "remote",
      url: "https://api.openworklabs.com/mcp/agent",
      enabled: true,
      headers: { Authorization: "Bearer member-token" },
    };
    const result = await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp,
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [
        { ...direct, description: null, url: `https://api.openworklabs.com/mcp/agent/connections/${directId}`, exposeDirectly: true },
        { connectionId: boundedId, name: "Bounded", description: null, url: `https://api.openworklabs.com/mcp/agent/connections/${boundedId}` },
      ]),
    });

    expect(result).toEqual({
      status: "synced",
      appHostNames: [connectMcpAppHostName(boundedId), connectMcpAppHostName(directId)].sort(),
      directNames: [directName],
      removedNames: ["openwork-direct-revoked-abc123"],
    });
    const runtime = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(runtime.mcp?.[directName]).toEqual({
      type: "remote",
      url: `https://api.openworklabs.com/mcp/agent/connections/${directId}`,
      enabled: true,
      headers: { Authorization: "Bearer member-token" },
      oauth: false,
    });
    expect(runtime.mcp?.["openwork-direct-revoked-abc123"]).toBeUndefined();
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
    expect(Object.keys(runtime.mcp ?? {}).filter((name) => name.startsWith("openwork-direct-"))).toEqual([directName]);
    expect(JSON.stringify(runtime.mcp)).not.toContain("private-app-host-token");

    // Turning the flag off removes the entry on the next reconcile.
    const revoked = await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp,
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [
        { ...direct, description: null, url: `https://api.openworklabs.com/mcp/agent/connections/${directId}`, exposeDirectly: false },
      ]),
    });
    expect(revoked.directNames).toEqual([]);
    expect(revoked.removedNames).toEqual([directName]);
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.[directName]).toBeUndefined();
  });

  test("a flagged connection is not projected when the Cloud entry carries no member credential", async () => {
    const config = await fixtureConfig();
    const directId = "emc_01direct";
    const result = await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://api.openworklabs.com/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [
        { connectionId: directId, name: "Linear", description: null, url: `https://api.openworklabs.com/mcp/agent/connections/${directId}`, exposeDirectly: true },
      ]),
    });
    expect(result.status).toBe("synced");
    expect(result.directNames).toEqual([]);
    expect(Object.keys((await readRuntimeOpencodeConfig(config, "ws_1")).mcp ?? {})).toEqual([]);
  });

  test("an unavailable index purges directly exposed entries instead of trusting a stale catalog", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: { "openwork-direct-linear-abc123": { type: "remote", url: "https://api.openworklabs.com/mcp/agent/connections/emc_01x" } },
    }));
    const result = await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://api.openworklabs.com/mcp/agent" },
      fetcher: async () => new Response(null, { status: 404 }),
    });
    expect(result).toEqual({
      status: "unavailable",
      appHostNames: [],
      directNames: [],
      removedNames: ["openwork-direct-linear-abc123"],
    });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["openwork-direct-linear-abc123"]).toBeUndefined();
  });

  test("opportunistically refreshes a stale private catalog from the runtime Cloud endpoint", async () => {
    const config = await fixtureConfig();
    const connectionId = "emc_01k28e8q8pf8r9sff9mhyqxved";
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "openwork-cloud": { type: "remote", url: "https://api.openworklabs.com/mcp/agent" },
      },
    }));
    await writeOpenWorkConnectMcpAppHostAuthorization(
      config,
      "ws_1",
      "Bearer private-app-host-token",
      "https://api.openworklabs.com/mcp/agent",
    );

    const result = await refreshOpenWorkConnectMcpAppHostCatalog(config, "ws_1", indexFetcher(requests));

    expect(result).toEqual({ status: "synced", appHostNames: [connectMcpAppHostName(connectionId)] });
    expect((await readOpenWorkConnectMcpAppHostCatalog(config, "ws_1")).servers[0]?.connectionId).toBe(connectionId);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer private-app-host-token")).toBe(true);
  });

  test("preserves the last known-good catalog when an opportunistic refresh is unavailable", async () => {
    const config = await fixtureConfig();
    const connectionId = "emc_01lastknowngood";
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "openwork-cloud": { type: "remote", url: "https://api.openworklabs.com/mcp/agent" },
      },
    }));
    await writeOpenWorkConnectMcpAppHostAuthorization(
      config,
      "ws_1",
      "Bearer private-app-host-token",
      "https://api.openworklabs.com/mcp/agent",
    );
    await writeOpenWorkConnectMcpAppHostCatalog(config, "ws_1", {
      schemaVersion: "openwork.connect/mcp-servers/1",
      servers: [{
        connectionId,
        name: "Last known good",
        description: null,
        url: `https://api.openworklabs.com/mcp/agent/connections/${connectionId}`,
        exposeDirectly: false,
      }],
    });

    const result = await refreshOpenWorkConnectMcpAppHostCatalog(
      config,
      "ws_1",
      async () => new Response(null, { status: 503 }),
    );

    expect(result).toEqual({ status: "unavailable", appHostNames: [] });
    expect((await readOpenWorkConnectMcpAppHostCatalog(config, "ws_1")).servers[0]?.connectionId).toBe(connectionId);
  });

  test("fails closed and purges prior runtime entries when Cloud has no index", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: { "openwork-connect-existing": { type: "remote", url: "https://cloud.example/existing" } },
    }));
    const result = await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://api.openworklabs.com/mcp/agent" },
      fetcher: async () => new Response(null, { status: 404 }),
    });
    expect(result).toEqual({
      status: "unavailable",
      appHostNames: [],
      directNames: [],
      removedNames: ["openwork-connect-existing"],
    });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["openwork-connect-existing"]).toBeUndefined();
    expect((await readOpenWorkConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });

  test("an empty index removes prior OpenWork-owned provider servers", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "openwork-connect-existing": { type: "remote", url: "https://cloud.example/existing" },
      },
    }));
    const result = await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://api.openworklabs.com/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], []),
    });

    expect(result).toEqual({
      status: "synced",
      appHostNames: [],
      directNames: [],
      removedNames: ["openwork-connect-existing"],
    });
    const runtime = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(runtime.mcp?.["openwork-connect-existing"]).toBeUndefined();
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
  });

  test("never sends the persisted App-host credential to an untrusted reconcile endpoint", async () => {
    const config = await fixtureConfig();
    const trustedRequests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://api.openworklabs.com/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher(trustedRequests),
    });
    expect(trustedRequests.length).toBeGreaterThan(0);

    let untrustedRequests = 0;
    const result = await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://attacker.example/mcp/agent" },
      fetcher: async () => {
        untrustedRequests += 1;
        return new Response(null, { status: 500 });
      },
    });

    expect(untrustedRequests).toBe(0);
    expect(result.status).toBe("unavailable");
    expect((await readOpenWorkConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });

  test("rejects a catalog that points the private App-host credential at another origin", async () => {
    const config = await fixtureConfig();
    const result = await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://api.openworklabs.com/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [{
        connectionId: "emc_01crossorigin",
        name: "Untrusted endpoint",
        description: null,
        url: "https://attacker.example/mcp/agent/connections/emc_01crossorigin",
      }]),
    });

    expect(result).toEqual({ status: "unavailable", appHostNames: [], directNames: [], removedNames: [] });
    expect((await readOpenWorkConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });

  test("rejects a hosted api-origin descriptor that is not the exact connection proxy", async () => {
    const config = await fixtureConfig();
    const result = await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://app.openworklabs.com/api/den/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [{
        connectionId: "emc_01crossorigin",
        name: "Wrong proxy path",
        description: null,
        url: "https://api.openworklabs.com/mcp/agent/connections/another-connection",
      }]),
    });

    expect(result).toEqual({ status: "unavailable", appHostNames: [], directNames: [], removedNames: [] });
    expect((await readOpenWorkConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });
});
