/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createOpenworkServerClient, type OpenworkMcpAppResource, type OpenworkServerClient } from "../src/app/lib/openwork-server";
import { createMcpAppActions } from "../src/components/chat/mcp-app-origin";
import type { McpAppSandboxViewProps } from "../src/components/chat/mcp-app-frame";
import { WorkspaceProvider } from "../src/react-app/shell/workspace-provider";
import type { DashboardMcpAppEntry } from "../src/react-app/domains/dashboard/granted-dashboard-store";

// Exercise the mounted tile and real action lifetime without starting an iframe or provider.
mock.module("@/components/chat/mcp-app-frame", () => ({
  McpAppSandboxView: ({ app, origin }: McpAppSandboxViewProps) => {
    const actions = useMemo(() => createMcpAppActions(origin, app, () => true), [origin, app]);
    const [message, setMessage] = useState("");
    useLayoutEffect(() => () => actions.dispose(), [actions]);
    return <div>
      <button disabled={origin.readOnly} onClick={() => {
        void actions.callTool("read_detail").then(() => setMessage("Lease usable"), error => setMessage(error.message));
      }}>App action</button>
      <span data-action-result>{message}</span>
    </div>;
  },
}));

const { McpAppTile } = await import("../src/react-app/domains/dashboard/mcp-app-tile");

test("a mounted tile retains its lease across fallback refreshes, but releases on owner removal, refresh and unmount", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const leases = new Set<string>();
  const released: string[] = [];
  const calls: string[] = [];
  let resolutions = 0;
  const resource: OpenworkMcpAppResource = {
    serverName: "fixture", toolName: "render", resourceUri: "ui://fixture/view.html", html: "<p>Fixture</p>",
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true,
  };
  const primary: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://primary.invalid" }),
    resolveMcpApp: async () => ({ app: null }) };
  const owner: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://owner.invalid" }),
    resolveMcpApp: async () => {
      const launchId = `launch-${++resolutions}`;
      leases.add(launchId);
      return { app: { ...resource, launchId } };
    },
    callMcpAppTool: async (workspaceId, request) => {
      expect(workspaceId).toBe("owner-workspace");
      if (!request.launchId || !leases.has(request.launchId)) throw new Error("Lease revoked");
      calls.push(request.name);
      return { content: [] };
    },
    releaseMcpApp: async (workspaceId, launchId) => {
      expect(workspaceId).toBe("owner-workspace");
      released.push(launchId);
      return { released: leases.delete(launchId) };
    },
  };
  const unrelated: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://unrelated.invalid" }),
    resolveMcpApp: async () => { throw new Error("Must not relaunch through an unrelated workspace"); } };
  const entry: DashboardMcpAppEntry = { kind: "mcp", id: "tile", serverName: "fixture", toolName: "render",
    projectedToolName: "fixture_render", resourceUri: resource.resourceUri, title: "Fixture", autoLaunch: true };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (includeOwner = true, includeUnrelated = false) => {
    await act(async () => root.render(<WorkspaceProvider client={null} openworkServerClient={primary} workspaceId="primary" selectedWorkspaceRoot="/fixture">
      <McpAppTile entry={entry} cacheScopeKey="fixture-cache" fallbackEndpoints={[
        ...(includeOwner ? [{ client: owner, workspaceId: "owner-workspace" }] : []),
        ...(includeUnrelated ? [{ client: unrelated, workspaceId: "unrelated-workspace" }] : []),
      ]} />
    </WorkspaceProvider>));
  };
  const button = (selector: string) => {
    const found = container.querySelector<HTMLButtonElement>(selector);
    if (!found) throw new Error(`Missing button ${selector}`);
    return found;
  };
  try {
    await render();
    expect(resolutions).toBe(1);
    const actionButton = button("button:not([aria-label])");
    await render();
    await render(true, true);
    expect(button("button:not([aria-label])")).toBe(actionButton);
    expect(released).toEqual([]);
    expect(resolutions).toBe(1);
    await act(async () => actionButton.click());
    expect(container.querySelector("[data-action-result]")?.textContent).toBe("Lease usable");
    expect(calls).toEqual(["render", "read_detail"]);

    await render(false, true);
    expect(released).toEqual(["launch-1"]);
    await render(true, true);
    expect(button("button:not([aria-label])").disabled).toBe(true);
    expect(resolutions).toBe(1);
    await act(async () => button('[aria-label="Refresh Fixture"]').click());
    expect(resolutions).toBe(2);
    expect(button("button:not([aria-label])").disabled).toBe(false);
    await act(async () => button('[aria-label="Refresh Fixture"]').click());
    expect(resolutions).toBe(3);
    expect(released).toEqual(["launch-1", "launch-2"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    await GlobalRegistrator.unregister();
  }
  expect(released).toEqual(["launch-1", "launch-2", "launch-3"]);
  expect(leases.size).toBe(0);
});
