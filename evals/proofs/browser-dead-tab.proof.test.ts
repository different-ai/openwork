import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { browserDeadTab } from "../worlds/browser-dead-tab.ts";

const test = spec.world(browserDeadTab, {
  timeout: 600_000,
  resources: {
    surfaces: ["desktop"], services: ["mock"],
    nativeReason: "The page lives in Electron's native page view with its own process; only the desktop shell can lose that process while OpenWork keeps running.",
  },
});

const WITHIN = 20_000;

test("a person whose open page crashed keeps OpenWork open when they switch conversations, and gets the page back with Reload", async ({ world, user, agent, probe, step, evidence }) => {
  let tabId = "";
  const firstTitle = world.session.title;

  await step("before: a page opened in the first conversation shows beside the chat", async () => {
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    if (await probe.has("Not now")) await user.click({ role: "button", label: "Not now" });
    // The person opens the page themselves. A page the agent opens is locked to
    // the agent's viewport, which OpenWork resizes in a way that never crashed.
    // The Browser button opens a new page; an older build asks for a destination first.
    await user.click({ testId: "session-browser-toggle" });
    if (await probe.has("Open a new page in the built-in browser.")) await user.click({ text: "Open a new page in the built-in browser." });
    await user.type({ placeholder: "Enter URL..." }, world.pageUrl, { replace: true });
    await user.press("Enter");
    const opened = await probe.eventually(() => probe.browserState(), {
      within: WITHIN, label: "the page is painted beside the chat",
      until: (state) => state.tabs.some((tab) => tab.url === world.pageUrl && tab.ownerSessionId === world.session.sessionId
        && state.nativeViews.some((view) => view.tabId === tab.id && view.attached && view.visible)),
    });
    tabId = opened.tabs.find((tab) => tab.url === world.pageUrl)?.id ?? "";
    // Witness: the person's own page, not one the agent sized (that shows e.g. "Panel · 95%").
    await user.notSee({ text: /^\w+ · \d+%$/ }, { timeoutMs: 5_000 });
    const responds = await probe.eventually(() => world.pageResponds(), { within: WITHIN, label: "the page answers", until: Boolean });
    evidence.recordAssertionEvidence("The person's page is open and alive", `the page the person opened (tab ${tabId}) is painted beside the chat at the panel's own size, with no agent page size shown, and answers scripts: ${responds}`, responds);
    await user.screenshot();
  });

  await step("the page's own process stops, as when it runs out of memory, and OpenWork keeps running", async () => {
    await world.crashPage();
    // Witness: the page really is gone, not just slow.
    const gone = await probe.eventually(() => world.pageResponds(), { within: WITHIN, label: "the page stops answering", until: (alive) => !alive });
    const alive = await world.appAlive();
    await user.see("composer", { editable: true });
    expect(gone).toBe(false);
    expect(alive).toBe(true);
    evidence.recordAssertionEvidence("Only the page stopped", `page answers scripts: ${gone}; OpenWork answers: ${alive}`, !gone && alive);
  });

  await step("after: switching to another conversation keeps OpenWork open", async () => {
    await user.click({ text: world.other.title });
    // Witness: the crashed page moved off screen, the moment OpenWork resizes it.
    const state = await probe.eventually(() => probe.browserState(), {
      within: WITHIN, label: "the crashed page moves off screen",
      until: (value) => value.visibleSessionId === world.other.sessionId && value.backgroundWindowCount > 0,
    });
    const alive = await world.appAlive();
    await user.see("composer", { editable: true });
    expect(alive).toBe(true);
    evidence.recordAssertionEvidence("OpenWork stays open", `"${world.other.title}" is on screen with the crashed page off screen (${state.backgroundWindowCount} background window), and OpenWork still answers: ${alive}`, alive);
    await user.screenshot();
  });

  await step("after: back in the first conversation, Reload brings the page back", async () => {
    await user.click({ text: firstTitle });
    await user.see("composer", { editable: true });
    if ((await probe.dom('[aria-label="Reload page"]')).elements.length === 0) await user.click({ testId: "session-browser-toggle" });
    await user.click({ label: "Reload page" });
    const responds = await probe.eventually(() => world.pageResponds(), { within: WITHIN, label: "the reloaded page answers", until: Boolean });
    const state = await probe.eventually(() => probe.browserState(), {
      within: WITHIN, label: "the reloaded page is painted beside the chat",
      until: (value) => value.nativeViews.some((view) => view.tabId === tabId && view.attached && view.visible),
    });
    const view = state.nativeViews.find((item) => item.tabId === tabId);
    expect(responds).toBe(true);
    evidence.recordAssertionEvidence("The page is back", `after Reload the page answers scripts: ${responds}, painted ${view?.bounds.width} × ${view?.bounds.height} beside the chat`, responds);
    await user.screenshot();
  });
});
