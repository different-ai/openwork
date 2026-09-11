import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proxyOpencodeRequest, startServer } from "./server.js";
import * as engineV2Preview from "./engine-v2-preview.js";
import { ApiError } from "./errors.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
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

function startMockOpencode(input?: { holdCommand?: Promise<void>; foreignSessionDirectory?: string; nativeV2Directory?: string; recovery?: { active: boolean; turn: number } }) {
  const requests: Array<{ pathname: string; search: string; directory: string | null; method: string; body?: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const record: { pathname: string; search: string; directory: string | null; method: string; body?: unknown } = {
        pathname: url.pathname,
        search: url.search,
        directory: input?.nativeV2Directory ? url.searchParams.get("location[directory]") : request.headers.get("x-opencode-directory"),
        method: request.method,
      };
      if (!["GET", "HEAD"].includes(request.method)) {
        const text = await request.text();
        if (text) record.body = JSON.parse(text);
      }
      requests.push(record);

      if (input?.nativeV2Directory) {
        const sessionId = url.pathname.match(/^\/api\/session\/(ses_[^/]+)$/)?.[1];
        if (sessionId) {
          if (sessionId === "ses_missing") return Response.json({ code: "not_found" }, { status: 404 });
          if (sessionId === "ses_unavailable") return Response.json({ code: "storage_unavailable" }, { status: 503 });
          const directory = sessionId === "ses_foreign" ? input.foreignSessionDirectory
            : sessionId === "ses_unscoped" ? undefined : input.nativeV2Directory;
          return Response.json({ data: { info: { id: sessionId, location: { directory }, title: "Stored thread" } } });
        }
        const messageSession = url.pathname.match(/^\/api\/session\/(ses_[^/]+)\/message(?:\/(msg_[^/]+))?$/);
        if (messageSession) {
          const message = { info: { id: "msg_1", sessionID: messageSession[1], role: "assistant" },
            parts: [{ id: "prt_1", type: "text", text: "Stored history" }] };
          return Response.json({ data: messageSession[2] ? message : [message] });
        }
        if (["/api/mcp", "/api/skill", "/api/session"].includes(url.pathname)) return Response.json({ data: [] });
        if (url.pathname === "/api/session/ses_1/instructions/entries/openwork.context"
          || url.pathname === "/api/session/ses_1/prompt") return Response.json({ data: { accepted: true } });
        return Response.json({ code: "not_found" }, { status: 404 });
      }

      if (input?.recovery) {
        if (url.pathname === "/session/ses_1/prompt_async") {
          input.recovery.active = true;
          input.recovery.turn++;
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/session/status") return Response.json(input.recovery.active ? { ses_1: { type: "busy" } } : {});
        if (["/permission", "/question"].includes(url.pathname)) return Response.json([]);
        if (url.pathname === "/api/session/ses_1/permission") return Response.json({ data: [] });
        if (url.pathname === "/session/ses_1/message") return Response.json([
          { info: { id: `user-${input.recovery.turn}`, role: "user", sessionID: "ses_1", model: { providerID: "test", modelID: "test" } }, parts: [] },
          { info: { id: `assistant-${input.recovery.turn}`, role: "assistant", sessionID: "ses_1", time: {} }, parts: [] },
        ]);
      }

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
  resumeInterruptedTasks?: boolean;
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
    configPath: join(input.workspaceRoot, "server.json"),
    resumeInterruptedTasks: input.resumeInterruptedTasks,
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
  return { server, token: config.token, config };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function readinessGate() {
  const entered = deferred();
  const released = deferred();
  let failure: ApiError | undefined;
  const calls: string[][] = [];
  return {
    calls,
    entered: entered.promise,
    release: released.resolve,
    fail() {
      failure = new ApiError(503, "fixture_readiness_failed", "Execution readiness failed");
      released.resolve();
    },
    async wait(...args: string[]) {
      calls.push(args);
      entered.resolve();
      await released.promise;
      if (failure) throw failure;
    },
  };
}

async function startV2Proxy() {
  const workspaceRoot = await createWorkspaceRoot();
  const secondWorkspaceRoot = await createWorkspaceRoot();
  const engine = startMockOpencode({ nativeV2Directory: workspaceRoot, foreignSessionDirectory: secondWorkspaceRoot });
  const provider = readinessGate();
  const mcp = readinessGate();
  const status = () => ({ enabled: true, chatRouting: true, running: true,
    mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [] });
  // Hold only execution preparation; requests still cross the real HTTP server,
  // auth/policy checks, native proxy and ownership lookup into a loopback witness.
  const preview = spyOn(engineV2Preview, "createEngineV2Preview").mockReturnValue({
    start() {}, status, setEnabled: async () => status(), setChatRouting: async () => status(),
    connection: () => ({ url: `http://127.0.0.1:${engine.server.port}`, username: "opencode", password: "fixture" }),
    ensureWorkspaceReady: provider.wait, syncWorkspaceMcp: mcp.wait, stop: async () => {},
  });
  try {
    const openwork = await startOpenworkServer({ workspaceRoot, secondWorkspaceRoot, readOnly: false });
    stops.push(() => { provider.release(); mcp.release(); });
    const base = `http://127.0.0.1:${openwork.server.port}`;
    const request = (path: string, init: RequestInit = {}, workspaceId = "ws_1") => fetch(
      `${base}/workspace/${workspaceId}/opencode2${path}`,
      { signal: AbortSignal.timeout(2_000), headers: auth(openwork.token), ...init },
    );
    return { ...openwork, base, request, engine, provider, mcp, workspaceRoot, secondWorkspaceRoot };
  } finally {
    preview.mockRestore();
  }
}

async function waitUntil(predicate: () => boolean) {
  for (let index = 0; index < 20; index++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("workspace OpenCode proxy", () => {
  test.serial("v2 stored history responds while provider and MCP readiness are held; prompts wait for both", async () => {
    const fixture = await startV2Proxy();
    let promptSettled = false;
    const prompt = fixture.request("/api/session/ses_1/prompt", { method: "POST", body: JSON.stringify({ parts: [] }) })
      .finally(() => { promptSettled = true; });
    for (const gate of [fixture.provider, fixture.mcp]) {
      await gate.entered;
      const before = fixture.engine.requests.length;
      for (const suffix of ["", "/message", "/message/msg_1"]) {
        const query = new URLSearchParams({ "location[directory]": fixture.secondWorkspaceRoot,
          "location[project]": "foreign", location: "foreign", limit: "50" });
        query.append("location[directory]", "another-directory");
        const response = await fixture.request(`/api/session/ses_1${suffix}?${query}`, {
          headers: { ...auth(fixture.token), "x-opencode-directory": fixture.secondWorkspaceRoot },
        });
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(JSON.stringify(payload)).toContain(suffix ? "Stored history" : "Stored thread");
      }
      const reads = fixture.engine.requests.slice(before);
      expect(reads.map((item) => item.pathname)).toEqual([
        "/api/session/ses_1", "/api/session/ses_1",
        "/api/session/ses_1", "/api/session/ses_1/message",
        "/api/session/ses_1", "/api/session/ses_1/message/msg_1",
      ]);
      for (const read of reads) {
        expect(read.method).toBe("GET");
        expect(read.directory).toBe(fixture.workspaceRoot);
        const query = new URLSearchParams(read.search);
        expect([...query.keys()].filter((key) => key.startsWith("location"))).toEqual(["location[directory]"]);
      }
      expect(promptSettled).toBe(false);
      gate.release();
    }
    expect((await prompt).status).toBe(200);
    expect(fixture.provider.calls).toEqual([[fixture.workspaceRoot]]);
    expect(fixture.mcp.calls).toEqual([["ws_1", fixture.workspaceRoot]]);
    expect(fixture.engine.requests.slice(-5).map((item) => `${item.method} ${item.pathname}`)).toEqual([
      "GET /api/session/ses_1", "GET /api/mcp", "GET /api/skill",
      "PUT /api/session/ses_1/instructions/entries/openwork.context", "POST /api/session/ses_1/prompt",
    ]);
  });

  for (const failingGate of ["provider", "mcp"]) {
    test.serial(`v2 history survives failed ${failingGate} readiness without admitting other reads or mutations`, async () => {
      const fixture = await startV2Proxy();
      if (failingGate === "provider") { fixture.provider.fail(); fixture.mcp.release(); }
      else { fixture.provider.release(); fixture.mcp.fail(); }
      const guarded: Array<[string, string]> = [
        ["GET", "/api/session"], ["GET", "/api/session/status"], ["GET", "/api/session/active"],
        ["GET", "/api/session/ses_1/todo"], ["GET", "/api/session/ses_1/permission"],
        ["GET", "/api/permission"], ["GET", "/api/form/request"], ["GET", "/api/provider"],
        ["GET", "/api/session/ses_1/unknown"], ["GET", "/api/session/status/message"],
        ["GET", "/api/session/ses_1/messages"], ["GET", "/api/session/ses_1/message/"],
        ["GET", "/api/session/ses_1/message/msg_1/part/prt_1"],
        ["GET", "/apix/session/ses_1/message"], ["GET", "/api/%73ession/ses_1/message"],
        ["GET", "/api/session/%73es_1/message"], ["GET", "/api/session/ses_1/%6dessage"],
        ["GET", "/api/session/ses_1/message/%6dsg_1"],
        ["GET", "/api/session/ses_1%2Fprompt/message"], ["GET", "/api/session/ses_1%252Fprompt/message"],
        ["GET", "/api/session/ses_1/message/msg_1%2F..%2Fprompt"],
        ["GET", "/api/session/ses_1/message/%2e%2e/prompt"],
        ["HEAD", "/api/session/ses_1/message"],
        ["POST", "/api/session"], ["POST", "/api/session/ses_1/prompt"],
        ["POST", "/api/session/ses_1/command"], ["POST", "/api/session/ses_1/generate"],
        ["POST", "/api/session/ses_1/message"], ["PUT", "/api/session/ses_1/message/msg_1"],
        ["PATCH", "/api/session/ses_1"], ["DELETE", "/api/session/ses_1/message/msg_1"],
      ];
      for (const [method, path] of guarded) {
        const response = await fixture.request(path, { method });
        expect({ method, path, status: response.status }).toEqual({ method, path, status: 503 });
        if (method !== "HEAD") await expect(response.json()).resolves.toMatchObject({ code: "fixture_readiness_failed" });
      }
      expect(fixture.engine.requests).toEqual([]);
      expect(fixture.provider.calls).toHaveLength(guarded.length);
      expect(fixture.mcp.calls).toHaveLength(failingGate === "provider" ? 0 : guarded.length);
      for (const suffix of ["", "/message", "/message/msg_1"]) {
        const response = await fixture.request(`/api/session/ses_1${suffix}`);
        expect(response.status).toBe(200);
        expect(JSON.stringify(await response.json())).toContain(suffix ? "Stored history" : "Stored thread");
      }
      expect(fixture.provider.calls).toHaveLength(guarded.length);
      expect(fixture.mcp.calls).toHaveLength(failingGate === "provider" ? 0 : guarded.length);
    });
  }

  test.serial("v2 history preserves authentication, token revocation, policy and workspace ownership while readiness is held", async () => {
    const fixture = await startV2Proxy();
    for (const suffix of ["", "/message", "/message/msg_1"]) {
      for (const headers of [{}, auth("invalid-token")]) {
        expect((await fixture.request(`/api/session/ses_1${suffix}`, { headers })).status).toBe(401);
      }
    }
    expect(fixture.engine.requests).toEqual([]);

    const issued = await fetch(`${fixture.base}/tokens`, {
      method: "POST", headers: { "x-openwork-host-token": fixture.config.hostToken }, body: JSON.stringify({ scope: "viewer" }),
    });
    expect(issued.status).toBe(201);
    const viewer = await issued.json();
    expect((await fixture.request("/api/session/ses_1/message", { headers: auth(viewer.token) })).status).toBe(200);
    fixture.engine.requests.length = 0;
    expect((await fixture.request("/api/session/ses_1/message", { method: "POST", headers: auth(viewer.token) })).status).toBe(403);
    const revoked = await fetch(`${fixture.base}/tokens/${viewer.id}`, {
      method: "DELETE", headers: { "x-openwork-host-token": fixture.config.hostToken },
    });
    expect(revoked.status).toBe(200);
    for (const suffix of ["", "/message", "/message/msg_1"]) {
      expect((await fixture.request(`/api/session/ses_1${suffix}`, { headers: auth(viewer.token) })).status).toBe(401);
    }
    expect(fixture.engine.requests).toEqual([]);

    const deniedSessions: Array<[string, number]> = [["ses_foreign", 404], ["ses_missing", 404], ["ses_unavailable", 503], ["ses_unscoped", 404]];
    for (const [sessionId, status] of deniedSessions) {
      for (const suffix of ["", "/message", "/message/msg_1"]) {
        const response = await fixture.request(`/api/session/${sessionId}${suffix}`);
        expect(response.status).toBe(status);
        expect(JSON.stringify(await response.json())).not.toContain("Stored history");
      }
    }
    expect(fixture.engine.requests.every((item) => !item.pathname.includes("/message"))).toBe(true);
    const owner = await fixture.request("/api/session/ses_foreign/message", {}, "ws_2");
    expect(owner.status).toBe(200);
    expect(JSON.stringify(await owner.json())).toContain("Stored history");
    fixture.engine.requests.length = 0;

    const policy = spyOn(managedDesktopPolicy(fixture.config), "assertRequest")
      .mockRejectedValue(new ApiError(403, "organization_policy_denied", "Fixture policy denied"));
    try {
      for (const suffix of ["", "/message", "/message/msg_1"]) {
        const response = await fixture.request(`/api/session/ses_1${suffix}`);
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ code: "organization_policy_denied" });
      }
    } finally { policy.mockRestore(); }
    expect(fixture.engine.requests).toEqual([]);
    expect(fixture.provider.calls).toEqual([]);
    expect(fixture.mcp.calls).toEqual([]);
  });

  test("desktop-owned recovery survives a server restart and admits one continuation through the authenticated proxy", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const recovery = { active: false, turn: 0 };
    const mock = startMockOpencode({ recovery });
    const openwork = await startOpenworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false, resumeInterruptedTasks: true });
    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/opencode/session/ses_1/prompt_async`, {
      method: "POST", headers: { ...auth(openwork.token), "content-type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: "Finish the task" }] }),
    });
    expect(response.status).toBe(204);
    await openwork.server.stop();
    recovery.active = false;
    const restarted = await startServer({ ...openwork.config, port: 0 });
    stops.push(() => restarted.stop());
    const resumed = () => mock.requests.filter((request) => request.method === "POST" && JSON.stringify(request.body).includes("Continue the interrupted task"));
    const deadline = Date.now() + 5_000;
    while (resumed().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(resumed()).toHaveLength(1);
    expect(resumed()[0].directory).toBe(workspaceRoot);
    expect(resumed()[0].body).toMatchObject({ model: { providerID: "test", modelID: "test" } });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(resumed()).toHaveLength(1);
  });

  test("accepts empty engine request bodies and rejects malformed JSON before forwarding", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false });
    const url = `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/opencode/session`;
    for (const body of [undefined, ""]) {
      const response = await fetch(url, { method: "POST", headers: auth(openwork.token), body });
      expect(response.status).toBe(200);
      expect((await response.json()).id).toBe("ses_created");
    }
    const sessionPosts = () => mock.requests.filter((request) => request.method === "POST" && request.pathname === "/session");
    expect(sessionPosts()).toHaveLength(2);
    const malformed = await fetch(url, { method: "POST", headers: auth(openwork.token), body: "{" });
    expect(malformed.status).toBe(400);
    expect(sessionPosts()).toHaveLength(2);
  });

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
