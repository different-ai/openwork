import { describe, expect, test } from "bun:test";

import type { OpenworkWorkspaceInfo } from "../src/app/lib/openwork-server";
import { mergeRouteWorkspaces, type RouteWorkspace } from "../src/react-app/shell/route-workspaces";

function serverWorkspace(id: string): OpenworkWorkspaceInfo {
  return {
    id,
    name: "workspace",
    path: "/workspace",
    preset: "default",
    workspaceType: "local",
  };
}

function remoteDesktopWorkspace(id: string, runtimeWorkspaceId: string): RouteWorkspace {
  return {
    id,
    name: "OpenWork workspace",
    path: "",
    preset: "remote",
    workspaceType: "remote",
    remoteType: "openwork",
    baseUrl: "http://192.168.0.55:8787",
    directory: null,
    displayName: "OpenWork workspace",
    openworkHostUrl: "http://192.168.0.55:8787",
    openworkToken: "client-token",
    openworkClientToken: "client-token",
    openworkHostToken: null,
    openworkWorkspaceId: runtimeWorkspaceId,
    openworkWorkspaceName: null,
    sandboxBackend: null,
    sandboxRunId: null,
    sandboxContainerName: null,
    displayNameResolved: "OpenWork workspace",
  };
}

describe("mergeRouteWorkspaces", () => {
  test("deduplicates server workspace aliases owned by desktop remote workspaces", () => {
    const merged = mergeRouteWorkspaces(
      [serverWorkspace("ws_c52ddf65534b")],
      [remoteDesktopWorkspace("rem_ws_c52ddf65534b", "ws_c52ddf65534b")],
    );

    expect(merged.map((workspace) => workspace.id)).toEqual(["rem_ws_c52ddf65534b"]);
    expect(merged[0]?.workspaceType).toBe("remote");
  });
});
