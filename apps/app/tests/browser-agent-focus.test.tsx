/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

let createRoot: typeof import("react-dom/client")["createRoot"];
let presentation: typeof import("../src/react-app/domains/session/panel/use-browser-presentation");
let presentationStore: typeof import("../src/react-app/domains/session/panel/browser-presentation-store");
let panelTabs: typeof import("../src/react-app/domains/session/panel/panel-tab-store");

const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
const calls: string[] = [];
const SESSION = "session-1";
let root: Root | null = null;

beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(window, "__OPENWORK_ELECTRON__", {
    browser: {
      onStateChange: () => () => {},
      getState: async () => null,
      setPresentation: async () => true,
      selectTab: async (tabId: string) => { calls.push(`select:${tabId}`); return tabId; },
      focusWindow: async () => { calls.push("focusWindow"); return true; },
    },
  });
  createRoot = (await import("react-dom/client")).createRoot;
  presentation = await import("../src/react-app/domains/session/panel/use-browser-presentation");
  presentationStore = await import("../src/react-app/domains/session/panel/browser-presentation-store");
  panelTabs = await import("../src/react-app/domains/session/panel/panel-tab-store");
});

afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  calls.length = 0;
  presentationStore.useBrowserPresentationStore.setState({ sessions: {} });
  panelTabs.usePanelTabStore.setState({ sessions: {} });
});

function Controller() {
  presentation.useBrowserPresentationController({
    enabled: true, sessionKey: SESSION, visibleSessionId: SESSION, sidePanel: null, setSidePanel: () => {},
  });
  return null;
}

test("a failed agent step in the popped-out window never takes focus from what the person is doing", async () => {
  panelTabs.usePanelTabStore.getState().syncBrowserTabs(SESSION, [{
    id: "tab-1", type: "browser", label: "Page", url: "https://example.com/", status: "ready", canGoBack: false, canGoForward: false,
    ownerSessionId: SESSION, favicon: null, siteToolCount: 0, browserTask: { status: "needs_attention", operation: "stale_observation" },
  } as import("../src/react-app/domains/session/panel/panel-tab-store").BrowserPanelTab], "tab-1");
  presentationStore.useBrowserPresentationStore.getState().setMode(SESSION, "floating", "floating");

  root = createRoot(document.createElement("div"));
  await act(async () => { root?.render(<Controller />); });

  expect(calls).toEqual(["select:tab-1"]);
});
