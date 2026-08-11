import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostHeaders(token: string) {
  return { "x-openwork-host-token": token, "content-type": "application/json" };
}

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-workspace-routes-"));
  roots.push(root);
  return root;
}

async function startOpenworkServer(workspaceRoot: string) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(workspaceRoot, "server.json"),
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, hostToken: config.hostToken };
}

async function postRemoteWorkspace(base: string, hostToken: string, payload: unknown): Promise<Response> {
  return fetch(`${base}/workspaces/remote`, {
    method: "POST",
    headers: hostHeaders(hostToken),
    body: JSON.stringify(payload),
  });
}

describe("remote workspace route validation", () => {
  test("rejects invalid remoteType", async () => {
    const root = await createWorkspaceRoot();
    const { base, hostToken } = await startOpenworkServer(root);

    const response = await postRemoteWorkspace(base, hostToken, {
      baseUrl: "http://127.0.0.1:4096",
      remoteType: "shell",
    });

    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(isRecord(body) ? body.code : null).toBe("invalid_payload");
  });

  test("rejects non-string optional request fields", async () => {
    const root = await createWorkspaceRoot();
    const { base, hostToken } = await startOpenworkServer(root);

    const response = await postRemoteWorkspace(base, hostToken, {
      baseUrl: "http://127.0.0.1:4096",
      remoteType: "opencode",
      directory: 123,
    });

    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(isRecord(body) ? body.code : null).toBe("invalid_payload");
  });

  test("rejects malformed remote URLs", async () => {
    const root = await createWorkspaceRoot();
    const { base, hostToken } = await startOpenworkServer(root);

    const response = await postRemoteWorkspace(base, hostToken, {
      baseUrl: "http://",
      remoteType: "opencode",
    });

    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(isRecord(body) ? body.code : null).toBe("invalid_payload");
  });
});
