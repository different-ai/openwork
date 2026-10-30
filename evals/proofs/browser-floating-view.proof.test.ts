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
    nativeReason: "Floating, side and full-screen presentation move Electron's native page view, which a browser tab cannot host.",
  },
});

const toggle: Target = { testId: "session-browser-toggle" };
const card: Target = { testId: "browser-floating-card" };
const fullscreen: Target = { testId: "browser-fullscreen-dialog" };
const WITHIN = 15_000;

test("a person moves the page the agent opened between the side, its own floating window and full screen without losing it", async ({ world, user, agent, probe, step, evidence }) => {
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
      label: shown ? "the agent's page is painted in the window" : "no browser page is painted over the chat",
      until: (value) => value.tabs.some((tab) => tab.id === tabId && tab.ownerSessionId === sessionId)
        && value.nativeViews.some((view) => view.tabId === tabId && view.attached && view.aboveApp && view.visible) === shown,
    });
    return state.nativeViews.find((view) => view.tabId === tabId) ?? null;
  };
  // The card's own window, outside the app window. A fresh attach each time
  // it opens: hiding or leaving it closes that window.
  let popup: Awaited<ReturnType<typeof world.floatingWindow>> | null = null;
  const floatingCard = async () => {
    await popup?.client.close();
    popup = await world.floatingWindow();
    await user.on(popup).see(card);
    return { user: user.on(popup), probe: probe.on(popup) };
  };
  const floatingClosed = () => probe.eventually(() => world.floatingWindowOpen(), {
    within: WITHIN, until: (open) => !open, label: "the floating browser window closes",
  });

  await step("before: a page the agent opens comes up beside the chat, as it does today", async () => {
    if (await probe.has("Not now")) await user.click({ role: "button", label: "Not now" });
    await user.see(toggle, { timeoutMs: 30_000 });
    await browserMode("hidden");
    // One Browser button, in the side rail; the chat header has none.
    const browserButtons = await probe.dom('button[aria-label^="Browser"]');
    expect(browserButtons.elements).toHaveLength(1);
    expect((await probe.dom('[data-session-header] button[aria-label^="Browser"]')).elements).toHaveLength(0);
    expect((await probe.browserState()).tabs.filter((tab) => tab.ownerSessionId === sessionId)).toEqual([]);
    tabId = browserTabHandle(await agent.run("browser.open_url", { url: world.pageUrl, provider: "builtin" })).tabId;
    await user.notSee({ role: "button", label: "Allow for this thread" });
    await browserMode("side");
    const view = await pageView(true);
    sideWidth = view?.bounds.width ?? 0;
    expect(sideWidth).toBeGreaterThan(0);
    await user.see({ testId: "browser-mode-float" });
    await user.notSee(card);
    evidence.recordAssertionEvidence(
      "The agent's page opens beside the chat",
      `Without a consent prompt, the page opened in the side panel (${sideWidth}px wide); the side rail's Browser button reads "side", it is the only Browser button, and no floating card is shown.`,
      sideWidth > 0 && browserButtons.elements.length === 1,
    );
    await user.screenshot();
  });

  await step("after: floating the browser moves it into its own borderless window and takes the page off the chat", async () => {
    await user.click({ testId: "browser-mode-float" });
    const floating = await floatingCard();
    await browserMode("floating");
    expect(await pageView(false)).toMatchObject({ tabId });
    await user.notSee({ testId: "browser-mode-float" });
    await user.notSee(card);
    const frame = await world.windowFrame(popup ?? undefined);
    const app = { width: (await world.windowFrame()).outer[0] };
    // Witness: the card is a separate window with no frame, not a layer in the app window.
    expect(frame.inner).toEqual(frame.outer);
    expect(frame.outer[0]).toBeLessThan(app.width);
    evidence.recordAssertionEvidence(
      "Float opens the card in its own window",
      `The card is a separate ${frame.outer[0]}×${frame.outer[1]}px window with no frame, while the chat shows no card and no native page.`,
      frame.inner[0] === frame.outer[0] && frame.inner[1] === frame.outer[1],
    );
    await floating.user.screenshot();
  });

  await step("after: full screen shows the same page across the whole screen", async () => {
    await (await floatingCard()).user.click({ testId: "browser-mode-fullscreen" });
    await user.see(fullscreen);
    await user.see({ testId: "browser-fullscreen-exit" });
    await browserMode("fullscreen");
    await floatingClosed();
    // Rest the pointer on Exit (no tooltip), so a toolbar tooltip under the
    // old pointer position cannot legitimately cover the page.
    await user.hover({ testId: "browser-fullscreen-exit" });
    const view = await probe.eventually(() => pageView(true), { within: WITHIN, until: (view) => (view?.bounds.width ?? 0) > sideWidth, label: "the native page fills the wider full-screen view" });
    const width = view?.bounds.width ?? 0;
    // Witness: a full-screen page wider than the side panel proves the native view really moved.
    expect(width).toBeGreaterThan(sideWidth);
    const screenFull = await probe.eventually(() => world.appFullscreen(), {
      within: WITHIN, until: Boolean, label: "the app window enters full screen",
    });
    evidence.recordAssertionEvidence(
      "Full screen paints the same page across the screen",
      `The app window is in full screen and the same tab is painted ${width}px wide, against ${sideWidth}px beside the chat; the floating window is gone.`,
      width > sideWidth && screenFull,
    );
    await user.screenshot();
  });

  await step("after: Escape leaves full screen for the floating window the person came from", async () => {
    await user.press("Escape");
    await probe.eventually(() => probe.dom('[data-testid="browser-fullscreen-dialog"]'), { within: WITHIN, until: (dom) => dom.elements.length === 0, label: "full screen finishes closing" });
    await user.notSee(fullscreen);
    await browserMode("floating");
    const floating = await floatingCard();
    expect(await pageView(false)).toMatchObject({ tabId });
    const windowed = !(await probe.eventually(() => world.appFullscreen(), { within: WITHIN, until: (full) => !full, label: "the app window leaves full screen" }));
    evidence.recordAssertionEvidence(
      "Escape returns to the last mode",
      "Escape closed full screen and left it on the screen too; the card is back in its own window and the native page is off the chat again.",
      windowed,
    );
    await floating.user.screenshot();
  });

  await step("after: the floating window's close button puts the browser back beside the chat", async () => {
    const floating = await floatingCard();
    await floating.user.click({ testId: "browser-floating-close" });
    await browserMode("side");
    await floatingClosed();
    const view = await pageView(true);
    expect(view).toMatchObject({ tabId });
    evidence.recordAssertionEvidence(
      "Closing the window docks the browser",
      `The close button closed the floating window and the same page is back beside the chat (${view?.bounds.width ?? 0}px wide).`,
      view?.tabId === tabId,
    );
    await user.screenshot();
    // Pop it out again for the Browser button step.
    await user.click({ testId: "browser-mode-float" });
    await browserMode("floating");
  });

  await step("after: the Browser button only opens and closes the side panel; it never pops the page out", async () => {
    // From the floating window, the button docks the page back beside the chat.
    await user.click(toggle);
    await browserMode("side");
    await floatingClosed();
    await pageView(true);
    await user.click(toggle);
    await browserMode("hidden");
    expect(await pageView(false)).toMatchObject({ tabId });
    // The person last floated the page, yet showing it again opens the side panel, not a window.
    await user.click(toggle);
    await browserMode("side");
    const view = await pageView(true);
    const popped = await world.floatingWindowOpen();
    expect(popped).toBe(false);
    const tabs = (await probe.browserState()).tabs.filter((tab) => tab.ownerSessionId === sessionId);
    expect(tabs.map((tab) => tab.id)).toEqual([tabId]);
    evidence.recordAssertionEvidence(
      "The Browser button toggles the side panel only",
      `It docked the floating page beside the chat, hid it, and showed it beside the chat again (${view?.bounds.width ?? 0}px wide) with no floating window and the same single tab (${tabs.length} owned by this chat).`,
      !popped && tabs.length === 1 && tabs[0]?.id === tabId,
    );
    await user.screenshot();
    // Popping out stays with the browser's own control.
    await user.click({ testId: "browser-mode-float" });
    await browserMode("floating");
  });
  await step("after: a page under the person's control has no floating screenshot", async () => {
    await (await floatingCard()).user.click({ testId: "browser-floating-preview" });
    await browserMode("side");
    await user.click({ role: "button", label: "Take over" });
    await user.see({ role: "button", label: "Resume browser" });
    await user.click({ testId: "browser-mode-float" });
    const floating = await floatingCard();
    await floating.user.notSee({ testId: "browser-floating-thumbnail" });
    evidence.recordAssertionEvidence("Takeover withholds the page preview", "The card window remains available while the person controls the page, and it contains no screenshot.", (await floating.probe.dom('[data-testid="browser-floating-thumbnail"]')).elements.length === 0);
    await floating.user.screenshot();
  });

  await step("after: resuming and navigating keeps the same tab and captures only its current page", async () => {
    await (await floatingCard()).user.click({ testId: "browser-floating-preview" });
    await user.click({ role: "button", label: "Resume browser" });
    await user.type({ placeholder: "Enter URL..." }, `${world.origin}/?floating-browser=updated`, { replace: true });
    await user.press("Enter");
    await user.click({ testId: "browser-mode-float" });
    const floating = await floatingCard();
    await floating.user.see({ testId: "browser-floating-thumbnail" }, { timeoutMs: 30_000 });
    const current = await probe.eventually(() => world.thumbnail(tabId), { within: WITHIN, until: (value) => Boolean(value?.url.includes("floating-browser=updated")), label: "the preview names the current page" });
    expect(current?.url).toBe(`${world.origin}/?floating-browser=updated`);
    evidence.recordAssertionEvidence("The floating preview follows navigation", "After resuming and navigating, the same tab returns to the card window with a screenshot of its current URL.", current?.url === `${world.origin}/?floating-browser=updated`);
    await floating.user.screenshot();
  });

});
