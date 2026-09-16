import * as React from "react";
import { activeBrowserTabIdForSession, browserTabsForSession } from "@openwork/browser-tabs";

import type { BrowserStatePayload } from "@/app/lib/desktop";
import { toast } from "@/components/ui/sonner";

import {
  type PanelTab,
  usePanelTabStore,
} from "./panel-tab-store";
import { getElectronBrowser } from "./utils";

export function useSidePanelTabs(sessionId: string) {
  const syncBrowserTabs = usePanelTabStore((state) => state.syncBrowserTabs);

  // Every conversation only sees the tabs it opened (plus shared tabs): the
  // native browser is one surface, but ownership decides what each panel shows.
  const applyBrowserState = React.useCallback((browserState: BrowserStatePayload) => {
    const tabs = browserTabsForSession(browserState.tabs ?? [], sessionId);
    const activeTabId = activeBrowserTabIdForSession(browserState, sessionId, tabs);

    syncBrowserTabs(sessionId, tabs, activeTabId);
  }, [sessionId, syncBrowserTabs]);

  React.useEffect(() => {
    const browser = getElectronBrowser();

    if (!browser) {
      return;
    }

    const unsub = browser.onStateChange?.(applyBrowserState);

    void browser.getState?.().then((browserState) => {
      if (browserState) {
        applyBrowserState(browserState);
      }
    });

    return unsub;
  }, [applyBrowserState]);

  const createTab = useCreateTab();

  const closeTab = useCloseTab();

  const selectTab = useSelectTab();

  const reorderTabs = useReorderTabs();

  return {
    createTab: (url?: string) => createTab(url, sessionId),
    closeTab: (tab: PanelTab) => closeTab(sessionId, tab),
    selectTab: (tabId: string) => selectTab(sessionId, tabId),
    reorderTabs: (tabIds: string[]) => reorderTabs(sessionId, tabIds),
  };
}

export function useOpenBrowserRailPane(
  sessionId: string,
  active: boolean,
  setPanel: (panel: "panel" | null) => void,
) {
  const createTab = useCreateTab();
  const selectTab = useSelectTab();
  const generation = React.useRef(0);

  React.useLayoutEffect(() => () => { generation.current += 1; }, [sessionId]);

  return React.useCallback(async () => {
    const request = ++generation.current;
    if (active) {
      setPanel(null);
      return;
    }

    try {
      const browserState = await getElectronBrowser()?.getState?.();
      if (request !== generation.current || !browserState) return;

      const tabs = browserTabsForSession(browserState.tabs ?? [], sessionId);
      usePanelTabStore.getState().syncBrowserTabs(
        sessionId,
        tabs,
        activeBrowserTabIdForSession(browserState, sessionId, tabs),
      );
      const session = usePanelTabStore.getState().sessions[sessionId];
      const activeTab = session?.tabs.find((tab) => tab.id === session.activeTabId);
      const browserTab = activeTab?.type === "browser"
        ? activeTab
        : session?.tabs.find((tab) => tab.type === "browser");
      if (browserTab) {
        selectTab(sessionId, browserTab.id);
      } else {
        void createTab(undefined, sessionId);
      }
      setPanel("panel");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [active, createTab, selectTab, sessionId, setPanel]);
}

export function useCreateTab() {
  return React.useCallback(async (url?: string, sessionId?: string | null) => {
    try {
      await getElectronBrowser()?.createTab?.(url, sessionId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, []);
}

export function useCloseTab() {
  const closeTab = usePanelTabStore((state) => state.closeTab);

  return React.useCallback((sessionId: string, tab: PanelTab) => {
    if (tab.type === "browser") {
      void getElectronBrowser()?.closeTab?.(tab.id);

      return;
    }

    const wasActive = usePanelTabStore.getState().sessions[sessionId]?.activeTabId === tab.id;

    closeTab(sessionId, tab.id);

    if (wasActive) {
      const nextTabId = usePanelTabStore.getState().sessions[sessionId]?.activeTabId;
      const nextTab = usePanelTabStore.getState().sessions[sessionId]?.tabs.find((entry) => entry.id === nextTabId);

      if (nextTab?.type === "browser") {
        void getElectronBrowser()?.selectTab?.(nextTab.id).catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error));
        });
      }
    }
  }, [closeTab]);
}

export function useSelectTab() {
  const selectTab = usePanelTabStore((state) => state.selectTab);

  return React.useCallback((sessionId: string, tabId: string) => {
    const tabs = usePanelTabStore.getState().sessions[sessionId]?.tabs ?? [];
    const tab = tabs.find((entry) => entry.id === tabId);

    if (!tab) {
      return;
    }

    selectTab(sessionId, tabId);

    if (tab.type === "browser") {
      void getElectronBrowser()?.selectTab?.(tabId).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    }
  }, [selectTab]);
}

export function useReorderTabs() {
  const reorderTabs = usePanelTabStore((state) => state.reorderTabs);

  return React.useCallback((sessionId: string, tabIds: string[]) => {
    const tabs = usePanelTabStore.getState().sessions[sessionId]?.tabs ?? [];
    const browserTabsById = new Map(
      tabs
        .filter((tab) => tab.type === "browser")
        .map((tab) => [tab.id, tab]),
    );
    const browserTabIds = tabIds.filter((tabId) => browserTabsById.has(tabId));

    reorderTabs(sessionId, tabIds);

    void getElectronBrowser()?.reorderTabs?.(browserTabIds);
  }, [reorderTabs]);
}
