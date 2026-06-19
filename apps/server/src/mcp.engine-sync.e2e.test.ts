import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, syncAllWorkspacesRuntimeMcpToEngine } from "./server.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
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

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-mcp-engine-sync-"));
  roots.push(root);
  return root;
}

function startMockOpencode(options?: { failMcpNames?: string[] }) {
  const requests: EngineRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });

      if (url.pathname === "/instance/dispose") return Response.json({ disposed: true });
      if (url.pathname === "/mcp" && request.method === "POST") {
        const name = (body as { name?: string } | null)?.name;
        if (name && options?.failMcpNames?.includes(name)) {
          return Response.json({ code: "mcp_invalid", message: "Invalid MCP config" }, { status: 500 });
        }
        return Response.json({});
      }
      if (url.pathname.match(/^\/mcp\/[^/]+\/disconnect$/) && request.method === "POST") return Response.json({});
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, requests };
}

async function startOpenworkServer(workspaceRoot: string, opencodeBaseUrl: string) {
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
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, token: config.token };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
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
      const listBody = await listResponse.json() as {
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
});
