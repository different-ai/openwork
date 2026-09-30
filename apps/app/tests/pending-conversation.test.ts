import { beforeEach, expect, test } from "bun:test";
import type { Session } from "@opencode-ai/sdk/v2/client";
import type { ComposerSessionState } from "../src/react-app/domains/session/surface/composer-state-store";
import { acknowledgePendingSession, beginPendingConversation, bindPendingConversationWorkspace, createPendingConversation, ensurePendingConversationGroup, pendingConversationAutoSendPayload, pendingConversationForRoute, publishPendingSideChat, retryPendingConversation, usePendingConversationStore, withPendingSessionPublication } from "../src/react-app/domains/session/chat/pending-conversation-store";
import { useWorkbenchStore, workbenchSessionKey } from "../src/react-app/domains/session/chat/workbench-store";
import { composerAutoSendScopeKey, consumeComposerAutoSendPayload, markComposerAutoSend } from "../src/react-app/domains/session/surface/composer-auto-send";

const session: Session = { id: "ses_actual", slug: "actual", title: "Actual conversation", directory: "/workspace", projectID: "project", version: "1", time: { created: 1, updated: 1 } };
const submitted: ComposerSessionState = { draft: "Review the file", attachments: [{ id: "file", name: "report.txt", kind: "file", mimeType: "text/plain", size: 1, file: new File(["a"], "report.txt") }], mentions: {}, pasteParts: [], revertMessageId: null };
const destination = { workspaceId: "workspace", groupId: "research" };
beforeEach(() => usePendingConversationStore.setState({ conversations: {} }));

test("a send cannot consume a draft into an unverified account scope", () => {
  expect(() => beginPendingConversation({ scope: null, destination, submitted })).toThrow("account to finish loading");
  expect(usePendingConversationStore.getState().conversations).toEqual({});
});

test("remote handoff targets the receiving runtime owner, not the sidebar workspace ID", () => {
  const entry = beginPendingConversation({ scope: "local", destination: { workspaceId: "rem_workspace", groupId: "research" }, submitted });
  const endpoint = { workspaceId: "workspace", opencodeBaseUrl: "https://worker.invalid/workspace/workspace/opencode2" };
  const payload = pendingConversationAutoSendPayload(entry, endpoint, session.id);
  markComposerAutoSend(session.id, payload);
  const receivingScope = composerAutoSendScopeKey({ draftScope: "local", ...endpoint, sessionId: session.id });
  expect(consumeComposerAutoSendPayload(session.id, receivingScope)?.composer.attachments[0]?.file).toBe(submitted.attachments[0]?.file);
  expect(consumeComposerAutoSendPayload(session.id, receivingScope)).toBeNull();
  expect(entry.destination.workspaceId).toBe("rem_workspace");
});

test("pending to persisted publication always has exactly one sidebar representation, including a late route-list commit", async () => {
  const entry = beginPendingConversation({ scope: "local", destination, submitted });
  let lists: Record<string, Session[]> = {};
  const counts: number[] = [];
  const observe = () => {
    const state = usePendingConversationStore.getState().conversations;
    const pending = Object.values(state).filter((entry) => !entry.sessionId).length;
    const real = withPendingSessionPublication(lists, state, "local").workspace?.length ?? 0;
    counts.push(pending + real);
  };
  observe();
  const unsubscribe = usePendingConversationStore.subscribe(observe);
  const creation = Promise.withResolvers<{ session: Session }>();
  let creates = 0;
  let publishes = 0;
  try {
    const first = createPendingConversation(entry.id, () => { creates++; return creation.promise; }, () => { publishes++; });
    const duplicate = retryPendingConversation(entry.id);
    expect(usePendingConversationStore.getState().conversations[entry.id]?.sessionId).toBeUndefined();
    creation.resolve({ session });
    await Promise.all([first, duplicate]);
    expect(creates).toBe(1);
    expect(publishes).toBe(1);
    const persisted = usePendingConversationStore.getState().conversations[entry.id];
    expect(persisted?.phase).toBe("persisted");
    expect(persisted?.sessionId).toBe("ses_actual");
    expect(persisted?.groupAssigned).toBe(false);
    lists = { workspace: [session] };
    observe();
    acknowledgePendingSession("local", "workspace", session.id);
    expect(usePendingConversationStore.getState().conversations[entry.id]?.session).toBeUndefined();
    expect(counts.every((count) => count === 1)).toBe(true);
    expect(withPendingSessionPublication({}, usePendingConversationStore.getState().conversations, "another-account")).toEqual({});
  } finally { unsubscribe(); }
});

