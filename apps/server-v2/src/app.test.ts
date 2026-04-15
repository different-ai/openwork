import { expect, test } from "bun:test";
import { createApp } from "./app.js";
import { createAppDependencies } from "./context/app-dependencies.js";

function createTestApp() {
  return createApp({
    dependencies: createAppDependencies({
      environment: "test",
      inMemory: true,
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

test("system metadata includes phase 2 startup diagnostics", async () => {
  const app = createTestApp();
  const response = await app.request("http://openwork.local/system/meta");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.data.foundation.phase).toBe(2);
  expect(body.data.foundation.startup.registry.localServerId).toBe("srv_local");
  expect(body.data.foundation.startup.registry.hiddenWorkspaceIds).toHaveLength(2);
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
