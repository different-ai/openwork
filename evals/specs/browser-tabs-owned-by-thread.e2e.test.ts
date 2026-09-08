import { expect } from "vitest";
import type { Target } from "@openwork/cdp";
import { eventually, spec } from "@openwork/testkit";
import { builtinBrowserWorld, transcriptLinkWorld } from "../worlds/browser-panel.ts";

const test = spec.world(async (seed) => {
  const world = await builtinBrowserWorld(seed, { OPENWORK_EVAL_BROWSER_LOGIN_SYNC: "1" });
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

test("memory saver reclaims only released safe pages and restores their identity without leaking native resources", async ({ world, user, agent, step }) => {
  const reading = { ...world.session, title: "Reading with memory saver" };
  await world.renameSession(reading.sessionId, reading.title);
  const research = await world.openSession("Saved browser research");
  await user.click(conversation(reading.title));
  const origin = await world.staticWitnessUrl();
  const neighbor = await world.openTabAs("protected", reading.sessionId, `${origin}/?page=protected`);
  await user.click({ role: "button", label: "Suspend tab" });
  await user.see({ text: /Cannot suspend browser tab: automation/ });
  const saved = await world.openTabAs("saved", research.sessionId, `${origin}/?page=saved`);
  const stateOfSaved = () => world.readBrowserState().then(state => state.tabs.find(tab => tab.id === saved.tabId));
  await world.tabCommandAs("browser.release_tab", saved.tabId, research.sessionId);
  await eventually(stateOfSaved, { within: 15_000,
    until: tab => tab?.status === "ready" && tab.automationProtected === false && tab.suspensionBlockedReason === null,
    label: "the real static HTTP response is eligible after automation releases it" });

  await step("Pressure saves a released background page, never its older protected neighbor", async () => {
    for (let index = 0; index < 10; index += 1) await world.openTabAs(`memory-${index}`, reading.sessionId);
    expect(await world.readBrowserState()).toMatchObject({ liveTabCount: 12, tabLimit: 12, backgroundWindowCount: 1 });
    await world.openTabAs("memory-overflow", reading.sessionId);
    const state = await world.readBrowserState();
    expect(state.tabs).toHaveLength(13);
    expect(state).toMatchObject({ liveTabCount: 12, backgroundWindowCount: 0, backgroundWindowVisible: false });
    expect(state.nativeViews).toHaveLength(12);
    expect(state.tabs.filter(tab => tab.status === "suspended").map(tab => tab.id)).toEqual([saved.tabId]);
    expect(state.tabs.find(tab => tab.id === neighbor.tabId)).toMatchObject({ automationProtected: true, ownerSessionId: reading.sessionId });
    expect(state.nativeViews.some(view => view.tabId === saved.tabId)).toBe(false);
    const pages = await world.pageTargets();
    expect(pages.some(page => page.id === saved.targetId)).toBe(false);
    expect(pages.some(page => page.id === neighbor.targetId)).toBe(true);
    for (const tab of state.tabs.filter(tab => tab.id !== neighbor.tabId && tab.id !== saved.tabId)) {
      await user.hover({ role: "button", label: `Select tab: ${tab.label}` });
      await user.click({ role: "button", label: `Close tab: ${tab.label}` });
    }
  });

  const baseline = await eventually(() => world.readBrowserState(), { within: 15_000,
    until: state => state.tabs.length === 2 && state.liveTabCount === 1 && state.backgroundWindowCount === 0,
    label: "only the saved logical tab and the live protected neighbor remain" });
  const baselinePages = await world.pageTargets();
  const neighborState = baseline.tabs.find(tab => tab.id === neighbor.tabId);
  if (!neighborState) throw new Error("Protected neighbor missing.");
  await user.click(conversation(research.title));
  const ready = () => eventually(stateOfSaved, { within: 15_000,
    until: tab => tab?.status === "ready" && tab.restoreError === null
      && (tab.automationProtected === true || tab.suspensionBlockedReason === null),
    label: "the saved logical tab reloads its HTTP URL" });
  const restored = await ready();
  if (!restored) throw new Error("Saved browser tab missing.");
  let handle = await world.tabHandle(restored);
  expect(handle.targetId).not.toBe(saved.targetId);
  expect(restored).toMatchObject({ id: saved.tabId, url: `${origin}/?page=saved`, ownerSessionId: research.sessionId, automationProtected: false });

  await step("A user pin refuses suspension without releasing the live page", async () => {
    await user.click({ role: "button", label: "Keep active" });
    await user.click({ role: "button", label: "Suspend tab" });
    await user.see({ text: /Cannot suspend browser tab: keep-active/ });
    expect(await stateOfSaved()).toMatchObject({ status: "ready", keepActive: true, suspensionBlockedReason: "keep-active" });
    expect((await world.tabHandle(restored)).targetId).toBe(handle.targetId);
    await user.click({ role: "button", label: "Keep active" });
  });

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await step(`Suspend/restore cycle ${cycle + 1} preserves identity and reclaims pages and hosts`, async () => {
      await agent.run("browser.release_tab", { tabId: saved.tabId });
      await eventually(stateOfSaved, { within: 15_000, until: tab => tab?.suspensionBlockedReason === null,
        label: "the released page is safe to suspend" });
      await user.click({ role: "button", label: "Suspend tab" });
      await user.see({ text: "Tab suspended" });
      await world.refreshBrowserLayout(research.sessionId);
      await user.click({ role: "button", label: "Close side panel" });
      await user.click({ role: "button", label: "Open side panel" });
      await user.see({ text: "Tab suspended" });
      expect(await stateOfSaved()).toMatchObject({ status: "suspended", ownerSessionId: research.sessionId });
      expect((await world.pageTargets()).some(page => page.id === handle.targetId)).toBe(false);
      if (cycle === 0) {
        await user.click({ role: "button", label: `Select tab: ${restored.label}` });
        expect(await ready()).toMatchObject({ id: saved.tabId, ownerSessionId: research.sessionId, automationProtected: false });
        const selected = await world.tabHandle(restored);
        expect(selected.targetId).not.toBe(handle.targetId);
        handle = selected;
        await user.click({ role: "button", label: "Suspend tab" });
        await user.see({ text: "Tab suspended" });
      }
      await user.click(conversation(reading.title));
      await eventually(async () => {
        const state = await world.readBrowserState();
        expect(state).toMatchObject({ liveTabCount: 1, backgroundWindowCount: 0, backgroundWindowVisible: false, visibleWindowCount: 1 });
        expect(state.nativeViews.map(view => view.tabId)).toEqual([neighbor.tabId]);
        expect(state.tabs.map(tab => tab.id)).toEqual(baseline.tabs.map(tab => tab.id));
        expect(state.tabs.find(tab => tab.id === neighbor.tabId)).toEqual(neighborState);
        expect(await world.pageTargets()).toEqual(baselinePages);
        return true;
      }, { within: 15_000, label: "suspension and returning to the neighbor remove every unused page and host" });
      const before = await stateOfSaved();
      await expect(agent.run("browser.restore_tab", { tabId: saved.tabId })).rejects.toThrow(/owner/i);
      expect(await stateOfSaved()).toEqual(before);
      expect(await world.pageTargets()).toEqual(baselinePages);
      if (cycle === 1) {
        const result = await world.tabCommandAs("browser.restore_tab", saved.tabId, research.sessionId);
        expect(result).toMatchObject({ tab_id: saved.tabId, owner_session_id: research.sessionId });
        expect(await stateOfSaved()).toMatchObject({ automationProtected: true, suspensionBlockedReason: "automation" });
        expect(result).toMatchObject({ target_id: (await world.tabHandle(restored)).targetId });
      }
      await user.click(conversation(research.title));
      await ready();
      const next = await world.tabHandle(restored);
      expect(next.tabId).toBe(saved.tabId);
      expect(next.targetId).not.toBe(handle.targetId);
      expect(await world.readBrowserState()).toMatchObject({ liveTabCount: 2, backgroundWindowCount: 1, visibleWindowCount: 1 });
      handle = next;
    });
  }

  await step("An interactive HTTP page refuses suspension and preserves its typed input", async () => {
    expect(await agent.run("browser.restore_tab", { tabId: saved.tabId }))
      .toMatchObject({ tab_id: saved.tabId, target_id: handle.targetId, owner_session_id: research.sessionId });
    await world.installInputProbe(handle);
    expect(await world.clickAndType(handle, "keep this input")).toEqual({ clicks: 1, value: "keep this input" });
    await agent.run("browser.release_tab", { tabId: saved.tabId });
    await user.click({ role: "button", label: "Suspend tab" });
    await user.see({ text: /Cannot suspend browser tab: interaction/ });
    expect(await stateOfSaved()).toMatchObject({ status: "ready", automationProtected: false, suspensionBlockedReason: "interaction" });
    expect((await world.tabHandle(restored)).targetId).toBe(handle.targetId);
    expect(await world.readInputProbe(handle)).toEqual({ clicks: 1, value: "keep this input" });
    expect((await world.tabHandle(neighborState)).targetId).toBe(neighbor.targetId);
  });
});

test("the global tab limit rejects new pages without disturbing live tabs, and closing a tab makes room", async ({ world, user, agent, step }) => {
  const reading = { ...world.session, title: "Reading at capacity" };
  await world.renameSession(reading.sessionId, reading.title);
  const researching = await world.openSession("Research at capacity");
  await user.click(conversation(reading.title));
  const initial = await world.readBrowserState();
  expect(initial.tabs).toEqual([]);
  expect(initial.tabLimit).toBe(12);
  const readingTab = await world.openTabAs("capacity-reading", reading.sessionId);
  await user.see(tabButton(readingTab.name), { timeoutMs: 30_000 });
  const researchTab = await world.openTabAs("capacity-research", researching.sessionId);
  await world.loadInputProbe(researchTab);
  expect(await world.clickAndType(researchTab, "before")).toEqual({ clicks: 1, value: "before" });
  for (let index = 2; index < initial.tabLimit; index += 1) {
    await world.openTabAs(`capacity-${index}`, researching.sessionId);
  }
  const full = await world.readBrowserState();
  expect(full.tabs).toHaveLength(12);
  expect(full).toMatchObject({ activeTabId: readingTab.tabId, visibleSessionId: reading.sessionId,
    backgroundWindowCount: 1, backgroundWindowVisible: false, visibleWindowCount: 1 });
  const pages = await world.pageTargets();
  const retryUrl = `${world.origin}/?viewport-probe=capacity-retry`;

  await step("The new-tab button explains how to make room without allocating a page", async () => {
    await user.click({ role: "button", label: "New tab" });
    await user.see({ text: /OpenWork has 12 browser tabs open with protected live pages\. Close an unused browser tab or release its automation handle, then try again\./ });
    const rejected = await world.readBrowserState();
    expect(rejected.tabs).toEqual(full.tabs);
    expect(rejected).toMatchObject({ activeTabId: readingTab.tabId, visibleSessionId: reading.sessionId,
      backgroundWindowCount: 1, backgroundWindowVisible: false, visibleWindowCount: 1 });
    expect(await world.pageTargets()).toEqual(pages);
    expect(await world.readInputProbe(researchTab)).toEqual({ clicks: 1, value: "before" });
    await user.see(tabButton(readingTab.name));
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
    await user.see(tabButton(readingTab.name));
    await user.notSee(tabButton("capacity-retry"));
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

    const result = await agent.run("browser.open_url", { url: retryUrl, provider: "builtin" });
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
    await user.see(tabButton("capacity-retry"));
    await world.loadInputProbe(handle);
    expect(await world.clickAndType(handle, "retry works")).toEqual({ clicks: 1, value: "retry works" });
    expect(await world.readInputProbe(researchTab)).toEqual({ clicks: 3, value: "before-limited-retry" });
  });
});

test("session deletion closes only its owned pages and preserves neighbor and shared tabs", async ({ world, user, agent, probe, step }) => {
    const removed = { ...world.session, title: "Completed browser research" };
    await world.renameSession(removed.sessionId, removed.title);
    const neighbor = await world.openSession("Continuing browser research");
    await user.see(conversation(neighbor.title));
    const shared = await world.openTab("shared-survivor");
    await world.loadInputProbe(shared);
    expect(await world.clickAndType(shared, "shared")).toEqual({ clicks: 1, value: "shared" });
    const neighborTab = await world.openTabAs("neighbor-survivor", neighbor.sessionId);
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
      await world.openTabAs("completed-one", removed.sessionId),
      await world.openTabAs("completed-two", removed.sessionId),
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

test("repeated refused navigations leave no allocated page or hidden host and keep the existing input alive", async ({ world, user, step }) => {
  const reading = { ...world.session, title: "Reading during failed opens" };
  await world.renameSession(reading.sessionId, reading.title);
  const researching = await world.openSession("Retrying browser research");
  await user.click(conversation(reading.title));
  const readingTab = await world.openTabAs("failed-open-survivor", reading.sessionId);
  await world.loadInputProbe(readingTab);
  expect(await world.clickAndType(readingTab, "kept")).toEqual({ clicks: 1, value: "kept" });
  const baseline = await eventually(() => world.readBrowserState(), {
    within: 15_000, until: state => state.tabs.length === 1 && state.tabs[0].label === "input-probe"
      && state.visibleSessionId === reading.sessionId && state.activeTabId === readingTab.tabId,
    label: "the existing input page settles before failed navigation attempts",
  });
  expect(baseline.backgroundWindowCount).toBe(0);
  const pages = await world.pageTargets();

  await step("Foreground and background unsafe-port failures release their otherwise unreachable native pages", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Chromium refuses this loopback port without depending on DNS or a server.
      const ownerSessionId = attempt === 1 ? reading.sessionId : researching.sessionId;
      await expect(world.openTabAs(`refused-${attempt}`, ownerSessionId, "http://127.0.0.1:1"))
        .rejects.toThrow(/ERR_UNSAFE_PORT/);
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

  await step("A valid retry still opens a usable background page after the failures", async () => {
    const recovered = await world.openTabAs("navigation-recovered", researching.sessionId);
    expect((await world.readBrowserState()).tabs).toHaveLength(2);
    await world.loadInputProbe(recovered);
    expect(await world.clickAndType(recovered, "recovered")).toEqual({ clicks: 1, value: "recovered" });
    expect(await world.readInputProbe(readingTab)).toEqual({ clicks: 2, value: "kept-after" });
  });
});

test("moving the last background page on screen releases its hidden host and repeated create-close cycles return to baseline", async ({ world, user, step }) => {
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
      const tab = await world.openTabAs(`temporary-${cycle}`, researching.sessionId);
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
