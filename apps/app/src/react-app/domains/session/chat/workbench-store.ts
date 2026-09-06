import type { OpenworkSessionRef } from "@openwork/types/openwork-context";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type WorkbenchPane = "primary" | "secondary";
export type WorkbenchSessionTab = OpenworkSessionRef & {
  workspaceTitle?: string;
};

export type WorkbenchSnapshot = {
  revision: number;
  primary: WorkbenchSessionTab | null;
  tabs: WorkbenchSessionTab[];
  secondary: WorkbenchSessionTab | null;
  focusedPane: WorkbenchPane;
  sideChats: Record<string, WorkbenchSessionTab>;
};

export type SyncWorkbenchInput = {
  workspaceId: string;
  workspaceTitle?: string;
  primarySessionId: string | null;
  sessions: OpenworkSessionRef[];
  sessionsKnown: boolean;
};

const initialWorkbenchSnapshot: WorkbenchSnapshot = {
  revision: 0,
  sideChats: {},
  primary: null,
  tabs: [],
  secondary: null,
  focusedPane: "primary",
};

export function isSameWorkbenchSession(
  left: Pick<OpenworkSessionRef, "workspaceId" | "sessionId"> | null | undefined,
  right: Pick<OpenworkSessionRef, "workspaceId" | "sessionId"> | null | undefined,
) {
  return Boolean(left && right && left.workspaceId === right.workspaceId && left.sessionId === right.sessionId);
}

export function workbenchSessionKey(session: Pick<OpenworkSessionRef, "workspaceId" | "sessionId">) {
  return JSON.stringify([session.workspaceId, session.sessionId]);
}

export function sideChatSystemContext(workspaceId: string, sessionId: string): string | undefined {
  const state = useWorkbenchStore.getState();
  const owner = Object.entries(state.sideChats).find(([, chat]) =>
    isSameWorkbenchSession(chat, { workspaceId, sessionId }));
  const main = owner ? state.tabs.find((tab) => workbenchSessionKey(tab) === owner[0]) : null;
  if (!main) return undefined;
  return [
    "This is a side chat associated with a main conversation in OpenWork.",
    `Main conversation reference: ${JSON.stringify({ workspaceId: main.workspaceId, sessionId: main.sessionId })}.`,
    "When relevant, use the main conversation as background for this side chat. Retrieve it through available session tools before referring to details; do not assume you have read it. Follow the user's request here and keep replies in this side chat.",
  ].join("\n");
}

function sameTab(left: WorkbenchSessionTab | null, right: WorkbenchSessionTab | null) {
  if (!left || !right) return left === right;
  return isSameWorkbenchSession(left, right)
    && left.title === right.title
    && left.workspaceTitle === right.workspaceTitle;
}

function sameTabs(left: WorkbenchSessionTab[], right: WorkbenchSessionTab[]) {
  return left.length === right.length && left.every((tab, index) => sameTab(tab, right[index] ?? null));
}

function withRevision(current: WorkbenchSnapshot, next: Omit<WorkbenchSnapshot, "revision">): WorkbenchSnapshot {
  if (
    current.sideChats === next.sideChats
    && sameTab(current.primary, next.primary)
    && sameTab(current.secondary, next.secondary)
    && current.focusedPane === next.focusedPane
    && sameTabs(current.tabs, next.tabs)
  ) {
    return current;
  }
  return { ...next, revision: current.revision + 1 };
}

function findTab(tabs: WorkbenchSessionTab[], session: Pick<OpenworkSessionRef, "workspaceId" | "sessionId">) {
  return tabs.find((tab) => isSameWorkbenchSession(tab, session));
}

function replaceOrAppendTab(tabs: WorkbenchSessionTab[], tab: WorkbenchSessionTab) {
  const index = tabs.findIndex((entry) => isSameWorkbenchSession(entry, tab));
  if (index === -1) return [...tabs, tab];
  return tabs.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...tab } : entry);
}

export function syncWorkbenchSnapshot(
  current: WorkbenchSnapshot,
  input: SyncWorkbenchInput,
): WorkbenchSnapshot {
  const workspaceTitle = input.workspaceTitle?.trim() || input.workspaceId;
  const available = input.sessions.map((session) => ({ ...session, workspaceTitle }));
  let tabs = current.tabs
    .filter((tab) => (
      tab.workspaceId !== input.workspaceId
      || !input.sessionsKnown
      || available.some((session) => isSameWorkbenchSession(session, tab))
      || tab.sessionId === input.primarySessionId
    ))
    .map((tab) => {
      const fresh = available.find((session) => isSameWorkbenchSession(session, tab));
      return fresh ? { ...tab, ...fresh } : tab;
    });

  let primary: WorkbenchSessionTab | null = null;
  if (input.primarySessionId) {
    const ref = { workspaceId: input.workspaceId, sessionId: input.primarySessionId };
    primary = findTab(available, ref) ?? findTab(tabs, ref) ?? { ...ref, workspaceTitle };
    tabs = replaceOrAppendTab(tabs, primary);
  }

  const retained = Object.entries(current.sideChats).filter(([owner, chat]) =>
    tabs.some((tab) => workbenchSessionKey(tab) === owner) && Boolean(findTab(tabs, chat)));
  const sideChats = retained.length === Object.keys(current.sideChats).length
    ? current.sideChats : Object.fromEntries(retained);
  const saved = primary ? sideChats[workbenchSessionKey(primary)] : null;
  const secondary = saved ? findTab(tabs, saved) ?? null : null;

  return withRevision(current, {
    sideChats,
    primary,
    tabs,
    secondary,
    focusedPane: secondary && isSameWorkbenchSession(primary, current.primary) ? current.focusedPane : "primary",
  });
}

