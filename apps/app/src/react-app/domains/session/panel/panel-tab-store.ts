import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { isCollectibleArtifactTarget, type OpenTarget, type OpenTargetPreview } from "../artifacts/open-target";

export const PERSISTED_PANEL_TAB_STORE_KEY = "openwork:panel-tabs:v1";

export type PanelTabType = "artifact" | "browser";

export type { BrowserPanelTab } from "../../../../app/lib/desktop-types";
import type { BrowserPanelTab } from "../../../../app/lib/desktop-types";

export type ArtifactPanelTab = {
  id: string;
  type: "artifact";
  label: string;
  preview: OpenTargetPreview;
}

export type PanelTab = BrowserPanelTab | ArtifactPanelTab;

export type SessionPanelState = {
  tabs: PanelTab[];
  activeTabId: string | null;
};

type PersistedPanelTabRef = {
  id: string;
  type: PanelTabType;
};

type PersistedSessionPanelState = {
  tabs: PersistedPanelTabRef[];
  activeTabId: string | null;
};

type PersistedPanelTabStore = {
  sessions: Record<string, PersistedSessionPanelState>;
};

export type PanelTabStore = {
  sessions: Record<string, SessionPanelState>;
  transcriptArtifactTargets: Record<string, OpenTarget[]>;
  openTab: (sessionId: string, tab: PanelTab) => void;
  closeTab: (sessionId: string, tabId: string) => void;
  selectTab: (sessionId: string, tabId: string) => void;
  reorderTabs: (sessionId: string, tabIds: string[]) => void;
  syncBrowserTabs: (sessionId: string, browserTabs: BrowserPanelTab[], activeBrowserTabId: string | null) => void;
  syncArtifactTargets: (
    sessionId: string,
    targets: Array<{ id: string; name: string; preview: OpenTargetPreview }>,
  ) => void;
  syncTranscriptArtifacts: (sessionId: string, targets: OpenTarget[]) => void;
  clearSession: (sessionId: string) => void;
};

const EMPTY_SESSION: SessionPanelState = {
  tabs: [],
  activeTabId: null,
};

function getWritableSession(state: PanelTabStore, sessionId: string): SessionPanelState {
  return state.sessions[sessionId] ?? EMPTY_SESSION;
}

function updateSession(
  state: PanelTabStore,
  sessionId: string,
  session: SessionPanelState,
): Partial<PanelTabStore> {
  return {
    sessions: {
      ...state.sessions,
      [sessionId]: session,
    },
  };
}

function reconcileOpenArtifactTabs(
  session: SessionPanelState,
  targets: Array<{ id: string; name: string; preview: OpenTargetPreview }>,
): SessionPanelState {
  const targetMap = new Map(targets.map((target) => [target.id, target]));

  const tabs = session.tabs
    .map((tab) => {
      if (tab.type !== "artifact") {
        return tab;
      }

      const target = targetMap.get(tab.id);

      if (!target) {
        return null;
      }

      return {
        ...tab,
        label: target.name,
        preview: target.preview,
      };
    })
    .filter((tab): tab is PanelTab => tab !== null);

  return {
    tabs,
    activeTabId: resolveActiveTabId(tabs, session.activeTabId),
  };
}

function isSameTranscriptArtifactTargets(left: OpenTarget[], right: OpenTarget[]) {
  return (
    left.length === right.length &&
    left.every((target, index) => target.id === right[index]?.id)
  );
}

function resolveActiveTabId<Tab extends { id: string }>(
  tabs: Tab[],
  preferredActiveTabId: string | null,
): string | null {
  if (preferredActiveTabId && tabs.some((tab) => tab.id === preferredActiveTabId)) {
    return preferredActiveTabId;
  }

  return tabs[0]?.id ?? null;
}

