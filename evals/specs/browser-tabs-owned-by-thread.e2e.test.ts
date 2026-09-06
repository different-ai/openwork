import { expect } from "vitest";
import type { Target } from "@openwork/cdp";
import { eventually, spec } from "@openwork/testkit";
import { builtinBrowserWorld } from "../worlds/browser-panel.ts";

const test = spec.world(builtinBrowserWorld);

// A user reads one conversation while another conversation's agent browses the
// web. The browser tab belongs to the conversation whose agent opened it: it
// must never pop into the conversation on screen, yet the agent must still be
// able to read, click, type, and screenshot the hidden page. Switching to the
// owning conversation shows its page already loaded.
const tabButton = (name: string): Target => ({ role: "button", label: new RegExp(`^Select tab: .*viewport-probe=${name}$`) });
// A conversation's row in the sidebar, found by the title the user reads there.
const conversation = (title: string): Target => ({ text: title });
// The desktop lays a hidden conversation's tab out at this viewport (see
// @openwork/browser-tabs) so the agent sees a desktop-sized page.
const BACKGROUND_TAB_VIEWPORT = { width: 1280, height: 800 };

test("a background conversation's agent browses silently and its page is waiting when the user switches to it", async ({ world, user, step }) => {
  const reading = { ...world.session, title: "Reading the news" };
  await world.renameSession(reading.sessionId, reading.title);
  const researching = await world.openSession("Background research");
  await user.click(conversation(reading.title));
  const readingTab = await world.openTabAs("reading", reading.sessionId);
  await user.see(tabButton(readingTab.name), { timeoutMs: 30_000 });
  const panelViewport = await world.readViewport(readingTab);
  expect(panelViewport.width).toBeGreaterThan(0);
  expect(panelViewport.width).toBeLessThan(BACKGROUND_TAB_VIEWPORT.width);

  const researchTab = await step("The background conversation opens a page without touching the screen", async () => {
    const opened = await world.openTabAs("research", researching.sessionId);
    expect(opened).toMatchObject({ ownerSessionId: researching.sessionId, visible: false });

    const state = await world.readBrowserState();
    expect(state.visibleSessionId).toBe(reading.sessionId);
    expect(state.activeTabId).toBe(readingTab.tabId);
    expect(state.tabs.find((tab) => tab.id === opened.tabId)?.ownerSessionId).toBe(researching.sessionId);
    expect(state.nativeViews.find((view) => view.tabId === opened.tabId)).toMatchObject({
      attached: false,
      aboveApp: false,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    });
    await user.see(tabButton(readingTab.name));
    await user.notSee(tabButton(opened.name));
    expect(await world.readViewport(readingTab)).toEqual(panelViewport);
    return opened;
  });

  await step("The hidden page is real for the agent: viewport, focus, clicks, typing, screenshot", async () => {
    const probe = await eventually(() => world.readPageProbe(researchTab), {
      within: 15_000,
      until: (value) => value.width === BACKGROUND_TAB_VIEWPORT.width && value.hasFocus,
      label: "background tab lays out at the background viewport and believes it is focused",
    });
    expect(probe).toMatchObject({ ...BACKGROUND_TAB_VIEWPORT, hasFocus: true });

    await world.loadInputProbe(researchTab);
    expect(await world.clickAndType(researchTab, "ok")).toEqual({ clicks: 1, value: "ok" });

    const screenshot = await world.screenshotSize(researchTab);
    expect(screenshot.width).toBeGreaterThanOrEqual(BACKGROUND_TAB_VIEWPORT.width);
    expect(screenshot.height).toBeGreaterThanOrEqual(BACKGROUND_TAB_VIEWPORT.height);
  });

  await step("Closing the panel leaves no browser surface above OpenWork while background browsing continues", async () => {
    await user.click({ role: "button", label: "Close side panel" });
    const hidden = await eventually(() => world.readBrowserState(), {
      within: 15_000,
      until: (state) => state.nativeViews.every((view) => !view.aboveApp),
      label: "no native browser view covers OpenWork after the panel closes",
    });
    expect(hidden.nativeViews.find((view) => view.tabId === readingTab.tabId)?.attached).toBe(false);
    expect(hidden.nativeViews.find((view) => view.tabId === researchTab.tabId)).toMatchObject({ attached: false, aboveApp: false });
    expect(await world.clickAndType(researchTab, "ok")).toEqual({ clicks: 2, value: "okok" });
    const screenshot = await world.screenshotSize(researchTab);
    expect(screenshot.width).toBeGreaterThanOrEqual(BACKGROUND_TAB_VIEWPORT.width);
    expect(screenshot.height).toBeGreaterThanOrEqual(BACKGROUND_TAB_VIEWPORT.height);
    await user.click({ role: "button", label: "Open side panel" });
    await user.see(tabButton(readingTab.name));
  });

  await step("Switching to the background conversation shows its page at the panel's size", async () => {
    await user.click(conversation(researching.title));
    const state = await eventually(() => world.readBrowserState(), {
      within: 30_000,
      until: (value) => value.visibleSessionId === researching.sessionId && value.activeTabId === researchTab.tabId,
      label: "the research conversation's tab takes the screen",
    });
    expect(state.tabs.map((tab) => tab.ownerSessionId).sort()).toEqual([reading.sessionId, researching.sessionId].sort());
    await user.notSee(tabButton(readingTab.name));

    const restored = await eventually(() => world.readViewport(researchTab), {
      within: 15_000,
      until: (viewport) => viewport.width === panelViewport.width,
      label: "the shown tab lays out for the panel again",
    });
    expect(restored).toEqual(panelViewport);
    const native = await world.readBrowserState();
    expect(native.nativeViews.find((view) => view.tabId === researchTab.tabId)).toMatchObject({ attached: true, aboveApp: true });
    expect(native.nativeViews.find((view) => view.tabId === readingTab.tabId)).toMatchObject({
      attached: false,
      aboveApp: false,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    });
  });

  await step("Returning to the first conversation brings back only its own tab", async () => {
    await user.click(conversation(reading.title));
    await eventually(() => world.readBrowserState(), {
      within: 30_000,
      until: (value) => value.visibleSessionId === reading.sessionId && value.activeTabId === readingTab.tabId,
      label: "the reading conversation's tab is back on screen",
    });
    await user.see(tabButton(readingTab.name), { timeoutMs: 30_000 });
    expect(await world.readViewport(readingTab)).toEqual(panelViewport);
  });
});
