import type { OpenworkSessionRef } from "@openwork/types/openwork-context";
import { create } from "zustand";

export type WorkbenchPane = "primary" | "secondary";
export type WorkbenchSessionTab = OpenworkSessionRef;

export type WorkbenchSnapshot = {
  revision: number;
  workspaceId: string | null;
  workspaceTitle: string | null;
  primarySessionId: string | null;
  tabs: OpenworkSessionRef[];
  splitSessionId: string | null;
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
  workspaceId: null,
  workspaceTitle: null,
  primarySessionId: null,
  tabs: [],
  splitSessionId: null,
  focusedPane: "primary",
};

function sameTabs(left: OpenworkSessionRef[], right: OpenworkSessionRef[]) {
  return left.length === right.length && left.every((tab, index) => {
    const other = right[index];
    return other?.workspaceId === tab.workspaceId
      && other.sessionId === tab.sessionId
      && other.title === tab.title;
  });
}

function withRevision(current: WorkbenchSnapshot, next: Omit<WorkbenchSnapshot, "revision">): WorkbenchSnapshot {
  if (
    current.workspaceId === next.workspaceId
    && current.workspaceTitle === next.workspaceTitle
    && current.primarySessionId === next.primarySessionId
    && current.splitSessionId === next.splitSessionId
    && current.focusedPane === next.focusedPane
    && sameTabs(current.tabs, next.tabs)
  ) {
    return current;
  }
  return { ...next, revision: current.revision + 1 };
}

export function syncWorkbenchSnapshot(
  current: WorkbenchSnapshot,
  input: SyncWorkbenchInput,
): WorkbenchSnapshot {
  const availableById = new Map(input.sessions.map((session) => [session.sessionId, session]));
  const currentTabs = current.workspaceId === input.workspaceId ? current.tabs : [];
  const tabs = currentTabs
    .filter((tab) => !input.sessionsKnown || availableById.has(tab.sessionId) || tab.sessionId === input.primarySessionId)
    .map((tab) => availableById.get(tab.sessionId) ?? tab);

  if (input.primarySessionId && !tabs.some((tab) => tab.sessionId === input.primarySessionId)) {
    const primary = availableById.get(input.primarySessionId) ?? {
      workspaceId: input.workspaceId,
      sessionId: input.primarySessionId,
    };
    tabs.push(primary);
  }

  const splitSessionId = input.primarySessionId
    && current.workspaceId === input.workspaceId
    && current.splitSessionId !== input.primarySessionId
    && current.splitSessionId
    && tabs.some((tab) => tab.sessionId === current.splitSessionId)
      ? current.splitSessionId
      : null;

  return withRevision(current, {
    workspaceId: input.workspaceId,
    workspaceTitle: input.workspaceTitle?.trim() || input.workspaceId,
    primarySessionId: input.primarySessionId,
    tabs,
    splitSessionId,
    focusedPane: splitSessionId ? current.focusedPane : "primary",
  });
}

export function openWorkbenchTab(
  current: WorkbenchSnapshot,
  tab: OpenworkSessionRef,
): WorkbenchSnapshot {
  const tabs = current.workspaceId === tab.workspaceId ? [...current.tabs] : [];
  if (!tabs.some((entry) => entry.sessionId === tab.sessionId)) {
    tabs.push(tab);
  }
  return withRevision(current, {
    workspaceId: tab.workspaceId,
    workspaceTitle: current.workspaceId === tab.workspaceId ? current.workspaceTitle : tab.workspaceId,
    primarySessionId: current.workspaceId === tab.workspaceId ? current.primarySessionId : null,
    tabs,
    splitSessionId: current.workspaceId === tab.workspaceId ? current.splitSessionId : null,
    focusedPane: current.workspaceId === tab.workspaceId ? current.focusedPane : "primary",
  });
}

export function closeWorkbenchTab(
  current: WorkbenchSnapshot,
  sessionId: string,
): WorkbenchSnapshot {
  const tabs = current.tabs.filter((tab) => tab.sessionId !== sessionId);
  const splitSessionId = current.splitSessionId === sessionId ? null : current.splitSessionId;
  return withRevision(current, {
    workspaceId: current.workspaceId,
    workspaceTitle: current.workspaceTitle,
    primarySessionId: current.primarySessionId === sessionId ? null : current.primarySessionId,
    tabs,
    splitSessionId,
    focusedPane: splitSessionId ? current.focusedPane : "primary",
  });
}

export function setWorkbenchSplit(
  current: WorkbenchSnapshot,
  sessionId: string | null,
): WorkbenchSnapshot {
  const splitSessionId = sessionId
    && sessionId !== current.primarySessionId
    && current.tabs.some((tab) => tab.sessionId === sessionId)
      ? sessionId
      : null;
  return withRevision(current, {
    workspaceId: current.workspaceId,
    workspaceTitle: current.workspaceTitle,
    primarySessionId: current.primarySessionId,
    tabs: current.tabs,
    splitSessionId,
    focusedPane: splitSessionId ? "secondary" : "primary",
  });
}

export function focusWorkbenchPane(
  current: WorkbenchSnapshot,
  pane: WorkbenchPane,
): WorkbenchSnapshot {
  const focusedPane = pane === "secondary" && !current.splitSessionId ? "primary" : pane;
  return withRevision(current, {
    workspaceId: current.workspaceId,
    workspaceTitle: current.workspaceTitle,
    primarySessionId: current.primarySessionId,
    tabs: current.tabs,
    splitSessionId: current.splitSessionId,
    focusedPane,
  });
}

type WorkbenchStore = WorkbenchSnapshot & {
  sync: (input: SyncWorkbenchInput) => void;
  openTab: (tab: OpenworkSessionRef) => void;
  closeTab: (sessionId: string) => void;
  setSplit: (sessionId: string | null) => void;
  focusPane: (pane: WorkbenchPane) => void;
};

export const useWorkbenchStore = create<WorkbenchStore>((set) => ({
  ...initialWorkbenchSnapshot,
  sync: (input) => set((state) => syncWorkbenchSnapshot(state, input)),
  openTab: (tab) => set((state) => openWorkbenchTab(state, tab)),
  closeTab: (sessionId) => set((state) => closeWorkbenchTab(state, sessionId)),
  setSplit: (sessionId) => set((state) => setWorkbenchSplit(state, sessionId)),
  focusPane: (pane) => set((state) => focusWorkbenchPane(state, pane)),
}));
