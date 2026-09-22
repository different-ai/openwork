import { expect } from "vitest";
import type { Target } from "@openwork/testkit";
import { spec } from "@openwork/testkit";
import { browserGeometryWorld, browserViewportWorld, CAPTURE_VIEWPORT, INPUT_PROBE_PAGE } from "../worlds/browser-panel.ts";

const test = spec.world(browserViewportWorld, {
  resources: { surfaces: ["desktop"], services: [], nativeReason: "Electron WebContentsView must recover its real panel viewport after CDP emulation." },
});
const geometryTest = spec.world(browserGeometryWorld, {
  resources: { surfaces: ["desktop"], services: [], nativeReason: "Native WebContentsView bounds follow Electron zoom and panel resizing without replacing the page." },
});

// Screenshot and docs-shots clients emulate a capture viewport on the visible
// built-in browser tab over CDP. Chromium keeps that emulated size after the
// client disconnects and nothing about the panel changes, so the page keeps
// laying out for a 1440px desktop inside a narrow side panel and shows up
// clipped. Returning to the tab must snap it back to the panel's viewport.
const tabButton = (name: string): Target => ({ role: "button", label: new RegExp(`^Select tab: .*viewport-probe=${name}$`) });

test("a visible built-in browser tab left with an automation viewport snaps back to the panel when the user returns to it", async ({ world, user, probe, step, evidence }) => {
  const { tab, panelViewport } = world;
  await user.see(tabButton("first"), { timeoutMs: 30_000 });
  expect(panelViewport.width).toBeGreaterThan(0);
  expect(panelViewport.width).toBeLessThan(CAPTURE_VIEWPORT.width);

  await step("An automation client leaves a capture viewport on the visible tab", async () => {
    expect(await probe.browserTabMetrics(tab.targetId)).toMatchObject(CAPTURE_VIEWPORT);
    evidence.recordAssertionEvidence("The fixture reproduces a leftover capture viewport", "The visible tab reported the requested 1440 by 900 capture viewport after the capture client left it behind.", true);
  });

  await step("Selecting the tab renders it at the panel's viewport again", async () => {
    await user.click(tabButton("first"));
    const recovered = await probe.eventually(() => probe.browserTabMetrics(tab.targetId), {
      within: 15_000,
      until: (viewport) => viewport.width === panelViewport.width && viewport.height === panelViewport.height,
      label: "built-in browser tab viewport matches the panel",
    });
    expect(recovered).toMatchObject(panelViewport);
    evidence.recordAssertionEvidence("Selecting the tab restores the panel viewport", "Clicking the visible tab restored both viewport dimensions to their original panel values.", true);
  });
});

