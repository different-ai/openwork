import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { server, hostToken: config.hostToken };
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
  return { server, hostToken: config.hostToken };
}

describe("workspace activation", () => {
  test("reloads the bound OpenCode engine on activate", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
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
