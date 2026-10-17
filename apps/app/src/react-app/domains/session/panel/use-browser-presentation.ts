import * as React from "react";
import { activeBrowserTabIdForSession, browserTabsForSession } from "@openwork/browser-tabs";

import type { BrowserStatePayload } from "@/app/lib/desktop";

import { useUiStateStore, type SidePanelItem } from "../../../shell/ui-state-store";
import {
  DEFAULT_BROWSER_PRESENTATION,
  useBrowserPresentation,
  useBrowserPresentationStore,
  type BrowserFloatingSnap,
  type BrowserPresentation,
  type BrowserPresentationMode,
} from "./browser-presentation-store";
import { browserNeedsPerson, browserStatusLabel } from "./browser-status";
import { useActivePanelTab, useSessionPanelState, type BrowserPanelTab } from "./panel-tab-store";
import { getSidePanelSessionKey } from "./side-panel-session";
import { useOpenBrowserRailPane, useSelectTab } from "./use-side-panel-tabs";
import { getElectronBrowser } from "./utils";

export type BrowserPresentationController = {
  /** The floating browser feature is on in the desktop app. */
  enabled: boolean;
  /** What is on screen now: `side` while the side panel shows the browser. */
  mode: BrowserPresentationMode;
  presentation: BrowserPresentation;
  /** The conversation's on-screen browser tab, if it has one. */
  tab: BrowserPanelTab | null;
  status: string;
  needsYou: boolean;
  present: (mode: BrowserPresentationMode) => void;
  toggle: () => void;
  exitFullscreen: () => void;
  setSnap: (snap: BrowserFloatingSnap) => void;
  /** Places a page the agent opened. False when the feature is off and the caller keeps today's behavior. */
  placeOpenedBrowser: (ownerSessionId: string | null | undefined) => boolean;
  /** The host closed the owner's browser panel. */
  handlePanelClosed: (ownerSessionId: string | null | undefined) => void;
  /** Where focus returns after full screen. */
  fullscreenReturnFocus: React.RefObject<HTMLElement | null>;
};

type Options = {
  enabled: boolean;
  /** The side panel key of the conversation on screen. */
  sessionKey: string;
  /** The conversation the host shows browser tabs for. */
  visibleSessionId: string | null;
  sidePanel: SidePanelItem | null;
  setSidePanel: (panel: "panel" | null) => void;
};

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
  const handledAttention = React.useRef(new Set<string>());
  const openBrowserSide = useOpenBrowserRailPane(sessionKey, false, setSidePanel);
  const selectTab = useSelectTab();

  // The side panel only remembers the active panel tab; an artifact may hold
  // it while the native browser keeps its own on-screen page.
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

  // Actions run from events and IPC callbacks; they read the latest render.
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
    const current = latest.current;
    if (current.mode !== "hidden") {
      present("hidden");
      return;
    }
    present(current.presentation.returnMode === "floating" && current.tab ? "floating" : "side");
  }, [present]);

  const setSnap = React.useCallback((snap: BrowserFloatingSnap) => {
    useBrowserPresentationStore.getState().setSnap(sessionKey, snap);
  }, [sessionKey]);

  const placeOpenedBrowser = React.useCallback((ownerSessionId: string | null | undefined) => {
    if (!enabled) return false;
    const ownerKey = getSidePanelSessionKey(ownerSessionId ?? null);
    const key = ownerSessionId == null ? sessionKey : ownerKey;
    const ownerPresentation = useBrowserPresentationStore.getState().sessions[key] ?? DEFAULT_BROWSER_PRESENTATION;
    if (ownerPresentation.mode === "fullscreen") return true;
    // The agent acts only on a page the person can see, so a page it opens
    // comes up beside the chat. The person can float it from there.
    useBrowserPresentationStore.getState().setMode(key, "side", "side");
    if (key === sessionKey) setSidePanel("panel");
    else useUiStateStore.getState().setSidePanelState(key, "panel");
    return true;
  }, [enabled, sessionKey, setSidePanel]);

  const handlePanelClosed = React.useCallback((ownerSessionId: string | null | undefined) => {
    if (!enabled) return;
    const key = ownerSessionId == null ? sessionKey : getSidePanelSessionKey(ownerSessionId);
    useBrowserPresentationStore.getState().setMode(key, "hidden");
  }, [enabled, sessionKey]);

  // Showing the browser in the side panel by any route is choosing the side.
  React.useEffect(() => {
    if (!enabled || !browserInSide) return;
    if (presentation.mode === "side" || presentation.mode === "fullscreen") return;
    useBrowserPresentationStore.getState().setMode(sessionKey, "side", "side");
  }, [browserInSide, enabled, presentation.mode, sessionKey]);

  // Rollback returns an existing floating page to the standard side panel.
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

  // Full screen never survives a conversation switch or the page going away.
  React.useEffect(() => {
    if (!enabled) return;
    return () => useBrowserPresentationStore.getState().dropFullscreen(sessionKey);
  }, [enabled, sessionKey]);
  React.useEffect(() => {
    if (enabled && presentation.mode === "fullscreen" && !tab) {
      useBrowserPresentationStore.getState().dropFullscreen(sessionKey);
    }
  }, [enabled, presentation.mode, sessionKey, tab]);

  // A page needing attention opens beside the chat, and an
  // agent that needs the page on screen to act brings it beside the chat.
  const attentionTab = browserTabs.find(browserNeedsPerson);
  const attentionId = attentionTab
    ? `${attentionTab.id}:${attentionTab.browserTask?.operation ?? "needs_attention"}`
    : null;
  React.useEffect(() => {
    if (!attentionId) handledAttention.current.clear();
    if (!enabled || !attentionTab || !attentionId || handledAttention.current.has(attentionId)) return;
    handledAttention.current.add(attentionId);
    if (mode === "side" || mode === "fullscreen") return;
    useBrowserPresentationStore.getState().setMode(sessionKey, "side");
    selectTab(sessionKey, attentionTab.id);
    setSidePanel("panel");
  }, [attentionId, attentionTab, enabled, mode, selectTab, sessionKey, setSidePanel]);

  // Escape pressed inside the full-screen page leaves full screen.
  React.useEffect(() => {
    if (!enabled) return;
    return getElectronBrowser()?.onPresentationExit?.((payload) => {
      if (getSidePanelSessionKey(payload.sessionId) === sessionKey) exitFullscreen();
    });
  }, [enabled, exitFullscreen, sessionKey]);

  // The host needs only full screen, for Escape inside the page.
  React.useEffect(() => {
    if (!enabled) return;
    void getElectronBrowser()?.setPresentation?.(visibleSessionId, mode)?.catch(() => undefined);
  }, [enabled, mode, visibleSessionId]);

  return {
    enabled,
    mode,
    presentation,
    tab,
    status: browserStatusLabel(tab),
    needsYou: browserTabs.some(browserNeedsPerson),
    present,
    toggle,
    exitFullscreen,
    setSnap,
    placeOpenedBrowser,
    handlePanelClosed,
    fullscreenReturnFocus,
  };
}
