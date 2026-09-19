import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SidebarContextValue } from "../src/react-app/domains/session/sidebar/app-sidebar-provider";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const actEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
const { act, Profiler } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SessionMenuItem } = await import("../src/react-app/domains/session/sidebar/app-sidebar");
const { SidebarContext } = await import("../src/react-app/domains/session/sidebar/app-sidebar-provider");
const { SidebarProvider } = await import("../src/components/ui/sidebar");
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");
const { claimQueuedSend, dispatchQueuedDrain, getQueuedDrainState, resetQueuedDrainForTests } = await import("../src/react-app/domains/session/surface/queued-drain-machine");
const { consumeComposerAutoSend, consumeComposerAutoSendPayload, hasPendingComposerAutoSend, markComposerAutoSend, subscribeComposerAutoSend } = await import("../src/react-app/domains/session/surface/composer-auto-send");
const { useSessionActivityStore } = await import("../src/react-app/domains/session/status/session-activity-store");
const { useSessionManagementStore } = await import("../src/react-app/domains/session/sidebar/session-management-store");
const { useWorkbenchStore, workbenchSessionKey } = await import("../src/react-app/domains/session/chat/workbench-store");

const sessionId = "sidebar-starting";
const otherId = "sidebar-other";
const cleanups: (() => Promise<void>)[] = [];
const composer = { draft: "Run this", attachments: [], mentions: {}, pasteParts: [], revertMessageId: null };
const noop = () => {};
const context: SidebarContextValue = {
  selectedWorkspaceId: "workspace",
  selectedSessionId: sessionId,
  developerMode: false,
  newTaskDisabled: false,
  connectingWorkspaceId: null,
  workspaceConnectionStateById: {},
  onSelectWorkspace: noop,
  onOpenSession: noop,
  onCreateTaskInWorkspace: noop,
  onCreateSplitTaskInWorkspace: noop,
  onOpenRenameWorkspace: noop,
  onShareWorkspace: noop,
  onRevealWorkspace: noop,
  onRecoverWorkspace: noop,
  onTestWorkspaceConnection: noop,
  onEditWorkspaceConnection: noop,
  onForgetWorkspace: noop,
  expandWorkspace: noop,
  toggleWorkspaceExpanded: noop,
  expandedWorkspaceIds: new Set(["workspace"]),
  sessionNumberShortcutOs: "macos",
  sessionNumberShortcutByTarget: new Map(),
};

beforeEach(() => {
  resetQueuedDrainForTests();
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {}, waitingByWorkspaceId: {} });
  useWorkbenchStore.setState({ primary: null, sideChats: {} });
  useSessionManagementStore.getState().clearUnread(sessionId);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const id of [sessionId, otherId]) {
    consumeComposerAutoSend(id);
    consumeComposerAutoSend(id, "owner-a");
    consumeComposerAutoSend(id, "owner-b");
  }
});
afterAll(async () => {
  if (actEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function mount(status?: string, isPinned = false, selectedSessionId: string | null = sessionId) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let otherCommits = 0;
  const render = async (nextStatus: string | undefined, attention = false) => {
    await act(async () => root.render(
      <PlatformProvider value={createDefaultPlatform()}>
        <SidebarProvider>
          <SidebarContext.Provider value={{ ...context,
            selectedSessionId,
            sessionStatusById: nextStatus ? { [sessionId]: nextStatus } : {},
            sessionAttentionLabelById: attention ? { [sessionId]: "Needs permission: Child task" } : {},
            sessionAttentionSourceById: attention ? { [sessionId]: "child" } : {},
          }}>
            <ul>
              <SessionMenuItem session={{ id: sessionId, title: "Task" }} workspaceId="workspace" isPinned={isPinned} />
              <Profiler id="other" onRender={() => { otherCommits++; }}>
                <SessionMenuItem session={{ id: otherId, title: "Other" }} workspaceId="workspace" />
              </Profiler>
            </ul>
          </SidebarContext.Provider>
        </SidebarProvider>
      </PlatformProvider>,
    ));
  };
  await render(status);
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
  const row = () => container.querySelector(`[data-session-tab-id="${sessionId}"]`);
  const loader = () => row()?.querySelector("[data-session-loading-indicator]");
  return { container, render, row, loader, otherCommits: () => otherCommits };
}

test("starting -> native busy -> idle reuses the loader without changing run state or unrelated rows", async () => {
  const view = await mount();
  const activity = useSessionActivityStore.getState();
  const otherCommits = view.otherCommits();
  expect(view.loader()).toBeNull();
  await act(async () => { expect(claimQueuedSend(sessionId, "initial")).toBe(true); });
  const startingLoader = view.loader();
  expect(startingLoader?.getAttribute("aria-label")).toBe("Starting");
  expect(view.row()?.getAttribute("aria-label")).toBe("Task, Starting");
  expect(useSessionActivityStore.getState()).toBe(activity);
  expect(view.otherCommits()).toBe(otherCommits);
  expect(useSessionManagementStore.getState().unreadIds).not.toContain(sessionId);

  await act(async () => { dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "initial", outcome: "sent", at: 100 }); });
  expect(view.loader()).toBe(startingLoader);
  await view.render("thinking");
  await act(async () => { dispatchQueuedDrain(sessionId, { type: "busy_observed" }); });
  expect(view.loader()).toBe(startingLoader);
  expect(view.loader()?.getAttribute("aria-label")).not.toBe("Starting");
  expect(getQueuedDrainState(sessionId).phase.kind).toBe("running");
  await act(async () => { dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: 101 }); });
  await view.render("idle");
  expect(view.loader()).toBeNull();
  expect(view.row()?.getAttribute("aria-label")).toBe("Task");
});

