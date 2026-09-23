/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ReloadCoordinatorProvider, useReloadCoordinator } from "../src/react-app/shell/reload-coordinator";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";

test.each(["activity", "admission"])("automatic reload waits for task %s even when the server supports rollover", async (phase) => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  let reloads = 0;
  let finishAdmission = () => {};
  const admitting = new Promise<void>(resolve => { finishAdmission = resolve; });
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
    return <>
      <button id="config" onClick={() => coordinator.markReloadRequired("config")}>Config changed</button>
      <button id="send" onClick={() => { void coordinator.withEngineReady("workspace", () => admitting); }}>Send</button>
    </>;
  }
  try {
    await act(async () => root.render(<ReloadCoordinatorProvider><Controls /></ReloadCoordinatorProvider>));
    await act(async () => { element.querySelector<HTMLButtonElement>("#config")?.click(); });
    await act(async () => {
      if (phase === "activity") useSessionActivityStore.setState({ statusesByWorkspaceId: { workspace: { first: "thinking" } } });
      else element.querySelector<HTMLButtonElement>("#send")?.click();
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1800)); });
    expect(reloads).toBe(0);
    await act(async () => {
      finishAdmission();
      useSessionActivityStore.setState({ statusesByWorkspaceId: { workspace: { first: "idle" } } });
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1800)); });
    expect(reloads).toBe(1);
  } finally {
    finishAdmission();
    await act(async () => root.unmount());
    useSessionActivityStore.setState({ statusesByWorkspaceId: {} });
    element.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    await GlobalRegistrator.unregister();
  }
}, 10_000);

test("a send waits for an engine reload that already started", async () => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const events: string[] = [];
  let finishReload = () => {};
  const reloading = new Promise<void>(resolve => { finishReload = resolve; });
  function Controls() {
    const coordinator = useReloadCoordinator();
    useEffect(() => coordinator.registerWorkspaceReloadControls({
      workspaceId: "workspace",
      canReloadWorkspaceEngine: () => true,
      allowsBusyReload: () => true,
      reloadWorkspaceEngine: async () => {
        events.push("reload started");
        await reloading;
        events.push("reload completed");
        return true;
      },
    }), [coordinator.registerWorkspaceReloadControls]);
    return <>
      <button id="reload" onClick={() => void coordinator.reloadWorkspaceEngine()}>Reload</button>
      <button id="send" onClick={() => {
        void coordinator.withEngineReady("workspace", async () => { events.push("sent"); });
      }}>Send</button>
    </>;
  }
  try {
    await act(async () => root.render(<ReloadCoordinatorProvider><Controls /></ReloadCoordinatorProvider>));
    await act(async () => { element.querySelector<HTMLButtonElement>("#reload")?.click(); });
    await act(async () => { element.querySelector<HTMLButtonElement>("#send")?.click(); });
    expect(events).toEqual(["reload started"]);
    await act(async () => { finishReload(); await reloading; });
    expect(events).toEqual(["reload started", "reload completed", "sent"]);
  } finally {
    finishReload();
    await act(async () => root.unmount());
    element.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    await GlobalRegistrator.unregister();
  }
});
