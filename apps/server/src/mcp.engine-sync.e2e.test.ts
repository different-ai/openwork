import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectEngineMcpRegistration,
  registerTrustedOpencodeProcess,
  startServer,
  syncAllWorkspacesRuntimeMcpToEngine,
} from "./server.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

type EngineRequest = {
  method: string;
  pathname: string;
  search: string;
  body: unknown;
};

// Keep the engine sync retry backoff tiny so failure-path tests stay fast.
process.env.OPENWORK_MCP_SYNC_RETRY_DELAY_MS = "10";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
let nextTestProcessGeneration = 0;

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-mcp-engine-sync-"));
  roots.push(root);
  return root;
}

function startMockOpencode(options?: {
  failMcpNames?: string[];
  mcpStatusByName?: Record<string, unknown>;
  mcpResponseForName?: (name: string) => Response | null;
  disposeResponse?: () => Response | null;
}) {
  const requests: EngineRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });

      if (url.pathname === "/instance/dispose") {
        return options?.disposeResponse?.() ?? Response.json({ disposed: true });
      }
      if (url.pathname === "/mcp" && request.method === "POST") {
        const name = (body as { name?: string } | null)?.name;
        if (name && options?.failMcpNames?.includes(name)) {
          return Response.json({ code: "mcp_invalid", message: "Invalid MCP config" }, { status: 500 });
        }
        if (!name) return Response.json({});
        const customResponse = options?.mcpResponseForName?.(name);
        if (customResponse) return customResponse;
        const status = Object.hasOwn(options?.mcpStatusByName ?? {}, name)
          ? options?.mcpStatusByName?.[name]
          : "connected";
        return Response.json({ [name]: { status } });
      }
      if (url.pathname.match(/^\/mcp\/[^/]+\/disconnect$/) && request.method === "POST") return Response.json({});
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, requests };
}

async function startOpenworkServer(
  workspaceRoot: string,
  opencodeBaseUrl: string,
  options?: { trustedProcessIdentity?: string | null; isAlive?: () => boolean },
) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: workspaceRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: opencodeBaseUrl,
      },
    ],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const trustedProcessIdentity = options?.trustedProcessIdentity === undefined
    ? `test-managed-opencode-${++nextTestProcessGeneration}`
    : options.trustedProcessIdentity;
  if (trustedProcessIdentity) {
    registerTrustedOpencodeProcess(config, {
      baseUrl: opencodeBaseUrl,
      identity: trustedProcessIdentity,
      isAlive: options?.isAlive ?? (() => true),
    });
  }
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, token: config.token, config, server };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`${label} was not an object`);
}

const POSTHOG_CONFIG = {
  type: "remote",
  url: "https://mcp.posthog.com/mcp",
  enabled: true,
  oauth: {},
};

