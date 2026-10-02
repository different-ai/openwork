import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
});

async function startOpenworkServer() {
  const root = await mkdtemp(join(tmpdir(), "openwork-default-model-"));
  roots.push(root);
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" },
      { id: "ws_2", name: "Other", path: root, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, token: config.token };
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function put(base: string, token: string, workspaceId: string, body: unknown) {
  return fetch(`${base}/workspace/${workspaceId}/default-model`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify(body),
  });
}

describe("workspace default model API", () => {
  test("starts empty, remembers a model per workspace, and clears with null", async () => {
    const { base, token } = await startOpenworkServer();

    const empty = await fetch(`${base}/workspace/ws_1/default-model`, { headers: headers(token) });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ model: null, updatedAt: null });

    const saved = await put(base, token, "ws_1", { model: { providerID: " fixture ", modelID: "model-a", variant: "high" } });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    expect(savedBody.model).toEqual({ providerID: "fixture", modelID: "model-a", variant: "high" });
    expect(typeof savedBody.updatedAt).toBe("number");

    const read = await fetch(`${base}/workspace/ws_1/default-model`, { headers: headers(token) });
    expect(await read.json()).toEqual(savedBody);

    const other = await fetch(`${base}/workspace/ws_2/default-model`, { headers: headers(token) });
    expect(await other.json()).toEqual({ model: null, updatedAt: null });

    const withoutVariant = await put(base, token, "ws_1", { model: { providerID: "fixture", modelID: "model-b" } });
    expect((await withoutVariant.json()).model).toEqual({ providerID: "fixture", modelID: "model-b" });

    const cleared = await put(base, token, "ws_1", { model: null });
    expect(cleared.status).toBe(200);
    const clearedBody = await cleared.json();
    expect(clearedBody.model).toBeNull();
    expect(typeof clearedBody.updatedAt).toBe("number");

    const afterClear = await fetch(`${base}/workspace/ws_1/default-model`, { headers: headers(token) });
    expect((await afterClear.json()).model).toBeNull();
  });

  test("rejects invalid bodies with 400", async () => {
    const { base, token } = await startOpenworkServer();
    const invalid: unknown[] = [
      {},
      { model: "fixture/model-a" },
      { model: { providerID: "fixture" } },
      { model: { providerID: "   ", modelID: "model-a" } },
      { model: { providerID: "fixture", modelID: "" } },
      { model: { providerID: "fixture", modelID: "x".repeat(201) } },
      { model: { providerID: "fixture", modelID: "model-a", variant: "" } },
      { model: { providerID: 1, modelID: "model-a" } },
    ];
    for (const body of invalid) {
      const response = await put(base, token, "ws_1", body);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("invalid_payload");
    }
    const malformed = await fetch(`${base}/workspace/ws_1/default-model`, { method: "PUT", headers: headers(token), body: "{" });
    expect(malformed.status).toBe(400);

    const read = await fetch(`${base}/workspace/ws_1/default-model`, { headers: headers(token) });
    expect(await read.json()).toEqual({ model: null, updatedAt: null });
  });

  test("returns 404 for an unknown workspace", async () => {
    const { base, token } = await startOpenworkServer();
    const read = await fetch(`${base}/workspace/ws_missing/default-model`, { headers: headers(token) });
    expect(read.status).toBe(404);
    expect((await read.json()).code).toBe("workspace_not_found");
    const write = await put(base, token, "ws_missing", { model: null });
    expect(write.status).toBe(404);
  });

  test("requires client auth", async () => {
    const { base } = await startOpenworkServer();
    const read = await fetch(`${base}/workspace/ws_1/default-model`);
    expect(read.status).toBe(401);
    const write = await put(base, "owt_wrong_token", "ws_1", { model: null });
    expect(write.status).toBe(401);
  });
});