test.each(["busy", "thinking"])("%s retires stale Starting across idle and remount without reconciling admission", async (status) => {
  claimQueuedSend(sessionId, "initial");
  dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "initial", outcome: "sent", at: 100 });
  const admission = getQueuedDrainState(sessionId);
  const activity = useSessionActivityStore.getState();
  const view = await mount("idle", false, otherId);
  expect(view.loader()?.getAttribute("aria-label")).toBe("Starting");
  await view.render(status);
  expect(view.loader()).not.toBeNull();
  await act(async () => { useSessionManagementStore.getState().markUnread(sessionId); });
  await view.render("idle");
  expect(view.loader()).toBeNull();
  expect(view.row()?.querySelector("[data-session-attention-indicator]")).not.toBeNull();
  expect(view.row()?.getAttribute("aria-label")).not.toContain("Starting");
  await cleanups.pop()?.();
  const remounted = await mount("idle", true, otherId);
  expect(remounted.loader()).toBeNull();
  expect(remounted.row()?.querySelector("[data-session-attention-indicator]")).not.toBeNull();
  expect(getQueuedDrainState(sessionId)).toBe(admission);
  expect(useSessionActivityStore.getState()).toBe(activity);
  await act(async () => { expect(claimQueuedSend(sessionId, "next", true)).toBe(true); });
  expect(remounted.loader()?.getAttribute("aria-label")).toBe("Starting");
});

test.each(["before acceptance", "after acceptance", "never mounted"])("shared native history retires missed busy/idle when the row was %s", async (unmountedAt) => {
  const clock = spyOn(Date, "now").mockReturnValue(50);
  try {
    const activity = useSessionActivityStore.getState();
    activity.setRunStatus("workspace", sessionId, "busy");
    clock.mockReturnValue(60);
    activity.setRunStatus("workspace", sessionId, "idle");
    claimQueuedSend(sessionId, "initial");
    if (unmountedAt !== "before acceptance") {
      dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "initial", outcome: "sent", at: 100 });
    }
    if (unmountedAt !== "never mounted") {
      const view = await mount("idle");
      expect(view.loader()?.getAttribute("aria-label")).toBe("Starting");
      await cleanups.pop()?.();
    }
    clock.mockReturnValue(120);
    activity.setRunStatus("workspace", sessionId, "busy");
    clock.mockReturnValue(130);
    activity.setRunStatus("workspace", sessionId, "idle");
    if (unmountedAt === "before acceptance") {
      dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "initial", outcome: "sent", at: 140 });
    }
    const admission = getQueuedDrainState(sessionId);
    const nativeState = useSessionActivityStore.getState();
    useSessionManagementStore.getState().markUnread(sessionId);
    const view = await mount("idle", false, otherId);
    expect(view.loader()).toBeNull();
    expect(view.row()?.querySelector("[data-session-attention-indicator]")).not.toBeNull();
    expect(getQueuedDrainState(sessionId)).toBe(admission);
    expect(admission.phase.kind).toBe("awaiting_observation");
    expect(useSessionActivityStore.getState()).toBe(nativeState);
    await act(async () => {
      expect(claimQueuedSend(sessionId, "next", true)).toBe(true);
      dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "next", outcome: "sent", at: 150 });
    });
    expect(view.loader()?.getAttribute("aria-label")).toBe("Starting");
  } finally {
    clock.mockRestore();
  }
});

