import { describe, expect, test } from "bun:test";

import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import {
  canFallbackToDesktopEngineRestart,
  captureWorkspaceReloadTarget,
  workspaceOpenworkServerSnapshot,
} from "../src/react-app/domains/connections/workspace-openwork-server";

describe("Settings workspace server target", () => {
  test("projects the selected remote endpoint into the connection stores", () => {
    const endpoint = resolveWorkspaceEndpoint(
      {
        id: "rem_workspace_remote",
        workspaceType: "remote",
        baseUrl: "https://worker.example.com",
        openworkHostUrl: null,
        openworkToken: "remote-token",
        openworkClientToken: null,
        openworkHostToken: null,
        openworkWorkspaceId: "workspace_remote",
      },
      { baseUrl: "http://127.0.0.1:8787", token: "local-token" },
    );

    expect(endpoint).not.toBeNull();
    const snapshot = workspaceOpenworkServerSnapshot(endpoint);

    expect(snapshot.openworkServerClient).toBe(endpoint?.client);
    expect(snapshot.openworkServerStatus).toBe("connected");
    expect(snapshot.openworkServerCapabilities?.config?.write).toBe(true);
    expect(snapshot.openworkServerCapabilities?.mcp?.write).toBe(true);
    expect(snapshot.openworkServerIsRemote).toBe(true);
    expect(captureWorkspaceReloadTarget(snapshot, endpoint?.workspaceId)).toEqual({
      client: endpoint?.client,
      workspaceId: "workspace_remote",
      isRemote: true,
    });
  });

  test("fails closed when no selected workspace endpoint is available", () => {
    expect(workspaceOpenworkServerSnapshot(null)).toEqual({
      openworkServerClient: null,
      openworkServerStatus: "disconnected",
      openworkServerCapabilities: null,
      openworkServerIsRemote: false,
      openworkServerBaseUrl: "",
      openworkServerAuth: { token: null },
    });
  });

  test("never restarts the local desktop engine for a remote worker failure", () => {
    expect(canFallbackToDesktopEngineRestart({
      engineUnreachable: true,
      desktopRuntime: true,
      remoteWorkspace: true,
    })).toBe(false);
    expect(canFallbackToDesktopEngineRestart({
      engineUnreachable: true,
      desktopRuntime: true,
      remoteWorkspace: false,
    })).toBe(true);
  });
});
