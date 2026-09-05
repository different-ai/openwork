import { describe, expect, test } from "bun:test";

import type { WorkspaceInfo } from "../src/app/lib/desktop";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { resolveWorkbenchPaneEndpoint } from "../src/react-app/domains/session/chat/pane-runtime";

type PaneWorkspace = Pick<WorkspaceInfo, "id" | "path" | "workspaceType">;

describe("split pane runtime", () => {
  test("retains the selected pane workspace endpoint without borrowing another workspace", () => {
    const workspaceA: PaneWorkspace = { id: "workspace-a", path: "/workspace/a", workspaceType: "local" };
    const workspaceB: PaneWorkspace = { id: "workspace-b", path: "/workspace/b", workspaceType: "local" };
    const localServer = { baseUrl: "http://127.0.0.1:8787", token: "pane-token" };
    const endpointA = resolveWorkspaceEndpoint(workspaceA, localServer);
    const endpointB = resolveWorkspaceEndpoint(workspaceB, localServer);

    const pane = resolveWorkbenchPaneEndpoint({
      workspaceId: workspaceB.id,
      workspaceTitle: "Workspace B",
      workspace: workspaceB,
      endpoint: endpointB,
    });

    expect(pane.status).toBe("ready");
    if (pane.status !== "ready") return;
    expect(pane.workspaceId).toBe(workspaceB.id);
    expect(pane.workspaceRoot).toBe(workspaceB.path);
    expect(pane.endpoint.workspaceId).toBe(workspaceB.id);
    expect(pane.endpoint.opencodeBaseUrl).toContain(`/workspace/${workspaceB.id}/opencode`);
    expect(pane.endpoint.opencodeBaseUrl).not.toContain(`/workspace/${workspaceA.id}/opencode`);
    expect(pane.endpoint.token).toBe(localServer.token);
    expect(pane.endpoint).not.toBe(endpointA);
  });

  test("keeps an unavailable error local to its pane", () => {
    const workspaceA: PaneWorkspace = { id: "workspace-a", path: "/workspace/a", workspaceType: "local" };
    const workspaceB: PaneWorkspace = { id: "workspace-b", path: "/workspace/b", workspaceType: "local" };
    const localServer = { baseUrl: "http://127.0.0.1:8787", token: "pane-token" };
    const primary = resolveWorkbenchPaneEndpoint({
      workspaceId: workspaceA.id,
      workspaceTitle: "Workspace A",
      workspace: workspaceA,
      endpoint: resolveWorkspaceEndpoint(workspaceA, localServer),
    });
    const secondary = resolveWorkbenchPaneEndpoint({
      workspaceId: workspaceB.id,
      workspaceTitle: "Workspace B",
      workspace: workspaceB,
      endpoint: resolveWorkspaceEndpoint(workspaceB, localServer),
      connectionError: "Workspace B is offline.",
    });

    expect(primary.status).toBe("ready");
    expect(secondary).toEqual({
      status: "unavailable",
      workspaceId: workspaceB.id,
      workspaceTitle: "Workspace B",
      message: "Workspace B is offline.",
    });
  });
});