test("creation failure retains the submission and files; each retry action is single-flight and never fabricates a session", async () => {
  const entry = beginPendingConversation({ scope: "local", destination, submitted });
  const retry = Promise.withResolvers<{ session: Session }>();
  let creates = 0;
  let publications = 0;
  await createPendingConversation(entry.id, async () => {
    creates++;
    if (creates === 1) throw new Error("Engine unavailable");
    return retry.promise;
  }, () => { publications++; });
  const failed = usePendingConversationStore.getState().conversations[entry.id];
  expect(failed?.phase).toBe("creation-failed");
  expect(failed?.sessionId).toBeUndefined();
  expect(failed?.submitted.attachments[0]?.file).toBe(submitted.attachments[0]?.file);
  expect(failed?.submitted.draft).toBe(submitted.draft);
  expect(publications).toBe(0);
  const first = retryPendingConversation(entry.id);
  const duplicate = retryPendingConversation(entry.id);
  retry.resolve({ session });
  await Promise.all([first, duplicate]);
  expect(creates).toBe(2);
  expect(publications).toBe(1);
  await retryPendingConversation(entry.id);
  expect(creates).toBe(2);
});

test("real-session assignment failure and admission failure never recreate or duplicate the auto-send payload", async () => {
  const entry = beginPendingConversation({ scope: "local", destination, submitted });
  let creates = 0;
  await createPendingConversation(entry.id, async () => { creates++; return { session }; }, ({ session }) => {
    markComposerAutoSend(session.id, { scopeKey: "owner", composer: entry.submitted });
  });
  const payload = consumeComposerAutoSendPayload(session.id, "owner");
  expect(payload?.composer.attachments[0]?.file).toBe(submitted.attachments[0]?.file);
  expect(consumeComposerAutoSendPayload(session.id, "owner")).toBeNull();
  let assignments = 0;
  let fail = true;
  const assign = async (workspaceId: string, sessionId: string, groupId: string) => {
    expect(usePendingConversationStore.getState().conversations[entry.id]?.phase).toBe("persisted");
    expect([workspaceId, sessionId, groupId]).toEqual(["workspace", "ses_actual", "research"]);
    assignments++;
    if (fail) throw new Error("Group assignment failed");
  };
  await expect(ensurePendingConversationGroup("local", "workspace", session.id, assign)).rejects.toThrow("Group assignment failed");
  expect(usePendingConversationStore.getState().conversations[entry.id]?.destination.groupId).toBe("research");
  fail = false;
  await Promise.all([
    ensurePendingConversationGroup("local", "workspace", session.id, assign),
    ensurePendingConversationGroup("local", "workspace", session.id, assign),
  ]);
  expect(assignments).toBe(2);
  const admission = async () => { throw new Error("Admission failed"); };
  await expect(admission()).rejects.toThrow("Admission failed");
  await retryPendingConversation(entry.id);
  expect(creates).toBe(1);
  expect(consumeComposerAutoSendPayload(session.id, "owner")).toBeNull();
});

test("completion is only adopted by its own pending route, account and workspace", async () => {
  const entry = beginPendingConversation({ scope: "local", destination, submitted });
  await createPendingConversation(entry.id, async () => ({ session }), () => {});
  const conversations = usePendingConversationStore.getState().conversations;
  expect(pendingConversationForRoute(conversations, entry.id, "local", "workspace")?.sessionId).toBe(session.id);
  expect(pendingConversationForRoute(conversations, null, "local", "workspace")).toBeUndefined();
  expect(pendingConversationForRoute(conversations, entry.id, "local", "elsewhere")).toBeUndefined();
  expect(pendingConversationForRoute(conversations, entry.id, "other-account", "workspace")).toBeUndefined();
});

test("first-workspace preparation binds the same local conversation without inventing a session ID", () => {
  const entry = beginPendingConversation({ scope: "local", destination: { workspaceId: "" }, submitted });
  bindPendingConversationWorkspace(entry.id, "workspace");
  const state = usePendingConversationStore.getState().conversations;
  expect(state[entry.id]?.sessionId).toBeUndefined();
  expect(state[entry.id]?.destination.workspaceId).toBe("workspace");
  expect(pendingConversationForRoute(state, entry.id, "local", "", true)?.id).toBe(entry.id);
  expect(pendingConversationForRoute(state, entry.id, "other-account", "", true)).toBeUndefined();
  expect(() => bindPendingConversationWorkspace(entry.id, "different-workspace")).toThrow("destination changed");
});

test("pending side completion preserves focus and cannot reopen a side pane the person closed", () => {
  const parent = { workspaceId: "workspace", sessionId: "ses_parent" };
  const entry = beginPendingConversation({ scope: "local", destination: { ...destination, parent }, submitted });
  const side = { workspaceId: "workspace", sessionId: "__new-task__", pendingConversationId: entry.id };
  useWorkbenchStore.setState({ primary: parent, secondary: side, tabs: [parent, side], sideChats: { [workbenchSessionKey(parent)]: side }, focusedPane: "primary" });
  publishPendingSideChat(entry, session);
  expect(useWorkbenchStore.getState().secondary?.sessionId).toBe(session.id);
  expect(useWorkbenchStore.getState().focusedPane).toBe("primary");
  useWorkbenchStore.getState().setSplit(null);
  publishPendingSideChat(entry, session);
  expect(useWorkbenchStore.getState().secondary).toBeNull();
  expect(useWorkbenchStore.getState().focusedPane).toBe("primary");
});
