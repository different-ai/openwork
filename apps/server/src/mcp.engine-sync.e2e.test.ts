import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

type EngineRequest = {
  method: string;
  pathname: string;
  search: string;
  body: unknown;
};

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

function startMockOpencode() {
  const requests: EngineRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });

      if (url.pathname === "/instance/dispose") return Response.json({ disposed: true });
      if (url.pathname === "/mcp" && request.method === "POST") return Response.json({});
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
