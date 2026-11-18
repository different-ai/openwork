import { afterEach, expect, test } from "bun:test";

import { useBrowserPresentationStore } from "../src/react-app/domains/session/panel/browser-presentation-store";
import { usePanelTabStore, type BrowserPanelTab } from "../src/react-app/domains/session/panel/panel-tab-store";
import { NO_SESSION_SIDE_PANEL_KEY } from "../src/react-app/domains/session/panel/side-panel-session";
import { carryDraftBrowser } from "../src/react-app/domains/session/panel/use-browser-presentation";
import { useUiStateStore } from "../src/react-app/shell/ui-state-store";

const claimed: string[] = [];
Object.assign(globalThis, {
  window: { ...globalThis.window, __OPENWORK_ELECTRON__: { browser: { claimDraftTabs: async (sessionId: string) => { claimed.push(sessionId); return true; } } } },
});

const page = (id: string): BrowserPanelTab => ({
  id, type: "browser", label: id, url: `https://example.com/${id}`, status: "ready", canGoBack: false, canGoForward: false,
  ownerSessionId: NO_SESSION_SIDE_PANEL_KEY, favicon: null, siteToolCount: 0,
}) as BrowserPanelTab;

const draftTabs = () => usePanelTabStore.getState().sessions[NO_SESSION_SIDE_PANEL_KEY]?.tabs ?? [];

afterEach(() => {
  claimed.length = 0;
  useBrowserPresentationStore.setState({ sessions: {} });
  usePanelTabStore.setState({ sessions: {} });
  useUiStateStore.setState({ sidePanelState: {} });
});

test("a popped-out browser keeps its window when a new thread's first message makes it a session", () => {
  usePanelTabStore.getState().syncBrowserTabs(NO_SESSION_SIDE_PANEL_KEY, [page("a"), page("b")], "b");
  useBrowserPresentationStore.getState().setMode(NO_SESSION_SIDE_PANEL_KEY, "floating", "floating");

  carryDraftBrowser("session-1");

  expect(claimed).toEqual(["session-1"]);
  const session = usePanelTabStore.getState().sessions["session-1"];
  expect(session?.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
  expect(session?.activeTabId).toBe("b");
  expect(useBrowserPresentationStore.getState().sessions["session-1"]?.mode).toBe("floating");
  // Nothing is left behind for the next new thread to find.
  expect(draftTabs()).toEqual([]);
  expect(useBrowserPresentationStore.getState().sessions[NO_SESSION_SIDE_PANEL_KEY]).toBeUndefined();
});

test("a browser beside the chat stays beside the chat through the first message", () => {
  usePanelTabStore.getState().syncBrowserTabs(NO_SESSION_SIDE_PANEL_KEY, [page("a")], "a");
  useBrowserPresentationStore.getState().setMode(NO_SESSION_SIDE_PANEL_KEY, "side", "side");
  useUiStateStore.getState().setSidePanelState(NO_SESSION_SIDE_PANEL_KEY, "panel");

  carryDraftBrowser("session-1");

  expect(useUiStateStore.getState().sidePanelState["session-1"]).toBe("panel");
  expect(useUiStateStore.getState().sidePanelState[NO_SESSION_SIDE_PANEL_KEY] ?? null).toBeNull();
  expect(useBrowserPresentationStore.getState().sessions["session-1"]?.mode).toBe("side");
});

test("a new thread with no browser changes nothing", () => {
  carryDraftBrowser("session-1");

  expect(claimed).toEqual([]);
  expect(usePanelTabStore.getState().sessions["session-1"]).toBeUndefined();
});
