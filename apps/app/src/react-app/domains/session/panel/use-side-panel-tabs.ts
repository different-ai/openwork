import * as React from "react";

import type { BrowserStatePayload } from "@/app/lib/desktop";

import {
  type PanelTab,
  usePanelTabStore,
} from "./panel-tab-store";
import { getElectronBrowser } from "./utils";

export function useSidePanelTabs(sessionId: string) {
  const syncBrowserTabs = usePanelTabStore((state) => state.syncBrowserTabs);

  const applyBrowserState = React.useCallback((browserState: BrowserStatePayload) => {
    const tabs = browserState.tabs ?? [];
    const activeTabId = browserState.activeTabId ?? tabs[0]?.id ?? null;

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
    createTab: (url?: string) => createTab(url),
    closeTab: (tab: PanelTab) => closeTab(sessionId, tab),
    selectTab: (tabId: string) => selectTab(sessionId, tabId),
    reorderTabs: (tabIds: string[]) => reorderTabs(sessionId, tabIds),
  };
}

export function useCreateTab() {
  return React.useCallback((url?: string) => {
    void getElectronBrowser()?.createTab?.(url);
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
        void getElectronBrowser()?.selectTab?.(nextTab.id);
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
      void getElectronBrowser()?.selectTab?.(tabId);
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
