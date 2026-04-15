import { afterEach, expect, test } from "bun:test";
import { createApp } from "./app.js";
import { createAppDependencies } from "./context/app-dependencies.js";

afterEach(() => {
  delete process.env.OPENWORK_TOKEN;
  delete process.env.OPENWORK_HOST_TOKEN;
});

function createTestApp(options?: { requireAuth?: boolean; seedRegistry?: boolean }) {
  if (options?.requireAuth) {
    process.env.OPENWORK_TOKEN = "client-token";
    process.env.OPENWORK_HOST_TOKEN = "host-token";
  }

  const dependencies = createAppDependencies({
    environment: "test",
    inMemory: true,
    legacy: {
      desktopDataDir: `/tmp/openwork-server-v2-test-desktop-${Math.random().toString(16).slice(2)}`,
      orchestratorDataDir: `/tmp/openwork-server-v2-test-orchestrator-${Math.random().toString(16).slice(2)}`,
    },
    runtime: {
      bootstrapPolicy: "disabled",
    },
    startedAt: new Date("2026-04-14T00:00:00.000Z"),
    version: "0.0.0-test",
  });

  if (options?.seedRegistry) {
    dependencies.persistence.registry.importLocalWorkspace({
      dataDir: "/tmp/openwork-phase5-local",
      displayName: "Alpha Local",
      status: "ready",
    });
    dependencies.persistence.registry.importRemoteWorkspace({
      baseUrl: "https://remote.example.com/w/alpha",
      directory: "/srv/remote-alpha",
      displayName: "Remote Alpha",
      legacyNotes: {
        source: "test",
      },
      remoteType: "openwork",
      remoteWorkspaceId: "alpha",
      serverAuth: { openworkToken: "secret" },
      serverBaseUrl: "https://remote.example.com",
      serverHostingKind: "self_hosted",
      serverLabel: "remote.example.com",
      workspaceStatus: "ready",
    });
  }

  return {
    app: createApp({ dependencies }),
    dependencies,
  };
}

test("root info uses the shared success envelope and route conventions", async () => {
  const { app } = createTestApp();
  const response = await app.request("http://openwork.local/");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(response.headers.get("x-request-id")).toBe(body.meta.requestId);
  expect(body).toMatchObject({
    ok: true,
    data: {
      service: "openwork-server-v2",
      routes: {
        system: "/system",
        workspaces: "/workspaces",
        workspaceResource: "/workspaces/:workspaceId",
      },
      contract: {
        source: "hono-openapi",
        sdkPackage: "@openwork/server-sdk",
      },
    },
  });
});

test("system health returns a consistent envelope", async () => {
  const { app } = createTestApp();
  const response = await app.request("http://openwork.local/system/health");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.data.status).toBe("ok");
  expect(body.data.database.kind).toBe("sqlite");
  expect(["ready", "warning"]).toContain(body.data.database.status);
});

test("system metadata includes phase 7 registry, config, and runtime migration state", async () => {
  const { app } = createTestApp();
  const response = await app.request("http://openwork.local/system/meta");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.data.foundation.phase).toBe(7);
  expect(body.data.foundation.startup.registry.localServerId).toBe("srv_local");
  expect(body.data.foundation.startup.registry.hiddenWorkspaceIds).toHaveLength(2);
  expect(body.data.runtimeSupervisor.bootstrapPolicy).toBe("disabled");
});

test("openapi route is generated from the live Hono app", async () => {
  const { app } = createTestApp();
  const response = await app.request("http://openwork.local/openapi.json");
  const document = await response.json();

  expect(response.status).toBe(200);
  expect(document.openapi).toBe("3.1.0");
  expect(document.info.title).toBe("OpenWork Server V2");
  expect(document.paths["/system/health"].get.operationId).toBe("getSystemHealth");
  expect(document.paths["/system/meta"].get.operationId).toBe("getSystemMeta");
  expect(document.paths["/system/capabilities"].get.operationId).toBe("getSystemCapabilities");
  expect(document.paths["/system/status"].get.operationId).toBe("getSystemStatus");
  expect(document.paths["/system/opencode/health"].get.operationId).toBe("getSystemOpencodeHealth");
  expect(document.paths["/system/runtime/versions"].get.operationId).toBe("getSystemRuntimeVersions");
  expect(document.paths["/workspaces"].get.operationId).toBe("getWorkspaces");
  expect(document.paths["/workspaces/local"].post.operationId).toBe("postWorkspacesLocal");
  expect(document.paths["/workspaces/{workspaceId}/config"].get.operationId).toBe("getWorkspacesByWorkspaceIdConfig");
  expect(document.paths["/workspaces/{workspaceId}/reload-events"].get.operationId).toBe("getWorkspacesByWorkspaceIdReloadEvents");
  expect(document.paths["/workspaces/{workspaceId}/sessions"].get.operationId).toBe("getWorkspacesByWorkspaceIdSessions");
  expect(document.paths["/workspaces/{workspaceId}/events"].get.operationId).toBe("getWorkspacesByWorkspaceIdEvents");
});

