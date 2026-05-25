import { useReducer } from "react";

export type BrowserTabInfo = {
  tabId: string;
  url: string;
  title: string;
  favicon?: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isActive: boolean;
};

export type BrowserStatePayload = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  activeTabId?: string | null;
  tabs?: BrowserTabInfo[];
};

export type BrowserPanelState = {
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
  urlInput: string;
};

export type BrowserPanelAction =
  | { type: "browserStateChanged"; browserState: BrowserStatePayload; syncUrlInput: boolean }
  | { type: "tabsReordered"; tabIds: string[] }
  | { type: "urlInputChanged"; value: string };

const EMPTY_TAB_STATE: BrowserTabInfo = {
  tabId: "",
  url: "",
  title: "",
  favicon: null,
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  isActive: false,
};

function normalizeTabs(browserState: BrowserStatePayload): {
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
} {
  if (browserState.tabs?.length) {
    const activeTabId =
      browserState.activeTabId ??
      browserState.tabs.find((tab) => tab.isActive)?.tabId ??
      browserState.tabs[0]?.tabId ??
      null;

    return {
      tabs: browserState.tabs.map((tab) => ({ ...tab, isActive: tab.tabId === activeTabId })),
      activeTabId,
    };
  }

  const tabId = browserState.activeTabId ?? "active";

  return {
    tabs: [{
      tabId,
      url: browserState.url,
      title: browserState.title,
      favicon: null,
      canGoBack: browserState.canGoBack,
      canGoForward: browserState.canGoForward,
      isLoading: browserState.isLoading,
      isActive: true,
    }],
    activeTabId: tabId,
  };
}

export function getActiveTab(state: BrowserPanelState): BrowserTabInfo {
  return state.tabs.find((tab) => tab.tabId === state.activeTabId) ?? state.tabs[0] ?? EMPTY_TAB_STATE;
}

function browserPanelReducer(
  state: BrowserPanelState,
  action: BrowserPanelAction,
): BrowserPanelState {
  switch (action.type) {
    case "browserStateChanged": {
      const { tabs, activeTabId } = normalizeTabs(action.browserState);

      const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? tabs[0] ?? EMPTY_TAB_STATE;

      return {
        tabs,
        activeTabId,
        urlInput: action.syncUrlInput ? activeTab.url : state.urlInput,
      };
    }
    case "tabsReordered": {
      const tabsById = new Map(state.tabs.map((tab) => [tab.tabId, tab]));

      const reorderedTabs = action.tabIds
        .map((tabId) => tabsById.get(tabId))
        .filter((tab): tab is BrowserTabInfo => Boolean(tab));

      if (reorderedTabs.length !== state.tabs.length) {
        return state;
      }

      return { ...state, tabs: reorderedTabs };
    }
    case "urlInputChanged":
      return { ...state, urlInput: action.value };
  }
}

export function useBrowserState() {
  return useReducer(browserPanelReducer, {
    tabs: [],
    activeTabId: null,
    urlInput: "",
  });
}
