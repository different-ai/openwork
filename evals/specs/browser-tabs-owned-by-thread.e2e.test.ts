import { expect } from "vitest";
import { browserImageTarget, eventually, spec } from "@openwork/testkit";
import type { BrowserTaskInput, Target } from "@openwork/testkit";
import { browserTabHandle, createBuiltinBrowserWorld, transcriptLinkWorld } from "../worlds/browser-panel.ts";
import { browserBackgroundWorld } from "../worlds/browser-webmcp.ts";

const test = spec.world(browserBackgroundWorld);
const lifecycleTest = spec.world((seed) => createBuiltinBrowserWorld(seed));
const linkTest = spec.world(transcriptLinkWorld);
const artifactTest = spec.world((seed) => createBuiltinBrowserWorld(seed));
const tabButton = (name: string): Target => ({ role: "button", label: `Select tab: Project ${name}` });
const lifecycleTabButton = (name: string): Target => ({ role: "button", label: new RegExp(`^Select tab: .*viewport-probe=${name}$`) });
const conversation = (title: string): Target => ({ text: title });
const BACKGROUND_TAB_VIEWPORT = { width: 1280, height: 800 };

lifecycleTest("the global tab limit rejects new pages without disturbing live tabs, and closing a tab makes room", async ({ world, user, agent, step }) => {
  const reading = { ...world.session, title: "Reading at capacity" };
  await world.renameSession(reading.sessionId, reading.title);
  const researching = await world.openSession("Research at capacity");
  await user.click(conversation(reading.title));
  const initial = await world.readBrowserState();
  expect(initial.tabs).toEqual([]);
  expect(initial.tabLimit).toBe(12);
  const readingTab = await world.openTab("capacity-reading", reading.sessionId);
  await user.see(lifecycleTabButton(readingTab.name), { timeoutMs: 30_000 });
  const researchTab = await world.openTab("capacity-research", researching.sessionId);
  await world.loadInputProbe(researchTab);
  expect(await world.clickAndType(researchTab, "before")).toEqual({ clicks: 1, value: "before" });
  for (let index = 2; index < initial.tabLimit; index += 1) {
    await world.openTab(`capacity-${index}`, researching.sessionId);
  }
  const full = await world.readBrowserState();
  expect(full.tabs).toHaveLength(12);
  expect(full).toMatchObject({ activeTabId: readingTab.tabId, visibleSessionId: reading.sessionId,
    backgroundWindowCount: 1, backgroundWindowVisible: false, visibleWindowCount: 1 });
  const pages = await world.pageTargets();
  const retryUrl = `${world.origin}/?viewport-probe=capacity-retry`;

  await step("The new-tab button explains how to make room without allocating a page", async () => {
    await user.click({ role: "button", label: "New tab" });
    await user.see({ text: /OpenWork has 12 browser tabs open\. Close an unused browser tab in any conversation, then try again\./ });
    const rejected = await world.readBrowserState();
    expect(rejected.tabs).toEqual(full.tabs);
    expect(rejected).toMatchObject({ activeTabId: readingTab.tabId, visibleSessionId: reading.sessionId,
      backgroundWindowCount: 1, backgroundWindowVisible: false, visibleWindowCount: 1 });
    expect(await world.pageTargets()).toEqual(pages);
    expect(await world.readInputProbe(researchTab)).toEqual({ clicks: 1, value: "before" });
    await user.see(lifecycleTabButton(readingTab.name));
  });

  await step("Foreground and background opens hit the same limit without allocating or replacing a CDP page", async () => {
    await expect(agent.run("browser.open_url", { url: retryUrl, provider: "builtin" }))
      .rejects.toThrow(/12 browser tabs open.*Close.*try again/s);
    await expect(world.openTabAs("capacity-overflow", researching.sessionId))
      .rejects.toThrow(/12 browser tabs open.*Close.*try again/s);
    const rejected = await world.readBrowserState();
    expect(rejected.tabs).toEqual(full.tabs);
    expect(rejected).toMatchObject({ activeTabId: readingTab.tabId, visibleSessionId: reading.sessionId,
      backgroundWindowCount: 1, backgroundWindowVisible: false, visibleWindowCount: 1 });
    expect(await world.pageTargets()).toEqual(pages);
    expect(await world.readInputProbe(researchTab)).toEqual({ clicks: 1, value: "before" });
    expect(await world.clickAndType(researchTab, "-limited")).toEqual({ clicks: 2, value: "before-limited" });
    await user.see(lifecycleTabButton(readingTab.name));
    await user.notSee(lifecycleTabButton("capacity-retry"));
  });

  await step("Closing a visible tab releases exactly one slot and the same request succeeds", async () => {
    const readingState = full.tabs.find(tab => tab.id === readingTab.tabId);
    if (!readingState) throw new Error("The reading tab is missing at capacity.");
    await user.hover({ role: "button", label: `Select tab: ${readingState.label}` });
    await user.click({ role: "button", label: `Close tab: ${readingState.label}` });
    await eventually(async () => {
      expect((await world.readBrowserState()).tabs).toEqual(full.tabs.filter(tab => tab.id !== readingTab.tabId));
      expect(await world.pageTargets()).toEqual(pages.filter(page => page.id !== readingTab.targetId));
      return true;
    }, { within: 15_000, label: "closing the tab removes its native page and releases one slot" });

    const pending = agent.run("browser.open_url", { url: retryUrl, provider: "builtin" });
    await user.click({ role: "button", label: "Allow origin in this tab" });
    const result = await pending;
    const retried = await eventually(() => world.readBrowserState(), {
      within: 15_000,
      until: state => state.tabs.some(tab => tab.url === retryUrl && tab.id === state.activeTabId),
      label: "the capacity retry selects a new owned browser page",
    });
    const replacement = retried.tabs.find(tab => tab.url === retryUrl);
    if (!replacement) throw new Error("The capacity retry did not create a tab.");
    const handle = await world.tabHandle(replacement);
    expect(result).toMatchObject({ tab_id: handle.tabId, target_id: handle.targetId, owner_session_id: reading.sessionId });
    expect(retried.tabs).toHaveLength(12);
    expect(retried.tabs.filter(tab => tab.id !== replacement.id)).toEqual(full.tabs.filter(tab => tab.id !== readingTab.tabId));
    expect(await world.pageTargets()).toEqual([...pages.filter(page => page.id !== readingTab.targetId),
      { id: handle.targetId, url: retryUrl }].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await world.clickAndType(researchTab, "-retry")).toEqual({ clicks: 3, value: "before-limited-retry" });
    await user.see(lifecycleTabButton("capacity-retry"));
    await world.loadInputProbe(handle);
    expect(await world.clickAndType(handle, "retry works")).toEqual({ clicks: 1, value: "retry works" });
    expect(await world.readInputProbe(researchTab)).toEqual({ clicks: 3, value: "before-limited-retry" });
  });
});

