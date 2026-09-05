import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

async function startOpenworkServer() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-removed-session-routes-"));
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  roots.push(workspaceRoot);
  const workspaces: WorkspaceInfo[] = [{
    id: "ws_1",
    name: "Workspace",
    path: workspaceRoot,
    preset: "starter",
    workspaceType: "local",
  }];
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces,
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
  return { server, token: config.token };
}

/**
 * The legacy `/workspace/:id/sessions*` wrapper routes were removed in favor of
 * the native `/workspace/:id/opencode/session*` proxy. These witnesses pin the
 * removal so a bad rebase cannot silently resurrect the duplicate surface and
 * no stale client can keep depending on it.
 */
describe("removed session wrapper routes", () => {
  const removedRoutes: Array<{ method: string; path: string; body?: string }> = [
    { method: "GET", path: "/workspace/ws_1/sessions" },
    { method: "POST", path: "/workspace/ws_1/sessions", body: JSON.stringify({ title: "resurrected" }) },
    { method: "GET", path: "/workspace/ws_1/sessions/ses_1" },
    { method: "GET", path: "/workspace/ws_1/sessions/ses_1/messages" },
    { method: "GET", path: "/workspace/ws_1/sessions/ses_1/snapshot" },
    { method: "DELETE", path: "/workspace/ws_1/sessions/ses_1" },
    { method: "POST", path: "/workspace/ws_1/sessions/ses_1/abort" },
  ];

  test("every removed wrapper route answers 404 for an authorized client", async () => {
    const openwork = await startOpenworkServer();

    for (const route of removedRoutes) {
      const response = await fetch(`http://127.0.0.1:${openwork.server.port}${route.path}`, {
        method: route.method,
        headers: {
          Authorization: `Bearer ${openwork.token}`,
          ...(route.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(route.body === undefined ? {} : { body: route.body }),
      });
      expect({ ...route, status: response.status }).toEqual({ ...route, status: 404 });
      await response.body?.cancel();
    }
  });

  test("session-group routes stay mounted after the sessions.ts removal", async () => {
    const openwork = await startOpenworkServer();

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/session-groups`, {
      headers: { Authorization: `Bearer ${openwork.token}` },
    });

    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  test("routes/sessions.ts stays deleted and server.ts only wires session-group routes", async () => {
    expect(existsSync(join(import.meta.dir, "routes", "sessions.ts"))).toBe(false);

    const serverSource = await readFile(join(import.meta.dir, "server.ts"), "utf8");
    expect(serverSource).not.toContain("registerSessionRoutes");
    expect(serverSource).toContain("registerSessionGroupRoutes");
  });
});
