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
  bundles: { fetch: true, publish: true, workspaceExport: true, workspaceImport: true },
  cloud: { persistence: true, validation: true },
  config: { projection: true, rawRead: true, rawWrite: true, read: true, write: true },
  files: { artifacts: true, contentRoutes: true, fileSessions: true, inbox: true, mutations: true },
  managed: { assignments: true, mcps: true, plugins: true, providerConfigs: true, skills: true },
  registry: { backendResolution: true, hiddenWorkspaceFiltering: true, serverInventory: true, workspaceDetail: true, workspaceList: true },
  reload: { manualEngineReload: true, reconciliation: true, watch: true, workspaceEvents: true },
  router: { bindings: true, identities: true, outboundSend: true, productRoutes: true },
  shares: { workspaceScoped: true },
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

test("client parses server-v2 error envelopes and compatibility routes for managed export flows", async () => {
  const baseUrl = startServer(async (request) => {
    const url = new URL(request.url);

    if (url.pathname === "/workspaces/ws_local/export") {
      return Response.json({
        ok: false,
        error: {
          code: "workspace_export_requires_decision",
          details: { warnings: [{ detail: "Contains secret-like plugin config.", id: "plugin-config", label: "Plugin settings" }] },
          message: "Choose a sensitive mode.",
          requestId: "owreq_err",
        },
      }, { status: 409 });
    }

    if (url.pathname === "/workspaces/ws_local/skills" && request.method === "GET") {
      return Response.json({ items: [{ description: "Demo", name: "demo-skill", path: "/tmp/demo-skill/SKILL.md", scope: "project" }] });
    }

    if (url.pathname === "/workspaces/ws_local/plugins" && request.method === "GET") {
      return Response.json({ items: [{ scope: "project", source: "config", spec: "demo-plugin" }], loadOrder: ["config.project"] });
    }

    if (url.pathname === "/workspaces/ws_local/mcp" && request.method === "GET") {
      return Response.json({ items: [{ config: { type: "local", command: ["demo"] }, name: "demo", source: "config.project" }] });
    }

    if (url.pathname === "/system/cloud-signin" && request.method === "GET") {
      return Response.json({ ok: true, data: { id: "cloud_primary", serverId: "srv_local", cloudBaseUrl: "https://app.openworklabs.com", userId: null, orgId: "org_123", auth: { authToken: "tok_123" }, metadata: { activeOrgName: "Acme", activeOrgSlug: "acme" }, lastValidatedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, meta: { requestId: "owreq_cloud_1", timestamp: new Date().toISOString() } });
    }

    if (url.pathname === "/system/cloud-signin" && request.method === "PUT") {
      return Response.json({ ok: true, data: { id: "cloud_primary", serverId: "srv_local", cloudBaseUrl: "https://app.openworklabs.com", userId: null, orgId: "org_123", auth: { authToken: "tok_123" }, metadata: { activeOrgName: "Acme", activeOrgSlug: "acme" }, lastValidatedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, meta: { requestId: "owreq_cloud_2", timestamp: new Date().toISOString() } });
    }

    if (url.pathname === "/system/cloud-signin" && request.method === "DELETE") {
      return Response.json({ ok: true, data: null, meta: { requestId: "owreq_cloud_3", timestamp: new Date().toISOString() } });
    }

    if (url.pathname === "/system/cloud-signin/validate" && request.method === "POST") {
      return Response.json({ ok: true, data: { ok: true, lastValidatedAt: new Date().toISOString(), record: { id: "cloud_primary", serverId: "srv_local", cloudBaseUrl: "https://app.openworklabs.com", userId: "usr_123", orgId: "org_123", auth: { authToken: "tok_123" }, metadata: { activeOrgName: "Acme", activeOrgSlug: "acme" }, lastValidatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }, meta: { requestId: "owreq_cloud_4", timestamp: new Date().toISOString() } });
    }

    if (url.pathname === "/workspaces/ws_local/share" && request.method === "GET") {
      return Response.json({ ok: true, data: { id: "share_ws_local", workspaceId: "ws_local", accessKey: "share_key", status: "active", lastUsedAt: null, audit: null, revokedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, meta: { requestId: "owreq_share_1", timestamp: new Date().toISOString() } });
    }

    if (url.pathname === "/workspaces/ws_local/share" && request.method === "POST") {
      return Response.json({ ok: true, data: { id: "share_ws_local", workspaceId: "ws_local", accessKey: "share_key", status: "active", lastUsedAt: null, audit: null, revokedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, meta: { requestId: "owreq_share_2", timestamp: new Date().toISOString() } });
    }

    if (url.pathname === "/workspaces/ws_local/share" && request.method === "DELETE") {
      return Response.json({ ok: true, data: { id: "share_ws_local", workspaceId: "ws_local", accessKey: null, status: "revoked", lastUsedAt: null, audit: null, revokedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, meta: { requestId: "owreq_share_3", timestamp: new Date().toISOString() } });
    }

    return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
  });

  const client = createOpenworkServerClient({
    baseUrl,
    serverV2: { enabled: true, capabilities: serverV2Capabilities as any },
    token: "client-token",
  });

  await expect(client.exportWorkspace("ws_local")).rejects.toMatchObject({
    code: "workspace_export_requires_decision",
    details: { warnings: [{ id: "plugin-config" }] },
  });

  const [skills, plugins, mcps] = await Promise.all([
    client.listSkills("ws_local"),
    client.listPlugins("ws_local"),
    client.listMcp("ws_local"),
  ]);

  const cloudSignin = await client.getCloudSignin();
  const persistedCloudSignin = await client.persistCloudSignin({
    auth: { authToken: "tok_123" },
    cloudBaseUrl: "https://app.openworklabs.com",
    metadata: { activeOrgName: "Acme", activeOrgSlug: "acme" },
    orgId: "org_123",
  });
  const validatedCloudSignin = await client.validateCloudSignin();
  const clearedCloudSignin = await client.clearCloudSignin();
  const workspaceShare = await client.getWorkspaceShare("ws_local");
  const exposedWorkspaceShare = await client.exposeWorkspaceShare("ws_local");
  const revokedWorkspaceShare = await client.revokeWorkspaceShare("ws_local");

  expect(skills.items[0]?.name).toBe("demo-skill");
  expect(plugins.items[0]?.spec).toBe("demo-plugin");
  expect(mcps.items[0]?.name).toBe("demo");
  expect(cloudSignin?.orgId).toBe("org_123");
  expect(persistedCloudSignin?.metadata?.activeOrgSlug).toBe("acme");
  expect(validatedCloudSignin.record.userId).toBe("usr_123");
  expect(clearedCloudSignin).toBeNull();
  expect(workspaceShare?.accessKey).toBe("share_key");
  expect(exposedWorkspaceShare?.status).toBe("active");
  expect(revokedWorkspaceShare?.status).toBe("revoked");
});