describe("runtime MCP engine sync", () => {
  test("hot-adds a runtime MCP into the running engine when added", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);

      const response = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(response.status).toBe(200);

      const addRequest = mock.requests.find((entry) => entry.method === "POST" && entry.pathname === "/mcp");
      expect(addRequest).toBeDefined();
      expect(addRequest?.body).toEqual({ name: "posthog", config: POSTHOG_CONFIG });
      expect(addRequest?.search).toContain(`directory=${encodeURIComponent(workspaceRoot)}`);
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("hot-syncs an external engine without treating its response as trusted registration evidence", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const openwork = await startOpenworkServer(
        workspaceRoot,
        `http://127.0.0.1:${mock.server.port}`,
        { trustedProcessIdentity: null },
      );

      const response = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(response.status).toBe(200);
      expect(mock.requests.some((entry) => entry.method === "POST" && entry.pathname === "/mcp")).toBe(true);
      expect(inspectEngineMcpRegistration(
        openwork.config,
        openwork.config.workspaces[0]!,
        "posthog",
        POSTHOG_CONFIG,
      )).toBe("not-recorded");
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("keeps accepted delivery separate from bounded normalized registration evidence", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const rawErrorCanary = "MCP_PROVIDER_RAW_ERROR_CANARY";
    const oversizedCanary = "MCP_OVERSIZED_RESPONSE_CANARY";
    try {
      const mock = startMockOpencode({
        mcpStatusByName: {
          connected: "connected",
          disabled: "disabled",
          failed: "failed",
          "client-registration": "needs_client_registration",
        },
        mcpResponseForName: (name) => {
          if (name === "auth") {
            return Response.json({
              auth: { status: "needs_auth", error: rawErrorCanary },
            });
          }
          if (name === "invalid") {
            return Response.json({ invalid: { error: rawErrorCanary } });
          }
          if (name === "oversized") {
            return new Response(JSON.stringify({
              oversized: { status: "connected", error: oversizedCanary.repeat(4_096) },
            }), { headers: { "Content-Type": "application/json" } });
          }
          return null;
        },
      });
      const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);
      const inspectRegistration = (name: string, config: Record<string, unknown>) =>
        inspectEngineMcpRegistration(openwork.config, openwork.config.workspaces[0]!, name, config);
      const configs = new Map<string, Record<string, unknown>>([
        ["connected", POSTHOG_CONFIG],
        ["disabled", { ...POSTHOG_CONFIG, enabled: false }],
        ["failed", POSTHOG_CONFIG],
        ["auth", POSTHOG_CONFIG],
        ["client-registration", POSTHOG_CONFIG],
        ["invalid", POSTHOG_CONFIG],
        ["oversized", POSTHOG_CONFIG],
      ]);

      for (const [name, config] of configs) {
        const response = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
          method: "POST",
          headers: auth(openwork.token),
          body: JSON.stringify({ name, config }),
        });
        expect(response.status).toBe(200);
      }

      expect(inspectRegistration("connected", configs.get("connected")!)).toBe("connected");
      expect(inspectRegistration("disabled", configs.get("disabled")!)).toBe("disabled");
      expect(inspectRegistration("failed", configs.get("failed")!)).toBe("failed");
      expect(inspectRegistration("auth", configs.get("auth")!)).toBe("needs-auth");
      expect(inspectRegistration(
        "client-registration",
        configs.get("client-registration")!,
      )).toBe("needs-client-registration");
      expect(inspectRegistration("invalid", configs.get("invalid")!)).toBe("not-recorded");
      expect(inspectRegistration("oversized", configs.get("oversized")!)).toBe("not-recorded");

      const listResponse = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        headers: auth(openwork.token),
      });
      const listText = await listResponse.text();
      expect(listResponse.status).toBe(200);
      expect(listText).not.toContain(rawErrorCanary);
      expect(listText).not.toContain(oversizedCanary);
      const listBody = JSON.parse(listText) as {
        engineSync?: {
          status: string;
          failures: Array<{ name: string; registrationStatus?: string; message?: string }>;
        } | null;
      };
      // Every POST returned 2xx, which is accepted delivery. Parsed statuses
      // remain point-in-time diagnostics evidence and never become delivery
      // failures; Cloud readiness verifies the actual state with GET /mcp.
      expect(listBody.engineSync).toMatchObject({ status: "ok", failures: [] });
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("scopes registration evidence to the concrete OpenWork server instance", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const engineA = startMockOpencode();
      const engineB = startMockOpencode();
      const serverA = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${engineA.server.port}`);
      const serverB = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${engineB.server.port}`);

      const response = await fetch(`${serverA.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(serverA.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(response.status).toBe(200);

      expect(inspectEngineMcpRegistration(
        serverA.config,
        serverA.config.workspaces[0]!,
        "posthog",
        POSTHOG_CONFIG,
      )).toBe("connected");
      expect(inspectEngineMcpRegistration(
        serverB.config,
        serverB.config.workspaces[0]!,
        "posthog",
        POSTHOG_CONFIG,
      )).toBe("not-recorded");
      expect(engineB.requests.some((entry) => entry.method === "POST" && entry.pathname === "/mcp")).toBe(false);
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("invalidates registration evidence when the engine endpoint changes", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const engineA = startMockOpencode();
      const engineB = startMockOpencode();
      const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${engineA.server.port}`);
      const workspace = openwork.config.workspaces[0]!;

      const response = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(response.status).toBe(200);
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG)).toBe("connected");

      workspace.baseUrl = `http://127.0.0.1:${engineB.server.port}`;
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG))
        .toBe("not-recorded");

      // Switching back must not revive the record that belonged to the old
      // endpoint. A new successful registration is required.
      workspace.baseUrl = `http://127.0.0.1:${engineA.server.port}`;
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG))
        .toBe("not-recorded");
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("invalidates registration evidence when a managed engine restarts at the same endpoint", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const engine = startMockOpencode();
      const baseUrl = `http://127.0.0.1:${engine.server.port}`;
      const openwork = await startOpenworkServer(workspaceRoot, baseUrl, {
        trustedProcessIdentity: "managed-process-a",
      });
      const workspace = openwork.config.workspaces[0]!;

      const response = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(response.status).toBe(200);
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG)).toBe("connected");

      registerTrustedOpencodeProcess(openwork.config, {
        baseUrl,
        identity: "managed-process-b",
        isAlive: () => true,
      });
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG))
        .toBe("not-recorded");

      await syncAllWorkspacesRuntimeMcpToEngine(openwork.config);
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG)).toBe("connected");

      // Reusing an older opaque value starts another monotonic generation and
      // cannot revive evidence recorded for either prior process.
      registerTrustedOpencodeProcess(openwork.config, {
        baseUrl,
        identity: "managed-process-a",
        isAlive: () => true,
      });
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG))
        .toBe("not-recorded");
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("revokes registration evidence when the managed engine is no longer alive", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    let isAlive = true;
    try {
      const engine = startMockOpencode();
      const openwork = await startOpenworkServer(
        workspaceRoot,
        `http://127.0.0.1:${engine.server.port}`,
        { trustedProcessIdentity: "managed-live-process", isAlive: () => isAlive },
      );
      const workspace = openwork.config.workspaces[0]!;

      const response = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(response.status).toBe(200);
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG)).toBe("connected");

      isAlive = false;
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG))
        .toBe("not-recorded");
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("invalidates registration evidence on stop and requires a new server generation", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const engine = startMockOpencode();
      const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${engine.server.port}`);
      const workspace = openwork.config.workspaces[0]!;

      const response = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(response.status).toBe(200);
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG)).toBe("connected");

      await openwork.server.stop(true);
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG))
        .toBe("not-recorded");

      const restarted = await startServer(openwork.config) as Served;
      stops.push(() => restarted.stop(true));
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG))
        .toBe("not-recorded");

      await syncAllWorkspacesRuntimeMcpToEngine(openwork.config);
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG)).toBe("connected");
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("expires registration evidence after the bounded freshness window", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    const previousMaxAge = process.env.OPENWORK_MCP_REGISTRATION_MAX_AGE_MS;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    process.env.OPENWORK_MCP_REGISTRATION_MAX_AGE_MS = "5";
    try {
      const engine = startMockOpencode();
      const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${engine.server.port}`);
      const workspace = openwork.config.workspaces[0]!;
      const response = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(response.status).toBe(200);
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG)).toBe("connected");

      await Bun.sleep(10);
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG))
        .toBe("not-recorded");
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
      if (previousMaxAge === undefined) delete process.env.OPENWORK_MCP_REGISTRATION_MAX_AGE_MS;
      else process.env.OPENWORK_MCP_REGISTRATION_MAX_AGE_MS = previousMaxAge;
    }
  });

  test("invalidates registration evidence before an engine reload attempt", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    let rejectDispose = false;
    try {
      const engine = startMockOpencode({
        disposeResponse: () => rejectDispose
          ? Response.json({ code: "reload_failed" }, { status: 500 })
          : null,
      });
      const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${engine.server.port}`);
      const workspace = openwork.config.workspaces[0]!;
      const response = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(response.status).toBe(200);
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG)).toBe("connected");

      rejectDispose = true;
      const reload = await fetch(`${openwork.base}/workspace/ws_1/engine/reload`, {
        method: "POST",
        headers: auth(openwork.token),
      });
      expect(reload.status).toBe(502);
      expect(inspectEngineMcpRegistration(openwork.config, workspace, "posthog", POSTHOG_CONFIG))
        .toBe("not-recorded");
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("cloud plugin install writes a remote MCP and hot-syncs it into the engine", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);

      const response = await fetch(`${openwork.base}/workspace/ws_1/cloud-plugins`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({
          marketplaceId: null,
          resolved: {
            plugin: {
              id: "plugin_cloud_mcp",
              name: "Cloud MCP Plugin",
              description: null,
              updatedAt: "2026-06-02T00:00:00.000Z",
            },
            memberships: [
              {
                configObjectId: "config_mcp_valid",
                configObject: {
                  id: "config_mcp_valid",
                  objectType: "mcp",
                  title: "Brief MCP",
                  description: null,
                  currentRelativePath: null,
                  status: "active",
                  updatedAt: "2026-06-02T00:00:00.000Z",
                  latestVersion: {
                    id: "version_mcp_valid",
                    rawSourceText: JSON.stringify({ mcpServers: { brief: { url: "https://example.com/mcp" } } }),
                    normalizedPayloadJson: { mcpServers: { brief: { url: "https://example.com/mcp" } } },
                  },
                },
              },
            ],
          },
        }),
      });
      expect(response.status).toBe(200);
      const parsed: unknown = await response.json();
      const body = requireRecord(parsed, "cloud plugin install response");
      const item = requireRecord(body.item, "cloud plugin install item");
      expect(item.pluginId).toBe("plugin_cloud_mcp");
      expect(body.warnings).toEqual([]);

      expect((await readRuntimeOpencodeConfig(openwork.config, "ws_1")).mcp?.brief).toMatchObject({
        type: "remote",
        url: "https://example.com/mcp",
      });
      const addRequest = mock.requests.find((entry) => entry.method === "POST" && entry.pathname === "/mcp");
      expect(addRequest).toBeDefined();
      expect(addRequest?.body).toEqual({
        name: "brief",
        config: { type: "remote", url: "https://example.com/mcp", enabled: true },
      });
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("cloud plugin install warns for dropped MCP payloads while still installing skills", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);

      const response = await fetch(`${openwork.base}/workspace/ws_1/cloud-plugins`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({
          marketplaceId: null,
          resolved: {
            plugin: {
              id: "plugin_broken_mcp",
              name: "Broken Plugin",
              description: null,
              updatedAt: "2026-06-02T00:00:00.000Z",
            },
            memberships: [
              {
                configObjectId: "config_skill_broken",
                configObject: {
                  id: "config_skill_broken",
                  objectType: "skill",
                  title: "Helpful Skill",
                  description: "Skill still installs",
                  currentRelativePath: null,
                  status: "active",
                  updatedAt: "2026-06-02T00:00:00.000Z",
                  latestVersion: {
                    id: "version_skill_broken",
                    rawSourceText: "# Helpful Skill\n\nInstalled skill body.",
                    normalizedPayloadJson: null,
                  },
                },
              },
              {
                configObjectId: "config_mcp_broken",
                configObject: {
                  id: "config_mcp_broken",
                  objectType: "mcp",
                  title: "Broken MCP",
                  description: null,
                  currentRelativePath: null,
                  status: "active",
                  updatedAt: "2026-06-02T00:00:00.000Z",
                  latestVersion: {
                    id: "version_mcp_broken",
                    rawSourceText: JSON.stringify({
                      mcpServers: { broken: { type: "sse", serverUrl: "https://x.example/mcp" } },
                    }),
                    normalizedPayloadJson: {
                      mcpServers: { broken: { type: "sse", serverUrl: "https://x.example/mcp" } },
                    },
                  },
                },
              },
            ],
          },
        }),
      });
      expect(response.status).toBe(200);
      const parsed: unknown = await response.json();
      const body = requireRecord(parsed, "cloud plugin install response");
      const item = requireRecord(body.item, "cloud plugin install item");
      expect(item.pluginId).toBe("plugin_broken_mcp");
      expect(body.warnings).toEqual([
        'MCP component "Broken MCP" could not be installed: no server config with a "url" or "command" was found.',
      ]);

      const skillPath = join(workspaceRoot, ".opencode", "skills", "broken-plugin", "helpful-skill", "SKILL.md");
      expect(await readFile(skillPath, "utf8")).toContain("Installed skill body.");
      expect((await readRuntimeOpencodeConfig(openwork.config, "ws_1")).mcp?.broken).toBeUndefined();
      expect(mock.requests.some((entry) => entry.method === "POST" && entry.pathname === "/mcp")).toBe(false);
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("re-registers runtime MCPs with the engine after a reload", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);

      const addResponse = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(addResponse.status).toBe(200);
      mock.requests.length = 0;

      const reloadResponse = await fetch(`${openwork.base}/workspace/ws_1/engine/reload`, {
        method: "POST",
        headers: auth(openwork.token),
      });
      expect(reloadResponse.status).toBe(200);

      const disposeIndex = mock.requests.findIndex((entry) => entry.pathname === "/instance/dispose");
      const syncIndex = mock.requests.findIndex((entry) => entry.method === "POST" && entry.pathname === "/mcp");
      expect(disposeIndex).toBeGreaterThanOrEqual(0);
      expect(syncIndex).toBeGreaterThan(disposeIndex);
      expect(mock.requests[syncIndex]?.body).toEqual({ name: "posthog", config: POSTHOG_CONFIG });
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("pushes toggled enabled state to the engine", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);

      const addResponse = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(addResponse.status).toBe(200);
      mock.requests.length = 0;

      const toggleResponse = await fetch(`${openwork.base}/workspace/ws_1/mcp/posthog/enabled`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ enabled: false }),
      });
      expect(toggleResponse.status).toBe(200);

      const syncRequest = mock.requests.find((entry) => entry.method === "POST" && entry.pathname === "/mcp");
      expect(syncRequest).toBeDefined();
      expect(syncRequest?.body).toEqual({ name: "posthog", config: { ...POSTHOG_CONFIG, enabled: false } });
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("disconnects a removed MCP from the engine", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);

      const addResponse = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(addResponse.status).toBe(200);
      mock.requests.length = 0;

      const removeResponse = await fetch(`${openwork.base}/workspace/ws_1/mcp/posthog`, {
        method: "DELETE",
        headers: auth(openwork.token),
      });
      expect(removeResponse.status).toBe(200);

      const disconnectRequest = mock.requests.find(
        (entry) => entry.method === "POST" && entry.pathname === "/mcp/posthog/disconnect",
      );
      expect(disconnectRequest).toBeDefined();
      expect(disconnectRequest?.search).toContain(`directory=${encodeURIComponent(workspaceRoot)}`);
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("reload keeps registering remaining MCPs when one entry fails", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode({ failMcpNames: ["bad"] });
      const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);

      for (const [name, config] of [["bad", POSTHOG_CONFIG], ["posthog", POSTHOG_CONFIG]] as const) {
        const response = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
          method: "POST",
          headers: auth(openwork.token),
          body: JSON.stringify({ name, config }),
        });
        expect(response.status).toBe(200);
      }
      mock.requests.length = 0;

      const reloadResponse = await fetch(`${openwork.base}/workspace/ws_1/engine/reload`, {
        method: "POST",
        headers: auth(openwork.token),
      });
      expect(reloadResponse.status).toBe(200);

      const syncedNames = mock.requests
        .filter((entry) => entry.method === "POST" && entry.pathname === "/mcp")
        .map((entry) => (entry.body as { name?: string } | null)?.name);
      // "bad" fails with a 500 but must not block the entries after it.
      expect(syncedNames).toContain("bad");
      expect(syncedNames).toContain("posthog");
      // 5xx entries are retried once.
      expect(syncedNames.filter((name) => name === "bad").length).toBe(2);

      // The failure is surfaced on the MCP list endpoint instead of being
      // swallowed silently.
      const listResponse = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        headers: auth(openwork.token),
      });
      expect(listResponse.status).toBe(200);
      const listText = await listResponse.text();
      expect(listText).not.toContain("Invalid MCP config");
      const listBody = JSON.parse(listText) as {
        engineSync?: { status: string; failures: Array<{ name: string }> } | null;
      };
      expect(listBody.engineSync?.status).toBe("failed");
      expect(listBody.engineSync?.failures.map((failure) => failure.name)).toContain("bad");
      expect(listBody.engineSync?.failures.map((failure) => failure.name)).not.toContain("posthog");
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("startup sync pushes runtime MCPs for every workspace", async () => {
    const rootA = await createWorkspaceRoot();
    const rootB = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(rootA, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const baseUrl = `http://127.0.0.1:${mock.server.port}`;
      const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        token: "owt_test_token",
        hostToken: "owt_host_token",
        approval: { mode: "auto", timeoutMs: 1000 },
        corsOrigins: ["*"],
        workspaces: [
          { id: "ws_1", name: "A", path: rootA, preset: "starter", workspaceType: "local", baseUrl },
          { id: "ws_2", name: "B", path: rootB, preset: "starter", workspaceType: "local", baseUrl },
        ],
        authorizedRoots: [rootA, rootB],
        readOnly: false,
        startedAt: Date.now(),
        tokenSource: "cli",
        hostTokenSource: "cli",
        logFormat: "pretty",
        logRequests: false,
      };

      await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({ ...current, mcp: { posthog: POSTHOG_CONFIG } }));
      await writeRuntimeOpencodeConfig(config, "ws_2", (current) => ({ ...current, mcp: { stripe: POSTHOG_CONFIG } }));

      await syncAllWorkspacesRuntimeMcpToEngine(config);

      const syncs = mock.requests.filter((entry) => entry.method === "POST" && entry.pathname === "/mcp");
      const byName = new Map(syncs.map((entry) => [(entry.body as { name?: string } | null)?.name, entry.search]));
      expect(byName.get("posthog")).toContain(`directory=${encodeURIComponent(rootA)}`);
      expect(byName.get("stripe")).toContain(`directory=${encodeURIComponent(rootB)}`);
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("MCP add still succeeds when the engine is unreachable", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const openwork = await startOpenworkServer(workspaceRoot, "http://127.0.0.1:9");

      const response = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(openwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { items: Array<{ name: string }> };
      expect(body.items.some((item) => item.name === "posthog")).toBe(true);
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  // When the OpenCode engine endpoint on record is unreachable (process down or
  // moved to a new port), a lightweight /instance/dispose cannot revive it.
  // The reload endpoint must report a distinct, actionable error
  // (opencode_engine_unreachable) instead of either a generic 502 or a fake
  // 200 — the latter would tell the user "reloaded" while chat stays broken.
  // The desktop client uses this code to escalate to a full engine restart.
  test("engine reload reports engine-unreachable when the engine is down", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const openwork = await startOpenworkServer(workspaceRoot, "http://127.0.0.1:9");

      const response = await fetch(`${openwork.base}/workspace/ws_1/engine/reload`, {
        method: "POST",
        headers: auth(openwork.token),
      });
      expect(response.status).toBe(503);
      const body = await response.json() as { code?: string };
      expect(body.code).toBe("opencode_engine_unreachable");
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });
});
