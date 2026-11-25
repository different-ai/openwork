import * as React from "react";
import { activeBrowserTabIdForSession, browserTabsForSession } from "@openwork/browser-tabs";

import type { BrowserStatePayload } from "@/app/lib/desktop";

import { useUiStateStore, type SidePanelItem } from "../../../shell/ui-state-store";
import {
  DEFAULT_BROWSER_PRESENTATION,
  useBrowserPresentation,
  useBrowserPresentationStore,
  type BrowserPresentation,
  type BrowserPresentationMode,
} from "./browser-presentation-store";
import { browserNeedsPerson, browserStatusLabel } from "./browser-status";
import { useActivePanelTab, usePanelTabStore, useSessionPanelState, type BrowserPanelTab } from "./panel-tab-store";
import { NO_SESSION_SIDE_PANEL_KEY, getSidePanelSessionKey } from "./side-panel-session";
import { useOpenBrowserRailPane, useSelectTab } from "./use-side-panel-tabs";
import { getElectronBrowser } from "./utils";

export type BrowserPresentationController = {
  enabled: boolean;
  mode: BrowserPresentationMode;
  presentation: BrowserPresentation;
  tab: BrowserPanelTab | null;
  browserTabs: BrowserPanelTab[];
  status: string;
  needsYou: boolean;
  present: (mode: BrowserPresentationMode) => void;
  toggle: () => void;
  exitFullscreen: () => void;
  isPoppedOut: (ownerSessionId: string | null | undefined) => boolean;
  placeOpenedBrowser: (ownerSessionId: string | null | undefined) => boolean;
  handlePanelClosed: (ownerSessionId: string | null | undefined) => void;
  fullscreenReturnFocus: React.RefObject<HTMLElement | null>;
  focusWindowOnOpen: React.RefObject<boolean>;
};

type Options = {
  enabled: boolean;
  sessionKey: string;
  visibleSessionId: string | null;
  sidePanel: SidePanelItem | null;
  setSidePanel: (panel: "panel" | null) => void;
};

export function carryDraftBrowser(sessionId: string) {
  const panels = usePanelTabStore.getState();
  const draft = panels.sessions[NO_SESSION_SIDE_PANEL_KEY];
  const tabs = draft?.tabs.filter((tab): tab is BrowserPanelTab => tab.type === "browser") ?? [];
  if (!draft || tabs.length === 0) return;
  void getElectronBrowser()?.claimDraftTabs?.(sessionId)?.catch(() => undefined);
  const browserInPanel = tabs.some((tab) => tab.id === draft.activeTabId);
  panels.syncBrowserTabs(sessionId, tabs, browserInPanel ? draft.activeTabId : null);
  panels.syncBrowserTabs(NO_SESSION_SIDE_PANEL_KEY, [], null);
  useBrowserPresentationStore.getState().moveSession(NO_SESSION_SIDE_PANEL_KEY, sessionId);
  const ui = useUiStateStore.getState();
  if (browserInPanel && ui.sidePanelState[NO_SESSION_SIDE_PANEL_KEY] === "panel") {
    ui.setSidePanelState(sessionId, "panel");
    ui.setSidePanelState(NO_SESSION_SIDE_PANEL_KEY, null);
  }
}

