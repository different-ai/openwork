import { expect } from "vitest";
import type { Target } from "@openwork/testkit";
import { spec } from "@openwork/testkit";
import { browserViewportWorld, CAPTURE_VIEWPORT } from "../worlds/browser-panel.ts";

const test = spec.world(browserViewportWorld);

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
