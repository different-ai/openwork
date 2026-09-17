import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrowserPanelTab, BrowserStatePayload } from "@openwork/browser-tabs";
import type { PanelTab } from "../src/react-app/domains/session/panel/panel-tab-store";

import {
  getPanelDestinations,
  handlePanelEscape,
  PanelEmpty,
} from "../src/react-app/domains/session/panel/panel-empty";
import {
  getSidePanelSessionKey,
  NO_SESSION_SIDE_PANEL_KEY,
} from "../src/react-app/domains/session/panel/side-panel-session";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const getState = mock<() => Promise<BrowserStatePayload | null>>(async () => ({ tabs: [] }));
const createTab = mock(async (_url?: string, _sessionId?: string | null) => undefined);
const selectTab = mock(async (_tabId: string) => undefined);
const showError = mock((_message: string) => undefined);
mock.module("../src/react-app/domains/session/panel/utils", () => ({
  getElectronBrowser: () => ({ getState, createTab, selectTab }),
}));
mock.module("@/components/ui/sonner", () => ({ toast: { error: showError } }));
const { useOpenBrowserRailPane } = await import("../src/react-app/domains/session/panel/use-side-panel-tabs");
const { usePanelTabStore } = await import("../src/react-app/domains/session/panel/panel-tab-store");

function browserTab(id: string, ownerSessionId: string | null, status: BrowserPanelTab["status"] = "ready"): BrowserPanelTab {
  return {
    id, ownerSessionId, status, type: "browser", label: id, url: "", favicon: null,
    canGoBack: false, canGoForward: false, siteToolCount: 0, siteTools: [], siteToolActivity: [],
  };
}

const setPanel = mock((_panel: "panel" | null) => undefined);
let openRail: () => Promise<void> = async () => undefined;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
function Rail({ sessionId, active }: { sessionId: string; active: boolean }) {
  openRail = useOpenBrowserRailPane(sessionId, active, setPanel);
  return null;
}
async function renderRail(sessionId = NO_SESSION_SIDE_PANEL_KEY, active = false) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => { root?.render(<Rail sessionId={sessionId} active={active} />); });
}

beforeEach(() => {
  getState.mockReset();
  getState.mockResolvedValue({ tabs: [] });
  createTab.mockReset();
  selectTab.mockReset();
  showError.mockClear();
  setPanel.mockClear();
  usePanelTabStore.setState({ sessions: {} });
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  container?.remove();
  container = null;
});
afterAll(() => {
  mock.restore();
  if (ownedDom) GlobalRegistrator.unregister();
});