lifecycleTest("session deletion closes only its owned pages and preserves neighbor and shared tabs", async ({ world, user, agent, probe, step }) => {
    const removed = { ...world.session, title: "Completed browser research" };
    await world.renameSession(removed.sessionId, removed.title);
    const neighbor = await world.openSession("Continuing browser research");
    await user.see(conversation(neighbor.title));
    const shared = await world.openTab("shared-survivor");
    await world.loadInputProbe(shared);
    expect(await world.clickAndType(shared, "shared")).toEqual({ clicks: 1, value: "shared" });
    const neighborTab = await world.openTab("neighbor-survivor", neighbor.sessionId);
    await world.loadInputProbe(neighborTab);
    expect(await world.clickAndType(neighborTab, "neighbor")).toEqual({ clicks: 1, value: "neighbor" });
    const baseline = await eventually(() => world.readBrowserState(), {
      within: 15_000,
      until: state => state.tabs.length === 2 && state.tabs.every(tab => tab.label === "input-probe")
        && state.visibleSessionId === neighbor.sessionId && state.activeTabId === neighborTab.tabId,
      label: "the shared and neighbor pages have settled before opening owned pages",
    });
    expect(baseline.tabs.find(tab => tab.id === shared.tabId)?.ownerSessionId).toBeNull();
    expect(baseline.tabs.find(tab => tab.id === neighborTab.tabId)?.ownerSessionId).toBe(neighbor.sessionId);
    expect(baseline.backgroundWindowCount).toBe(0);
    const baselinePages = await world.pageTargets();
    const owned = [
      await world.openTab("completed-one", removed.sessionId),
      await world.openTab("completed-two", removed.sessionId),
    ];
    const before = await world.readBrowserState();
    expect(before.tabs.filter(tab => tab.ownerSessionId === removed.sessionId).map(tab => tab.id))
      .toEqual(owned.map(tab => tab.tabId));
    expect(before).toMatchObject({ activeTabId: neighborTab.tabId, visibleSessionId: neighbor.sessionId,
      backgroundWindowCount: 1, backgroundWindowVisible: false, visibleWindowCount: 1 });
    const pages = await world.pageTargets();
    for (const tab of owned) expect(pages.some(page => page.id === tab.targetId)).toBe(true);

    await step("A real session deletion destroys every owned page, but neither surviving document", async () => {
      // Delete through the public server rail, not a renderer cleanup helper,
      // so browser cleanup must arrive through the real session event.
      expect((await agent.desktopApi(`${world.sessionApiBase}/${removed.sessionId}`, { method: "DELETE" })).status).toBe(200);
      await eventually(async () => {
        expect((await probe.desktopApi(`${world.sessionApiBase}/${removed.sessionId}`)).status).toBe(404);
        expect((await probe.desktopApi(`${world.sessionApiBase}/${neighbor.sessionId}`)).status).toBe(200);
        const sessions = await agent.list();
        expect(sessions.some(session => session.sessionId === removed.sessionId)).toBe(false);
        expect(sessions.some(session => session.sessionId === neighbor.sessionId)).toBe(true);
        const state = await world.readBrowserState();
        expect(state.tabs).toEqual(baseline.tabs);
        expect(state.nativeViews.map(view => view.tabId).sort()).toEqual(baseline.nativeViews.map(view => view.tabId).sort());
        expect(state).toMatchObject({ activeTabId: neighborTab.tabId, visibleSessionId: neighbor.sessionId,
          backgroundWindowCount: 0, backgroundWindowVisible: false, visibleWindowCount: 1 });
        expect(await world.pageTargets()).toEqual(baselinePages);
        return true;
      }, { within: 30_000, label: "the deleted session and its pages disappear, including their empty hidden host" });
      await user.notSee(conversation(removed.title));
      await user.see(conversation(neighbor.title));
      expect(await world.readInputProbe(shared)).toEqual({ clicks: 1, value: "shared" });
      expect(await world.readInputProbe(neighborTab)).toEqual({ clicks: 1, value: "neighbor" });
      expect(await world.clickAndType(neighborTab, "-kept")).toEqual({ clicks: 2, value: "neighbor-kept" });
      expect(await world.pageTargets()).toEqual(baselinePages);
    });
});

