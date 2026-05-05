import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

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

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-activate-"));
  await mkdir(join(root, ".opencode"), { recursive: true });
  roots.push(root);
  return root;
}

function hostAuth(token: string) {
  return { "X-OpenWork-Host-Token": token };
}

function startMockOpencode() {
  const requests: Array<{ pathname: string; search: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ pathname: url.pathname, search: url.search });

      if (url.pathname === "/instance/dispose") {
        return Response.json({ disposed: true });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, requests };
}

function startOpenworkServer(input: { workspaceRoot: string; opencodeBaseUrl: string }) {
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
        path: input.workspaceRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: input.opencodeBaseUrl,
      },
    ],
    authorizedRoots: [input.workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { server, hostToken: config.hostToken };
}

describe("workspace activation", () => {
  test("reloads the bound OpenCode engine on activate", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const base = `http://127.0.0.1:${openwork.server.port}`;
    const response = await fetch(`${base}/workspaces/ws_1/activate`, {
      method: "POST",
      headers: hostAuth(openwork.hostToken),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.activeId).toBe("ws_1");

    const reloadRequest = mock.requests.find(
      (request) => request.pathname === "/instance/dispose",
    );
    expect(reloadRequest).toBeDefined();
    expect(reloadRequest?.search).toContain(
      `directory=${encodeURIComponent(workspaceRoot)}`,
    );
  });
});
