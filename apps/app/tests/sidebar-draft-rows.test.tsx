/** @jsxImportSource react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SidebarContextValue } from "../src/react-app/domains/session/sidebar/app-sidebar-provider";

const registeredDom = typeof globalThis.document === "undefined";
beforeAll(() => {
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});
afterAll(async () => { if (registeredDom) await GlobalRegistrator.unregister(); });

const workspaceId = "workspace-drafts";
const longTitle = "Review the upcoming release and prepare a detailed summary of the remaining work ".repeat(4);

async function mount(grouped: boolean, draftsOnly = false, sideChat?: "absent" | "existing") {
  const { MemoryRouter } = await import("react-router");
  const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
  const { SidebarMenuSub } = await import("../src/components/ui/sidebar");
  const { SidebarContext } = await import("../src/react-app/domains/session/sidebar/app-sidebar-provider");
  const { SidebarReorderScope, GroupedSessionList, SessionMenuItem, NewSessionDraftRow } = await import("../src/react-app/domains/session/sidebar/app-sidebar");
  const { useSessionManagementStore } = await import("../src/react-app/domains/session/sidebar/session-management-store");
  const { saveSessionDraft } = await import("../src/react-app/domains/session/sync/draft-store");
  const { newSessionDraftSlot } = await import("../src/react-app/domains/session/chat/new-session-destination");
  const { useWorkbenchStore, workbenchSessionKey } = await import("../src/react-app/domains/session/chat/workbench-store");
  const { usePendingConversationStore, withPendingGroupAssignments, withPendingSessionPublication } = await import("../src/react-app/domains/session/chat/pending-conversation-store");
  const calls: { workspaceId: string; groupId?: string }[] = [];
  const sideChatCreations: string[] = [];
  const primary = { workspaceId, sessionId: "ses_normal", title: "Normal session" };
  const secondary = { workspaceId, sessionId: "ses_side", title: "Existing side chat" };
  useWorkbenchStore.setState({
    primary: sideChat ? primary : null,
    secondary: sideChat === "existing" ? secondary : null,
    tabs: sideChat === "existing" ? [primary, secondary] : sideChat ? [primary] : [],
    sideChats: sideChat === "existing" ? { [workbenchSessionKey(primary)]: secondary } : {},
    focusedPane: "primary",
  });
  const noop = () => {};
  const ctx: SidebarContextValue = {
    draftScope: "local", selectedWorkspaceId: workspaceId, selectedSessionId: sideChat ? primary.sessionId : null,
    developerMode: false, newTaskDisabled: false, connectingWorkspaceId: null, workspaceConnectionStateById: {},
    onSelectWorkspace: noop, onOpenSession: noop,
    onCreateTaskInWorkspace: (workspaceId, groupId) => calls.push({ workspaceId, groupId }),
    onCreateSplitTaskInWorkspace: (workspaceId) => sideChatCreations.push(workspaceId), onOpenRenameWorkspace: noop, onShareWorkspace: noop, onRevealWorkspace: noop,
    onRecoverWorkspace: noop, onTestWorkspaceConnection: noop, onEditWorkspaceConnection: noop, onForgetWorkspace: noop,
    expandWorkspace: noop, toggleWorkspaceExpanded: noop, expandedWorkspaceIds: new Set([workspaceId]),
    sessionNumberShortcutOs: "macos", sessionNumberShortcutByTarget: new Map(),
  };
  const groups = grouped ? [{ id: "research", label: "Research" }] : [];
  useSessionManagementStore.setState({ groupsByWorkspace: { [workspaceId]: { groups, assignments: { ses_group: "research" } } } });
  for (const groupId of [undefined, "research"]) {
    saveSessionDraft("local", workspaceId, newSessionDraftSlot({ workspaceId, groupId }), { text: longTitle, mode: "prompt" });
  }
  const sessions = [
    { id: "ses_normal", slug: "normal", directory: "/workspace", projectID: "project", version: "1", title: "Normal session", time: { created: 1, updated: 1 } },
    { id: "ses_group", slug: "group", directory: "/workspace", projectID: "project", version: "1", title: "Grouped session", time: { created: 1, updated: 1 } },
  ];
  function Rows() {
    const state = useSessionManagementStore((state) => state.groupsByWorkspace[workspaceId]);
    const pending = usePendingConversationStore((state) => state.conversations);
    const visible = withPendingSessionPublication({ [workspaceId]: draftsOnly ? [] : sessions }, pending, "local")[workspaceId] ?? [];
    return <SidebarMenuSub>
      {grouped ? <GroupedSessionList
        workspaceId={workspaceId} groups={groups} assignments={withPendingGroupAssignments(state?.assignments ?? {}, pending, "local", workspaceId)}
        sessionRows={visible.map((session) => ({ session }))}
        pinnedIds={new Set()} store={useSessionManagementStore}
      /> : <>
        <NewSessionDraftRow workspaceId={workspaceId} />
        <SessionMenuItem workspaceId={workspaceId} session={sessions[0]!} />
      </>}
    </SidebarMenuSub>;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/workspace/${workspaceId}/session${grouped ? "?draftGroup=research" : ""}`]}>
      <PlatformProvider value={createDefaultPlatform()}>
        <SidebarContext.Provider value={ctx}><SidebarReorderScope><Rows /></SidebarReorderScope></SidebarContext.Provider>
      </PlatformProvider>
    </MemoryRouter>,
  ));
  return { container, calls, sideChatCreations, workbench: useWorkbenchStore, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

function element(root: ParentNode, selector: string): HTMLElement {
  const result = root.querySelector<HTMLElement>(selector);
  if (!result) throw new Error(`Missing ${selector}`);
  return result;
}

function assertSameRowLayout(normalRow: HTMLElement, draftRow: HTMLElement) {
  const normal = element(normalRow, '[data-slot="sidebar-menu-sub-button"]');
  const draft = element(draftRow, '[data-slot="sidebar-menu-sub-button"]');
  expect(draftRow.className).toBe(normalRow.className);
  expect(draft.parentElement?.className).toBe(normal.parentElement?.className);
  expect(draft.style.paddingInlineStart).toBe(normal.style.paddingInlineStart);
  for (const token of ["h-8", "rounded-md", "pe-2.5", "w-full", "text-start", "focus-visible:ring-2", "group-hover/menu-sub-item:bg-black/[0.05]"]) {
    expect(normal.classList.contains(token)).toBe(true);
    expect(draft.classList.contains(token)).toBe(true);
  }
  expect(draft.firstElementChild?.className).toBe(normal.firstElementChild?.className);
  const normalTitle = element(normal, "[data-session-title-slot]");
  const draftTitle = element(draft, "[data-session-title-slot]");
  expect(draftTitle.className).toBe(normalTitle.className);
  for (const token of ["min-w-0", "flex-1", "overflow-hidden", "whitespace-nowrap"]) expect(draftTitle.classList.contains(token)).toBe(true);
  expect(draft.lastElementChild?.textContent).toBe("Draft");
  expect(draft.lastElementChild?.classList.contains("shrink-0")).toBe(true);
  const normalMetadata = element(normalRow, "[data-session-hover-actions] span");
  for (const token of normalMetadata.classList) expect(draft.lastElementChild?.classList.contains(token)).toBe(true);
  expect(draftRow.querySelector('[aria-label="Discard draft"]')).toBeNull();
}

test("ungrouped draft shares session row lanes, title clipping, metadata and resume behavior", async () => {
  const ui = await mount(false);
  try {
    const normal = element(ui.container, '[data-sidebar-session-id="ses_normal"]');
    const draft = element(ui.container, '[data-sidebar-draft-group-id=""]');
    expect(draft.parentElement).toBe(normal.parentElement);
    expect(draft.parentElement?.firstElementChild).toBe(draft);
    assertSameRowLayout(normal, draft);
    const button = element(draft, "button");
    expect(button.hasAttribute("data-active")).toBe(true);
    await act(async () => { button.focus(); button.click(); });
    expect(document.activeElement).toBe(button);
    expect(ui.calls).toEqual([{ workspaceId, groupId: undefined }]);
  } finally { await ui.unmount(); }
});

test("grouped and ungrouped drafts live inside their own session lists and collapse with the group", async () => {
  const ui = await mount(true);
  try {
    const normal = element(ui.container, '[data-sidebar-session-id="ses_group"]');
    const draft = element(ui.container, '[data-sidebar-draft-group-id="research"]');
    const ungrouped = element(ui.container, '[data-sidebar-draft-group-id=""]');
    expect(draft.parentElement?.firstElementChild).toBe(draft);
    expect(ungrouped.parentElement?.firstElementChild).toBe(ungrouped);
    expect(draft.parentElement).toBe(normal.parentElement);
    // Persisted ungrouped rows additionally own a drag wrapper; both rows
    // must remain in the same collapsible list, not beside its group header.
    expect(ungrouped.closest('[data-slot="collapsible-content"]')).toBe(element(ui.container, '[data-sidebar-session-id="ses_normal"]').closest('[data-slot="collapsible-content"]'));
    expect(draft.parentElement).not.toBe(ungrouped.parentElement);
    assertSameRowLayout(normal, draft);
    expect(element(draft, "button").hasAttribute("data-active")).toBe(true);
    expect(element(ungrouped, "button").hasAttribute("data-active")).toBe(false);
    await act(async () => element(draft, "button").click());
    expect(ui.calls).toEqual([{ workspaceId, groupId: "research" }]);
    await act(async () => element(ui.container, '[data-session-group="research"]').click());
    expect(ui.container.querySelector('[data-sidebar-draft-group-id="research"]')).toBeNull();
    expect(ui.container.querySelector('[data-sidebar-draft-group-id=""]')).not.toBeNull();
  } finally { await ui.unmount(); }
});

test("draft-only groups retain their hierarchy without an empty-group placeholder", async () => {
  const ui = await mount(true, true);
  try {
    const draft = element(ui.container, '[data-sidebar-draft-group-id="research"]');
    expect(draft.closest('[data-slot="collapsible-content"]')).not.toBeNull();
    expect(draft.parentElement?.querySelector('[aria-disabled="true"]')).toBeNull();
    expect(ui.container.querySelectorAll("[data-sidebar-draft-workspace-id]")).toHaveLength(2);
  } finally { await ui.unmount(); }
});

test("selected session without a side chat has no sidebar creation button or context-menu action", async () => {
  const ui = await mount(false, false, "absent");
  try {
    const row = element(ui.container, '[data-sidebar-session-id="ses_normal"]');
    expect(row.querySelector("[data-session-side-chat]")).toBeNull();
    const trigger = element(row, '[data-slot="context-menu-trigger"]');
    await act(async () => trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    const menu = element(document, '[role="menu"]');
    expect(menu.querySelector('[role="menuitem"]')).not.toBeNull();
    expect(menu.querySelector("[data-session-menu-new-split]")).toBeNull();
    expect(menu.textContent).not.toContain("Open side chat");
    expect(ui.sideChatCreations).toEqual([]);
  } finally { await ui.unmount(); }
});

test("existing side chat remains a reopen control and never creates another chat", async () => {
  const ui = await mount(false, false, "existing");
  try {
    const reopen = element(ui.container, '[data-session-side-chat="ses_side"]');
    expect(ui.container.querySelector('[data-session-side-chat="new"]')).toBeNull();
    expect(reopen.title).toBe("Existing side chat");
    await act(async () => reopen.click());
    expect(ui.workbench.getState().focusedPane).toBe("secondary");
    expect(ui.workbench.getState().secondary?.sessionId).toBe("ses_side");
    expect(ui.workbench.getState().tabs).toHaveLength(2);
    expect(ui.sideChatCreations).toEqual([]);
  } finally { await ui.unmount(); }
});

test("pending creation, failure, retry and real publication keep one row in the intended group", async () => {
  const { beginPendingConversation, createPendingConversation, retryPendingConversation, ensurePendingConversationGroup, usePendingConversationStore } = await import("../src/react-app/domains/session/chat/pending-conversation-store");
  const { clearSessionDraft } = await import("../src/react-app/domains/session/sync/draft-store");
  const { newSessionDraftSlot } = await import("../src/react-app/domains/session/chat/new-session-destination");
  const ui = await mount(true);
  try {
    const destination = { workspaceId, groupId: "research" };
    let id = "";
    await act(async () => {
      const pending = beginPendingConversation({ scope: "local", destination, submitted: { draft: "First message", attachments: [], mentions: {}, pasteParts: [], revertMessageId: null } });
      id = pending.id;
      clearSessionDraft("local", workspaceId, newSessionDraftSlot(destination));
    });
    expect(ui.container.querySelectorAll('[data-sidebar-draft-group-id="research"]')).toHaveLength(1);
    const row = element(ui.container, `[data-sidebar-pending-conversation="${id}"]`);
    expect(row.textContent).toBe("First message");
    expect(row.dataset.sidebarDraftWorkspaceId).toBe(workspaceId);
    expect(row.parentElement).toBe(element(ui.container, '[data-sidebar-session-id="ses_group"]').parentElement);
    let tries = 0;
    const session = { id: "ses_handoff", slug: "handoff", directory: "/workspace", projectID: "project", version: "1", title: "First message", time: { created: 2, updated: 2 } };
    await act(async () => createPendingConversation(id, async () => {
      tries++;
      if (tries === 1) throw new Error("Creation failed");
      return { session };
    }, () => {}));
    expect(element(ui.container, `[data-sidebar-pending-conversation="${id}"]`)).toBe(row);
    expect(row.textContent).toBe("First messageNot sent");
    await act(async () => retryPendingConversation(id));
    expect(ui.container.querySelectorAll('[data-sidebar-session-id="ses_handoff"]')).toHaveLength(1);
    expect(ui.container.querySelector('[data-sidebar-draft-group-id="research"]')).toBeNull();
    const created = element(ui.container, '[data-sidebar-session-id="ses_handoff"]');
    expect(created.parentElement).toBe(element(ui.container, '[data-sidebar-session-id="ses_group"]').parentElement);
    await act(async () => { await ensurePendingConversationGroup("local", workspaceId, session.id, async () => { throw new Error("Assignment failed"); }).catch(() => {}); });
    expect(element(ui.container, '[data-sidebar-session-id="ses_handoff"]').parentElement).toBe(element(ui.container, '[data-sidebar-session-id="ses_group"]').parentElement);
    expect(ui.container.querySelector('[data-sidebar-draft-group-id="research"]')).toBeNull();
    expect(ui.container.querySelector('[data-sidebar-draft-group-id=""]')).not.toBeNull();
    expect(tries).toBe(2);
  } finally {
    await ui.unmount();
    usePendingConversationStore.setState({ conversations: {} });
  }
});
