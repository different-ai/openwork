import type { OpenworkSessionRef } from "@openwork/types/openwork-context";
import { create } from "zustand";

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
    sameTab(current.primary, next.primary)
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

  const secondary = current.secondary
    && !isSameWorkbenchSession(current.secondary, primary)
    ? findTab(tabs, current.secondary) ?? null
    : null;

  return withRevision(current, {
    primary,
    tabs,
    secondary,
    focusedPane: secondary ? current.focusedPane : "primary",
  });
}

export function openWorkbenchTab(
  current: WorkbenchSnapshot,
  tab: WorkbenchSessionTab,
): WorkbenchSnapshot {
  return withRevision(current, {
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
  const secondary = session && !isSameWorkbenchSession(session, current.primary)
    ? findTab(current.tabs, session) ?? null
    : null;
  return withRevision(current, {
    primary: current.primary,
    tabs: current.tabs,
    secondary,
    focusedPane: secondary ? "secondary" : "primary",
  });
}

export function focusWorkbenchPane(
  current: WorkbenchSnapshot,
  pane: WorkbenchPane,
): WorkbenchSnapshot {
  const focusedPane = pane === "secondary" && !current.secondary ? "primary" : pane;
  return withRevision(current, {
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
  focusPane: (pane: WorkbenchPane) => void;
};

export const useWorkbenchStore = create<WorkbenchStore>((set) => ({
  ...initialWorkbenchSnapshot,
  sync: (input) => set((state) => syncWorkbenchSnapshot(state, input)),
  openTab: (tab) => set((state) => openWorkbenchTab(state, tab)),
  closeTab: (tab) => set((state) => closeWorkbenchTab(state, tab)),
  setSplit: (session) => set((state) => setWorkbenchSplit(state, session)),
  focusPane: (pane) => set((state) => focusWorkbenchPane(state, pane)),
}));
