import { describe, expect, test } from "bun:test";

import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import {
  filterSessionsForRouteWorkspace,
  type RouteSession,
  type RouteWorkspace,
} from "../src/react-app/shell/route-workspaces";

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
  test("resolves a remote workspace to its worker instead of the local server", () => {
    const remote = workspace({
      id: "rem_workspace_remote",
      workspaceType: "remote",
      path: "/remote/project",
      baseUrl: "https://worker.example.com",
      token: "remote-token",
      serverWorkspaceId: "workspace_remote",
    });

    const endpoint = resolveWorkspaceEndpoint(remote, {
      baseUrl: "http://127.0.0.1:8787",
      token: "local-token",
    });

    expect(endpoint?.baseUrl).toBe("https://worker.example.com");
    expect(endpoint?.token).toBe("remote-token");
    expect(endpoint?.workspaceId).toBe("workspace_remote");
    expect(endpoint?.isRemote).toBe(true);
  });

  test("keeps the local server as owner for a local workspace", () => {
    const local = workspace({
      id: "workspace_local",
      workspaceType: "local",
      path: "/local/project",
    });

    const endpoint = resolveWorkspaceEndpoint(local, {
      baseUrl: "http://127.0.0.1:8787",
      token: "local-token",
    });

    expect(endpoint?.baseUrl).toBe("http://127.0.0.1:8787");
    expect(endpoint?.workspaceId).toBe("workspace_local");
    expect(endpoint?.isRemote).toBe(false);
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