function isSameTab(left: PanelTab, right: PanelTab) {
  if (left.id !== right.id || left.type !== right.type) {
    return false;
  }

  if (left.type === "artifact" && right.type === "artifact") {
    return (
      left.label === right.label &&
      left.preview === right.preview
    );
  }

  if (left.type === "browser" && right.type === "browser") {
    return (
      left.label === right.label &&
      left.url === right.url &&
      left.favicon === right.favicon &&
      left.status === right.status &&
      left.canGoBack === right.canGoBack &&
      left.canGoForward === right.canGoForward
    );
  }

  return false;
}

function isSameSessionPanelState(
  session: SessionPanelState,
  tabs: PanelTab[],
  activeTabId: string | null,
) {
  return (
    session.tabs.length === tabs.length &&
    session.activeTabId === activeTabId &&
    session.tabs.every((tab, index) => isSameTab(tab, tabs[index]))
  );
}

function mergePersistedSessions(
  persistedState: unknown,
  currentState: PanelTabStore,
): PanelTabStore {
  const persisted = persistedState as PersistedPanelTabStore | undefined;

  if (!persisted?.sessions) {
    return currentState;
  }

  const sessions: Record<string, SessionPanelState> = {};

  for (const [sessionId, session] of Object.entries(persisted.sessions)) {
    const tabs = session.tabs
      .filter(({ type }) => type === "browser")
      .map(({ id }): PanelTab => ({
        id,
        type: "browser",
        label: "New tab",
        url: "",
        favicon: null,
        status: "ready",
        canGoBack: false,
        canGoForward: false,
      }));

    sessions[sessionId] = {
      tabs,
      activeTabId: resolveActiveTabId(tabs, session.activeTabId),
    };
  }

  return {
    ...currentState,
    sessions,
  };
}

