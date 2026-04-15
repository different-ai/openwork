import { expect, test } from "bun:test";
import { createApp } from "./app.js";
import { createAppDependencies } from "./context/app-dependencies.js";

function createTestApp() {
  return createApp({
    dependencies: createAppDependencies({
      environment: "test",
      inMemory: true,
      runtime: {
        bootstrapPolicy: "disabled",
      },
      startedAt: new Date("2026-04-14T00:00:00.000Z"),
      version: "0.0.0-test",
    }),
  });
}

test("root info uses the shared success envelope and route conventions", async () => {
  const app = createTestApp();
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
  const app = createTestApp();
  const response = await app.request("http://openwork.local/system/health");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.data.status).toBe("ok");
  expect(body.data.database.kind).toBe("sqlite");
  expect(["ready", "warning"]).toContain(body.data.database.status);
});

test("system metadata includes phase 3 runtime supervision state", async () => {
  const app = createTestApp();
  const response = await app.request("http://openwork.local/system/meta");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.data.foundation.phase).toBe(3);
  expect(body.data.foundation.startup.registry.localServerId).toBe("srv_local");
  expect(body.data.foundation.startup.registry.hiddenWorkspaceIds).toHaveLength(2);
  expect(body.data.runtimeSupervisor.bootstrapPolicy).toBe("disabled");
});

test("openapi route is generated from the live Hono app", async () => {
  const app = createTestApp();
  const response = await app.request("http://openwork.local/openapi.json");
  const document = await response.json();

  expect(response.status).toBe(200);
  expect(document.openapi).toBe("3.1.0");
  expect(document.info.title).toBe("OpenWork Server V2");
  expect(document.paths["/system/health"].get.operationId).toBe("getSystemHealth");
  expect(document.paths["/system/meta"].get.operationId).toBe("getSystemMeta");
  expect(document.paths["/system/opencode/health"].get.operationId).toBe("getSystemOpencodeHealth");
  expect(document.paths["/system/runtime/versions"].get.operationId).toBe("getSystemRuntimeVersions");
});

test("runtime routes expose the initial server-owned status surfaces", async () => {
  const app = createTestApp();

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
  const app = createTestApp();
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
