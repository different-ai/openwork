import { beforeEach, expect, test } from "bun:test";
import { draftWorkspaceChangeBlocked, newSessionDraftOwnerKey, newSessionDraftSlot, openNewSessionDraft } from "../src/react-app/domains/session/chat/new-session-destination";
import type { ComposerSessionState } from "../src/react-app/domains/session/surface/composer-state-store";
import { assignNewSessionGroup, setSessionGroupSyncHandler, useSessionManagementStore } from "../src/react-app/domains/session/sidebar/session-management-store";
import { createDraftFirstSend } from "../src/react-app/domains/session/chat/draft-first-send";
import { useWorkbenchStore, workbenchSessionKey } from "../src/react-app/domains/session/chat/workbench-store";
import { workspaceSessionRoute } from "../src/react-app/shell/workspace-routes";

const parent = { workspaceId: "workspace-a", sessionId: "ses_parent", title: "Main" };
const other = { workspaceId: "workspace-b", sessionId: "ses_other" };

beforeEach(() => {
  useWorkbenchStore.setState({ primary: parent, secondary: other, tabs: [parent, other], focusedPane: "secondary", sideChats: {} });
});

test("workspace changes reject attachments and live workspace-file references; group changes retain them", () => {
  const state: ComposerSessionState = { draft: "Check this", attachments: [], mentions: {}, pasteParts: [], revertMessageId: null };
  expect(draftWorkspaceChangeBlocked("a", "b", state)).toBe(false);
  state.attachments = [{ id: "file", name: "local.txt", mimeType: "text/plain", size: 1, kind: "file", file: new File(["a"], "local.txt") }];
  expect(draftWorkspaceChangeBlocked("a", "b", state)).toBe(true);
  expect(draftWorkspaceChangeBlocked("a", "a", state)).toBe(false);
  state.attachments = [];
  state.mentions = { "local file.txt": "file" };
  state.draft = "Check @local%20file.txt";
  expect(draftWorkspaceChangeBlocked("a", "b", state)).toBe(true);
  state.draft = "File mention removed";
  expect(draftWorkspaceChangeBlocked("a", "b", state)).toBe(false);
  state.draft = "Check file:///workspace/report.txt";
  expect(draftWorkspaceChangeBlocked("a", "b", state)).toBe(true);
});

test("first-send assignment waits for the server and exposes failure to the retry guard", async () => {
  const groups = [{ id: "group-one", label: "One" }];
  useSessionManagementStore.setState({ groupsByWorkspace: { "workspace-a": { groups, assignments: {} } } });
  let fail = true;
  setSessionGroupSyncHandler({
    createGroup: async () => null, reorderGroups: async () => null, renameGroup: async () => null, removeGroup: async () => null,
    assignGroup: async (workspaceId, sessionId, groupId) => {
      expect(workspaceId).toBe("workspace-a");
      expect(groupId).toBe("group-one");
      if (fail) throw new Error("Assignment failed");
      return { groups, assignments: { [sessionId]: "group-one" } };
    },
  });
  try {
    await expect(assignNewSessionGroup("workspace-a", "ses_created", "group-one")).rejects.toThrow("Assignment failed");
    expect(useSessionManagementStore.getState().groupsByWorkspace["workspace-a"]?.assignments).toEqual({});
    fail = false;
    await assignNewSessionGroup("workspace-a", "ses_created", "group-one");
    expect(useSessionManagementStore.getState().groupsByWorkspace["workspace-a"]?.assignments).toEqual({ ses_created: "group-one" });
  } finally { setSessionGroupSyncHandler(null); }
});

test("generic, workspace and Settings New session are ungrouped primary drafts even with a focused split", () => {
  for (const workspaceId of [parent.workspaceId, other.workspaceId]) {
    const paths: string[] = [];
    openNewSessionDraft({ workspaceId }, (path) => paths.push(path));
    expect(paths).toEqual([workspaceSessionRoute(workspaceId)]);
    expect(useWorkbenchStore.getState().focusedPane).toBe("primary");
    expect(useWorkbenchStore.getState().tabs).toEqual([parent, other]);
  }
});