test("runtime routes expose the initial server-owned status surfaces", async () => {
  const { app } = createTestApp();

  const [opencodeResponse, routerResponse, runtimeResponse] = await Promise.all([
    app.request("http://openwork.local/system/opencode/health"),
    app.request("http://openwork.local/system/router/health"),
    app.request("http://openwork.local/system/runtime/summary"),
  ]);

  const opencodeBody = await opencodeResponse.json();
  const routerBody = await routerResponse.json();
  const runtimeBody = await runtimeResponse.json();

  expect(opencodeResponse.status).toBe(200);
  expect(opencodeBody.data.status).toBe("disabled");
  expect(routerBody.data.status).toBe("disabled");
  expect(runtimeBody.data.bootstrapPolicy).toBe("disabled");
});

test("not found routes use the shared error envelope", async () => {
  const { app } = createTestApp();
  const response = await app.request("http://openwork.local/nope");
  const body = await response.json();

  expect(response.status).toBe(404);
  expect(response.headers.get("x-request-id")).toBe(body.error.requestId);
  expect(body).toMatchObject({
    ok: false,
    error: {
      code: "not_found",
    },
  });
});

test("system status reports registry summary and capabilities", async () => {
  const { app } = createTestApp({ seedRegistry: true });
  const response = await app.request("http://openwork.local/system/status");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.data.registry).toMatchObject({
    hiddenWorkspaceCount: 2,
    remoteServerCount: 1,
    totalServers: 2,
    visibleWorkspaceCount: 2,
  });
  expect(body.data.capabilities.transport.v2).toBe(true);
  expect(body.data.auth.required).toBe(false);
});

test("workspace list excludes hidden workspaces by default", async () => {
  const { app } = createTestApp({ seedRegistry: true });
  const response = await app.request("http://openwork.local/workspaces");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.data.items).toHaveLength(2);
  expect(body.data.items.map((item: any) => item.displayName).sort()).toEqual(["Alpha Local", "Remote Alpha"]);
  expect(body.data.items.find((item: any) => item.displayName === "Remote Alpha")?.backend.kind).toBe("remote_openwork");
});

test("workspace detail hides internal workspaces from non-host readers", async () => {
  const { app, dependencies } = createTestApp({ requireAuth: true, seedRegistry: true });
  const hiddenWorkspaceId = dependencies.persistence.registry.ensureHiddenWorkspace("control").id;

  const clientResponse = await app.request(`http://openwork.local/workspaces/${hiddenWorkspaceId}`, {
    headers: {
      Authorization: "Bearer client-token",
    },
  });
  const hostResponse = await app.request(`http://openwork.local/workspaces/${hiddenWorkspaceId}`, {
    headers: {
      "X-OpenWork-Host-Token": "host-token",
    },
  });

  expect(clientResponse.status).toBe(404);
  expect(hostResponse.status).toBe(200);
});

test("auth-protected registry reads require client or host scope", async () => {
  const { app } = createTestApp({ requireAuth: true, seedRegistry: true });

  const anonymous = await app.request("http://openwork.local/workspaces");
  const client = await app.request("http://openwork.local/workspaces", {
    headers: {
      Authorization: "Bearer client-token",
    },
  });
  const clientHidden = await app.request("http://openwork.local/workspaces?includeHidden=true", {
    headers: {
      Authorization: "Bearer client-token",
    },
  });
  const hostInventory = await app.request("http://openwork.local/system/servers", {
    headers: {
      "X-OpenWork-Host-Token": "host-token",
    },
  });

  expect(anonymous.status).toBe(401);
  expect(client.status).toBe(200);
  expect(clientHidden.status).toBe(403);
  expect(hostInventory.status).toBe(200);
});