lifecycleTest("repeated refused navigations leave no allocated page or hidden host and keep the existing input alive", async ({ world, user, step }) => {
  const reading = { ...world.session, title: "Reading during failed opens" };
  await world.renameSession(reading.sessionId, reading.title);
  const researching = await world.openSession("Retrying browser research");
  await user.click(conversation(reading.title));
  const readingTab = await world.openTab("failed-open-survivor", reading.sessionId);
  await world.loadInputProbe(readingTab);
  expect(await world.clickAndType(readingTab, "kept")).toEqual({ clicks: 1, value: "kept" });
  const baseline = await eventually(() => world.readBrowserState(), {
    within: 15_000, until: state => state.tabs.length === 1 && state.tabs[0].label === "input-probe"
      && state.visibleSessionId === reading.sessionId && state.activeTabId === readingTab.tabId,
    label: "the existing input page settles before failed navigation attempts",
  });
  expect(baseline.backgroundWindowCount).toBe(0);
  const pages = await world.pageTargets();

  await step("Foreground and background unsafe-port failures release their pages after navigation approval", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Chromium refuses this loopback port without depending on DNS or a server.
      const ownerSessionId = attempt === 1 ? reading.sessionId : researching.sessionId;
      const rejected = expect(world.openTabAs(`refused-${attempt}`, ownerSessionId, "http://127.0.0.1:1"))
        .rejects.toThrow(/Browser operation could not finish/);
      if (ownerSessionId === researching.sessionId) await user.click(conversation(researching.title));
      await user.click({ role: "button", label: "Allow origin in this tab" });
      await rejected;
      if (ownerSessionId === researching.sessionId) await user.click(conversation(reading.title));
      await eventually(async () => {
        const state = await world.readBrowserState();
        expect(state.tabs).toEqual(baseline.tabs);
        expect(state.nativeViews.map(view => view.tabId)).toEqual([readingTab.tabId]);
        expect(state).toMatchObject({ activeTabId: readingTab.tabId, visibleSessionId: reading.sessionId,
          backgroundWindowCount: 0, backgroundWindowVisible: false, visibleWindowCount: 1 });
        expect(await world.pageTargets()).toEqual(pages);
        return true;
      }, { within: 15_000, label: `failed navigation ${attempt + 1} returns pages and hosts to baseline` });
      expect(await world.readInputProbe(readingTab)).toEqual({ clicks: 1, value: "kept" });
    }
    expect(await world.clickAndType(readingTab, "-after")).toEqual({ clicks: 2, value: "kept-after" });
  });

  await step("An approved retry remains usable in the background after the failures", async () => {
    const pending = world.openTabAs("navigation-recovered", researching.sessionId);
    await user.click(conversation(researching.title));
    await user.click({ role: "button", label: "Allow origin in this tab" });
    const recovered = await pending;
    await user.click(conversation(reading.title));
    expect((await world.readBrowserState()).tabs).toHaveLength(2);
    await world.loadInputProbe(recovered);
    expect(await world.clickAndType(recovered, "recovered")).toEqual({ clicks: 1, value: "recovered" });
    expect(await world.readInputProbe(readingTab)).toEqual({ clicks: 2, value: "kept-after" });
  });
});

