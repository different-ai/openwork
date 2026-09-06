import { expect } from "vitest";
import { browserImageTarget, eventually, spec } from "@openwork/testkit";
import type { BrowserTaskInput, Target } from "@openwork/testkit";
import { browserTabHandle, transcriptLinkWorld } from "../worlds/browser-panel.ts";
import { browserBackgroundWorld } from "../worlds/browser-webmcp.ts";

const test = spec.world(browserBackgroundWorld);
const linkTest = spec.world(transcriptLinkWorld);
const tabButton = (name: string): Target => ({ role: "button", label: `Select tab: Project ${name}` });
const conversation = (title: string): Target => ({ text: title });
const BACKGROUND_TAB_VIEWPORT = { width: 1280, height: 800 };

test("a background conversation reads its owned page silently and requests attention before acting", async ({ world, user, agent, probe, step, evidence }) => {
  const reading = { ...world.session, title: "Reading the news" };
  await agent.run("session.rename", { sessionId: reading.sessionId, title: reading.title });
  const researching = { sessionId: await agent.createSession("Background research"), title: "Background research" };
  await user.click(conversation(reading.title));
  const readingTab = browserTabHandle(await agent.run("browser.open_url", { url: `${world.origin}/?viewport-probe=reading`, provider: "builtin" }));
  await user.see(tabButton("reading"), { timeoutMs: 30_000 });
  const initial = await probe.browserTabMetrics(readingTab.targetId);
  const panelViewport = { width: initial.width, height: initial.height };
  expect(panelViewport.width).toBeGreaterThan(0);
  expect(panelViewport.width).toBeLessThan(BACKGROUND_TAB_VIEWPORT.width);
  const witness = () => probe.browserFixtureState(world.origin);

  const researchTab = await step("A background-origin browser command opens a page without touching the viewed conversation", async () => {
    const response = await agent.desktopApi("/experimental/ui-control/request", { method: "POST", body: {
      kind: "command", input: { id: "browser.open_url", args: { url: `${world.origin}/?viewport-probe=research`, provider: "builtin" }, origin: { sessionId: researching.sessionId } },
    } });
    expect(response.status).toBe(200);
    const result = response.body;
    if (!result || typeof result !== "object" || !("result" in result)) throw new Error("The background browser command returned no result.");
    expect(result).toMatchObject({ ok: true, result: { owner_session_id: researching.sessionId, visible: false } });
    const opened = browserTabHandle(result.result);
    const state = await probe.browserState();
    expect(state).toMatchObject({ visibleSessionId: reading.sessionId, activeTabId: readingTab.tabId });
    expect(state.tabs.find((tab) => tab.id === opened.tabId)?.ownerSessionId).toBe(researching.sessionId);
    expect(state.nativeViews.find((view) => view.tabId === opened.tabId)).toMatchObject({ attached: false, aboveApp: false, bounds: { x: 0, y: 0, ...BACKGROUND_TAB_VIEWPORT } });
    await user.see(tabButton("reading"));
    await user.notSee(tabButton("research"));
    expect(await probe.browserTabMetrics(readingTab.targetId)).toMatchObject(panelViewport);
    evidence.recordAssertionEvidence("Background browsing preserves the viewed conversation", "The origin-stamped command opened an owned background tab. It left the visible conversation, active tab, panel dimensions and detached native view unchanged.", true);
    return opened;
  });
  const task = (operation: BrowserTaskInput["operation"], args: BrowserTaskInput["args"] = {}) => agent.browserTask({ sessionId: researching.sessionId, operation, args: { tabId: researchTab.tabId, ...args } });

  await step("The browser reads and images a hidden page, but click, fill and site callbacks need attention", async () => {
    await user.click(conversation(researching.title));
    const access = task("observe");
    await user.click({ role: "button", label: "Allow once" });
    expect((await access).ok).toBe(true);
    await user.click(conversation(reading.title));
    const metrics = await probe.eventually(() => probe.browserTabMetrics(researchTab.targetId), { within: 15_000, until: (value) => value.width === BACKGROUND_TAB_VIEWPORT.width && value.hasFocus, label: "the hidden page has its background viewport and focus" });
    expect(metrics).toMatchObject({ ...BACKGROUND_TAB_VIEWPORT, hasFocus: true });
    const observed = await task("observe", { includeImage: true });
    expect(observed.text).toContain("Project status");
    expect(browserImageTarget(observed.image)).toMatchObject(BACKGROUND_TAB_VIEWPORT);
    const actions: Array<{ type: "click" | "fill"; name: string; text?: string }> = [{ type: "click", name: "Save draft" }, { type: "fill", name: "Draft title", text: "ok" }];
    for (const action of actions) {
      const fresh = await task("observe");
      const ref = fresh.elements?.find((element) => element.name === action.name)?.ref;
      if (!ref) throw new Error(`Missing observed ${action.name} control.`);
      expect(await task("act", { observationId: fresh.observationId, action: { type: action.type, ref, text: action.text } })).toMatchObject({ ok: false, code: "needs_attention" });
    }
    const listed = await task("site_tools");
    const tool = listed.tools?.find((tool) => tool.name === "read_session");
    if (!tool) throw new Error("The hidden page did not list its session-read tool.");
    expect(await task("site_tool", { toolId: tool.toolId })).toMatchObject({ ok: false, code: "needs_attention" });
    expect(await witness()).toMatchObject({ sessionReads: 0, records: [], inputValue: "", signInCount: 0 });
    expect(await probe.browserState()).toMatchObject({ visibleSessionId: reading.sessionId, activeTabId: readingTab.tabId });
    expect(await probe.browserTabMetrics(readingTab.targetId)).toMatchObject(panelViewport);
    evidence.recordAssertionEvidence("Hidden browser tools read without unapproved mutations", "The browser/task boundary returned real text and a decoded 1280 by 800 image. Click, fill and site callbacks returned needs_attention with zero fixture writes or session reads and no foreground change.", true);
  });

  await step("Closing the panel removes all native overlays while background observation continues", async () => {
    await user.click({ role: "button", label: "Close side panel" });
    const hidden = await probe.eventually(() => probe.browserState(), { within: 15_000, until: (state) => state.nativeViews.every((view) => !view.aboveApp), label: "no browser view covers OpenWork" });
    expect(hidden.nativeViews.find((view) => view.tabId === readingTab.tabId)?.attached).toBe(false);
    expect(hidden.nativeViews.find((view) => view.tabId === researchTab.tabId)).toMatchObject({ attached: false, aboveApp: false });
    const observed = await task("observe", { includeImage: true });
    expect(observed.text).toContain("Nothing saved");
    expect(browserImageTarget(observed.image)).toMatchObject(BACKGROUND_TAB_VIEWPORT);
    const ref = observed.elements?.find((element) => element.name === "Save draft")?.ref;
    if (!ref) throw new Error("Missing hidden Save draft control.");
    expect(await task("act", { observationId: observed.observationId, action: { type: "click", ref } })).toMatchObject({ ok: false, code: "needs_attention" });
    expect(await witness()).toMatchObject({ records: [], inputValue: "", sessionReads: 0 });
    await user.click({ role: "button", label: "Open side panel" });
    await user.see(tabButton("reading"));
  });

  await step("Switching to the owner restores its native view and permits only explicitly approved actions", async () => {
    await user.click(conversation(researching.title));
    const state = await probe.eventually(() => probe.browserState(), { within: 30_000, until: (value) => value.visibleSessionId === researching.sessionId && value.activeTabId === researchTab.tabId, label: "the research conversation takes the screen" });
    expect(state.tabs.map((tab) => tab.ownerSessionId).sort()).toEqual([reading.sessionId, researching.sessionId].sort());
    await user.notSee(tabButton("reading"));
    await user.see(tabButton("research"));
    const restored = await probe.eventually(() => probe.browserTabMetrics(researchTab.targetId), { within: 15_000, until: (value) => value.width === panelViewport.width && value.height === panelViewport.height, label: "the owned page matches the panel dimensions" });
    expect(restored).toMatchObject(panelViewport);
    const native = await probe.browserState();
    expect(native.nativeViews.find((view) => view.tabId === researchTab.tabId)).toMatchObject({ attached: true, aboveApp: true });
    expect(native.nativeViews.find((view) => view.tabId === readingTab.tabId)).toMatchObject({ attached: false, aboveApp: false, bounds: { x: 0, y: 0, ...BACKGROUND_TAB_VIEWPORT } });
    const actions: Array<{ type: "click" | "fill"; name: string; text?: string }> = [{ type: "click", name: "Save draft" }, { type: "fill", name: "Draft title", text: "ok" }];
    for (const action of actions) {
      const observed = await task("observe");
      const ref = observed.elements?.find((element) => element.name === action.name)?.ref;
      if (!ref) throw new Error(`Missing observed ${action.name} control.`);
      const before = await witness();
      const pending = task("act", { observationId: observed.observationId, action: { type: action.type, ref, text: action.text } });
      await user.see({ role: "button", label: "Allow once" });
      expect(await witness()).toMatchObject({ records: before.records, inputValue: before.inputValue });
      await user.click({ role: "button", label: "Allow once" });
      expect(await pending).toMatchObject({ ok: true, dispatched: true, outcome: "not_yet_verified" });
      if (action.type === "click") await probe.eventually(() => task("observe"), { within: 5_000, until: (value) => value.text?.includes("Saved 1") === true, label: "the approved save visibly completes before the next action" });
    }
    const completed = await probe.eventually(witness, { within: 5_000, until: (value) => value.records.length === 1 && value.inputValue === "ok", label: "the fixture receives only the approved click and text" });
    expect(completed.records).toEqual([{ method: "dom", count: 1, signedIn: false }]);
    expect((await task("observe")).text).toContain("Saved 1");
    evidence.recordAssertionEvidence("Selecting the owner restores its tab and approved actions", "Native attachment, z-order and both panel dimensions recovered. The guest fixture saw no writes before approval, then one DOM save and the expected field value; a new page observation verified Saved 1.", true);
  });

  await step("A paused background conversation cannot open through the legacy automation command", async () => {
    await user.click({ role: "button", label: "Take over" });
    await user.click(conversation(reading.title));
    const before = await probe.browserState();
    const requests = (await witness()).pageRequests;
    const response = await agent.desktopApi("/experimental/ui-control/request", { method: "POST", body: {
      kind: "command", input: { id: "browser.open_url", args: { url: `${world.origin}/paused-open`, provider: "builtin" }, origin: { sessionId: researching.sessionId } },
    } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: false, error: expect.stringMatching(/user has browser control/i) });
    expect(await probe.browserState()).toEqual(before);
    expect((await witness()).pageRequests).toEqual(requests);
    await user.see(tabButton("reading"));
    await user.notSee(tabButton("paused-open"));
    expect(await probe.browserTabMetrics(readingTab.targetId)).toMatchObject(panelViewport);
  });

  await step("Returning to the first conversation brings back only its own tab", async () => {
    await probe.eventually(() => probe.browserState(), { within: 30_000, until: (value) => value.visibleSessionId === reading.sessionId && value.activeTabId === readingTab.tabId, label: "the reading tab returns" });
    await user.see(tabButton("reading"));
    await user.notSee(tabButton("research"));
    expect(await probe.browserTabMetrics(readingTab.targetId)).toMatchObject(panelViewport);
  });
});

