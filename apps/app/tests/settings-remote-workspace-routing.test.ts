import { afterEach, describe, expect, test } from "bun:test";

import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import {
  filterSessionsForRouteWorkspace,
  loadRouteWorkspaceSessions,
  type RouteSession,
  type RouteWorkspace,
} from "../src/react-app/shell/route-workspaces";

const originalFetch = globalThis.fetch;

type SessionRequest = {
  url: string;
  authorization: string | null;
  hostAuthorization: string | null;
};

function recordSessionRequests(items: RouteSession[]) {
  const calls: SessionRequest[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get("authorization"),
      hostAuthorization: headers.get("x-openwork-host-token"),
    });
    return new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchMock,
  });
  return calls;
}

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
});

function workspace(input: {
  id: string;
  workspaceType: "local" | "remote";
  path: string;
  baseUrl?: string;
  token?: string;
  serverWorkspaceId?: string;
}): RouteWorkspace {
  return {
    id: input.id,
    name: input.id,
    displayNameResolved: input.id,
    path: input.path,
    preset: input.workspaceType === "remote" ? "remote" : "starter",
    workspaceType: input.workspaceType,
    remoteType: input.workspaceType === "remote" ? "openwork" : null,
    baseUrl: input.baseUrl ?? null,
    openworkToken: input.token ?? null,
    openworkWorkspaceId: input.serverWorkspaceId ?? null,
  };
}

function session(id: string, directory: string): RouteSession {
  return {
    id,
    slug: id,
    projectID: "project_1",
    directory,
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
  };
}

describe("Settings remote workspace routing", () => {
  test("resolves a remote workspace to its worker instead of the local server", async () => {
    const remote = workspace({
      id: "rem_workspace_remote",
      workspaceType: "remote",
      path: "/remote/project",
      baseUrl: "https://worker.example.com",
      token: "remote-token",
      serverWorkspaceId: "workspace_remote",
    });
    const workerSessions = [
      session("session_remote", "/remote/project"),
      session("session_worker_root", "/worker/root"),
    ];
    const calls = recordSessionRequests(workerSessions);

    const endpoint = resolveWorkspaceEndpoint(remote, {
      baseUrl: "http://127.0.0.1:8787",
      token: "local-token",
      hostToken: "local-host-token",
    });
    if (!endpoint) throw new Error("Expected a remote workspace endpoint");

    expect(await loadRouteWorkspaceSessions(remote, endpoint)).toEqual(workerSessions);
    expect(calls).toEqual([{
      url: "https://worker.example.com/workspace/workspace_remote/sessions?limit=200",
      authorization: "Bearer remote-token",
      hostAuthorization: null,
    }]);
    expect(endpoint.baseUrl).toBe("https://worker.example.com");
    expect(endpoint.workspaceId).toBe("workspace_remote");
    expect(endpoint.isRemote).toBe(true);
  });

  test("keeps the local server as owner for a local workspace", async () => {
    const local = workspace({
      id: "workspace_local",
      workspaceType: "local",
      path: "/local/project",
    });
    const localSession = session("session_local", "/local/project");
    const calls = recordSessionRequests([
      localSession,
      session("session_other", "/local/other"),
    ]);

    const endpoint = resolveWorkspaceEndpoint(local, {
      baseUrl: "http://127.0.0.1:8787",
      token: "local-token",
      hostToken: "local-host-token",
    });
    if (!endpoint) throw new Error("Expected a local workspace endpoint");

    expect(await loadRouteWorkspaceSessions(local, endpoint)).toEqual([localSession]);
    expect(calls).toEqual([{
      url: "http://127.0.0.1:8787/workspace/workspace_local/sessions?limit=200",
      authorization: "Bearer local-token",
      hostAuthorization: "local-host-token",
    }]);
    expect(endpoint.baseUrl).toBe("http://127.0.0.1:8787");
    expect(endpoint.workspaceId).toBe("workspace_local");
    expect(endpoint.isRemote).toBe(false);
  });

  test("keeps all worker-returned sessions for an OpenWork remote workspace", () => {
    const remote = workspace({
      id: "rem_workspace_remote",
      workspaceType: "remote",
      path: "/remote/project",
    });
    const sessions = [
      session("session_remote", "/remote/project"),
      session("session_worker_root", "/worker/root"),
    ];

    expect(filterSessionsForRouteWorkspace(remote, sessions)).toEqual(sessions);
  });

  test("continues filtering local sessions to the selected workspace directory", () => {
    const local = workspace({
      id: "workspace_local",
      workspaceType: "local",
      path: "/local/project",
    });

    expect(
      filterSessionsForRouteWorkspace(local, [
        session("session_local", "/local/project"),
        session("session_other", "/local/other"),
      ]).map((item) => item.id),
    ).toEqual(["session_local"]);
  });
});