lifecycleTest("moving the last background page on screen releases its hidden host and repeated create-close cycles return to baseline", async ({ world, user, step }) => {
  const reading = { ...world.session, title: "Conversation without browser tabs" };
  await world.renameSession(reading.sessionId, reading.title);
  const researching = await world.openSession("Temporary browser research");
  await user.click(conversation(reading.title));
  const baseline = await eventually(() => world.readBrowserState(), {
    within: 15_000, until: state => state.visibleSessionId === reading.sessionId,
    label: "the empty reading conversation is on screen before counting native resources",
  });
  expect(baseline).toMatchObject({ tabs: [], nativeViews: [], backgroundWindowCount: 0 });
  const pages = await world.pageTargets();

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await step(`Create-close cycle ${cycle + 1} releases the empty host without replacing the live page`, async () => {
      const tab = await world.openTab(`temporary-${cycle}`, researching.sessionId);
      const hidden = await world.readBrowserState();
      expect(hidden).toMatchObject({ visibleSessionId: reading.sessionId, backgroundWindowCount: 1,
        backgroundWindowVisible: false, visibleWindowCount: 1 });
      expect(hidden.nativeViews).toHaveLength(1);
      expect(hidden.nativeViews[0]).toMatchObject({ tabId: tab.tabId, attached: false, aboveApp: false });
      await world.loadInputProbe(tab);
      expect(await world.clickAndType(tab, "background")).toEqual({ clicks: 1, value: "background" });
      await user.click(conversation(researching.title));
      const shown = await eventually(() => world.readBrowserState(), {
        within: 15_000,
        until: state => state.backgroundWindowCount === 0 && state.activeTabId === tab.tabId
          && state.nativeViews.some(view => view.tabId === tab.tabId && view.attached && view.aboveApp),
        label: "moving the last child to the sidebar destroys the empty hidden host",
      });
      expect(shown.tabs).toHaveLength(1);
      expect(shown).toMatchObject({ visibleSessionId: researching.sessionId, backgroundWindowVisible: false, visibleWindowCount: 1 });
      await eventually(async () => {
        expect((await world.pageTargets()).filter(page => !pages.some(previous => previous.id === page.id)))
          .toEqual([{ id: tab.targetId, url: shown.tabs[0].url }]);
        return true;
      }, { within: 15_000, label: "the hidden host target disappears while the same browser page remains" });
      expect(await world.clickAndType(tab, "-shown")).toEqual({ clicks: 2, value: "background-shown" });
      await user.hover({ role: "button", label: "Select tab: input-probe" });
      await user.click({ role: "button", label: "Close tab: input-probe" });
      await user.click(conversation(reading.title));
      await eventually(async () => {
        const state = await world.readBrowserState();
        expect(state).toMatchObject({ tabs: [], nativeViews: [], activeTabId: null, visibleSessionId: reading.sessionId,
          backgroundWindowCount: 0, backgroundWindowVisible: false, visibleWindowCount: 1 });
        expect(await world.pageTargets()).toEqual(pages);
        return true;
      }, { within: 15_000, label: "closing the page returns native resources and CDP targets to baseline" });
    });
  }
});

