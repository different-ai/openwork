import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import { openworkRuntimeConfigFilePath, writeOpenworkRuntimeConfigFile } from "./openwork-runtime-config.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
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

function clientAuth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function workspaceIdsFromConfig(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  if (!("workspaces" in value) || !Array.isArray(value.workspaces)) return [];
  return value.workspaces.flatMap((workspace) =>
    workspace && typeof workspace === "object" && !Array.isArray(workspace) && "id" in workspace && typeof workspace.id === "string"
      ? [workspace.id]
      : [],
  );
}

function workspacesFromConfig(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  if (!("workspaces" in value) || !Array.isArray(value.workspaces)) return [];
  return value.workspaces.filter(
    (workspace): workspace is Record<string, unknown> =>
      Boolean(workspace) && typeof workspace === "object" && !Array.isArray(workspace),
  );
}

function authorizedRootsFromConfig(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  if (!("authorizedRoots" in value) || !Array.isArray(value.authorizedRoots)) return [];
  return value.authorizedRoots.filter((root): root is string => typeof root === "string");
}

async function readPersistedWorkspaceIds(configPath: string) {
  return workspaceIdsFromConfig(JSON.parse(await readFile(configPath, "utf8")));
}

async function readPersistedConfig(configPath: string): Promise<unknown> {
  return JSON.parse(await readFile(configPath, "utf8"));
}

function startMockOpencode() {
  const requests: Array<{ method: string; pathname: string; search: string; directory: string | null }> = [];
  const busyDirectories = new Set<string>();
  const abortedDirectories = new Set<string>();
  const heldStatus = new Map<string, Promise<void>>();
  let heldMcpRegistration: {
    markReached: () => void;
    released: Promise<void>;
    markCompleted: () => void;
  } | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      // The engine accepts the directory as a header or a query param; record whichever arrived.
      const directory = request.headers.get("x-opencode-directory") ?? url.searchParams.get("directory");
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, directory });

      if (url.pathname === "/session/status") {
        const hold = directory ? heldStatus.get(directory) : undefined;
        if (hold) {
          heldStatus.delete(directory!);
          return hold.then(() => Response.json({}));
        }
        return Response.json(
          directory && busyDirectories.has(directory)
            ? { ses_busy: { type: "busy" } }
            : {},
        );
      }

      if (url.pathname.endsWith("/prompt_async") && request.method === "POST") {
        if (directory) busyDirectories.add(directory);
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/instance/dispose") {
        const target = url.searchParams.get("directory");
        if (target && busyDirectories.has(target)) abortedDirectories.add(target);
        if (target) busyDirectories.delete(target);
        return Response.json({ disposed: true });
      }

      if (url.pathname === "/mcp" && request.method === "POST") {
        const hold = heldMcpRegistration;
        heldMcpRegistration = null;
        if (hold) {
          hold.markReached();
          try {
            await hold.released;
          } finally {
            hold.markCompleted();
          }
        }
        return Response.json({ posthog: { status: "connected" } });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return {
    server,
    requests,
    busyDirectories,
    abortedDirectories,
    setBusy(directory: string, busy: boolean) {
      if (busy) busyDirectories.add(directory);
      else busyDirectories.delete(directory);
    },
    holdNextStatus(directory: string) {
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldStatus.set(directory, released);
      return {
        reached: new Promise<void>((resolve) => {
          const poll = () => {
            if (requests.some((entry) => entry.pathname === "/session/status" && entry.directory === directory)) {
              resolve();
              return;
            }
            setTimeout(poll, 1);
          };
          poll();
        }),
        release,
      };
    },
    holdNextMcpRegistration() {
      let markReached: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markCompleted: () => void = () => undefined;
      const completed = new Promise<void>((resolve) => {
        markCompleted = resolve;
      });
      heldMcpRegistration = { markReached, released, markCompleted };
      return { reached, release, completed };
    },
  };
}

