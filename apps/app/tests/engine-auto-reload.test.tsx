/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ReloadCoordinatorProvider, useReloadCoordinator } from "../src/react-app/shell/reload-coordinator";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";

test("automatic reload waits for a just-submitted task even when the server supports rollover", async () => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  let reloads = 0;
  function Controls() {
    const coordinator = useReloadCoordinator();
    useEffect(() => coordinator.registerWorkspaceReloadControls({
      workspaceId: "workspace",
      canReloadWorkspaceEngine: () => true,
      allowsBusyReload: () => true,
      // The task has not reached the server's session list yet.
      activeSessions: () => [],
      reloadWorkspaceEngine: async () => { reloads++; return true; },
    }), [coordinator.registerWorkspaceReloadControls]);
    return <button onClick={() => coordinator.markReloadRequired("config")}>Config changed</button>;
  }
  try {
    await act(async () => root.render(<ReloadCoordinatorProvider><Controls /></ReloadCoordinatorProvider>));
    await act(async () => { element.querySelector("button")?.click(); });
    await act(async () => {
      useSessionActivityStore.setState({ statusesByWorkspaceId: { workspace: { first: "thinking" } } });
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1800)); });
    expect(reloads).toBe(0);
    await act(async () => {
      useSessionActivityStore.setState({ statusesByWorkspaceId: { workspace: { first: "idle" } } });
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1800)); });
    expect(reloads).toBe(1);
  } finally {
    await act(async () => root.unmount());
    useSessionActivityStore.setState({ statusesByWorkspaceId: {} });
    element.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    await GlobalRegistrator.unregister();
  }
}, 10_000);