test("a background conversation reads its owned page silently and requests attention before acting", async ({ world, user, agent, probe, step, evidence }) => {
  const reading = { ...world.session, title: "Reading the news" };
  await agent.run("session.rename", { sessionId: reading.sessionId, title: reading.title });
  const researching = { sessionId: await agent.createSession("Background research"), title: "Background research" };
  await user.click(conversation(reading.title));
  const readingOpen = agent.run("browser.open_url", { url: `${world.origin}/?viewport-probe=reading`, provider: "builtin" });
  await user.click({ role: "button", label: "Allow origin in this tab" });
  const readingTab = browserTabHandle(await readingOpen);
  await user.see(tabButton("reading"), { timeoutMs: 30_000 });
  const initial = await probe.browserTabMetrics(readingTab.targetId);
  const panelViewport = { width: initial.width, height: initial.height };
  expect(panelViewport.width).toBeGreaterThan(0);
  expect(panelViewport.width).toBeLessThan(BACKGROUND_TAB_VIEWPORT.width);
  const witness = () => probe.browserFixtureState(world.origin);

  const researchTab = await step("A background open waits without switching conversations or contacting its destination", async () => {
    const requests = (await witness()).pageRequests;
    let settled = false;
    // The server's HTTP mailbox answers within 5 s, so a command that must wait
    // for approval is stamped with its origin at the window boundary instead.
    const pending = world.commandFrom(researching.sessionId, "browser.open_url", { url: `${world.origin}/?viewport-probe=research`, provider: "builtin" })
      .then((result) => { settled = true; return result; });
    const state = await probe.eventually(() => probe.browserState(), { within: 10_000, until: (value) => value.tabs.some((tab) => tab.ownerSessionId === researching.sessionId), label: "the background command allocates an owned review tab" });
    const blank = state.tabs.find((tab) => tab.ownerSessionId === researching.sessionId);
    if (!blank) throw new Error("Missing background review tab.");
    expect(state).toMatchObject({ visibleSessionId: reading.sessionId, activeTabId: readingTab.tabId });
    expect(state).toMatchObject({ visibleWindowCount: 1, backgroundWindowVisible: false });
    expect(blank.label).toBe("New tab");
    expect(settled).toBe(false);
    expect((await witness()).pageRequests).toEqual(requests);
    // A consent tab has no document yet: it stays off every host, unsized, and
    // allocates no hidden window until its approved first navigation completes.
    expect(state).toMatchObject({ backgroundWindowCount: 0 });
    expect(state.nativeViews.find((view) => view.tabId === blank.id)).toMatchObject({ attached: false, aboveApp: false, bounds: { x: 0, y: 0, width: 0, height: 0 } });
    await user.see(tabButton("reading"));
    await user.notSee(tabButton("research"));
    await user.notSee({ role: "button", label: "Allow origin in this tab" });
    expect(await probe.browserTabMetrics(readingTab.targetId)).toMatchObject(panelViewport);
    await user.click(conversation(researching.title));
    await user.see({ role: "button", label: "Allow origin in this tab" });
    expect((await witness()).pageRequests).toEqual(requests);
    await user.click({ role: "button", label: "Allow origin in this tab" });
    const result = await pending;
    if (!result || typeof result !== "object" || !("result" in result)) throw new Error(`The background browser command returned no result: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ ok: true, result: { owner_session_id: researching.sessionId, visible: true } });
    const opened = browserTabHandle(result.result);
    expect(opened.tabId).toBe(blank.id);
    expect((await witness()).pageRequests).toEqual([...requests, { path: "/", signedIn: false }]);
    await user.see(tabButton("research"));
    await user.click(conversation(reading.title));
    evidence.recordAssertionEvidence("Pending background navigation preserves the viewed conversation", "The origin-stamped command allocated an owned blank tab and stayed pending with zero additional page requests, no approval in the unrelated conversation, and unchanged foreground dimensions. Selecting the owner and approving navigation released exactly one GET into that same tab.", true);
    return opened;
  });
  const task = (operation: BrowserTaskInput["operation"], args: BrowserTaskInput["args"] = {}) => agent.browserTask({ sessionId: researching.sessionId, operation, args: { tabId: researchTab.tabId, ...args } });

  await step("The browser reads and images a hidden page, but click, fill and site callbacks need attention", async () => {
    await user.click(conversation(researching.title));
    const access = task("observe");
    await user.click({ role: "button", label: "Allow reading this origin" });
    expect((await access).ok).toBe(true);
    await user.click(conversation(reading.title));
    const metrics = await probe.eventually(() => probe.browserTabMetrics(researchTab.targetId), { within: 15_000, until: (value) => value.width === BACKGROUND_TAB_VIEWPORT.width && value.hasFocus, label: "the hidden page has its background viewport and focus" });
    expect(metrics).toMatchObject({ ...BACKGROUND_TAB_VIEWPORT, hasFocus: true });
    // Once it holds a document, the owned page lives in the single hidden host at the background viewport.
    const parked = await probe.browserState();
    expect(parked).toMatchObject({ backgroundWindowCount: 1, backgroundWindowVisible: false });
    expect(parked.nativeViews.find((view) => view.tabId === researchTab.tabId)).toMatchObject({ attached: false, aboveApp: false, bounds: { x: 0, y: 0, ...BACKGROUND_TAB_VIEWPORT } });
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
    expect(hidden).toMatchObject({ visibleWindowCount: 1, backgroundWindowVisible: false });
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
    // Baseline once the reading tab is back in the panel, so the comparison below sees only the rejected command's effect.
    const before = await probe.eventually(() => probe.browserState(), { within: 15_000, until: (value) => value.visibleSessionId === reading.sessionId && value.activeTabId === readingTab.tabId
      && value.nativeViews.some((view) => view.tabId === readingTab.tabId && view.attached && view.aboveApp), label: "the reading tab is attached in the panel before the paused open" });
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
  await step("Task handles preserve live pages, reject the other owner, and require explicit release", async () => {
    expect(await agent.run("browser.restore_tab", { tabId: readingTab.tabId }))
      .toMatchObject({ tab_id: readingTab.tabId, target_id: readingTab.targetId, owner_session_id: reading.sessionId });
    await expect(agent.run("browser.restore_tab", { tabId: researchTab.tabId })).rejects.toThrow(/owner/i);
    // While a task protects the page, the panel refuses suspension; disabled controls never reach the browser.
    const suspendButton = (title: string) => probe.dom(`button[title=${JSON.stringify(title)}]`);
    await probe.eventually(() => suspendButton("Protected until browser work is released"), { within: 15_000,
      until: (value) => value.elements.length === 1 && value.elements[0].text === "Suspend", label: "the protected page shows a disabled Suspend control" });
    expect((await probe.dom('button[title="Protected until browser work is released"]:disabled')).elements).toHaveLength(1);
    expect((await suspendButton("Suspend this tab to free memory")).elements).toEqual([]);
    expect(await agent.run("browser.release_tab", { tabId: readingTab.tabId }))
      .toMatchObject({ tabId: readingTab.tabId, released: true });
    await probe.eventually(() => probe.dom('button[title="Suspend this tab to free memory"]:not(:disabled)'), { within: 15_000,
      until: (value) => value.elements.length === 1 && value.elements[0].text === "Suspend", label: "releasing the task lets the user suspend the page" });
    expect((await suspendButton("Protected until browser work is released")).elements).toEqual([]);
    expect((await probe.browserState()).tabs.map(tab => tab.id).sort())
      .toEqual([readingTab.tabId, researchTab.tabId].sort());
    expect(await witness()).toMatchObject({ records: [{ method: "dom", count: 1, signedIn: false }], inputValue: "ok", sessionReads: 0 });
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

  // The link menu is a native OS popup: it has no DOM and no CDP target, so the
  // development seam is the only way to read its entries or deliver a choice.
  const menuOpen = (open: boolean) => eventually(() => world.nativeMenu(), {
    within: 15_000, until: value => value.open === open,
    label: open ? "the native menu is on screen" : "the native menu has closed",
  });
  const openMenu = async (target: Target) => {
    await user.rightClick(target);
    const shown = await menuOpen(true);
    if (!shown.current) throw new Error("The native menu is open without a template.");
    return shown.current;
  };
  const labels = (popup: { items: Array<{ type: string; label: string | null }> }) =>
    popup.items.filter(item => item.type === "item").map(item => item.label);
  const choose = async (popup: { items: Array<{ id: string | null; label: string | null }> }, label: string) => {
    const id = popup.items.find(item => item.label === label)?.id;
    if (!id) throw new Error(`The native menu offers no "${label}" entry.`);
    expect(await world.chooseMenuItem(id)).toBe(true);
    const closed = await menuOpen(false);
    expect(closed.last).toMatchObject({ selectedId: id });
  };

  await step("Right-click and Escape leave the transcript and every browser page unchanged", async () => {
    const popup = await openMenu(link);
    const entries = labels(popup);
    expect(entries.slice(0, 2)).toEqual(["Open in OpenWork", "Open in Default Browser"]);
    expect(entries.at(-1)).toBe("Copy Link Address");
    for (const installed of entries.slice(2, -1)) expect(installed).toMatch(/^Open in .+/);
    expect(entries).not.toContain("Edit message");
    expect(popup.items.filter(item => item.type === "item").every(item => item.enabled)).toBe(true);
    // A native popup renders no HTML menu in the app document.
    await user.notSee(menuItem("Open in OpenWork"));
    await user.notSee(menuItem("Edit message"));
    await unchanged();
    await user.press("Escape");
    const dismissed = await menuOpen(false);
    expect(dismissed.last).toMatchObject({ selectedId: null });
    await unchanged();
  });

  await step("Copy Link Address copies the exact URL, not the whole message, without opening a page", async () => {
    await choose(await openMenu(link), "Copy Link Address");
    // Clipboard reads require the app document to be focused.
    await user.click("composer");
    expect(await world.readClipboard()).toBe(world.linkUrl);
    await unchanged();
  });

  await step("Right-clicking nonlink message text still offers the message menu", async () => {
    const popup = await openMenu({ text: world.note });
    const entries = labels(popup);
    expect(entries).toEqual(expect.arrayContaining(["Edit message", "Copy"]));
    expect(entries).not.toContain("Open in OpenWork");
    await user.notSee(menuItem("Edit message"));
    expect(await world.dismissMenu()).toBe(true);
    expect((await menuOpen(false)).last).toMatchObject({ selectedId: null });
    await unchanged();
  });

  const opened = await step("Open in OpenWork creates exactly one tab owned by the link's conversation", async () => {
    await choose(await openMenu(link), "Open in OpenWork");
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
    expect((await world.nativeMenu()).open).toBe(false);
  });
});

artifactTest("a transcript link replaces the selected artifact with its own live sidebar tab, not a native window", async ({ world, user, step }) => {
  const tabButton = (name: string): Target => ({ role: "button", label: new RegExp(`^Select tab: .*viewport-probe=${name}$`) });
  const reading = { ...world.session, title: "Linked research" };
  await world.renameSession(reading.sessionId, reading.title);
  const link = await world.seedTranscriptLink(reading.sessionId);
  const other = await world.openSession("Other conversation");
  const otherTab = await world.openTab("other-conversation", other.sessionId);
  await user.see(tabButton(otherTab.name), { timeoutMs: 30_000 });
  await user.click(conversation(reading.title));
  await user.see({ role: "link", text: link.url }, { timeoutMs: 30_000 });
  await user.click({ role: "button", label: /^browser-handoff\.md\b/ });
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

    const pending = world.openTabAs("requested-preview", reading.sessionId);
    await user.click({ role: "button", label: "Allow origin in this tab" });
    const requested = await pending;
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
