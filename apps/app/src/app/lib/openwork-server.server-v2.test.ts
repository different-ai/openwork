// @ts-nocheck
import { afterEach, expect, test } from "bun:test";
import { createOpenworkServerClient } from "./openwork-server";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const stops: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
});

function startServer(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }) as Served;
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

const serverV2Capabilities = {
  auth: { actorKind: "client", hostTokenConfigured: true, required: true },
  config: { projection: true, rawRead: true, rawWrite: true, read: true, write: true },
  files: { artifacts: true, contentRoutes: true, fileSessions: true, inbox: true, mutations: true },
  registry: { backendResolution: true, hiddenWorkspaceFiltering: true, serverInventory: true, workspaceDetail: true, workspaceList: true },
  reload: { manualEngineReload: true, reconciliation: true, watch: true, workspaceEvents: true },
  sessions: { events: true, list: true, messages: true, mutations: true, promptAsync: true, revertHistory: true },
  transport: { rootMounted: true, v2: true },
  workspaces: { activate: true, createLocal: true },
};

test("server-v2 client routes workspace lifecycle and config/file calls to root-mounted paths", async () => {
  const calls: string[] = [];
  const baseUrl = startServer(async (request) => {
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}${url.search}`);

    if (url.pathname === "/workspaces/local" && request.method === "POST") {
      return Response.json({ ok: true, data: { id: "ws_local" }, meta: { requestId: "owreq_1", timestamp: new Date().toISOString() } });
    }

    if (url.pathname === "/workspaces" && request.method === "GET") {
      return Response.json({
        ok: true,
        data: {
          items: [
            {
              id: "ws_local",
              displayName: "Local",
              preset: "starter",
              kind: "local",
              status: "ready",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              hidden: false,
              slug: "local",
              notes: null,
              runtime: { backendKind: "local_opencode", health: null, lastError: null, lastSessionRefreshAt: null, lastSyncAt: null, updatedAt: null },
              server: { id: "srv_local", auth: { configured: false, scheme: "none" }, baseUrl: null, capabilities: {}, hostingKind: "desktop", isEnabled: true, isLocal: true, kind: "local", label: "Local", lastSeenAt: null, source: "seeded", updatedAt: new Date().toISOString() },
              backend: { kind: "local_opencode", serverId: "srv_local", local: { dataDir: "/tmp/local", configDir: "/tmp/config", opencodeProjectId: null }, remote: null },
            },
          ],
        },
        meta: { requestId: "owreq_2", timestamp: new Date().toISOString() },
      });
    }

    if (url.pathname === "/workspaces/ws_local/config" && request.method === "GET") {
      return Response.json({
        ok: true,
        data: {
          stored: { openwork: { reload: { auto: true } }, opencode: {} },
          effective: { openwork: { reload: { auto: true } }, opencode: { permission: { external_directory: ["/tmp/local"] } } },
          materialized: { configDir: "/tmp/config", configOpencodePath: "/tmp/config/opencode.jsonc", configOpenworkPath: "/tmp/config/.opencode/openwork.json", compatibilityOpencodePath: "/tmp/local/opencode.jsonc", compatibilityOpenworkPath: "/tmp/local/.opencode/openwork.json" },
          updatedAt: new Date().toISOString(),
          workspaceId: "ws_local",
        },
        meta: { requestId: "owreq_3", timestamp: new Date().toISOString() },
      });
    }

    if (url.pathname === "/workspaces/ws_local/config/opencode-raw" && request.method === "GET") {
      return Response.json({ ok: true, data: { content: "{}\n", exists: true, path: "/tmp/config/opencode.jsonc", updatedAt: new Date().toISOString() }, meta: { requestId: "owreq_4", timestamp: new Date().toISOString() } });
    }

    if (url.pathname === "/workspaces/ws_local/config/opencode-raw" && request.method === "POST") {
      return Response.json({ ok: true, data: { content: "{}\n", exists: true, path: "/tmp/config/opencode.jsonc", updatedAt: new Date().toISOString() }, meta: { requestId: "owreq_5", timestamp: new Date().toISOString() } });
    }

    if (url.pathname === "/workspaces/ws_local/reload-events" && request.method === "GET") {
      return Response.json({ ok: true, data: { cursor: 2, items: [{ id: "evt_1", seq: 2, workspaceId: "ws_local", reason: "config", timestamp: Date.now(), trigger: { type: "config", action: "updated", name: "opencode.jsonc" } }] }, meta: { requestId: "owreq_6", timestamp: new Date().toISOString() } });
    }

    if (url.pathname === "/workspaces/ws_local/engine/reload" && request.method === "POST") {
      return Response.json({ ok: true, data: { reloadedAt: 123 }, meta: { requestId: "owreq_7", timestamp: new Date().toISOString() } });
    }

    if (url.pathname === "/workspaces/ws_local/files/content" && request.method === "POST") {
      return Response.json({ ok: true, data: { ok: true, path: "notes.md", bytes: 5, updatedAt: 42, revision: "42:5" }, meta: { requestId: "owreq_8", timestamp: new Date().toISOString() } });
    }

    if (url.pathname === "/workspaces/ws_local/files/content" && request.method === "GET") {
      return Response.json({ ok: true, data: { path: "notes.md", content: "hello", bytes: 5, updatedAt: 42 }, meta: { requestId: "owreq_9", timestamp: new Date().toISOString() } });
    }

    return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
  });

  const client = createOpenworkServerClient({
    baseUrl,
    serverV2: { enabled: true, capabilities: serverV2Capabilities },
    token: "client-token",
  });

  const list = await client.listWorkspaces();
  expect(list.items[0].opencode?.directory).toBe("/tmp/local");

  const created = await client.createLocalWorkspace({ folderPath: "/tmp/local", name: "Local", preset: "starter" });
  expect(created.workspaces[0].id).toBe("ws_local");

  const config = await client.getConfig("ws_local");
  expect(config.openwork.reload.auto).toBe(true);
  expect(config.opencode.permission.external_directory).toContain("/tmp/local");

  const raw = await client.readOpencodeConfigFile("ws_local", "project");
  expect(raw.path).toBe("/tmp/config/opencode.jsonc");

  const writeRaw = await client.writeOpencodeConfigFile("ws_local", "project", "{}\n");
  expect(writeRaw.ok).toBe(true);

  const reloads = await client.listReloadEvents("ws_local");
  expect(reloads.cursor).toBe(2);

  const reloaded = await client.reloadEngine("ws_local");
  expect(reloaded.reloadedAt).toBe(123);

  const contentWrite = await client.writeWorkspaceFile("ws_local", { path: "notes.md", content: "hello" });
  expect(contentWrite.revision).toBe("42:5");

  const contentRead = await client.readWorkspaceFile("ws_local", "notes.md");
  expect(contentRead.content).toBe("hello");

  expect(calls).toContain("POST /workspaces/local");
  expect(calls).toContain("GET /workspaces/ws_local/config");
  expect(calls).toContain("GET /workspaces/ws_local/config/opencode-raw?scope=project");
  expect(calls).toContain("GET /workspaces/ws_local/reload-events");
  expect(calls).toContain("POST /workspaces/ws_local/files/content");
});
