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

async function createWorkspaceRoot(folderName?: string) {
  const root = await mkdtemp(join(tmpdir(), "openwork-session-read-"));
  const workspaceRoot = folderName ? join(root, folderName) : root;
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  roots.push(root);
  return workspaceRoot;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function startMockOpencode(input?: { invalidList?: boolean; holdCommand?: Promise<void> }) {
  const requests: Array<{ pathname: string; search: string; directory: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        pathname: url.pathname,
        search: url.search,
        directory: request.headers.get("x-opencode-directory"),
      });

      if (url.pathname === "/session") {
        if (input?.invalidList) {
          return Response.json({ nope: true });
        }
        return Response.json([
          {
            id: "ses_1",
            title: "Hostname Check",
            slug: "hostname-check",
            directory: request.headers.get("x-opencode-directory"),
            time: { created: 100, updated: 200 },
          },
        ]);
      }

      if (url.pathname === "/session/status") {
        return Response.json({ ses_1: { type: "busy" } });
      }

      if (url.pathname === "/session/ses_1") {
        return Response.json({
          id: "ses_1",
          title: "Hostname Check",
          slug: "hostname-check",
          directory: request.headers.get("x-opencode-directory"),
          time: { created: 100, updated: 200 },
        });
      }

      if (url.pathname === "/session/ses_1/message") {
        return Response.json([
          {
            info: {
              id: "msg_1",
              sessionID: "ses_1",
              role: "assistant",
              time: { created: 200 },
            },
            parts: [
              {
                id: "prt_1",
                messageID: "msg_1",
                sessionID: "ses_1",
                type: "text",
                text: "hostname: mock-host",
              },
            ],
          },
        ]);
      }

      if (url.pathname === "/session/ses_1/todo") {
        return Response.json([
          {
            content: "Validate session reads",
            status: "completed",
            priority: "high",
          },
        ]);
      }

      if (url.pathname === "/session/ses_1/command" && request.method === "POST") {
        await input?.holdCommand;
        return Response.json({ ok: true });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, requests };
}

async function startOpenworkServer(input: { workspaceRoot: string; opencodeBaseUrl: string }) {
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
    readOnly: true,
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean) {
  for (let index = 0; index < 20; index++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("workspace session read APIs", () => {
  test("lists sessions and returns session details, messages, and snapshot", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const base = `http://127.0.0.1:${openwork.server.port}`;

    const listResponse = await fetch(`${base}/workspace/ws_1/sessions?roots=true&limit=1&search=host&start=10`, {
      headers: auth(openwork.token),
    });
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody).toEqual({
      items: [
        {
          id: "ses_1",
          title: "Hostname Check",
          slug: "hostname-check",
          directory: workspaceRoot,
          time: { created: 100, updated: 200 },
        },
      ],
    });

    const detailResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1`, {
      headers: auth(openwork.token),
    });
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json();
    expect(detailBody.item.id).toBe("ses_1");
    expect(detailBody.item.directory).toBe(workspaceRoot);

    const messagesResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1/messages?limit=5`, {
      headers: auth(openwork.token),
    });
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json();
    expect(messagesBody.items).toHaveLength(1);
    expect(messagesBody.items[0]?.info.id).toBe("msg_1");
    expect(messagesBody.items[0]?.parts[0]?.text).toBe("hostname: mock-host");

    const snapshotResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1/snapshot?limit=5`, {
      headers: auth(openwork.token),
    });
    expect(snapshotResponse.status).toBe(200);
    const snapshotBody = await snapshotResponse.json();
    expect(snapshotBody.item.session.id).toBe("ses_1");
    expect(snapshotBody.item.messages).toHaveLength(1);
    expect(snapshotBody.item.todos).toEqual([
      {
        content: "Validate session reads",
        status: "completed",
        priority: "high",
      },
    ]);
    expect(snapshotBody.item.status).toEqual({ type: "busy" });

    const listRequest = mock.requests.find((request) => request.pathname === "/session");
    expect(listRequest?.directory).toBe(workspaceRoot);
    expect(listRequest?.search).toContain("roots=true");
    expect(listRequest?.search).toContain("limit=1");
    expect(listRequest?.search).toContain("search=host");
    expect(listRequest?.search).toContain("start=10");

  });

  test("accepts guest-side rem_ workspace aliases for session reads", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/rem_ws_1/sessions`, {
      headers: auth(openwork.token),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0]?.id).toBe("ses_1");
    expect(body.items[0]?.directory).toBe(workspaceRoot);
    expect(mock.requests.find((request) => request.pathname === "/session")?.directory).toBe(workspaceRoot);
  });

  test("encodes non-ASCII workspace directory headers for session reads", async () => {
    const workspaceRoot = await createWorkspaceRoot("项目");
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions`, {
      headers: auth(openwork.token),
    });

    expect(response.status).toBe(200);
    const listRequest = mock.requests.find((request) => request.pathname === "/session");
    const encodedDirectory = encodeURIComponent(workspaceRoot);
    expect(listRequest?.directory).toBe(encodedDirectory);
    expect(listRequest?.search).toContain(`directory=${encodedDirectory}`);
  });

  test("encodes non-ASCII workspace directory headers for opencode proxy requests", async () => {
    const workspaceRoot = await createWorkspaceRoot("项目");
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/opencode/session`, {
      headers: auth(openwork.token),
    });

    expect(response.status).toBe(200);
    const proxyRequest = mock.requests.find((request) => request.pathname === "/session");
    expect(proxyRequest?.directory).toBe(encodeURIComponent(workspaceRoot));
  });

  test("returns 404 when the upstream session is missing", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/ses_missing/snapshot`, {
      headers: auth(openwork.token),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "session_not_found",
      message: "Session not found",
    });

  });

  test("acknowledges proxied session commands before upstream completion", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const command = deferred();
    const mock = startMockOpencode({ holdCommand: command.promise });
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await Promise.race([
      fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/opencode/session/ses_1/command`, {
        method: "POST",
        headers: { ...auth(openwork.token), "Content-Type": "application/json" },
        body: JSON.stringify({ command: "review", arguments: "" }),
      }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    expect(response).not.toBe("timeout");
    expect(response instanceof Response ? response.status : 0).toBe(200);
    await expect(response instanceof Response ? response.json() : null).resolves.toMatchObject({ accepted: true });
    const sawCommand = await waitUntil(() => mock.requests.some((request) => request.pathname === "/session/ses_1/command"));
    command.resolve();
    expect(sawCommand).toBe(true);
  });

  test("keeps legacy /w workspace opencode proxy alias", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/w/ws_1/opencode/session`, {
      headers: auth(openwork.token),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(mock.requests.some((request) => request.pathname === "/session")).toBe(true);
  });

  test("returns 502 when OpenCode returns an invalid session list payload", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ invalidList: true });
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions`, {
      headers: auth(openwork.token),
    });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "opencode_invalid_response",
      message: "OpenCode returned invalid session list",
    });

  });
});