export function openWorkbenchTab(
  current: WorkbenchSnapshot,
  tab: WorkbenchSessionTab,
): WorkbenchSnapshot {
  return withRevision(current, {
    sideChats: current.sideChats,
    primary: current.primary,
    tabs: replaceOrAppendTab(current.tabs, tab),
    secondary: current.secondary,
    focusedPane: current.focusedPane,
  });
}

export function closeWorkbenchTab(
  current: WorkbenchSnapshot,
  tab: Pick<OpenworkSessionRef, "workspaceId" | "sessionId">,
): WorkbenchSnapshot {
  const tabs = current.tabs.filter((entry) => !isSameWorkbenchSession(entry, tab));
  const closesPrimary = isSameWorkbenchSession(current.primary, tab);
  const closesSecondary = isSameWorkbenchSession(current.secondary, tab);
  const primary = closesPrimary ? current.secondary : current.primary;
  const secondary = closesPrimary || closesSecondary ? null : current.secondary;
  return withRevision(current, {
    sideChats: Object.fromEntries(Object.entries(current.sideChats).filter(([owner, chat]) =>
      owner !== workbenchSessionKey(tab) && !isSameWorkbenchSession(chat, tab))),
    primary,
    tabs,
    secondary,
    focusedPane: closesPrimary || closesSecondary ? "primary" : current.focusedPane,
  });
}

export function setWorkbenchSplit(
  current: WorkbenchSnapshot,
  session: Pick<OpenworkSessionRef, "workspaceId" | "sessionId"> | null,
): WorkbenchSnapshot {
  if (!current.primary) return current;
  return setWorkbenchSideChat(current, current.primary, session);
}

export function setWorkbenchSideChat(
  current: WorkbenchSnapshot,
  owner: Pick<OpenworkSessionRef, "workspaceId" | "sessionId">,
  session: Pick<OpenworkSessionRef, "workspaceId" | "sessionId"> | null,
): WorkbenchSnapshot {
  if (!findTab(current.tabs, owner)) return current;
  const chat = session && !isSameWorkbenchSession(session, owner)
    ? findTab(current.tabs, session) ?? null : null;
  const sideChats = { ...current.sideChats };
  delete sideChats[workbenchSessionKey(owner)];
  if (chat) {
    for (const [key, existing] of Object.entries(sideChats)) {
      if (isSameWorkbenchSession(existing, chat)) delete sideChats[key];
    }
    sideChats[workbenchSessionKey(owner)] = chat;
  }
  const ownsVisibleSession = isSameWorkbenchSession(current.primary, owner);
  const secondary = current.primary
    ? sideChats[workbenchSessionKey(current.primary)] ?? null : null;
  return withRevision(current, {
    sideChats,
    primary: current.primary,
    tabs: current.tabs,
    secondary,
    focusedPane: ownsVisibleSession && secondary ? "secondary" : secondary ? current.focusedPane : "primary",
  });
}

export function focusWorkbenchPane(
  current: WorkbenchSnapshot,
  pane: WorkbenchPane,
): WorkbenchSnapshot {
  const focusedPane = pane === "secondary" && !current.secondary ? "primary" : pane;
  return withRevision(current, {
    sideChats: current.sideChats,
    primary: current.primary,
    tabs: current.tabs,
    secondary: current.secondary,
    focusedPane,
  });
}

type WorkbenchStore = WorkbenchSnapshot & {
  sync: (input: SyncWorkbenchInput) => void;
  openTab: (tab: WorkbenchSessionTab) => void;
  closeTab: (tab: Pick<OpenworkSessionRef, "workspaceId" | "sessionId">) => void;
  setSplit: (session: Pick<OpenworkSessionRef, "workspaceId" | "sessionId"> | null) => void;
  setSideChat: (owner: WorkbenchSessionTab, session: WorkbenchSessionTab) => void;
  focusPane: (pane: WorkbenchPane) => void;
};

export const useWorkbenchStore = create<WorkbenchStore>()(persist((set) => ({
  ...initialWorkbenchSnapshot,
  sync: (input) => set((state) => syncWorkbenchSnapshot(state, input)),
  openTab: (tab) => set((state) => openWorkbenchTab(state, tab)),
  closeTab: (tab) => set((state) => closeWorkbenchTab(state, tab)),
  setSplit: (session) => set((state) => setWorkbenchSplit(state, session)),
  setSideChat: (owner, session) => set((state) => setWorkbenchSideChat(state, owner, session)),
  focusPane: (pane) => set((state) => focusWorkbenchPane(state, pane)),
}), {
  name: "openwork.session-splits.v1",
  partialize: (state) => ({ tabs: state.tabs, sideChats: state.sideChats }),
}));