export function useBrowserPresentationController({
  enabled,
  sessionKey,
  visibleSessionId,
  sidePanel,
  setSidePanel,
}: Options): BrowserPresentationController {
  const presentation = useBrowserPresentation(sessionKey);
  const { tabs } = useSessionPanelState(sessionKey);
  const activePanelTab = useActivePanelTab(sessionKey);
  const [nativeActiveTabId, setNativeActiveTabId] = React.useState<string | null>(null);
  const fullscreenReturnFocus = React.useRef<HTMLElement | null>(null);
  const focusWindowOnOpen = React.useRef(false);
  const handledAttention = React.useRef(new Set<string>());
  const openBrowserSide = useOpenBrowserRailPane(sessionKey, false, setSidePanel);
  const selectTab = useSelectTab();

  React.useEffect(() => {
    if (!enabled) return;
    const browser = getElectronBrowser();
    if (!browser) return;
    let disposed = false;
    const apply = (state: BrowserStatePayload) => {
      if (disposed) return;
      const sessionTabs = browserTabsForSession(state.tabs ?? [], sessionKey);
      setNativeActiveTabId(activeBrowserTabIdForSession(state, sessionKey, sessionTabs));
    };
    const unsubscribe = browser.onStateChange?.(apply);
    void browser.getState?.().then((state) => {
      if (state) apply(state);
    }).catch(() => undefined);
    return () => { disposed = true; unsubscribe?.(); };
  }, [enabled, sessionKey]);

  const browserTabs = React.useMemo(
    () => tabs.filter((tab): tab is BrowserPanelTab => tab.type === "browser"),
    [tabs],
  );
  const tab = browserTabs.find((entry) => entry.id === nativeActiveTabId)
    ?? (activePanelTab?.type === "browser" ? activePanelTab : null)
    ?? browserTabs[browserTabs.length - 1]
    ?? null;
  const browserInSide = sidePanel === "panel" && activePanelTab?.type === "browser";
  const mode: BrowserPresentationMode = !enabled ? "hidden"
    : presentation.mode === "fullscreen" && tab ? "fullscreen"
      : browserInSide ? "side"
        : presentation.mode === "floating" && tab ? "floating"
          : "hidden";

  const latest = React.useRef({ mode, presentation, tab, browserInSide });
  React.useLayoutEffect(() => {
    latest.current = { mode, presentation, tab, browserInSide };
  });

  const present = React.useCallback((next: BrowserPresentationMode) => {
    if (!enabled) return;
    const store = useBrowserPresentationStore.getState();
    const current = latest.current;
    if (next === "side") {
      store.setMode(sessionKey, "side", "side");
      if (!current.browserInSide) void openBrowserSide();
      return;
    }
    if (next === "floating" && !current.tab) {
      store.setMode(sessionKey, "side", "side");
      void openBrowserSide();
      return;
    }
    if (next === "fullscreen") {
      if (!current.tab) return;
      const returnMode = current.mode === "side" || current.mode === "floating" ? current.mode : current.presentation.returnMode;
      fullscreenReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      store.setMode(sessionKey, "fullscreen", returnMode);
    } else {
      if (next === "floating") focusWindowOnOpen.current = true;
      store.setMode(sessionKey, next, next === "floating" ? "floating" : undefined);
    }
    if (current.browserInSide) setSidePanel(null);
  }, [enabled, openBrowserSide, sessionKey, setSidePanel]);

  const exitFullscreen = React.useCallback(() => {
    const current = latest.current;
    if (current.presentation.mode !== "fullscreen") return;
    present(current.presentation.returnMode);
  }, [present]);

  const toggle = React.useCallback(() => {
    present(latest.current.mode === "side" ? "hidden" : "side");
  }, [present]);

  const presentationKey = React.useCallback((ownerSessionId: string | null | undefined) => (
    ownerSessionId == null ? sessionKey : getSidePanelSessionKey(ownerSessionId)
  ), [sessionKey]);

  const isPoppedOut = React.useCallback((ownerSessionId: string | null | undefined) => (
    enabled && useBrowserPresentationStore.getState().sessions[presentationKey(ownerSessionId)]?.mode === "floating"
  ), [enabled, presentationKey]);

  const placeOpenedBrowser = React.useCallback((ownerSessionId: string | null | undefined) => {
    if (!enabled) return false;
    const key = presentationKey(ownerSessionId);
    const ownerPresentation = useBrowserPresentationStore.getState().sessions[key] ?? DEFAULT_BROWSER_PRESENTATION;
    if (ownerPresentation.mode === "fullscreen") return true;
    useBrowserPresentationStore.getState().setMode(key, "side", "side");
    if (key === sessionKey) setSidePanel("panel");
    else useUiStateStore.getState().setSidePanelState(key, "panel");
    return true;
  }, [enabled, presentationKey, sessionKey, setSidePanel]);

  const handlePanelClosed = React.useCallback((ownerSessionId: string | null | undefined) => {
    if (!enabled) return;
    useBrowserPresentationStore.getState().setMode(presentationKey(ownerSessionId), "hidden");
  }, [enabled, presentationKey]);

  React.useEffect(() => {
    if (!enabled || !browserInSide) return;
    if (presentation.mode === "side" || presentation.mode === "fullscreen") return;
    useBrowserPresentationStore.getState().setMode(sessionKey, "side", "side");
  }, [browserInSide, enabled, presentation.mode, sessionKey]);

  const wasEnabled = React.useRef(enabled);
  React.useEffect(() => {
    const reverted = wasEnabled.current && !enabled;
    wasEnabled.current = enabled;
    if (!reverted) return;
    void getElectronBrowser()?.setPresentation?.(visibleSessionId, "side");
    if (tab && (presentation.mode === "floating" || presentation.mode === "fullscreen")) {
      useBrowserPresentationStore.getState().setMode(sessionKey, "side", "side");
      selectTab(sessionKey, tab.id);
      setSidePanel("panel");
    }
  }, [enabled, presentation.mode, sessionKey, setSidePanel, selectTab, tab, visibleSessionId]);

  React.useEffect(() => {
    if (!enabled) return;
    return () => useBrowserPresentationStore.getState().dropFullscreen(sessionKey);
  }, [enabled, sessionKey]);
  React.useEffect(() => {
    if (enabled && presentation.mode === "fullscreen" && !tab) {
      useBrowserPresentationStore.getState().dropFullscreen(sessionKey);
    }
  }, [enabled, presentation.mode, sessionKey, tab]);

  const attentionTab = browserTabs.find(browserNeedsPerson);
  const attentionId = attentionTab
    ? `${attentionTab.id}:${attentionTab.browserTask?.operation ?? "needs_attention"}`
    : null;
  React.useEffect(() => {
    if (!attentionId) handledAttention.current.clear();
    if (!enabled || !attentionTab || !attentionId || handledAttention.current.has(attentionId)) return;
    handledAttention.current.add(attentionId);
    if (mode === "side" || mode === "fullscreen") return;
    if (mode === "floating") {
      void getElectronBrowser()?.selectTab?.(attentionTab.id).catch(() => undefined);
      return;
    }
    useBrowserPresentationStore.getState().setMode(sessionKey, "side");
    selectTab(sessionKey, attentionTab.id);
    setSidePanel("panel");
  }, [attentionId, attentionTab, enabled, mode, selectTab, sessionKey, setSidePanel]);

  React.useEffect(() => {
    if (!enabled) return;
    return getElectronBrowser()?.onPresentationExit?.((payload) => {
      if (getSidePanelSessionKey(payload.sessionId) === sessionKey) exitFullscreen();
    });
  }, [enabled, exitFullscreen, sessionKey]);

  React.useEffect(() => {
    if (!enabled) return;
    void getElectronBrowser()?.setPresentation?.(visibleSessionId, mode)?.catch(() => undefined);
  }, [enabled, mode, visibleSessionId]);

  return {
    enabled,
    mode,
    presentation,
    tab,
    browserTabs,
    status: browserStatusLabel(tab),
    needsYou: browserTabs.some(browserNeedsPerson),
    present,
    toggle,
    exitFullscreen,
    isPoppedOut,
    placeOpenedBrowser,
    handlePanelClosed,
    fullscreenReturnFocus,
    focusWindowOnOpen,
  };
}