describe("browser rail reconciliation", () => {
  test.each([NO_SESSION_SIDE_PANEL_KEY, "ses_existing"])("replaces stale IDs with a new tab owned by %s", async (sessionId) => {
    usePanelTabStore.getState().openTab(sessionId, browserTab("stale", sessionId));
    getState.mockResolvedValue({ tabs: [browserTab("other", "ses_other")], activeTabId: "other" });
    await renderRail(sessionId);
    await act(async () => { await openRail(); });
    expect(getState).toHaveBeenCalledTimes(1);
    expect(selectTab).not.toHaveBeenCalled();
    expect(createTab).toHaveBeenCalledWith(undefined, sessionId);
    expect(usePanelTabStore.getState().sessions[sessionId]?.tabs).toEqual([]);
    expect(setPanel).toHaveBeenCalledWith("panel");
  });

  test.each(["ready", "suspended"] satisfies BrowserPanelTab["status"][])("selects the native owner-active %s tab instead of a stale selection", async (status) => {
    const sessionId = "ses_existing";
    usePanelTabStore.getState().openTab(sessionId, browserTab("stale", sessionId));
    getState.mockResolvedValue({
      tabs: [browserTab("first", sessionId), browserTab("current", sessionId, status), browserTab("other", "ses_other")],
      activeTabId: "other", activeTabIdByOwner: { [sessionId]: "current" },
    });
    await renderRail(sessionId);
    await act(async () => { await openRail(); });
    expect(selectTab).toHaveBeenCalledWith("current");
    expect(createTab).not.toHaveBeenCalled();
    expect(usePanelTabStore.getState().sessions[sessionId]?.activeTabId).toBe("current");
  });

  test("retains artifacts and selects the first shared browser tab from Files", async () => {
    const sessionId = NO_SESSION_SIDE_PANEL_KEY;
    const artifact = { id: "artifact", type: "artifact", label: "Document", preview: "text" } satisfies PanelTab;
    usePanelTabStore.getState().openTab(sessionId, artifact);
    getState.mockResolvedValue({ tabs: [browserTab("shared", null), browserTab("other", "ses_other")] });
    await renderRail(sessionId);
    await act(async () => { await openRail(); });
    expect(selectTab).toHaveBeenCalledWith("shared");
    expect(usePanelTabStore.getState().sessions[sessionId]?.tabs.map((tab) => tab.id)).toEqual(["artifact", "shared"]);
    expect(createTab).not.toHaveBeenCalled();
  });

  test("closes the active rail without fetching or selecting", async () => {
    await renderRail(NO_SESSION_SIDE_PANEL_KEY, true);
    await act(async () => { await openRail(); });
    expect(setPanel).toHaveBeenCalledWith(null);
    expect(getState).not.toHaveBeenCalled();
    expect(selectTab).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  test.each(["switch", "unmount"])("ignores pending native state after %s", async (change) => {
    let resolve: (state: BrowserStatePayload) => void = () => undefined;
    getState.mockReturnValue(new Promise((done) => { resolve = done; }));
    await renderRail();
    const pending = openRail();
    if (change === "switch") {
      await renderRail("ses_other");
      await renderRail();
    } else {
      await act(async () => { root?.unmount(); });
      root = null;
    }
    await act(async () => { resolve({ tabs: [] }); await pending; });
    expect(usePanelTabStore.getState().sessions).toEqual({});
    expect(createTab).not.toHaveBeenCalled();
    expect(selectTab).not.toHaveBeenCalled();
    expect(setPanel).not.toHaveBeenCalled();
  });

  test("reports state failures without trusting persisted IDs", async () => {
    usePanelTabStore.getState().openTab(NO_SESSION_SIDE_PANEL_KEY, browserTab("stale", NO_SESSION_SIDE_PANEL_KEY));
    getState.mockRejectedValue(new Error("State unavailable"));
    await renderRail();
    await act(async () => { await openRail(); });
    expect(showError).toHaveBeenCalledWith("State unavailable");
    expect(selectTab).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
    expect(setPanel).not.toHaveBeenCalled();
  });

  test.each(["select", "create"])("preserves %s error reporting", async (operation) => {
    if (operation === "select") {
      getState.mockResolvedValue({ tabs: [browserTab("shared", null)] });
      selectTab.mockRejectedValue(new Error("Selection failed"));
    } else {
      createTab.mockRejectedValue(new Error("Creation failed"));
    }
    await renderRail();
    await act(async () => { await openRail(); });
    expect(showError).toHaveBeenCalledWith(operation === "select" ? "Selection failed" : "Creation failed");
  });
});

describe("right panel empty state", () => {
  test("keeps the panel addressable before a session exists", () => {
    expect(getSidePanelSessionKey(null)).toBe(NO_SESSION_SIDE_PANEL_KEY);
    expect(getSidePanelSessionKey("")).toBe(NO_SESSION_SIDE_PANEL_KEY);
    expect(getSidePanelSessionKey("   ")).toBe(NO_SESSION_SIDE_PANEL_KEY);
    expect(getSidePanelSessionKey("ses_existing")).toBe("ses_existing");
  });

  test("renders spacious keyboard-accessible destination actions", () => {
    const html = renderToStaticMarkup(
      <PanelEmpty
        onOpenBrowser={() => undefined}
        onOpenExtensions={() => undefined}
      />,
    );

    expect(html).toContain("Choose a destination");
    expect(html).toContain("Browser");
    expect(html).toContain("Files &amp; artifacts");
    expect(html).toContain("Library");
    expect(html).not.toContain("Voice Mode");
    expect(html).toContain('aria-label="Panel destinations"');
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toContain("min-h-16");
    expect(html).toContain("w-full");
    expect(html).toContain("overflow-y-auto");
  });

  test("shows only destinations supported by the runtime", () => {
    const html = renderToStaticMarkup(<PanelEmpty />);

    expect(html).toContain("Files &amp; artifacts");
    expect(html).not.toContain("Browser");
    expect(html).not.toContain("Library");
    expect(html).not.toContain("Voice Mode");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  test("activates every available destination through its supplied handler", () => {
    const activated: string[] = [];
    const destinations = getPanelDestinations(
      {
        onOpenBrowser: () => activated.push("browser"),
        onOpenExtensions: () => activated.push("extensions"),
      },
      () => activated.push("files"),
    );

    for (const destination of destinations) destination.activate();

    expect(activated).toEqual(["browser", "files", "extensions"]);
  });

  test("closes on Escape without consuming unrelated keys", () => {
    let closeCount = 0;

    expect(handlePanelEscape("ArrowDown", () => { closeCount += 1; })).toBe(false);
    expect(handlePanelEscape("Escape", () => { closeCount += 1; })).toBe(true);
    expect(closeCount).toBe(1);
  });
});
