import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AppSidebarProps } from "../src/react-app/domains/session/sidebar/app-sidebar";

GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
// Account/network chrome is outside this rendering check; session rows, Motion,
// disclosure controls, and all navigation/activity stores are real.
mock.module("../src/react-app/domains/session/sidebar/account-status-menu", () => ({ AccountStatusMenu: () => null }));
mock.module("../src/react-app/shell/notification-center", () => ({ NotificationBell: () => null }));
mock.module("../src/react-app/domains/cloud/brand-theme", () => ({ useBrandLogoUrl: () => null, useBrandAppName: () => "OpenWork" }));

const { AppSidebar } = await import("../src/react-app/domains/session/sidebar/app-sidebar");
const { SidebarProvider } = await import("../src/components/ui/sidebar");
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
const { useUiStateStore } = await import("../src/react-app/shell/ui-state-store");
const { useSessionManagementStore } = await import("../src/react-app/domains/session/sidebar/session-management-store");
const { useSidebarPreviewStore } = await import("../src/react-app/domains/session/sidebar/sidebar-preview-store");
const { useWorkbenchStore } = await import("../src/react-app/domains/session/chat/workbench-store");
const { useSessionActivityStore } = await import("../src/react-app/domains/session/status/session-activity-store");

const sessions = Array.from({ length: 100 }, (_, index) => ({ id: `session-${index}`, title: `Conversation ${index}` }));
const noop = () => {};
const props: AppSidebarProps = {
  sessionNumberShortcuts: { os: "macos", modifierHeld: false, targets: [] },
  workspaceSessionGroups: [{ workspace: { id: "workspace", name: "Project", path: "/project", preset: "", workspaceType: "local" }, sessions, status: "ready", sessionsLoaded: true }],
  selectedWorkspaceId: "workspace", selectedSessionId: "session-0", developerMode: false,
  connectingWorkspaceId: null, workspaceConnectionStateById: {}, newTaskDisabled: false, newTaskDraftScope: "owner-a",
  onSelectWorkspace: noop, onOpenSession: noop, onCreateTaskInWorkspace: noop, onCreateSplitTaskInWorkspace: noop,
  onOpenRenameWorkspace: noop, onShareWorkspace: noop, onRevealWorkspace: noop, onRecoverWorkspace: noop,
  onTestWorkspaceConnection: noop, onEditWorkspaceConnection: noop, onForgetWorkspace: noop,
  onOpenCreateWorkspace: noop, onOpenExtensions: noop,
  status: { clientConnected: true, openworkServerStatus: "connected", developerMode: false, showConnectionStatus: false, providerConnectedIds: [], mcpConnectedCount: 0 },
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const platform = createDefaultPlatform();
const render = (overrides: Partial<AppSidebarProps> = {}) => act(async () => root.render(
  <PlatformProvider value={platform}><SidebarProvider><AppSidebar {...props} {...overrides} /></SidebarProvider></PlatformProvider>,
));
const rowIds = () => [...container.querySelectorAll<HTMLElement>("[data-sidebar-session-id]")].map((row) => row.dataset.sidebarSessionId);
const listIds = () => [...container.querySelectorAll<HTMLElement>("[data-sidebar-session-id]")]
  .filter((row) => !row.closest("[data-sidebar-current-conversation]"))
  .map((row) => row.dataset.sidebarSessionId);
const showMore = () => [...container.querySelectorAll<HTMLElement>("button, a")].find((button) => button.textContent === "Show 6 more");

beforeEach(() => {
  useSidebarPreviewStore.setState({ scope: null, counts: {} });
  useUiStateStore.setState({ expandedWorkspaceIds: ["workspace"] });
  useSessionManagementStore.setState({ pinnedIds: [], unreadIds: [], orderByWorkspace: {}, groupsByWorkspace: {} });
  useWorkbenchStore.setState({ primary: null, secondary: null, tabs: [], sideChats: {}, focusedPane: "primary" });
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(async () => { mock.restore(); await GlobalRegistrator.unregister(); });

test("an older search/history selection adds only a location row and never focuses or reorders the preview", async () => {
  await render();
  expect(rowIds()).toEqual(sessions.slice(0, 6).map((session) => session.id));
  const focus = document.createElement("input");
  container.append(focus);
  focus.focus();
  await render({ selectedSessionId: "session-90" });
  expect(rowIds()).toHaveLength(7);
  expect(listIds()).toEqual(sessions.slice(0, 6).map((session) => session.id));
  expect(container.querySelector("[data-sidebar-current-conversation]")?.textContent).toContain("Current conversationProjectConversation 90");
  expect(container.querySelector('[data-session-tab-active="true"]')?.getAttribute("data-session-tab-id")).toBe("session-90");
  expect(document.activeElement).toBe(focus);
  expect(useSessionManagementStore.getState().orderByWorkspace).toEqual({});
  await render({ selectedSessionId: "session-2" });
  expect(rowIds()).toHaveLength(6);
  expect(container.querySelector("[data-sidebar-current-conversation]")).toBeNull();
});

test.each(["workspace", "group", "ungrouped"])("Settings return retains %s depth; other owners and workspaces start at six", async (mode) => {
  if (mode !== "workspace") useSessionManagementStore.setState({ groupsByWorkspace: { workspace: {
    groups: [{ id: "group", label: "Research" }],
    assignments: mode === "group" ? Object.fromEntries(sessions.map((session) => [session.id, "group"])) : {},
  } } });
  await render();
  expect(rowIds()).toHaveLength(6);
  const button = showMore();
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(rowIds()).toHaveLength(12);
  await act(async () => root.render(<div>Settings</div>));
  await render({ selectedSessionId: "session-90" });
  expect(rowIds()).toHaveLength(13);
  expect(listIds()).toEqual(sessions.slice(0, 12).map((session) => session.id));
  if (mode === "group") expect(container.querySelector("[data-sidebar-current-conversation]")?.textContent).toContain("Project / Research");
  if (mode === "ungrouped") expect(container.querySelector("[data-sidebar-current-conversation]")?.textContent).toContain("Project / Ungrouped");
  await render({ newTaskDraftScope: "owner-b" });
  expect(rowIds()).toHaveLength(6);
  await render({ newTaskDraftScope: null });
  expect(rowIds()).toHaveLength(6);
  await render({ selectedWorkspaceId: "other-workspace", workspaceSessionGroups: [{ ...props.workspaceSessionGroups[0]!, workspace: { ...props.workspaceSessionGroups[0]!.workspace, id: "other-workspace" } }] });
  expect(rowIds()).toHaveLength(6);
});

test("a collapsed selected group remains identifiable without opening its other rows", async () => {
  useSessionManagementStore.setState({ groupsByWorkspace: { workspace: {
    groups: [{ id: "group", label: "Research" }], assignments: Object.fromEntries(sessions.map((session) => [session.id, "group"])), collapsedGroupIds: ["group"],
  } } });
  await render({ selectedSessionId: "session-90" });
  expect(rowIds()).toEqual(["session-90"]);
  expect(container.querySelector("[data-sidebar-current-conversation]")?.textContent).toContain("Project / Research");
  expect(useSessionManagementStore.getState().groupsByWorkspace.workspace.collapsedGroupIds).toEqual(["group"]);
});

test("real activity distinguishes work, pending input and unseen completion without selection or focus changes", async () => {
  const store = useSessionActivityStore.getState();
  store.setRunStatus("workspace", "session-1", { type: "busy" });
  store.setWaitingRequest("workspace", "session-2", "permission", "approval", true);
  store.setRunStatus("workspace", "session-3", { type: "busy" });
  store.setRunStatus("workspace", "session-4", { type: "busy" });
  useWorkbenchStore.setState({ secondary: { workspaceId: "workspace", sessionId: "session-4" } });
  const statuses = () => useSessionActivityStore.getState().statusesByWorkspaceId.workspace;
  await render({ sessionStatusById: statuses(), visibleSecondarySessionId: "session-4" });
  const selected = container.querySelector<HTMLButtonElement>('[data-session-tab-id="session-0"]')!;
  await act(async () => selected.focus());
  store.setRunStatus("workspace", "session-3", { type: "idle" });
  store.setRunStatus("workspace", "session-4", { type: "idle" });
  await render({ sessionStatusById: statuses(), visibleSecondarySessionId: "session-4" });
  const label = (id: string) => container.querySelector(`[data-sidebar-session-id="${id}"] [data-session-attention-label]`)?.textContent;
  expect(label("session-1")).toBe("Working");
  expect(label("session-2")).toBe("Needs your input");
  expect(label("session-3")).toBe("Unread result");
  expect(label("session-4")).toBeUndefined();
  expect(useSessionManagementStore.getState().unreadIds).toEqual(["session-3"]);
  expect(document.activeElement).toBe(selected);
  expect(container.querySelector('[data-session-tab-active="true"]')).toBe(selected);
  expect(rowIds()).toHaveLength(6);
  await render({ selectedSessionId: "session-3", sessionStatusById: statuses() });
  expect(label("session-3")).toBeUndefined();
});

test("an auth transition with matching session IDs does not manufacture an unread completion", async () => {
  await render({ sessionStatusById: { "session-1": "responding" } });
  await render({ newTaskDraftScope: "owner-b", sessionStatusById: { "session-1": "idle" } });
  expect(useSessionManagementStore.getState().unreadIds).toEqual([]);
  expect(container.querySelector("[data-session-attention-label]")).toBeNull();
});

test("a retained secondary finishing while unmounted stays unread until its pane is rendered again", async () => {
  const activity = useSessionActivityStore.getState();
  const secondary = { workspaceId: "workspace", sessionId: "session-4" };
  useWorkbenchStore.setState({
    primary: { workspaceId: "workspace", sessionId: "session-0" },
    secondary,
    sideChats: { [JSON.stringify(["workspace", "session-0"])]: secondary },
  });
  activity.setRunStatus("workspace", "session-4", { type: "busy" });
  const busyStatuses = useSessionActivityStore.getState().statusesByWorkspaceId.workspace;
  await render({ sessionStatusById: busyStatuses, visibleSecondarySessionId: "session-4" });
  // Mobile main-pane selection or a main-content takeover unmounts the pane,
  // but deliberately keeps the workbench reference and task running.
  await render({ sessionStatusById: busyStatuses, visibleSecondarySessionId: null });
  activity.setRunStatus("workspace", "session-4", { type: "idle" });
  const idleStatuses = useSessionActivityStore.getState().statusesByWorkspaceId.workspace;
  await render({ sessionStatusById: idleStatuses, visibleSecondarySessionId: null });
  expect(useWorkbenchStore.getState().secondary?.sessionId).toBe("session-4");
  expect(useSessionManagementStore.getState().unreadIds).toEqual(["session-4"]);
  expect(container.querySelector('[data-session-side-chat="session-4"] [aria-label="Unread result"]')).not.toBeNull();
  // No new activity snapshot: visibility itself must retrigger read handling.
  await render({ sessionStatusById: idleStatuses, visibleSecondarySessionId: "session-4" });
  expect(useSessionManagementStore.getState().unreadIds).toEqual([]);
  expect(container.querySelector('[data-session-side-chat="session-4"] [aria-label="Unread result"]')).toBeNull();
  expect(container.querySelector('[data-session-tab-active="true"]')?.getAttribute("data-session-tab-id")).toBe("session-0");
});

test("a pinned archived selection belongs only to Archive and exposes the correct unpin action", async () => {
  useSessionManagementStore.setState({ pinnedIds: ["session-90"] });
  const workspaceSessionGroups = [{ ...props.workspaceSessionGroups[0]!, sessions: sessions.map((session) => session.id === "session-90"
    ? { ...session, time: { archived: 1 } } : session) }];
  await render({ workspaceSessionGroups, selectedSessionId: "session-90" });
  expect(container.querySelector("[data-sidebar-current-conversation]")).toBeNull();
  expect(rowIds()).not.toContain("session-90");
  const archive = container.querySelector<HTMLButtonElement>("[data-global-archived-sessions] button");
  expect(archive).not.toBeNull();
  await act(async () => archive!.click());
  const archivedRows = container.querySelectorAll('[data-sidebar-session-id="session-90"]');
  expect(archivedRows).toHaveLength(1);
  expect(archivedRows[0]?.closest("[data-global-archived-sessions]")).not.toBeNull();
  expect(archivedRows[0]?.querySelector('[aria-label="Pin session"]')).toBeNull();
  const unpin = archivedRows[0]?.querySelector<HTMLButtonElement>('[aria-label="Unpin session"]');
  expect(unpin).not.toBeNull();
  await act(async () => unpin!.click());
  expect(useSessionManagementStore.getState().pinnedIds).toEqual([]);
  expect(container.querySelectorAll('[data-sidebar-session-id="session-90"]')).toHaveLength(1);
  await render({ workspaceSessionGroups, selectedSessionId: "session-91" });
  expect(container.querySelector('[data-sidebar-current-conversation] [data-session-tab-id="session-91"]')).not.toBeNull();
  expect(listIds()).toEqual([...sessions.slice(0, 6).map((session) => session.id), "session-90"]);
});
