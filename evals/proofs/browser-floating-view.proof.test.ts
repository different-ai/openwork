import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Target } from "@openwork/testkit";
function browserTabHandle(value: unknown) {
  if (!value || typeof value !== "object" || !("tab_id" in value) || typeof value.tab_id !== "string") throw new Error("The browser returned no tab handle.");
  return { tabId: value.tab_id };
}
import { browserFloatingViewWorld } from "../worlds/desktop-chat-features.ts";

const test = spec.world(browserFloatingViewWorld, {
  resources: {
    surfaces: ["desktop"],
    services: ["den", "mock"],
    nativeReason: "Side, windowed and full-screen presentation move Electron's native page view, which a browser tab cannot host.",
  },
});

const toggle: Target = { testId: "session-browser-toggle" };
const browserWindowRoot: Target = { testId: "browser-window" };
const addressBar: Target = { placeholder: "Enter URL..." };
const fullscreen: Target = { testId: "browser-fullscreen-dialog" };
const WITHIN = 15_000;

test("a person pops the page the agent opened out into a real browser window, browses in it, and puts it back without losing it", async ({ world, user, agent, probe, step, evidence }) => {
  const sessionId = world.session.sessionId;
  await agent.run("session.open", { sessionId });
  let tabId = "";
  let sideWidth = 0;

  // The side rail's Browser button reports what is on screen in data-browser-mode.
  const browserMode = (mode: string) => probe.eventually(
    () => probe.dom(`[data-testid="session-browser-toggle"][data-browser-mode="${mode}"]`),
    { within: WITHIN, until: (dom) => dom.elements.length === 1, label: `the Browser button reports ${mode}` },
  );
  // The agent's page keeps the same native tab in every presentation.
  const pageView = async (shown: boolean) => {
    const state = await probe.eventually(() => probe.browserState(), {
      within: WITHIN,
      label: shown ? "the agent's page is painted in the app window" : "no browser page is painted over the chat",
      until: (value) => value.tabs.some((tab) => tab.id === tabId && tab.ownerSessionId === sessionId)
        && value.nativeViews.some((view) => view.tabId === tabId && view.attached && view.aboveApp && view.visible) === shown,
    });
    return state.nativeViews.find((view) => view.tabId === tabId) ?? null;
  };
  // The live page itself is inside the browser's window, not a picture of it.
  const windowPage = async (id: string, label = "the live page is painted in the browser window", accept: (width: number) => boolean = () => true) => {
    const state = await probe.eventually(() => probe.browserState(), {
      within: WITHIN,
      label,
      until: (value) => value.nativeViews.some((view) => view.tabId === id && view.poppedOut && view.visible && accept(view.bounds.width)),
    });
    return state.nativeViews.find((view) => view.tabId === id) ?? null;
  };
  // A fresh attach each time it opens: leaving it closes that window.
  let popup: Awaited<ReturnType<typeof world.floatingWindow>> | null = null;
  const browserWindow = async () => {
    await popup?.client.close();
    popup = await world.floatingWindow();
    await user.on(popup).see(browserWindowRoot);
    return { surface: popup, user: user.on(popup), probe: probe.on(popup) };
  };
  const browserWindowClosed = () => probe.eventually(() => world.floatingWindowOpen(), {
    within: WITHIN, until: (open) => !open, label: "the browser window closes",
  });
  const ownedTabs = async () => (await probe.browserState()).tabs.filter((tab) => tab.ownerSessionId === sessionId);

  await step("before: a page the agent opens comes up beside the chat, as it does today", async () => {
    if (await probe.has("Not now")) await user.click({ role: "button", label: "Not now" });
    await user.see(toggle, { timeoutMs: 30_000 });
    await browserMode("hidden");
    // One Browser button, in the side rail; the chat header has none.
    const browserButtons = await probe.dom('button[aria-label^="Browser"]');
    expect(browserButtons.elements).toHaveLength(1);
    expect((await probe.dom('[data-session-header] button[aria-label^="Browser"]')).elements).toHaveLength(0);
    expect(await ownedTabs()).toEqual([]);
    tabId = browserTabHandle(await agent.run("browser.open_url", { url: world.pageUrl, provider: "builtin" })).tabId;
    await user.notSee({ role: "button", label: "Allow for this thread" });
    await browserMode("side");
    const view = await pageView(true);
    sideWidth = view?.bounds.width ?? 0;
    expect(sideWidth).toBeGreaterThan(0);
    await user.see({ testId: "browser-mode-float" });
    evidence.recordAssertionEvidence(
      "The agent's page opens beside the chat",
      `Without a consent prompt, the page opened in the side panel (${sideWidth}px wide); the side rail's Browser button reads "side" and it is the only Browser button.`,
      sideWidth > 0 && browserButtons.elements.length === 1,
    );
    await user.screenshot();
  });

  await step("after: popping out moves the live page into its own window with tabs and an address bar", async () => {
    await user.click({ testId: "browser-mode-float" });
    const win = await browserWindow();
    await browserMode("floating");
    expect(await pageView(false)).toMatchObject({ tabId });
    const view = await windowPage(tabId);
    const width = view?.bounds.width ?? 0;
    // Witness: the page is wider than it was beside the chat, because the same view moved here.
    expect(width).toBeGreaterThan(sideWidth);
    await win.user.see(addressBar);
    expect((await win.probe.dom('[data-testid="browser-window-tab"]')).elements).toHaveLength(1);
    await user.notSee({ testId: "browser-mode-float" });
    // Witness: going back to the chat cannot bury a window that stays above the app.
    const aboveOthers = (await probe.browserState()).popOutAboveOthers;
    expect(aboveOthers).toBe(true);
    evidence.recordAssertionEvidence(
      "Pop out moves the page into a real browser window",
      `The live tab is painted ${width}px wide inside a separate window (${sideWidth}px beside the chat) that stays above other windows, with its own tab strip and address bar, and nothing is painted over the chat.`,
      width > sideWidth && aboveOthers,
    );
    await win.user.screenshot();
  });

  await step("after: the address bar and tabs in the window browse like any browser", async () => {
    const win = await browserWindow();
    await win.user.type(addressBar, `${world.origin}/?floating-browser=updated`, { replace: true });
    await win.user.press("Enter");
    await probe.eventually(() => ownedTabs(), {
      within: WITHIN,
      until: (tabs) => tabs.length === 1 && tabs[0]?.id === tabId && tabs[0].url.includes("floating-browser=updated"),
      label: "the same tab navigates from the window's address bar",
    });
    await win.user.click({ testId: "browser-window-new-tab" });
    const opened = await probe.eventually(() => ownedTabs(), { within: WITHIN, until: (tabs) => tabs.length === 2, label: "the window opens a second tab" });
    const newTabId = opened.find((tab) => tab.id !== tabId)?.id ?? "";
    await windowPage(newTabId, "the new tab is on screen in the window");
    await win.user.click({ role: "button", label: `Close tab: ${opened.find((tab) => tab.id === newTabId)?.label ?? ""}` });
    await windowPage(tabId, "closing the new tab returns to the first page");
    await browserMode("floating");
    const tabs = await ownedTabs();
    evidence.recordAssertionEvidence(
      "The window browses like a browser",
      "Typing in the window's address bar navigated the same tab; its New tab button opened a second page in the window and closing that tab returned to the first, with the window still open.",
      tabs.length === 1 && tabs[0]?.id === tabId,
    );
    await win.user.screenshot();
  });

  await step("after: resizing the window resizes the page", async () => {
    const win = await browserWindow();
    const before = (await windowPage(tabId))?.bounds.width ?? 0;
    const narrower = before - 200;
    await world.resizeWindow(win.surface, narrower, 720);
    const view = await windowPage(tabId, "the page follows the window's new size", (width) => width === narrower);
    expect(view?.bounds.width).toBe(narrower);
    evidence.recordAssertionEvidence(
      "The page follows the window",
      `The window went from ${before}px to ${narrower}px wide and the page went with it.`,
      view?.bounds.width === narrower,
    );
    await win.user.screenshot();
  });

  await step("after: a page the agent opens arrives as a tab in the window instead of pulling the browser back", async () => {
    const win = await browserWindow();
    const opened = browserTabHandle(await agent.run("browser.open_url", { url: `${world.origin}/?floating-browser=agent`, provider: "builtin" })).tabId;
    await windowPage(opened, "the agent's new page is on screen in the window");
    await browserMode("floating");
    await probe.eventually(() => win.probe.dom('[data-testid="browser-window-tab"]'), {
      within: WITHIN, until: (dom) => dom.elements.length === 2, label: "the window's tab strip shows both pages",
    });
    const stillOpen = await world.floatingWindowOpen();
    expect(stillOpen).toBe(true);
    evidence.recordAssertionEvidence(
      "The agent works in the window",
      "A page the agent opened while the browser was popped out came up as a second tab in the window; the side panel stayed closed.",
      stillOpen,
    );
    await win.user.screenshot();
    await win.user.click({ role: "button", label: `Close tab: ${(await ownedTabs()).find((tab) => tab.id === opened)?.label ?? ""}` });
    await windowPage(tabId, "the first page is back on screen in the window");
  });

  await step("after: closing the window puts the page back beside the chat", async () => {
    const win = await browserWindow();
    await world.closeWindow(win.surface).catch(() => undefined);
    await browserMode("side");
    await browserWindowClosed();
    const view = await pageView(true);
    expect(view).toMatchObject({ tabId });
    evidence.recordAssertionEvidence(
      "Closing the window docks the browser",
      `Closing the window put the same page back beside the chat (${view?.bounds.width ?? 0}px wide).`,
      view?.tabId === tabId,
    );
    await user.screenshot();
  });

  await step("after: the window's own button puts the page back too", async () => {
    await user.click({ testId: "browser-mode-float" });
    const win = await browserWindow();
    await win.user.click({ testId: "browser-mode-side" });
    await browserMode("side");
    await browserWindowClosed();
    const view = await pageView(true);
    expect(view).toMatchObject({ tabId });
    await user.screenshot();
  });

  await step("after: the Browser button only opens and closes the side panel; it never pops the page out", async () => {
    await user.click({ testId: "browser-mode-float" });
    await browserMode("floating");
    // From the window, the button docks the page back beside the chat.
    await user.click(toggle);
    await browserMode("side");
    await browserWindowClosed();
    await pageView(true);
    await user.click(toggle);
    await browserMode("hidden");
    expect(await pageView(false)).toMatchObject({ tabId });
    // The person last popped the page out, yet showing it again opens the side panel, not a window.
    await user.click(toggle);
    await browserMode("side");
    const view = await pageView(true);
    const popped = await world.floatingWindowOpen();
    expect(popped).toBe(false);
    const tabs = await ownedTabs();
    expect(tabs.map((tab) => tab.id)).toEqual([tabId]);
    evidence.recordAssertionEvidence(
      "The Browser button toggles the side panel only",
      `It docked the popped-out page beside the chat, hid it, and showed it beside the chat again (${view?.bounds.width ?? 0}px wide) with no window and the same single tab (${tabs.length} owned by this chat).`,
      !popped && tabs.length === 1 && tabs[0]?.id === tabId,
    );
    await user.screenshot();
  });

  await step("after: full screen shows the same page across the whole screen and Escape comes back", async () => {
    await user.click({ testId: "browser-mode-fullscreen" });
    await user.see(fullscreen);
    await user.see({ testId: "browser-fullscreen-exit" });
    await browserMode("fullscreen");
    // Rest the pointer on Exit (no tooltip), so a toolbar tooltip under the
    // old pointer position cannot legitimately cover the page.
    await user.hover({ testId: "browser-fullscreen-exit" });
    const view = await probe.eventually(() => pageView(true), { within: WITHIN, until: (value) => (value?.bounds.width ?? 0) > sideWidth, label: "the native page fills the wider full-screen view" });
    const width = view?.bounds.width ?? 0;
    const screenFull = await probe.eventually(() => world.appFullscreen(), {
      within: WITHIN, until: Boolean, label: "the app window enters full screen",
    });
    await user.screenshot();
    await user.press("Escape");
    await probe.eventually(() => probe.dom('[data-testid="browser-fullscreen-dialog"]'), { within: WITHIN, until: (dom) => dom.elements.length === 0, label: "full screen finishes closing" });
    await browserMode("side");
    const windowed = !(await probe.eventually(() => world.appFullscreen(), { within: WITHIN, until: (full) => !full, label: "the app window leaves full screen" }));
    evidence.recordAssertionEvidence(
      "Full screen paints the same page across the screen",
      `The app window went full screen with the same tab painted ${width}px wide, against ${sideWidth}px beside the chat, and Escape returned it beside the chat.`,
      width > sideWidth && screenFull && windowed,
    );
  });

  await step("after: the person takes over the page from the window itself", async () => {
    await user.click({ testId: "browser-mode-float" });
    const win = await browserWindow();
    await win.user.click({ role: "button", label: "Take over" });
    await win.user.see({ role: "button", label: "Resume browser" });
    await win.user.click({ role: "button", label: "Resume browser" });
    await win.user.see({ role: "button", label: "Take over" });
    const view = await windowPage(tabId);
    expect(view).toMatchObject({ tabId, poppedOut: true, visible: true });
    evidence.recordAssertionEvidence("Takeover works from the window", "Take over and Resume browser sit in the window's own toolbar and the page stays live in the window throughout.", view?.poppedOut === true);
    await win.user.screenshot();
  });
});
