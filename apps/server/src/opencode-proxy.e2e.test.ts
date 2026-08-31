import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proxyOpencodeRequest, startServer } from "./server.js";
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

async function createWorkspaceRoot(folderName?: string) {
  const root = await mkdtemp(join(tmpdir(), "openwork-opencode-proxy-"));
  const workspaceRoot = folderName ? join(root, folderName) : root;
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  roots.push(root);
  return workspaceRoot;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function startMockOpencode(input?: { holdCommand?: Promise<void>; foreignSessionDirectory?: string }) {
  const requests: Array<{ pathname: string; search: string; directory: string | null; method: string; body?: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const record: { pathname: string; search: string; directory: string | null; method: string; body?: unknown } = {
        pathname: url.pathname,
        search: url.search,
        directory: request.headers.get("x-opencode-directory"),
        method: request.method,
      };
      if (request.method === "POST") record.body = await request.json();
      requests.push(record);

      if (url.pathname === "/session") {
        if (request.method === "POST") {
          const title = typeof record.body === "object" && record.body !== null
            ? Reflect.get(record.body, "title")
            : undefined;
          return Response.json({
            id: "ses_created",
            title: typeof title === "string" ? title : "New session",
            slug: "created-session",
            directory: request.headers.get("x-opencode-directory"),
            time: { created: 300, updated: 300 },
          });
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

      if (url.pathname === "/session/ses_foreign") {
        return Response.json({
          id: "ses_foreign",
          title: "Foreign session",
          slug: "foreign-session",
          directory: input?.foreignSessionDirectory,
          time: { created: 100, updated: 200 },
        });
      }

      if (url.pathname === "/session/ses_foreign/message") {
        return Response.json([{ info: { id: "msg_foreign", sessionID: "ses_foreign" }, parts: [] }]);
      }

      if (url.pathname === "/session/ses_foreign/todo") {
        return Response.json([{ content: "Foreign todo", status: "pending", priority: "high" }]);
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

      if (url.pathname === "/session/ses_created/prompt_async" && request.method === "POST") {
        return new Response(null, { status: 204 });
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

async function startOpenworkServer(input: {
  workspaceRoot: string;
  secondWorkspaceRoot?: string;
  opencodeBaseUrl?: string;
  readOnly?: boolean;
}) {
  const workspaces: WorkspaceInfo[] = [{
    id: "ws_1",
    name: "Workspace",
    path: input.workspaceRoot,
    preset: "starter",
    workspaceType: "local",
    ...(input.opencodeBaseUrl ? { baseUrl: input.opencodeBaseUrl } : {}),
  }];
  if (input.secondWorkspaceRoot) {
    workspaces.push({
      id: "ws_2",
      name: "Other workspace",
      path: input.secondWorkspaceRoot,
      preset: "starter",
      workspaceType: "local",
      ...(input.opencodeBaseUrl ? { baseUrl: input.opencodeBaseUrl } : {}),
    });
  }
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: [input.workspaceRoot, ...(input.secondWorkspaceRoot ? [input.secondWorkspaceRoot] : [])],
    readOnly: input.readOnly ?? true,
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

describe("workspace OpenCode proxy", () => {
  test("accepts guest-side rem_ workspace aliases", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/rem_ws_1/opencode/session`, {
      headers: auth(openwork.token),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body[0]?.id).toBe("ses_1");
    expect(body[0]?.directory).toBe(workspaceRoot);
    expect(mock.requests.find((request) => request.pathname === "/session")?.directory).toBe(workspaceRoot);
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
    expect(new URLSearchParams(proxyRequest?.search).get("directory")).toBe(workspaceRoot);
  });

  test("prevents opencode proxy callers from escaping the mounted workspace directory", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const foreignDirectory = "/tmp/foreign-workspace";
    const response = await fetch(
      `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/opencode/session?directory=${encodeURIComponent(foreignDirectory)}&roots=true`,
      {
        headers: {
          ...auth(openwork.token),
          "x-opencode-directory": foreignDirectory,
        },
      },
    );

    expect(response.status).toBe(200);
    const proxyRequest = mock.requests.find((request) => request.pathname === "/session");
    expect(proxyRequest?.directory).toBe(workspaceRoot);
    expect(new URLSearchParams(proxyRequest?.search).getAll("directory")).toEqual([workspaceRoot]);
    expect(new URLSearchParams(proxyRequest?.search).get("roots")).toBe("true");
  });

  test("pins the workspace directory against repeated, encoded, and traversal spoof variants", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const hostileQueries = [
      // Repeated directory params: the proxy must collapse them to exactly one.
      `directory=${encodeURIComponent("/tmp/foreign-a")}&directory=${encodeURIComponent("/tmp/foreign-b")}`,
      // Double-encoded traversal out of the mounted workspace.
      `directory=${encodeURIComponent(`${workspaceRoot}/%2e%2e/%2e%2e/etc`)}`,
      // Plain traversal plus an unrelated param that must survive.
      `directory=${encodeURIComponent(`${workspaceRoot}/../outside`)}&roots=true`,
    ];

    for (const [index, query] of hostileQueries.entries()) {
      mock.requests.length = 0;
      const response = await fetch(
        `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/opencode/session?${query}`,
        {
          method: "GET",
          headers: {
            ...auth(openwork.token),
            "x-opencode-directory": "/tmp/foreign-header",
          },
        },
      );

      expect({ index, status: response.status }).toEqual({ index, status: 200 });
      await response.body?.cancel();
      const proxyRequest = mock.requests.find((request) => request.pathname === "/session");
      expect({ index, directory: proxyRequest?.directory }).toEqual({ index, directory: workspaceRoot });
      expect({ index, queryDirectories: new URLSearchParams(proxyRequest?.search).getAll("directory") })
        .toEqual({ index, queryDirectories: [workspaceRoot] });
    }

    const lastRequest = mock.requests.find((request) => request.pathname === "/session");
    expect(new URLSearchParams(lastRequest?.search).get("roots")).toBe("true");
  });

  test("returns 404 for every cross-workspace session read even when OpenCode resolves the foreign id", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const secondWorkspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ foreignSessionDirectory: secondWorkspaceRoot });
    const openwork = await startOpenworkServer({
      workspaceRoot,
      secondWorkspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });
    const base = `http://127.0.0.1:${openwork.server.port}`;

    for (const path of [
      "/session/ses_foreign",
      "/session/ses_foreign/message?limit=50",
      "/session/ses_foreign/todo",
    ]) {
      const response = await fetch(`${base}/workspace/ws_1/opencode${path}`, { headers: auth(openwork.token) });
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      await expect(response.json()).resolves.toMatchObject({ code: "session_not_found" });
    }

    const ownerResponse = await fetch(`${base}/workspace/ws_2/opencode/session/ses_foreign/message`, {
      headers: auth(openwork.token),
    });
    expect(ownerResponse.status).toBe(200);
    await expect(ownerResponse.json()).resolves.toEqual([
      { info: { id: "msg_foreign", sessionID: "ses_foreign" }, parts: [] },
    ]);
  });

  test("scopes spoofed directories on POST proxy requests without touching the body", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
      readOnly: false,
    });

    const body = { title: "Spoofed create", directory: "/tmp/foreign-body" };
    const response = await fetch(
      `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/opencode/session?directory=${encodeURIComponent("/tmp/foreign-query")}`,
      {
        method: "POST",
        headers: {
          ...auth(openwork.token),
          "Content-Type": "application/json",
          "x-opencode-directory": "/tmp/foreign-header",
        },
        body: JSON.stringify(body),
      },
    );

    expect(response.status).toBe(200);
    await response.body?.cancel();
    const proxyRequest = mock.requests.find((request) => request.pathname === "/session" && request.method === "POST");
    expect(proxyRequest?.directory).toBe(workspaceRoot);
    expect(new URLSearchParams(proxyRequest?.search).getAll("directory")).toEqual([workspaceRoot]);
    // The proxy scopes routing inputs only; the JSON body is the caller's contract.
    expect(proxyRequest?.body).toEqual(body);
  });

  test("keeps opencode proxy requests off the workspace bootstrap path", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
      readOnly: false,
    });
    const commandsDir = join(workspaceRoot, ".opencode", "commands");
    const commandPath = join(commandsDir, "legacy.md");
    const legacyCommand = "---\nname: legacy\ndescription: Legacy\nmodel: null\n---\nRun legacy command\n";
    await mkdir(commandsDir, { recursive: true });
    await writeFile(commandPath, legacyCommand, "utf8");

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/opencode/session`, {
      headers: auth(openwork.token),
    });

    expect(response.status).toBe(200);
    expect(mock.requests.some((request) => request.pathname === "/session")).toBe(true);
    expect(await readFile(commandPath, "utf8")).toBe(legacyCommand);
  });

  test.serial("acknowledges proxied session commands before upstream completion and admits each message once", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const engineUrl = "http://127.0.0.1:4111";
    const replacementEngineUrl = "http://127.0.0.1:4222";
    const workspace: WorkspaceInfo = {
      id: "ws_1",
      name: "Workspace",
      path: workspaceRoot,
      preset: "starter",
      workspaceType: "local",
      baseUrl: engineUrl,
    };
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      token: "owt_test_token",
      hostToken: "owt_host_token",
      approval: { mode: "auto", timeoutMs: 1_000 },
      corsOrigins: ["*"],
      workspaces: [workspace],
      authorizedRoots: [workspaceRoot],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
    };
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const upstream = deferred();
    globalThis.fetch = Object.assign(
      (input: Parameters<typeof fetch>[0]) => {
        requests.push(input instanceof Request ? input.url : String(input));
        return upstream.promise.then(() => Response.json({ ok: true }));
      },
      { preconnect: originalFetch.preconnect },
    );
    const sendCommand = (
      targetWorkspace: WorkspaceInfo,
      sessionId: string,
      body: string,
    ) => {
      const proxyPath = `/session/${sessionId}/command`;
      const url = new URL(`http://openwork.invalid/opencode${proxyPath}`);
      return proxyOpencodeRequest({
        config,
        workspace: targetWorkspace,
        proxyPath,
        url,
        request: new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      });
    };
    const commandBody = JSON.stringify({ messageID: "msg_command_once", command: "review", arguments: "" });

    try {
      const response = await Promise.race([
        sendCommand(workspace, "ses_1", commandBody),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);
      expect(response).not.toBe("timeout");
      expect(response instanceof Response ? response.status : 0).toBe(200);
      await expect(response instanceof Response ? response.json() : null).resolves.toMatchObject({ accepted: true });

      const duplicate = await sendCommand(workspace, "ses_1", commandBody);
      expect(duplicate.status).toBe(200);
      await expect(duplicate.json()).resolves.toMatchObject({ accepted: true });

      const conflict = await sendCommand(
        workspace,
        "ses_1",
        JSON.stringify({ messageID: "msg_command_once", command: "summarize", arguments: "" }),
      );
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toMatchObject({ code: "command_admission_conflict" });

      const rolloverDuplicate = await sendCommand(
        { ...workspace, baseUrl: replacementEngineUrl },
        "ses_1",
        commandBody,
      );
      const otherSession = await sendCommand(workspace, "ses_2", commandBody);
      expect(rolloverDuplicate.status).toBe(200);
      expect(otherSession.status).toBe(200);
      expect(requests.map((request) => new URL(request).pathname)).toEqual([
        "/session/ses_1/command",
        "/session/ses_2/command",
      ]);
      expect(requests.every((request) => request.startsWith(engineUrl))).toBe(true);
    } finally {
      upstream.resolve();
      globalThis.fetch = originalFetch;
    }
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

  test("returns a configured error instead of constructing an SDK request with a relative URL", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const openwork = await startOpenworkServer({ workspaceRoot });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/opencode/session?limit=200`, {
      headers: auth(openwork.token),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "opencode_unconfigured",
      message: "OpenCode base URL is missing for this workspace",
    });
  });
});