test("group New session captures its workspace/group without a persisted session", () => {
  const paths: string[] = [];
  openNewSessionDraft({ workspaceId: other.workspaceId, groupId: "group / one" }, (path) => paths.push(path));
  expect(paths).toEqual([`${workspaceSessionRoute(other.workspaceId)}?draftGroup=group%20%2F%20one`]);
  expect(useWorkbenchStore.getState().tabs).toEqual([parent, other]);
});

test("side drafts retain their primary parent and group, and repeated Open side chat reopens the same draft", () => {
  const destination = { workspaceId: parent.workspaceId, groupId: "group-one", parent };
  const navigate = () => { throw new Error("Side chat must not navigate the primary"); };
  openNewSessionDraft(destination, navigate);
  const first = useWorkbenchStore.getState().secondary;
  expect(first?.draftDestination).toEqual(destination);
  expect(first?.workspaceId).toBe(parent.workspaceId);
  expect(first?.sessionId).toBe(newSessionDraftSlot(destination));
  openNewSessionDraft(destination, navigate);
  expect(useWorkbenchStore.getState().secondary).toEqual(first);
  expect(useWorkbenchStore.getState().primary).toEqual(parent);
  expect(useWorkbenchStore.getState().tabs).toHaveLength(3);
});

test("existing side chats reopen without being replaced by drafts", () => {
  useWorkbenchStore.setState({ sideChats: { [workbenchSessionKey(parent)]: other } });
  openNewSessionDraft({ workspaceId: parent.workspaceId, parent }, () => { throw new Error("navigation"); });
  expect(useWorkbenchStore.getState().secondary).toEqual(other);
  expect(useWorkbenchStore.getState().tabs).toHaveLength(2);
});

test("draft identity isolates account, workspace, group and side parent", () => {
  const destinations = [
    { workspaceId: parent.workspaceId },
    { workspaceId: other.workspaceId },
    { workspaceId: parent.workspaceId, groupId: "one" },
    { workspaceId: parent.workspaceId, groupId: "two" },
    { workspaceId: parent.workspaceId, groupId: "one", parent },
    { workspaceId: parent.workspaceId, groupId: "one", parent: { ...parent, sessionId: "ses_second" } },
  ];
  const keys = destinations.flatMap((destination) => ["local", "cloud:other"].map((scope) => newSessionDraftOwnerKey(scope, destination)));
  expect(new Set(keys).size).toBe(keys.length);
  expect(newSessionDraftOwnerKey("local", destinations[2]!)).toBe(newSessionDraftOwnerKey("local", destinations[2]!));
});

test("first send creates once, assigns then sends, and deduplicates concurrent submits", async () => {
  const coordinator = createDraftFirstSend<{ id: string }>();
  const created = Promise.withResolvers<{ id: string }>();
  const calls: string[] = [];
  const create = () => { calls.push("create"); return created.promise; };
  const send = async (session: { id: string }) => { calls.push(`assign:${session.id}`, `send:${session.id}`); };
  const first = coordinator.run("destination", create, send);
  const duplicate = coordinator.run("destination", create, send);
  expect(duplicate).toBe(first);
  created.resolve({ id: "ses_created" });
  await first;
  expect(calls).toEqual(["create", "assign:ses_created", "send:ses_created"]);
});

for (const failure of ["assign", "send"]) {
  test(`a failed ${failure} retries the created session, not session.create`, async () => {
    const coordinator = createDraftFirstSend<{ id: string }>();
    let creates = 0;
    const create = async () => { creates++; return { id: "ses_created" }; };
    await expect(coordinator.run("destination", create, async () => { throw new Error(failure); })).rejects.toThrow(failure);
    expect(coordinator.hasCreated("destination")).toBe(true);
    const sessions: string[] = [];
    await coordinator.run("destination", create, async (session) => { sessions.push(session.id); });
    expect(creates).toBe(1);
    expect(sessions).toEqual(["ses_created"]);
  });
}