export const usePanelTabStore = create<PanelTabStore>()(
  persist(
    (set, get) => ({
      sessions: {},
      transcriptArtifactTargets: {},
      openTab: (sessionId, tab) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const existingIndex = session.tabs.findIndex((entry) => entry.id === tab.id);

        if (existingIndex >= 0) {
          const tabs = [...session.tabs];
          tabs[existingIndex] = tab;

          return updateSession(state, sessionId, {
            tabs,
            activeTabId: tab.id,
          });
        }

        return updateSession(state, sessionId, {
          tabs: [...session.tabs, tab],
          activeTabId: tab.id,
        });
      }),
      closeTab: (sessionId, tabId) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const index = session.tabs.findIndex((tab) => tab.id === tabId);
        if (index < 0) {
          return state;
        }

        const tabs = session.tabs.filter((tab) => tab.id !== tabId);
        const activeTabId = session.activeTabId === tabId
          ? resolveActiveTabId(tabs, tabs[index]?.id ?? tabs[index - 1]?.id ?? null)
          : session.activeTabId;

        return updateSession(state, sessionId, { tabs, activeTabId });
      }),
      selectTab: (sessionId, tabId) => set((state) => {
        const session = getWritableSession(state, sessionId);
        if (!session.tabs.some((tab) => tab.id === tabId)) {
          return state;
        }

        if (session.activeTabId === tabId) {
          return state;
        }

        return updateSession(state, sessionId, {
          ...session,
          activeTabId: tabId,
        });
      }),
      reorderTabs: (sessionId, tabIds) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const tabsById = new Map(session.tabs.map((tab) => [tab.id, tab]));
        const reorderedTabs = tabIds
          .map((tabId) => tabsById.get(tabId))
          .filter((tab): tab is PanelTab => Boolean(tab));

        if (reorderedTabs.length !== session.tabs.length) {
          return state;
        }

        return updateSession(state, sessionId, {
          ...session,
          tabs: reorderedTabs,
        });
      }),
      syncBrowserTabs: (sessionId, browserTabs, activeBrowserTabId) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const browserTabsById = new Map(browserTabs.map((tab) => [tab.id, tab]));

        const mergedTabs: PanelTab[] = [];

        for (const tab of session.tabs) {
          if (tab.type === "artifact") {
            mergedTabs.push(tab);
            continue;
          }

          const browserTab = browserTabsById.get(tab.id);
          if (browserTab) {
            mergedTabs.push(browserTab);
            browserTabsById.delete(tab.id);
          }
        }

        for (const browserTab of browserTabsById.values()) {
          mergedTabs.push(browserTab);
        }

        const currentActiveTab = session.tabs.find((tab) => tab.id === session.activeTabId);
        const shouldSyncActiveFromElectron =
          !session.activeTabId || currentActiveTab?.type === "browser";

        const activeTabId = shouldSyncActiveFromElectron
          ? resolveActiveTabId(mergedTabs, activeBrowserTabId)
          : resolveActiveTabId(mergedTabs, session.activeTabId);

        if (isSameSessionPanelState(session, mergedTabs, activeTabId)) {
          return state;
        }

        return updateSession(state, sessionId, {
          tabs: mergedTabs,
          activeTabId,
        });
      }),
      syncArtifactTargets: (sessionId, targets) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const nextSession = reconcileOpenArtifactTabs(session, targets);

        if (isSameSessionPanelState(session, nextSession.tabs, nextSession.activeTabId)) {
          return state;
        }

        return updateSession(state, sessionId, nextSession);
      }),
      syncTranscriptArtifacts: (sessionId, targets) => set((state) => {
        const currentTranscript = state.transcriptArtifactTargets[sessionId] ?? [];
        const session = getWritableSession(state, sessionId);
        const collectibleTargets = targets
          .filter(isCollectibleArtifactTarget)
          .map((target) => ({
            id: target.id,
            name: target.name,
            preview: target.preview,
          }));
        const nextSession = reconcileOpenArtifactTabs(session, collectibleTargets);
        const transcriptChanged = !isSameTranscriptArtifactTargets(currentTranscript, targets);
        const sessionChanged = !isSameSessionPanelState(session, nextSession.tabs, nextSession.activeTabId);

        if (!transcriptChanged && !sessionChanged) {
          return state;
        }

        const sessionUpdate = sessionChanged ? updateSession(state, sessionId, nextSession) : null;

        return {
          transcriptArtifactTargets: transcriptChanged ? {
            ...state.transcriptArtifactTargets,
            [sessionId]: targets,
          } : state.transcriptArtifactTargets,
          sessions: sessionUpdate?.sessions ?? state.sessions,
        };
      }),
      clearSession: (sessionId) => set((state) => {
        const nextSessions = { ...state.sessions };
        const nextTranscriptArtifactTargets = { ...state.transcriptArtifactTargets };
        
        let changed = false;

        if (state.sessions[sessionId]) {
          delete nextSessions[sessionId];
          changed = true;
        }

        if (state.transcriptArtifactTargets[sessionId]) {
          delete nextTranscriptArtifactTargets[sessionId];
          changed = true;
        }

        if (!changed) {
          return state;
        }

        return {
          sessions: nextSessions,
          transcriptArtifactTargets: nextTranscriptArtifactTargets,
        };
      }),
    }),
    {
      name: PERSISTED_PANEL_TAB_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sessions: Object.fromEntries(
          Object.entries(state.sessions).map(([sessionId, session]) => {
            const tabs = session.tabs
              .filter((tab) => tab.type === "browser")
              .map(({ id, type }) => ({ id, type }));

            return [
              sessionId,
              {
                tabs,
                activeTabId: resolveActiveTabId(tabs, session.activeTabId),
              },
            ];
          }),
        ),
      }),
      merge: (persistedState, currentState) => mergePersistedSessions(persistedState, currentState),
    },
  ),
);

export function useSessionPanelState(sessionId: string): SessionPanelState {
  return usePanelTabStore((state) => state.sessions[sessionId] ?? EMPTY_SESSION);
}

export function useActivePanelTab(sessionId: string): PanelTab | null {
  return usePanelTabStore((state) => {
    const session = state.sessions[sessionId] ?? EMPTY_SESSION;

    return session.tabs.find((tab) => tab.id === session.activeTabId) ?? session.tabs[0] ?? null;
  });
}
