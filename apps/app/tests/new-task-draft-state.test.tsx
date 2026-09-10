/** @jsxImportSource react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";

beforeAll(() => {
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterAll(async () => {
  if (registeredDom) await GlobalRegistrator.unregister();
});

type Snapshot = { text: string } | null;
type Handle = {
  save: (text: string) => { status: string };
  snapshot: Snapshot;
  scopeKey: string;
};

async function mountNewTaskDraft(scope: string | null, workspaceId: string | null) {
  const {
    NEW_TASK_DRAFT_SESSION_ID,
    SESSION_DRAFT_STORAGE_KEY,
    sessionDraftScopeKey,
    useNewTaskDraftState,
  } = await import("../src/react-app/domains/session/sync/draft-store");
  const handle: { current: Handle | null } = { current: null };
  function Probe() {
    const state = useNewTaskDraftState(scope, workspaceId);
    handle.current = {
      save: (text) => state.save({ text, mode: "prompt" }),
      snapshot: state.snapshot,
      scopeKey: state.scopeKey,
    };
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => root.render(<Probe />));
  return {
    handle,
    expectedKey: sessionDraftScopeKey(scope, workspaceId ?? "", NEW_TASK_DRAFT_SESSION_ID),
    storageKey: SESSION_DRAFT_STORAGE_KEY,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function storedKeys(storageKey: string) {
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("drafts" in parsed) || typeof parsed.drafts !== "object" || parsed.drafts === null) return [];
  return Object.keys(parsed.drafts);
}

test("a workspace's new-task draft outlives its composer and stays scoped to that workspace and account", async () => {
  window.localStorage.clear();
  const draft = "Ask about the deploy checklist";

  const first = await mountNewTaskDraft("local", "ws_alpha");
  expect(first.handle.current?.snapshot).toBeNull();
  await act(async () => {
    expect(first.handle.current?.save(draft).status).toBe("saved");
  });
  expect(first.handle.current?.snapshot?.text).toBe(draft);
  expect(storedKeys(first.storageKey)).toEqual([first.expectedKey]);
  await first.unmount();

  // Navigating to another session unmounts the hero; a fresh mount reads the same text back.
  const again = await mountNewTaskDraft("local", "ws_alpha");
  expect(again.handle.current?.snapshot?.text).toBe(draft);

  // Another workspace, or another signed-in identity, must not see the draft.
  const otherWorkspace = await mountNewTaskDraft("local", "ws_beta");
  expect(otherWorkspace.handle.current?.snapshot).toBeNull();
  const otherAccount = await mountNewTaskDraft("cloud:usr_bob:org_ops", "ws_alpha");
  expect(otherAccount.handle.current?.snapshot).toBeNull();
  await otherWorkspace.unmount();
  await otherAccount.unmount();

  // Sending (or deleting the text) clears the slot so the sidebar row disappears.
  await act(async () => {
    expect(again.handle.current?.save("").status).toBe("saved");
  });
  expect(again.handle.current?.snapshot).toBeNull();
  expect(storedKeys(again.storageKey)).toEqual([]);
  await again.unmount();
});

test("without a workspace the new-task draft is not persisted anywhere", async () => {
  window.localStorage.clear();
  const chatFirst = await mountNewTaskDraft("local", null);
  expect(chatFirst.handle.current?.scopeKey).toBe("");
  expect(chatFirst.handle.current?.save("typed before any workspace exists").status).toBe("unavailable");
  expect(chatFirst.handle.current?.snapshot).toBeNull();
  expect(window.localStorage.getItem(chatFirst.storageKey)).toBeNull();
  await chatFirst.unmount();
});