linkTest("a transcript link's menu copies its exact address and opens only its own conversation's browser", async ({ world, user, step }) => {
  const tabButton = (name: string): Target => ({ role: "button", label: new RegExp(`^Select tab: .*viewport-probe=${name}$`) });
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

  await step("Normal click keeps the existing loopback-popup behavior without launching a system browser", async () => {
    // Main-window target=_blank links to loopback are allowed as Electron popups.
    // Do not substitute a public URL here: those launch the user's system browser.
    expect(["127.0.0.1", "localhost"]).toContain(new URL(world.linkUrl).hostname);
    const before = await world.pageTargets();
    const browserBefore = await world.readBrowserState();
    await user.click(link);
    const after = await eventually(() => world.pageTargets(), {
      within: 15_000,
      until: value => value.some(page => page.url === world.linkUrl && !before.some(previous => previous.id === page.id)),
      label: "a normal link click opens its existing Electron popup",
    });
    const popups = after.filter(page => !before.some(previous => previous.id === page.id));
    try {
      expect(popups).toHaveLength(1);
      expect(popups[0]?.url).toBe(world.linkUrl);
      expect((await world.readBrowserState()).tabs).toEqual(browserBefore.tabs);
      expect(await world.readMainUrl()).toBe(mainUrl);
      expect(await world.menuShown(overlay)).toBe(false);
    } finally {
      for (const popup of popups) await world.closePopup(popup.id);
    }
    expect(await eventually(() => world.pageTargets(), {
      within: 10_000, until: value => value.length === before.length,
      label: "the normal-click popup is closed without changing existing pages",
    })).toEqual(before);
  });
});
