import { expect } from "vitest";
import type { Target } from "@openwork/cdp";
import { eventually, spec } from "@openwork/testkit";
import { builtinBrowserWorld, transcriptLinkWorld } from "../worlds/browser-panel.ts";

const test = spec.world(async (seed) => {
  const world = await builtinBrowserWorld(seed);
  return { ...world, withTranscriptLink: () => transcriptLinkWorld(seed, world) };
});

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
    expect(state).toMatchObject({ visibleWindowCount: 1, backgroundWindowVisible: false });
    expect(state.visibleSessionId).toBe(reading.sessionId);
    expect(state.activeTabId).toBe(readingTab.tabId);
    expect(state.tabs.find((tab) => tab.id === opened.tabId)?.ownerSessionId).toBe(researching.sessionId);
    expect(state.nativeViews.find((view) => view.tabId === opened.tabId)).toMatchObject({
      attached: false,
      aboveApp: false,
      bounds: { x: 0, y: 0, ...BACKGROUND_TAB_VIEWPORT },
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
    expect(hidden).toMatchObject({ visibleWindowCount: 1, backgroundWindowVisible: false });
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
      bounds: { x: 0, y: 0, ...BACKGROUND_TAB_VIEWPORT },
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

test("a transcript link's menu copies its exact address and opens only its own conversation's browser", async ({ world: browserWorld, user, step }) => {
  const world = await browserWorld.withTranscriptLink();
  const link: Target = { role: "link", label: world.linkUrl };
  const menuItem = (label: string): Target => ({ role: "menuitem", label });
  await user.see(link);
  expect(await world.readLink()).toEqual({ href: world.linkUrl, sessionId: world.reading.sessionId });
  const initial = await eventually(() => world.readBrowserState(), {
    within: 15_000,
    until: state => state.visibleSessionId === world.reading.sessionId,
    label: "the link's conversation is on screen",
  });
  expect(initial.tabs.map(tab => ({ id: tab.id, ownerSessionId: tab.ownerSessionId }))).toEqual([
    { id: world.neighborTab.tabId, ownerSessionId: world.neighbor.sessionId },
  ]);
  const mainUrl = await world.readMainUrl();
  const pages = await world.pageTargets();
  const unchanged = async () => {
    const state = await world.readBrowserState();
    expect(state.tabs).toEqual(initial.tabs);
    expect(state.activeTabId).toBe(initial.activeTabId);
    expect(state.visibleSessionId).toBe(world.reading.sessionId);
    expect(await world.readMainUrl()).toBe(mainUrl);
    expect(await world.pageTargets()).toEqual(pages);
    await user.see(link);
  };

  await user.rightClick(link);
  const attached = await eventually(() => world.menuOverlay(), {
    within: 15_000, until: value => value !== null, label: "the native overlay.html menu target appears",
  });
  if (!attached) throw new Error("The link context menu has no native overlay surface.");
  await using overlay = attached;
  const menu = user.on(overlay);
  const menuShown = (shown: boolean) => eventually(() => world.menuShown(overlay), {
    within: 10_000, until: value => value === shown,
    label: shown ? "the native link menu is rendered" : "the dismissed link menu is cleared",
  });

  await step("Right-click and Escape leave the transcript and every browser page unchanged", async () => {
    await menuShown(true);
    for (const label of ["Open in OpenWork", "Open in Default Browser", "Copy Link Address"]) {
      await menu.see(menuItem(label));
    }
    // TargetRole excludes menu; keep its container semantics as a DOM observation.
    expect(await world.menuLabels(overlay)).toEqual(["link context menu"]);
    await user.notSee(menuItem("Edit message"));
    await unchanged();
    await menu.press("Escape");
    await menuShown(false);
    await unchanged();
  });

  await step("Copy Link Address copies the exact URL, not the whole message, without opening a page", async () => {
    await user.rightClick(link);
    await menuShown(true);
    await menu.click(menuItem("Copy Link Address"));
    await menuShown(false);
    // Clipboard reads require the app document to be focused.
    await user.click("composer");
    expect(await world.readClipboard()).toBe(world.linkUrl);
    await unchanged();
  });

  await step("Right-clicking nonlink message text still offers the message menu", async () => {
    await user.rightClick({ text: world.note });
    await user.see(menuItem("Edit message"));
    await user.see(menuItem("Copy"));
    await user.notSee(menuItem("Open in OpenWork"));
    expect(await world.menuShown(overlay)).toBe(false);
    await user.press("Escape");
    await user.notSee(menuItem("Edit message"));
    await unchanged();
  });

  const opened = await step("Open in OpenWork creates exactly one tab owned by the link's conversation", async () => {
    await user.rightClick(link);
    await menuShown(true);
    await menu.click(menuItem("Open in OpenWork"));
    await menuShown(false);
    const state = await eventually(() => world.readBrowserState(), {
      within: 30_000,
      until: value => value.tabs.some(tab => tab.url === world.linkUrl && tab.id === value.activeTabId),
      label: "the selected built-in tab loads the exact transcript URL",
    });
    const tab = state.tabs.find(tab => tab.id === state.activeTabId);
    if (!tab) throw new Error("The transcript link did not select a built-in browser tab.");
    expect(tab).toMatchObject({ url: world.linkUrl, ownerSessionId: world.reading.sessionId });
    expect(state.tabs).toHaveLength(initial.tabs.length + 1);
    expect(state.tabs.filter(candidate => candidate.id !== tab.id)).toEqual(initial.tabs);
    expect(state.visibleSessionId).toBe(world.reading.sessionId);
    await user.see({ role: "button", label: `Select tab: ${tab.label}` });
    await user.see({ placeholder: "Enter URL..." }, { value: world.linkUrl });
    await user.notSee(tabButton(world.neighborTab.name));
    await eventually(() => world.readBrowserState(), {
      within: 15_000,
      until: value => value.nativeViews.some(view => view.tabId === tab.id && view.attached && view.aboveApp),
      label: "the new owned browser page is visible in the side panel",
    });
    expect(await world.readMainUrl()).toBe(mainUrl);
    return tab;
  });

  await step("Switching conversations never shows or duplicates the other conversation's tab", async () => {
    await user.click(conversation(world.neighbor.title));
    const state = await eventually(() => world.readBrowserState(), {
      within: 30_000,
      until: value => value.visibleSessionId === world.neighbor.sessionId && value.activeTabId === world.neighborTab.tabId,
      label: "the unrelated conversation restores only its original browser tab",
    });
    expect(state.tabs.filter(tab => tab.ownerSessionId === world.neighbor.sessionId)).toEqual(initial.tabs);
    expect(state.tabs.filter(tab => tab.ownerSessionId === world.reading.sessionId)).toEqual([opened]);
    expect(state.tabs).toHaveLength(2);
    await user.see(tabButton(world.neighborTab.name));
    await user.notSee({ role: "button", label: `Select tab: ${opened.label}` });
    await user.click(conversation(world.reading.title));
    await eventually(() => world.readBrowserState(), {
      within: 30_000,
      until: value => value.visibleSessionId === world.reading.sessionId && value.activeTabId === opened.id,
      label: "the link's conversation restores its selected browser tab",
    });
    await user.see(link);
    await user.see({ placeholder: "Enter URL..." }, { value: world.linkUrl });
  });

  await step("Normal click opens an owned sidebar tab instead of a separate native window", async () => {
    const before = await world.pageTargets();
    const browserBefore = await world.readBrowserState();
    await user.click(link);
    const state = await eventually(() => world.readBrowserState(), {
      within: 30_000,
      until: value => value.tabs.some(tab => tab.url === world.linkUrl && tab.id === value.activeTabId
        && !browserBefore.tabs.some(previous => previous.id === tab.id))
        && value.nativeViews.some(view => view.tabId === value.activeTabId && view.attached),
      label: "a normal link click selects its owned sidebar page",
    });
    expect(state.tabs).toHaveLength(browserBefore.tabs.length + 1);
    expect(state.tabs.find(tab => tab.id === state.activeTabId)?.ownerSessionId).toBe(world.reading.sessionId);
    expect(state.tabs.filter(tab => tab.id !== state.activeTabId)).toEqual(browserBefore.tabs);
    expect(state).toMatchObject({ visibleWindowCount: 1, backgroundWindowVisible: false });
    const newPages = (await world.pageTargets()).filter(page => !before.some(previous => previous.id === page.id));
    expect(newPages).toHaveLength(1);
    expect(newPages[0].url).toBe(world.linkUrl);
    expect(await world.readMainUrl()).toBe(mainUrl);
    expect(await world.menuShown(overlay)).toBe(false);
  });
});

test("a transcript link replaces the selected artifact with its own live sidebar tab, not a native window", async ({ world, user, step }) => {
  const reading = { ...world.session, title: "Linked research" };
  await world.renameSession(reading.sessionId, reading.title);
  const link = await world.seedTranscriptLink(reading.sessionId);
  const other = await world.openSession("Other conversation");
  const otherTab = await world.openTabAs("other-conversation", other.sessionId);
  await user.see(tabButton(otherTab.name), { timeoutMs: 30_000 });
  await user.click(conversation(reading.title));
  await user.see({ role: "link", text: link.url }, { timeoutMs: 30_000 });
  await user.click({ role: "button", text: link.artifactName });
  await user.see({ role: "button", label: `Select tab: ${link.artifactName}` }, { timeoutMs: 30_000 });
  await user.see({ text: link.artifactText }, { timeoutMs: 30_000 });
  const before = await world.readBrowserState();
  expect(before.tabs).toHaveLength(1);
  expect(before.tabs.filter((tab) => tab.ownerSessionId === reading.sessionId)).toEqual([]);
  expect(before).toMatchObject({ visibleSessionId: reading.sessionId, visibleWindowCount: 1, backgroundWindowVisible: false });

  const linkedTab = await step("Clicking the real transcript link selects exactly one owned sidebar page with the complete URL", async () => {
    await user.click({ role: "link", text: link.url });
    const state = await eventually(() => world.readBrowserState(), {
      within: 30_000,
      until: (value) => value.tabs.some((tab) => tab.url === link.url && tab.id === value.activeTabId
        && value.nativeViews.some((view) => view.tabId === tab.id && view.attached && view.aboveApp)),
      label: "the transcript URL is selected and attached in the sidebar",
    });
    const owned = state.tabs.filter((tab) => tab.ownerSessionId === reading.sessionId);
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ id: state.activeTabId, url: link.url });
    expect(state).toMatchObject({ visibleSessionId: reading.sessionId, visibleWindowCount: 1, backgroundWindowVisible: false });
    expect(state.tabs.filter((tab) => tab.ownerSessionId !== reading.sessionId)).toEqual(before.tabs);
    expect(state.nativeViews.filter((view) => view.attached || view.aboveApp).map((view) => view.tabId)).toEqual([owned[0].id]);
    await user.see({ role: "button", label: `Select tab: ${owned[0].label}` });
    await user.notSee({ text: link.artifactText });
    await user.notSee(tabButton(otherTab.name));
    return eventually(() => world.tabHandle(owned[0]), { within: 15_000, label: "the exact transcript URL has one CDP target" });
  });

  await step("Hiding and showing the sidebar keeps the same CDP page and its live input", async () => {
    await world.loadInputProbe(linkedTab);
    expect(await world.clickAndType(linkedTab, "before")).toEqual({ clicks: 1, value: "before" });
    const viewport = await world.readViewport(linkedTab);
    await user.click({ role: "button", label: "Close side panel" });
    const hidden = await eventually(() => world.readBrowserState(), {
      within: 15_000,
      until: (state) => state.nativeViews.every((view) => !view.attached && !view.aboveApp),
      label: "closing the sidebar hides every native browser view",
    });
    expect(hidden).toMatchObject({ visibleWindowCount: 1, backgroundWindowVisible: false });
    expect(await world.readInputProbe(linkedTab)).toEqual({ clicks: 1, value: "before" });
    await user.click({ role: "button", label: "Open side panel" });
    const shown = await eventually(() => world.readBrowserState(), {
      within: 15_000,
      until: (state) => state.activeTabId === linkedTab.tabId
        && state.nativeViews.some((view) => view.tabId === linkedTab.tabId && view.attached && view.aboveApp),
      label: "the same browser tab returns to the sidebar",
    });
    expect(shown).toMatchObject({ visibleWindowCount: 1, backgroundWindowVisible: false });
    expect(await world.clickAndType(linkedTab, "-shown")).toEqual({ clicks: 2, value: "before-shown" });
    expect(await eventually(() => world.readViewport(linkedTab), {
      within: 15_000,
      until: (value) => value.width === viewport.width && value.height === viewport.height,
      label: "the preserved page returns to its sidebar viewport",
    })).toEqual(viewport);
  });

  await step("A page refresh preserves the selected artifact, but a new browser request selects its working page", async () => {
    await world.navigateTab(linkedTab, link.url);
    await user.click({ role: "button", label: `Select tab: ${link.artifactName}` });
    await user.see({ text: link.artifactText });
    await world.reloadTab(linkedTab);
    await user.see({ text: link.artifactText });
    expect((await world.readBrowserState()).nativeViews.every((view) => !view.attached)).toBe(true);

    const requested = await world.openTabAs("requested-preview", reading.sessionId);
    const state = await eventually(() => world.readBrowserState(), {
      within: 15_000,
      until: (value) => value.activeTabId === requested.tabId
        && value.nativeViews.some((view) => view.tabId === requested.tabId && view.attached),
      label: "the explicit browser request replaces the artifact with its working page",
    });
    expect(state).toMatchObject({ visibleWindowCount: 1, backgroundWindowVisible: false });
    await user.see(tabButton(requested.name));
    await user.notSee({ text: link.artifactText });
  });

  await step("The other conversation keeps its original tab and page", async () => {
    await user.click(conversation(other.title));
    const state = await eventually(() => world.readBrowserState(), {
      within: 30_000,
      until: (value) => value.visibleSessionId === other.sessionId && value.activeTabId === otherTab.tabId
        && value.nativeViews.some((view) => view.tabId === otherTab.tabId && view.attached && view.aboveApp),
      label: "the other conversation restores only its original browser tab",
    });
    expect(state.tabs.filter((tab) => tab.ownerSessionId === other.sessionId)).toEqual(before.tabs);
    expect(state.tabs).toHaveLength(3);
    expect(state).toMatchObject({ visibleWindowCount: 1, backgroundWindowVisible: false });
    expect(state.nativeViews.find((view) => view.tabId === linkedTab.tabId)).toMatchObject({ attached: false, aboveApp: false });
    expect((await world.tabHandle(before.tabs[0])).targetId).toBe(otherTab.targetId);
    await user.see(tabButton(otherTab.name));
    await user.notSee({ role: "link", text: link.url });
  });
});
