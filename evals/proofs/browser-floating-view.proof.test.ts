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
    services: ["den"],
    nativeReason: "Floating, side and full-screen presentation move Electron's native page view, which a browser tab cannot host.",
  },
});

const toggle: Target = { testId: "session-browser-toggle" };
const card: Target = { testId: "browser-floating-card" };
const fullscreen: Target = { testId: "browser-fullscreen-dialog" };
const WITHIN = 15_000;

test("a person moves the page the agent opened between the side, a floating card and full screen without losing it", async ({ world, user, agent, probe, step, evidence }) => {
  const sessionId = world.session.sessionId;
  await agent.run("session.open", { sessionId });
  let tabId = "";
  let sideWidth = 0;

  // The header Browser button reports what is on screen in data-browser-mode.
  const headerMode = (mode: string) => probe.eventually(
    () => probe.dom(`[data-testid="session-browser-toggle"][data-browser-mode="${mode}"]`),
    { within: WITHIN, until: (dom) => dom.elements.length === 1, label: `the header Browser button reports ${mode}` },
  );
  // The agent's page keeps the same native tab in every presentation.
  const pageView = async (shown: boolean) => {
    const state = await probe.eventually(() => probe.browserState(), {
      within: WITHIN,
      label: shown ? "the agent's page is painted in the window" : "no browser page is painted over the chat",
      until: (value) => value.tabs.some((tab) => tab.id === tabId && tab.ownerSessionId === sessionId)
        && value.nativeViews.some((view) => view.tabId === tabId && view.attached && view.aboveApp && view.visible) === shown,
    });
    return state.nativeViews.find((view) => view.tabId === tabId) ?? null;
  };
  const cardSnap = async (snap: string) => {
    const dom = await probe.eventually(() => probe.dom(`[data-testid="browser-floating-card"][data-snap="${snap}"]`), {
      within: WITHIN, until: (value) => value.elements.length === 1, label: `the floating card sits at the ${snap} right`,
    });
    return dom.elements[0].rect;
  };

  await step("before: a page the agent opens comes up beside the chat, as it does today", async () => {
    if (await probe.has("Not now")) await user.click({ role: "button", label: "Not now" });
    await user.see(toggle, { timeoutMs: 30_000 });
    await headerMode("hidden");
    expect((await probe.browserState()).tabs.filter((tab) => tab.ownerSessionId === sessionId)).toEqual([]);
    tabId = browserTabHandle(await agent.run("browser.open_url", { url: world.pageUrl, provider: "builtin" })).tabId;
    await user.notSee({ role: "button", label: "Allow for this thread" });
    await headerMode("side");
    const view = await pageView(true);
    sideWidth = view?.bounds.width ?? 0;
    expect(sideWidth).toBeGreaterThan(0);
    await user.see({ testId: "browser-mode-float" });
    await user.notSee(card);
    evidence.recordAssertionEvidence(
      "The agent's page opens beside the chat",
      `Without a consent prompt, the page opened in the side panel (${sideWidth}px wide); the header Browser button reads "side" and no floating card is shown.`,
      sideWidth > 0,
    );
    await user.screenshot();
  });

  await step("after: floating the browser leaves a small card over the chat and takes the page off the screen", async () => {
    await user.click({ testId: "browser-mode-float" });
    await user.see(card);
    await headerMode("floating");
    expect(await pageView(false)).toMatchObject({ tabId });
    await user.notSee({ testId: "browser-mode-float" });
    const rect = await cardSnap("middle");
    evidence.recordAssertionEvidence(
      "Float shows the card and hides the native page",
      `The floating card is ${Math.round(rect.width)}px wide at the middle right; the same tab is kept but no native page is painted over the chat.`,
      rect.width > 0,
    );
    await user.screenshot();
  });

  await step("after: the card snaps to the top right from its position menu", async () => {
    const middle = await cardSnap("middle");
    await user.click({ testId: "browser-floating-position" });
    await user.click({ testId: "browser-snap-top" });
    const top = await probe.eventually(() => cardSnap("top"), { within: WITHIN, until: (rect) => rect.top < middle.top, label: "the card finishes moving above its middle position" });
    expect(top.top).toBeLessThan(middle.top);
    // Radio items keep the menu open; Escape closes it as a person would.
    await user.press("Escape");
    await probe.eventually(() => probe.dom('[data-testid="browser-snap-top"]'), { within: WITHIN, until: (dom) => dom.elements.length === 0, label: "the position menu finishes closing" });
    await user.notSee({ testId: "browser-snap-top" });
    await headerMode("floating");
    evidence.recordAssertionEvidence(
      "The card moves to the top snap",
      `The card's top edge moved from ${Math.round(middle.top)}px to ${Math.round(top.top)}px and it reports the top snap.`,
      top.top < middle.top,
    );
    await user.screenshot();
  });

  await step("after: full screen shows the same page over the whole window", async () => {
    await user.click({ testId: "browser-mode-fullscreen" });
    await user.see(fullscreen);
    await user.see({ testId: "browser-fullscreen-exit" });
    await headerMode("fullscreen");
    // Rest the pointer on Exit (no tooltip), so a toolbar tooltip under the
    // old pointer position cannot legitimately cover the page.
    await user.hover({ testId: "browser-fullscreen-exit" });
    const view = await probe.eventually(() => pageView(true), { within: WITHIN, until: (view) => (view?.bounds.width ?? 0) > sideWidth, label: "the native page fills the wider full-screen view" });
    const width = view?.bounds.width ?? 0;
    // Witness: a full-screen page wider than the side panel proves the native view really moved.
    expect(width).toBeGreaterThan(sideWidth);
    await user.notSee(card);
    evidence.recordAssertionEvidence(
      "Full screen paints the same page across the window",
      `The same tab is painted ${width}px wide in full screen, against ${sideWidth}px beside the chat; the floating card is gone.`,
      width > sideWidth,
    );
    await user.screenshot();
  });

  await step("after: Escape leaves full screen for the floating card the person came from", async () => {
    await user.press("Escape");
    await probe.eventually(() => probe.dom('[data-testid="browser-fullscreen-dialog"]'), { within: WITHIN, until: (dom) => dom.elements.length === 0, label: "full screen finishes closing" });
    await user.notSee(fullscreen);
    await headerMode("floating");
    await cardSnap("top");
    expect(await pageView(false)).toMatchObject({ tabId });
    evidence.recordAssertionEvidence(
      "Escape returns to the last mode",
      "Escape closed full screen; the card is back at the top right and the native page is off the screen again.",
      (await probe.dom('[data-testid="browser-floating-card"][data-snap="top"]')).elements.length === 1,
    );
    await user.screenshot();
  });

  await step("after: the header Browser button hides the browser and brings it back where it was", async () => {
    await user.click(toggle);
    await headerMode("hidden");
    await user.notSee(card);
    expect(await pageView(false)).toMatchObject({ tabId });
    await user.click(toggle);
    await headerMode("floating");
    await user.see(card);
    await cardSnap("top");
    const tabs = (await probe.browserState()).tabs.filter((tab) => tab.ownerSessionId === sessionId);
    expect(tabs.map((tab) => tab.id)).toEqual([tabId]);
    evidence.recordAssertionEvidence(
      "Hide and show keep the page and its place",
      `Hidden, neither the card nor the page is shown; shown again, the card returns at the top right with the same single tab (${tabs.length} owned by this chat).`,
      tabs.length === 1 && tabs[0]?.id === tabId,
    );
    await user.screenshot();
  });
  await step("after: a page under the person's control has no floating screenshot", async () => {
    await user.click({ testId: "browser-floating-preview" });
    await headerMode("side");
    await user.click({ role: "button", label: "Take over" });
    await user.see({ role: "button", label: "Resume browser" });
    await user.click({ testId: "browser-mode-float" });
    await user.see(card);
    await user.notSee({ testId: "browser-floating-thumbnail" });
    evidence.recordAssertionEvidence("Takeover withholds the page preview", "The card remains available while the person controls the page, and it contains no screenshot.", (await probe.dom('[data-testid="browser-floating-thumbnail"]')).elements.length === 0);
    await user.screenshot();
  });

  await step("after: resuming and navigating keeps the same tab and captures only its current page", async () => {
    await user.click({ testId: "browser-floating-preview" });
    await user.click({ role: "button", label: "Resume browser" });
    await user.type({ placeholder: "Enter URL..." }, `${world.origin}/?floating-browser=updated`, { replace: true });
    await user.press("Enter");
    await user.click({ testId: "browser-mode-float" });
    await user.see({ testId: "browser-floating-thumbnail" }, { timeoutMs: 30_000 });
    const current = await probe.eventually(() => world.thumbnail(tabId), { within: WITHIN, until: (value) => Boolean(value?.url.includes("floating-browser=updated")), label: "the preview names the current page" });
    expect(current?.url).toBe(`${world.origin}/?floating-browser=updated`);
    evidence.recordAssertionEvidence("The floating preview follows navigation", "After resuming and navigating, the same tab returns to the floating card with a screenshot of its current URL.", current?.url === `${world.origin}/?floating-browser=updated`);
    await user.screenshot();
  });

  await step("turning the rollout off returns the same page to the standard side panel", async () => {
    await world.setCapabilities({ browserFloatingView: false });
    await probe.eventually(() => probe.dom('[data-testid="session-browser-toggle"]'), { within: 60_000, until: (dom) => dom.elements.length === 0, label: "the admin rollout refresh removes the Browser button" });
    await user.notSee(toggle);
    await user.notSee(card);
    const view = await pageView(true);
    expect(view?.tabId).toBe(tabId);
    evidence.recordAssertionEvidence("Rollout rollback preserves the page", "The Browser header button and floating card disappeared; the same native tab is visible beside the chat.", view?.tabId === tabId);
    await user.screenshot();
  });

});