function startMockRemoteOpenwork() {
  const requests: Array<{ pathname: string; authorization: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ pathname: url.pathname, authorization: request.headers.get("authorization") });

      if (url.pathname === "/workspaces") {
        return Response.json({
          activeId: "ws_remote",
          items: [
            { id: "ws_remote", name: "Remote Project", path: "/remote/project" },
            { id: "ws_other", name: "Other", path: "/remote/other" },
          ],
        });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, requests };
}

async function startOpenworkServerWithWorkspaces(input: {
  configPath: string;
  workspaces: ServerConfig["workspaces"];
  authorizedRoots: string[];
  opencodeBaseUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
}) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    configPath: input.configPath,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: input.workspaces,
    authorizedRoots: input.authorizedRoots,
    opencodeBaseUrl: input.opencodeBaseUrl,
    opencodeUsername: input.opencodeUsername,
    opencodePassword: input.opencodePassword,
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { server, token: config.token, hostToken: config.hostToken, config };
}

describe("workspace activation", () => {
  test("workspace switch never disposes the engine or patches its config", async () => {
    const firstRoot = await createWorkspaceRoot();
    const secondRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const opencodeBaseUrl = `http://127.0.0.1:${mock.server.port}`;
    const workspaces: ServerConfig["workspaces"] = [
      {
        id: "ws_1",
        name: "One",
        path: firstRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: opencodeBaseUrl,
      },
      {
        id: "ws_2",
        name: "Two",
        path: secondRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: opencodeBaseUrl,
      },
    ];
    const openwork = await startOpenworkServerWithWorkspaces({
      configPath: join(firstRoot, "server.json"),
      workspaces,
      authorizedRoots: [firstRoot, secondRoot],
    });

    const base = `http://127.0.0.1:${openwork.server.port}`;
    const disposeCount = () => mock.requests.filter(
      (request) => request.method === "POST" && request.pathname === "/instance/dispose",
    ).length;
    const configPatchCount = () => mock.requests.filter(
      (request) => request.method === "PATCH" && request.pathname === "/config",
    ).length;

    const response = await fetch(`${base}/workspaces/ws_2/activate`, {
      method: "POST",
      headers: hostAuth(openwork.hostToken),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.activeId).toBe("ws_2");
    // The injected engine config file is workspace-independent: switching
    // never rebuilds the engine instance.
    expect(disposeCount()).toBe(0);
    expect(configPatchCount()).toBe(0);

    const sameWorkspaceResponse = await fetch(`${base}/workspaces/ws_2/activate`, {
      method: "POST",
      headers: hostAuth(openwork.hostToken),
    });

    expect(sameWorkspaceResponse.status).toBe(200);
    expect(disposeCount()).toBe(0);
    expect(configPatchCount()).toBe(0);
  });

  test("activation re-attaches the target workspace's runtime MCPs without any dispose", async () => {
    const firstRoot = await createWorkspaceRoot();
    const secondRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(firstRoot, "runtime.sqlite");
    const mock = startMockOpencode();
    const opencodeBaseUrl = `http://127.0.0.1:${mock.server.port}`;
    const workspaces: ServerConfig["workspaces"] = [
      { id: "ws_1", name: "One", path: firstRoot, preset: "starter", workspaceType: "local", baseUrl: opencodeBaseUrl },
      { id: "ws_2", name: "Two", path: secondRoot, preset: "starter", workspaceType: "local", baseUrl: opencodeBaseUrl },
    ];
    try {
      const openwork = await startOpenworkServerWithWorkspaces({
        configPath: join(firstRoot, "server.json"),
        workspaces,
        authorizedRoots: [firstRoot, secondRoot],
      });
      await writeRuntimeOpencodeConfig(openwork.config, "ws_2", (current) => ({
        ...current,
        mcp: {
          posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true },
        },
      }));

      const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspaces/ws_2/activate`, {
        method: "POST",
        headers: hostAuth(openwork.hostToken),
      });
      expect(response.status).toBe(200);

      // The re-attach is fire-and-forget; poll for the dynamic push.
      let mcpPushed = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        mcpPushed = mock.requests.some(
          (request) => request.method === "POST" && request.pathname === "/mcp" && request.directory === secondRoot,
        );
        if (mcpPushed) break;
        await Bun.sleep(20);
      }
      expect(mcpPushed).toBe(true);
      // The runtime MCP reached the engine dynamically with no preceding dispose.
      expect(mock.requests.some((request) => request.pathname === "/instance/dispose")).toBe(false);
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("activation rewrites identical engine config file bytes", async () => {
    const firstRoot = await createWorkspaceRoot();
    const secondRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(firstRoot, "runtime.sqlite");
    const mock = startMockOpencode();
    const opencodeBaseUrl = `http://127.0.0.1:${mock.server.port}`;
    const workspaces: ServerConfig["workspaces"] = [
      { id: "ws_1", name: "One", path: firstRoot, preset: "starter", workspaceType: "local", baseUrl: opencodeBaseUrl },
      { id: "ws_2", name: "Two", path: secondRoot, preset: "starter", workspaceType: "local", baseUrl: opencodeBaseUrl },
    ];
    try {
      const openwork = await startOpenworkServerWithWorkspaces({
        configPath: join(firstRoot, "server.json"),
        workspaces,
        authorizedRoots: [firstRoot, secondRoot],
      });
      // Distinct per-workspace runtime MCP rows must not influence the file.
      await writeRuntimeOpencodeConfig(openwork.config, "ws_1", (current) => ({
        ...current,
        mcp: { one: { type: "remote", url: "https://one.example/mcp", enabled: true } },
      }));
      await writeRuntimeOpencodeConfig(openwork.config, "ws_2", (current) => ({
        ...current,
        mcp: { two: { type: "remote", url: "https://two.example/mcp", enabled: true } },
      }));
      await writeOpenworkRuntimeConfigFile(openwork.config);
      const filePath = openworkRuntimeConfigFilePath(openwork.config);
      const before = await readFile(filePath, "utf8");

      const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspaces/ws_2/activate`, {
        method: "POST",
        headers: hostAuth(openwork.hostToken),
      });
      expect(response.status).toBe(200);

      // Wait for the fire-and-forget re-attach to settle before comparing.
      let mcpPushed = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        mcpPushed = mock.requests.some(
          (request) => request.method === "POST" && request.pathname === "/mcp" && request.directory === secondRoot,
        );
        if (mcpPushed) break;
        await Bun.sleep(20);
      }
      expect(mcpPushed).toBe(true);
      const rewritten = await writeOpenworkRuntimeConfigFile(openwork.config);
      expect(rewritten.changed).toBe(false);
      expect(await readFile(filePath, "utf8")).toBe(before);
      expect(mock.requests.some((request) => request.pathname === "/instance/dispose")).toBe(false);
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("returns without waiting for post-activation MCP registration", async () => {
    const firstRoot = await createWorkspaceRoot();
    const secondRoot = await createWorkspaceRoot();
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(firstRoot, "runtime.sqlite");
    const mock = startMockOpencode();
    const opencodeBaseUrl = `http://127.0.0.1:${mock.server.port}`;
    const workspaces: ServerConfig["workspaces"] = [
      { id: "ws_1", name: "One", path: firstRoot, preset: "starter", workspaceType: "local", baseUrl: opencodeBaseUrl },
      { id: "ws_2", name: "Two", path: secondRoot, preset: "starter", workspaceType: "local", baseUrl: opencodeBaseUrl },
    ];
    const heldRegistration = mock.holdNextMcpRegistration();
    try {
      const openwork = await startOpenworkServerWithWorkspaces({
        configPath: join(firstRoot, "server.json"),
        workspaces,
        authorizedRoots: [firstRoot, secondRoot],
      });
      await writeRuntimeOpencodeConfig(openwork.config, "ws_2", (current) => ({
        ...current,
        mcp: {
          posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true },
        },
      }));

      const activation = fetch(`http://127.0.0.1:${openwork.server.port}/workspaces/ws_2/activate`, {
        method: "POST",
        headers: hostAuth(openwork.hostToken),
      });
      expect(await Promise.race([
        heldRegistration.reached.then(() => true),
        Bun.sleep(1_000).then(() => false),
      ])).toBe(true);

      try {
        const response = await Promise.race([
          activation,
          Bun.sleep(250).then(() => null),
        ]);
        expect(response?.status).toBe(200);
        expect(mock.requests.some((request) => request.pathname === "/instance/dispose")).toBe(false);
        expect(await Promise.race([
          heldRegistration.completed.then(() => true),
          Bun.sleep(25).then(() => false),
        ])).toBe(false);
      } finally {
        heldRegistration.release();
      }
      await heldRegistration.completed;
      expect((await activation).status).toBe(200);
    } finally {
      heldRegistration.release();
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
    }
  });

  test("activation with busy sessions never probes, disposes, or aborts them", async () => {
    const firstRoot = await createWorkspaceRoot();
    const secondRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const opencodeBaseUrl = `http://127.0.0.1:${mock.server.port}`;
    const workspaces: ServerConfig["workspaces"] = [
      { id: "ws_1", name: "One", path: firstRoot, preset: "starter", workspaceType: "local", baseUrl: opencodeBaseUrl },
      { id: "ws_2", name: "Two", path: secondRoot, preset: "starter", workspaceType: "local", baseUrl: opencodeBaseUrl },
    ];
    const openwork = await startOpenworkServerWithWorkspaces({
      configPath: join(firstRoot, "server.json"),
      workspaces,
      authorizedRoots: [firstRoot, secondRoot],
    });
    mock.setBusy(firstRoot, true);

    const base = `http://127.0.0.1:${openwork.server.port}`;
    const promptResponse = await fetch(`${base}/workspace/ws_2/opencode/session/ses_b/prompt_async`, {
      method: "POST",
      headers: clientAuth(openwork.token),
      body: JSON.stringify({ parts: [{ type: "text", text: "Keep running" }] }),
    });
    expect(promptResponse.status).toBe(204);

    const response = await fetch(`${base}/workspaces/ws_2/activate`, {
      method: "POST",
      headers: hostAuth(openwork.hostToken),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).activeId).toBe("ws_2");
    // Without a reload there is no idle probe or dispose on activation.
    expect(mock.requests.some((request) => request.pathname === "/session/status")).toBe(false);
    expect(mock.requests.some((request) => request.pathname === "/instance/dispose")).toBe(false);
    expect(mock.busyDirectories.has(firstRoot)).toBe(true);
    expect(mock.busyDirectories.has(secondRoot)).toBe(true);
    expect(mock.abortedDirectories.size).toBe(0);
  });

  test("persists activation order only when requested", async () => {
    const firstRoot = await createWorkspaceRoot();
    const secondRoot = await createWorkspaceRoot();
    const configPath = join(firstRoot, "server.json");
    const workspaces: ServerConfig["workspaces"] = [
      {
        id: "ws_1",
        name: "One",
        path: firstRoot,
        preset: "starter",
        workspaceType: "local",
      },
      {
        id: "ws_2",
        name: "Two",
        path: secondRoot,
        preset: "starter",
        workspaceType: "local",
      },
    ];
    await writeFile(
      configPath,
      `${JSON.stringify({ workspaces, authorizedRoots: [firstRoot, secondRoot] }, null, 2)}\n`,
      "utf8",
    );
    const openwork = await startOpenworkServerWithWorkspaces({
      configPath,
      workspaces,
      authorizedRoots: [firstRoot, secondRoot],
    });

    const base = `http://127.0.0.1:${openwork.server.port}`;
    const persistedResponse = await fetch(`${base}/workspaces/ws_2/activate?persist=true`, {
      method: "POST",
      headers: hostAuth(openwork.hostToken),
    });
    expect(persistedResponse.status).toBe(200);
    const persistedBody = await persistedResponse.json();
    expect(persistedBody.activeId).toBe("ws_2");
    expect(persistedBody.persisted).toBe(true);
    expect(await readPersistedWorkspaceIds(configPath)).toEqual(["ws_2", "ws_1"]);

    const volatileResponse = await fetch(`${base}/workspaces/ws_1/activate`, {
      method: "POST",
      headers: hostAuth(openwork.hostToken),
    });
    expect(volatileResponse.status).toBe(200);
    const volatileBody = await volatileResponse.json();
    expect(volatileBody.activeId).toBe("ws_1");
    expect(volatileBody.persisted).toBe(false);
    expect(await readPersistedWorkspaceIds(configPath)).toEqual(["ws_2", "ws_1"]);

    const bodyPersistedResponse = await fetch(`${base}/workspaces/ws_1/activate`, {
      method: "POST",
      headers: { ...hostAuth(openwork.hostToken), "Content-Type": "application/json" },
      body: JSON.stringify({ persist: true }),
    });
    expect(bodyPersistedResponse.status).toBe(200);
    const bodyPersistedBody = await bodyPersistedResponse.json();
    expect(bodyPersistedBody.activeId).toBe("ws_1");
    expect(bodyPersistedBody.persisted).toBe(true);
    expect(await readPersistedWorkspaceIds(configPath)).toEqual(["ws_1", "ws_2"]);
  });
});

describe("workspace lifecycle registry", () => {
  test("creates server config file when adding a local workspace", async () => {
    const configRoot = await createWorkspaceRoot();
    const workspaceRoot = await createWorkspaceRoot();
    const configPath = join(configRoot, "server.json");
    const openwork = await startOpenworkServerWithWorkspaces({
      configPath,
      workspaces: [],
      authorizedRoots: [],
    });

    const base = `http://127.0.0.1:${openwork.server.port}`;
    const response = await fetch(`${base}/workspaces/local`, {
      method: "POST",
      headers: { ...hostAuth(openwork.hostToken), "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath: workspaceRoot, name: "Persisted Local", preset: "starter" }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.persisted).toBe(true);

    const persisted = await readPersistedConfig(configPath);
    const workspaces = workspacesFromConfig(persisted);
    expect(workspaces[0]?.path).toBe(workspaceRoot);
    expect(workspaces[0]?.name).toBe("Persisted Local");
    expect(authorizedRootsFromConfig(persisted)).toEqual([workspaceRoot]);
  });

  test("does not persist transient local OpenCode runtime fields", async () => {
    const configRoot = await createWorkspaceRoot();
    const workspaceRoot = await createWorkspaceRoot();
    const configPath = join(configRoot, "server.json");
    const openwork = await startOpenworkServerWithWorkspaces({
      configPath,
      workspaces: [],
      authorizedRoots: [],
      opencodeBaseUrl: "http://127.0.0.1:49999",
      opencodeUsername: "runtime-user",
      opencodePassword: "runtime-pass",
    });

    const base = `http://127.0.0.1:${openwork.server.port}`;
    const response = await fetch(`${base}/workspaces/local`, {
      method: "POST",
      headers: { ...hostAuth(openwork.hostToken), "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath: workspaceRoot, name: "Runtime Local", preset: "starter" }),
    });
    expect(response.status).toBe(201);

    const persisted = await readPersistedConfig(configPath);
    const workspace = workspacesFromConfig(persisted)[0];
    expect(workspace?.path).toBe(workspaceRoot);
    expect(workspace?.baseUrl).toBeUndefined();
    expect(workspace?.directory).toBeUndefined();
    expect(workspace?.opencodeUsername).toBeUndefined();
    expect(workspace?.opencodePassword).toBeUndefined();
  });

  test("creates and persists remote OpenWork workspace records", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const configPath = join(workspaceRoot, "server.json");
    await writeFile(configPath, `${JSON.stringify({ workspaces: [], authorizedRoots: [] }, null, 2)}\n`, "utf8");
    const remote = startMockRemoteOpenwork();
    const openwork = await startOpenworkServerWithWorkspaces({
      configPath,
      workspaces: [],
      authorizedRoots: [],
    });

    const base = `http://127.0.0.1:${openwork.server.port}`;
    const response = await fetch(`${base}/workspaces/remote`, {
      method: "POST",
      headers: { ...hostAuth(openwork.hostToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${remote.server.port}`,
        openworkHostUrl: `http://127.0.0.1:${remote.server.port}`,
        openworkToken: "remote_token",
        directory: "/remote/project",
        remoteType: "openwork",
        sandboxRunId: "run_1",
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.activeId).toBe("rem_ws_remote");
    expect(body.workspaces[0].openworkWorkspaceId).toBe("ws_remote");
    expect(body.workspaces[0].openworkWorkspaceName).toBe("Remote Project");
    expect(remote.requests[0]).toEqual({ pathname: "/workspaces", authorization: "Bearer remote_token" });

    const persisted = await readPersistedConfig(configPath);
    const workspaces = workspacesFromConfig(persisted);
    expect(workspaces[0]?.id).toBe("rem_ws_remote");
    expect(workspaces[0]?.workspaceType).toBe("remote");
    expect(workspaces[0]?.remoteType).toBe("openwork");
    expect(workspaces[0]?.sandboxRunId).toBe("run_1");
    expect(authorizedRootsFromConfig(persisted)).toEqual([]);
  });

  test("renames activates and deletes remote records without authorized roots", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const configPath = join(workspaceRoot, "server.json");
    const workspaces: ServerConfig["workspaces"] = [
      {
        id: "rem_ws_one",
        name: "One",
        path: "/remote/one",
        preset: "remote",
        workspaceType: "remote",
        remoteType: "openwork",
        baseUrl: "http://127.0.0.1:9",
        openworkWorkspaceId: "ws_one",
      },
      {
        id: "rem_ws_two",
        name: "Two",
        path: "/remote/two",
        preset: "remote",
        workspaceType: "remote",
        remoteType: "openwork",
        baseUrl: "http://127.0.0.1:9",
        openworkWorkspaceId: "ws_two",
      },
    ];
    await writeFile(configPath, `${JSON.stringify({ workspaces, authorizedRoots: [] }, null, 2)}\n`, "utf8");
    const openwork = await startOpenworkServerWithWorkspaces({
      configPath,
      workspaces,
      authorizedRoots: [],
    });
    const base = `http://127.0.0.1:${openwork.server.port}`;

    const renameResponse = await fetch(`${base}/workspaces/rem_ws_one/display-name`, {
      method: "PATCH",
      headers: { ...hostAuth(openwork.hostToken), "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Renamed One" }),
    });
    expect(renameResponse.status).toBe(200);
    let persisted = await readPersistedConfig(configPath);
    expect(workspacesFromConfig(persisted)[0]?.displayName).toBe("Renamed One");

    const activateResponse = await fetch(`${base}/workspaces/rem_ws_two/activate?persist=true`, {
      method: "POST",
      headers: hostAuth(openwork.hostToken),
    });
    expect(activateResponse.status).toBe(200);
    expect(await readPersistedWorkspaceIds(configPath)).toEqual(["rem_ws_two", "rem_ws_one"]);

    const deleteResponse = await fetch(`${base}/workspaces/rem_ws_one`, {
      method: "DELETE",
      headers: hostAuth(openwork.hostToken),
    });
    expect(deleteResponse.status).toBe(200);
    persisted = await readPersistedConfig(configPath);
    expect(workspaceIdsFromConfig(persisted)).toEqual(["rem_ws_two"]);
    expect(authorizedRootsFromConfig(persisted)).toEqual([]);
  });
});
