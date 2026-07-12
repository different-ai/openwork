import { describe, expect, test } from "bun:test";

import type { WorkspaceConnectionState } from "../src/app/types";
import {
  markRemoteWorkspacesReconnecting,
  retainRouteWorkspacesOnRefreshFailure,
  shouldRetryFailedWorkspaceRefresh,
  type RouteWorkspace,
} from "../src/react-app/shell/route-workspaces";

function workspace(input: {
  id: string;
  name: string;
  workspaceType: "local" | "remote";
  path?: string;
  baseUrl?: string;
  openworkToken?: string;
}): RouteWorkspace {
  return {
    id: input.id,
    name: input.name,
    displayNameResolved: input.name,
    path: input.path ?? "",
    preset: input.workspaceType === "remote" ? "remote" : "starter",
    workspaceType: input.workspaceType,
    remoteType: input.workspaceType === "remote" ? "openwork" : null,
    baseUrl: input.baseUrl ?? null,
    openworkToken: input.openworkToken ?? null,
  };
}

describe("remote workspace refresh resilience", () => {
  test("retains server-sourced remote workspaces when refresh fails", () => {
    const local = workspace({
      id: "local_1",
      name: "Local",
      workspaceType: "local",
      path: "/workspaces/local",
    });
    const remote = workspace({
      id: "remote_1",
      name: "Remote design",
      workspaceType: "remote",
      baseUrl: "https://worker.example.com",
      openworkToken: "retained-token",
    });

    const retained = retainRouteWorkspacesOnRefreshFailure(
      [local, remote],
      [local],
    );

    expect(retained.map((item) => item.id)).toEqual(["local_1", "remote_1"]);
    expect(retained[1]?.openworkToken).toBe("retained-token");
  });

  test("prefers fresh desktop routing fields without duplicating a remote workspace", () => {
    const staleRemote = workspace({
      id: "remote_1",
      name: "Remote design",
      workspaceType: "remote",
      baseUrl: "https://old-worker.example.com",
      openworkToken: "old-token",
    });
    const freshDesktopRemote = workspace({
      id: "remote_1",
      name: "Remote design",
      workspaceType: "remote",
      baseUrl: "https://worker.example.com",
      openworkToken: "new-token",
    });

    const retained = retainRouteWorkspacesOnRefreshFailure(
      [staleRemote],
      [freshDesktopRemote],
    );

    expect(retained).toHaveLength(1);
    expect(retained[0]?.baseUrl).toBe("https://worker.example.com");
    expect(retained[0]?.openworkToken).toBe("new-token");
  });

  test("marks retained remote workspaces reconnecting without hiding a specific error", () => {
    const remote = workspace({
      id: "remote_1",
      name: "Remote design",
      workspaceType: "remote",
    });
    const brokenRemote = workspace({
      id: "remote_2",
      name: "Broken worker",
      workspaceType: "remote",
    });
    const current: Record<string, WorkspaceConnectionState> = {
      remote_1: { status: "connected", checkedAt: 100 },
      remote_2: { status: "error", message: "Token rejected", checkedAt: 200 },
    };

    const next = markRemoteWorkspacesReconnecting(current, [remote, brokenRemote]);

    expect(next.remote_1).toEqual({
      status: "reconnecting",
      message: null,
      checkedAt: 100,
    });
    expect(next.remote_2).toEqual(current.remote_2);
  });

  test("retries only after a failed refresh while the client is online", () => {
    expect(shouldRetryFailedWorkspaceRefresh({ refreshFailed: true, online: true })).toBe(true);
    expect(shouldRetryFailedWorkspaceRefresh({ refreshFailed: true, online: false })).toBe(false);
    expect(shouldRetryFailedWorkspaceRefresh({ refreshFailed: false, online: true })).toBe(false);
  });
});