test("an initial scoped auto-send is visible before the send claim and survives remount", async () => {
  markComposerAutoSend(sessionId, { scopeKey: "owner-a", composer });
  const first = await mount(undefined);
  expect(first.loader()?.getAttribute("aria-label")).toBe("Starting");
  const unmount = cleanups.pop();
  await unmount?.();
  const view = await mount();
  expect(view.loader()?.getAttribute("aria-label")).toBe("Starting");
  await act(async () => {
    expect(consumeComposerAutoSendPayload(sessionId, "owner-a")).not.toBeNull();
    expect(claimQueuedSend(sessionId, "initial")).toBe(true);
  });
  expect(view.loader()?.getAttribute("aria-label")).toBe("Starting");
  await act(async () => { dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "initial", outcome: "cancelled", at: 100 }); });
  expect(view.loader()).toBeNull();
});

test("auto-send marks notify only their session and remain pending until every scope is consumed", async () => {
  const view = await mount();
  const otherCommits = view.otherCommits();
  const snapshots: boolean[] = [];
  const unsubscribe = subscribeComposerAutoSend(sessionId, () => snapshots.push(hasPendingComposerAutoSend(sessionId)));
  await act(async () => { markComposerAutoSend(sessionId); });
  expect(view.loader()?.getAttribute("aria-label")).toBe("Starting");
  expect(view.otherCommits()).toBe(otherCommits);
  await act(async () => {
    markComposerAutoSend(sessionId, { scopeKey: "owner-a", composer });
    markComposerAutoSend(sessionId, { scopeKey: "owner-b", composer });
    consumeComposerAutoSend(sessionId);
    consumeComposerAutoSendPayload(sessionId, "owner-a");
  });
  expect(view.loader()).not.toBeNull();
  await act(async () => { consumeComposerAutoSend(sessionId, "owner-b"); });
  expect(view.loader()).toBeNull();
  expect(snapshots).toEqual([true, true, true, true, true, false]);
  unsubscribe();
  await act(async () => { markComposerAutoSend(otherId); });
  expect(view.loader()).toBeNull();
  expect(snapshots).toHaveLength(6);
});

test.each(["waiting", "error"])("%s takes precedence over both startup signals", async (status) => {
  markComposerAutoSend(sessionId, { scopeKey: "owner-a", composer });
  claimQueuedSend(sessionId, "initial");
  const view = await mount();
  expect(view.loader()).not.toBeNull();
  await view.render(status, status === "waiting");
  expect(view.loader()).toBeNull();
  expect(view.row()?.getAttribute("aria-label")).not.toContain("Starting");
  if (status === "waiting") {
    const attention = view.row()?.querySelector("[data-session-attention-indicator]");
    expect(attention?.getAttribute("aria-label")).toBe("Needs permission: Child task");
    expect(attention?.getAttribute("data-session-attention-source")).toBe("child");
  }
});

test.each([false, true])("authoritative idle ends an unobserved startup (pinned: %s)", async (isPinned) => {
  claimQueuedSend(sessionId, "initial");
  dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "initial", outcome: "accepted", at: 100 });
  const view = await mount("idle", isPinned);
  expect(view.loader()?.getAttribute("aria-label")).toBe("Starting");
  await act(async () => { dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: 99 }); });
  expect(view.loader()).not.toBeNull();
  await act(async () => { dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: 101 }); });
  expect(view.loader()).toBeNull();
  expect(useSessionManagementStore.getState().unreadIds).not.toContain(sessionId);
});

test("side chats subscribe to their own startup, not the parent admission", async () => {
  const primary = { workspaceId: "workspace", sessionId };
  useWorkbenchStore.setState({ primary, sideChats: {
    [workbenchSessionKey(primary)]: { workspaceId: "workspace", sessionId: otherId },
  } });
  const view = await mount();
  const side = () => view.container.querySelector(`[data-session-side-chat="${otherId}"]`);
  await act(async () => { claimQueuedSend(sessionId, "parent"); });
  expect(side()?.querySelector("[data-session-loading-indicator]")).toBeNull();
  await act(async () => { markComposerAutoSend(otherId); });
  expect(side()?.querySelector("[data-session-loading-indicator]")?.getAttribute("aria-label")).toBe("Starting");
  expect(side()?.getAttribute("aria-description")).toBe("Starting");
  await act(async () => { consumeComposerAutoSend(otherId); });
  expect(side()?.querySelector("[data-session-loading-indicator]")).toBeNull();
});

test.each(["blocked", "failed", "unknown"])("%s admission stops the startup loader", async (outcome) => {
  const view = await mount();
  await act(async () => { claimQueuedSend(sessionId, "initial"); });
  expect(view.loader()).not.toBeNull();
  await act(async () => {
    if (outcome === "failed") dispatchQueuedDrain(sessionId, { type: "send_error", itemId: "initial" });
    else if (outcome === "unknown") dispatchQueuedDrain(sessionId, { type: "send_unknown", itemId: "initial", messageID: "message", at: 100 });
    else dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "initial", outcome: "blocked", at: 100 });
  });
  expect(view.loader()).toBeNull();
});