geometryTest("the native browser survives zoom, resizing, overlays and conversation changes without losing input", async ({ world, user, probe, step, evidence }) => {
  const { tab, page, session, neighbor } = world;
  const field: Target = { role: "textbox" };
  const draft = "Keep this browser input through layout changes";
  const budgetMs = 5_000;
  await user.see({ role: "button", label: "Reload page" });
  await probe.eventually(() => probe.browserState(), {
    within: budgetMs,
    until: state => state.activeTabId === tab.tabId && state.nativeViews.some(view =>
      view.tabId === tab.tabId && view.attached && view.aboveApp && view.visible),
    label: "the seeded browser tab is visible in its panel before typing",
  });
  await user.on(page).see({ role: "button", label: "hit" });
  const original = await probe.browserTabMetrics(tab.targetId);
  expect(original).toMatchObject({ url: INPUT_PROBE_PAGE, title: "input-probe" });
  const identity = { url: original.url, title: original.title, timeOrigin: original.timeOrigin };

  // This is the actual contentRef div, not the surrounding toolbar/panel shell.
  const container = '[data-slot="resizable-panel"]:has(button[aria-label="Reload page"]) .relative.min-h-0.flex-1.overflow-hidden > .h-full.overflow-hidden';
  // This bound includes CDP round trips; it is not a renderer latency measurement.
  const aligned = async (expectedZoom: number, expectedInput = draft) => {
    const started = performance.now();
    let consecutive = 0;
    const sample = await probe.eventually(async () => {
      try {
        const zoom = await probe.zoom();
        expect(zoom).toBeCloseTo(expectedZoom, 5);
        const dom = await probe.dom(container);
        expect(dom.elements).toHaveLength(1);
        const rect = dom.elements[0].rect;
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.height).toBeGreaterThan(0);
        const state = await probe.browserState();
        expect(state.activeTabId).toBe(tab.tabId);
        expect(state.visibleSessionId).toBe(session.sessionId);
        expect(state.tabs.map(item => ({ id: item.id, ownerSessionId: item.ownerSessionId })))
          .toEqual([{ id: tab.tabId, ownerSessionId: session.sessionId }]);
        expect(state.nativeViews).toHaveLength(1);
        const view = state.nativeViews[0];
        expect(view).toMatchObject({ tabId: tab.tabId, attached: true, aboveApp: true, visible: true });
        const expected = {
          x: Math.round(rect.left * zoom), y: Math.round(rect.top * zoom),
          width: Math.round(rect.right * zoom) - Math.round(rect.left * zoom),
          height: Math.round(rect.bottom * zoom) - Math.round(rect.top * zoom),
        };
        // One DIP accommodates independent fractional-edge rounding, not stale layout.
        const edges: Array<keyof typeof expected> = ["x", "y", "width", "height"];
        for (const key of edges) {
          expect(Math.abs(view.bounds[key] - expected[key]), `${key}: native vs current container at zoom ${zoom}`).toBeLessThanOrEqual(1);
        }
        // Matching the child rectangle alone cannot prove containment when that
        // child overflows. The native sibling must not cover the chat or toolbar.
        const panel = await probe.dom('[data-slot="resizable-panel"]:has(button[aria-label="Reload page"])');
        const toolbar = await probe.dom('button[aria-label="Reload page"]');
        expect(panel.elements).toHaveLength(1);
        expect(toolbar.elements).toHaveLength(1);
        const paneRect = panel.elements[0].rect;
        expect(view.bounds.x).toBeGreaterThanOrEqual(Math.round(paneRect.left * zoom) - 1);
        expect(view.bounds.x + view.bounds.width).toBeLessThanOrEqual(Math.round(paneRect.right * zoom) + 1);
        expect(view.bounds.y).toBeGreaterThanOrEqual(Math.round(toolbar.elements[0].rect.bottom * zoom) - 1);
        expect(view.bounds.y + view.bounds.height).toBeLessThanOrEqual(Math.round(paneRect.bottom * zoom) + 1);
        const metrics = await probe.browserTabMetrics(tab.targetId);
        expect(metrics).toMatchObject({ ...identity, width: view.bounds.width, height: view.bounds.height });
        expect(await probe.zoom()).toBe(zoom);
        consecutive += 1;
        return { rect, zoom };
      } catch (error) {
        consecutive = 0;
        throw error;
      }
    }, { within: budgetMs, intervalMs: 50, until: () => consecutive >= 3, label: "three aligned native/container/viewport samples within five seconds" });
    // Keep the observation bounded even if eventually finishes a probe after its deadline.
    expect(performance.now() - started).toBeLessThanOrEqual(budgetMs);
    await user.on(page).see(field, { value: expectedInput, timeoutMs: budgetMs });
    return sample;
  };

  const focusSeparator = async () => {
    await user.click({ role: "separator" });
    expect((await probe.dom('[data-slot="resizable-handle"][role="separator"]')).elements.map(element => element.focused))
      .toEqual([true]);
  };

  await step("Initial resizing recovers the viewport before any interaction with the page", async () => {
    if (await probe.has("Not now")) {
      await user.click({ role: "button", label: "Not now" });
    }
    await focusSeparator();
    await user.press("Control+0");
    const before = await aligned(1, "");
    const initialFocus = (await probe.browserTabMetrics(tab.targetId)).hasFocus;
    for (let key = 0; key < 3; key++) await user.press("ArrowLeft");
    const after = await aligned(1, "");
    expect(after.rect.width).toBeGreaterThan(before.rect.width + 10);
    const separator = await probe.dom('[data-slot="resizable-handle"][role="separator"]');
    expect(separator.elements.map(element => element.focused)).toEqual([true]);
    // CDP routes input to the chosen renderer; on Linux that renderer's DOM
    // focus and the native sibling's document.hasFocus() can both remain true.
    // Prove the divider owned these keys, without clicking/typing in the page.
    evidence.recordJsonArtifact("Initial resize focus and geometry", {
      initialPageHasFocus: initialFocus,
      finalPageHasFocus: (await probe.browserTabMetrics(tab.targetId)).hasFocus,
      separatorFocused: true, before: before.rect, after: after.rect,
    });
    evidence.recordAssertionEvidence("Browser resizing converges before the first page interaction", "Three keys went to the focused divider before any page click or typing. The native view and page matched the resized container in three consecutive samples, with the same document and empty input.", true);
  });
  await user.on(page).type(field, draft);

  // The single separator resizes the side panel through trusted keyboard events.
  await user.click({ role: "separator" });
  await user.press("Control+0");
  await aligned(1);
  await step("Zoom and keyboard panel resizing reach aligned samples within five seconds and retain the exact document and draft", async () => {
    // No settling waits between keys in a burst. These are sampled convergence
    // assertions, not a claim about every frame or native OS window dragging.
    await user.press("Control+=");
    await user.press("Control+=");
    await aligned(1.2);
    // Zoom can cross the responsive breakpoint that hides the resize handle.
    // Check alignment there too, then return to the resizable desktop layout.
    await user.press("Control+-");
    const enlarged = await aligned(1.1);
    await focusSeparator();
    await user.press("ArrowLeft");
    await user.press("ArrowLeft");
    const wider = await aligned(1.1);
    expect(wider.rect.width).toBeGreaterThan(enlarged.rect.width + 10);
    expect(wider.rect.left).toBeLessThan(enlarged.rect.left - 10);

    await user.press("Control+-");
    await user.press("Control+-");
    const reduced = await aligned(0.9);
    await focusSeparator();
    await user.press("ArrowRight");
    await user.press("ArrowRight");
    const narrower = await aligned(0.9);
    expect(narrower.rect.width).toBeLessThan(reduced.rect.width - 10);
    expect(narrower.rect.left).toBeGreaterThan(reduced.rect.left + 10);
    await user.press("Control+=");
    await user.press("ArrowLeft");
    await user.press("Control+=");
    await user.press("ArrowRight");
    await aligned(1.1);
    await user.press("Control+0");
    await aligned(1);
  });
  const noNativeOverlay = async () => {
    const state = await probe.eventually(() => probe.browserState(), {
      within: budgetMs,
      until: value => value.nativeViews.every(view => !view.aboveApp || !view.visible),
      label: "no native browser is painted over the app",
    });
    expect(state.tabs.map(item => item.id)).toEqual([tab.tabId]);
    expect(await probe.browserTabMetrics(tab.targetId)).toMatchObject(identity);
  };
  const palette = { placeholder: "Search actions, settings, and sessions…" };
  await step("A dialog hides the native sibling, and sidebar position changes restore the same page", async () => {
    const before = await aligned(1);
    for (let toggle = 0; toggle < 2; toggle++) {
      await focusSeparator();
      await user.press("Control+K");
      await user.see(palette);
      await noNativeOverlay();
      await user.type(palette, "> Toggle sidebar", { replace: true });
      await user.click({ role: "option", label: /^Toggle sidebar/ });
      await user.notSee(palette);
      const after = await aligned(1);
      if (toggle === 0) expect(after.rect.left).not.toBe(before.rect.left);
      else expect(Math.abs(after.rect.left - before.rect.left)).toBeLessThanOrEqual(1);
    }
  });
  await step("Repeated panel close and reopen cannot leave a native overlay or replace the document", async () => {
    for (let cycle = 0; cycle < 2; cycle++) {
      await user.click({ role: "button", label: "Close side panel" });
      await noNativeOverlay();
      await user.click({ role: "button", label: "Open side panel" });
      await aligned(1);
    }
  });
  await step("Repeated conversation round trips preserve the page and keep background geometry off screen", async () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      await user.click({ text: neighbor.title });
      await noNativeOverlay();
      const parked = await probe.eventually(() => probe.browserState(), {
        within: budgetMs,
        until: value => value.visibleSessionId === neighbor.sessionId
          && value.nativeViews.every(view => !view.aboveApp),
        label: "the neighbor owns the screen without a browser overlay",
      });
      expect(parked.nativeViews).toHaveLength(1);
      expect(parked.nativeViews[0]).toMatchObject({ tabId: tab.tabId, attached: false, aboveApp: false });
      await probe.eventually(() => probe.browserTabMetrics(tab.targetId), {
        within: budgetMs,
        until: value => value.width === 1280 && value.height === 800,
        label: "background viewport emulation remains usable after each round trip",
      });
      await user.click({ text: session.title });
      await aligned(1);
    }
  });
  await user.on(page).type(field, " and still editable");
  await user.on(page).see(field, { value: `${draft} and still editable`, timeoutMs: budgetMs });
  expect(await probe.browserTabMetrics(tab.targetId)).toMatchObject(identity);
  evidence.recordAssertionEvidence("Browser geometry and page state survive layout and ownership transitions", "Native and page dimensions remained aligned at 90–120% zoom, through keyboard resizing, modal/sidebar transitions, two panel close/reopen cycles and three conversation round trips. Hidden views never painted over the app, and the original page retained its input and accepted further typing.", true);
});
