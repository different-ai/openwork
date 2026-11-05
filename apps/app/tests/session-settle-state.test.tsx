/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { useSessionManagementStore } from "../src/react-app/domains/session/sidebar/session-management-store";
import { useSessionSettleState, type SessionSettleState } from "../src/react-app/domains/session/sidebar/session-settle";

let createRoot: typeof import("react-dom/client")["createRoot"];
let root: Root | undefined;
let state: SessionSettleState;
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
const activityAt = Date.now() - 10 * 24 * 60 * 60 * 1000;
const session = { id: "chat", time: { created: activityAt, updated: activityAt } };

beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  createRoot = (await import("react-dom/client")).createRoot;
});
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
beforeEach(() => {
  useSessionManagementStore.setState({
    sidebarView: "workspaces", groupsByWorkspace: {}, pinnedIds: [], unreadIds: [],
    settledById: { chat: { settledThrough: activityAt } }, autoSettleDays: 3,
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function Subject() {
  state = useSessionSettleState("workspace", session, "idle", "Chat", true);
  return null;
}

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Subject />));
}

const expectDisabled = () => {
  expect(state.enabled).toBe(false);
  expect(state.settled).toBe(false);
  expect(state.canSettle).toBe(false);
};

test("Workspaces ignore existing settles and the shared shortcut cannot change them", async () => {
  await mount();
  expectDisabled();
  const before = useSessionManagementStore.getState().settledById;
  await act(async () => state.toggle());
  expect(useSessionManagementStore.getState().settledById).toBe(before);

  await act(async () => useSessionManagementStore.getState().setSidebarView("feed"));
  expect(state.enabled).toBe(true);
  expect(state.settled).toBe(true);
  await act(async () => useSessionManagementStore.getState().setSidebarView("workspaces"));
  expectDisabled();
});

test("grouping a Feed chat disables settling immediately, including old manual settles", async () => {
  useSessionManagementStore.setState({ sidebarView: "feed" });
  await mount();
  expect(state.settled).toBe(true);
  await act(async () => useSessionManagementStore.setState({ groupsByWorkspace: {
    workspace: { groups: [{ id: "project", label: "Project" }], assignments: { chat: "project" } },
  } }));
  expectDisabled();
  const before = useSessionManagementStore.getState().settledById;
  await act(async () => state.toggle());
  expect(useSessionManagementStore.getState().settledById).toBe(before);
});

test("ungrouped Feed chats retain auto-settle and manual settle actions", async () => {
  useSessionManagementStore.setState({ sidebarView: "feed", settledById: {} });
  await mount();
  expect(state.enabled).toBe(true);
  expect(state.settled).toBe(true);
  await act(async () => state.toggle());
  expect(state.settled).toBe(false);
  expect(state.canSettle).toBe(true);
  await act(async () => state.toggle());
  expect(state.settled).toBe(true);
});
