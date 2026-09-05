import { expect } from "vitest";
import type { Target } from "@openwork/cdp";
import { eventually, spec } from "@openwork/testkit";
import { builtinBrowserWorld } from "../worlds/browser-panel.ts";

const test = spec.world(builtinBrowserWorld);

// Screenshot and docs-shots clients emulate a capture viewport on the visible
// built-in browser tab over CDP. Chromium keeps that emulated size after the
// client disconnects and nothing about the panel changes, so the page keeps
// laying out for a 1440px desktop inside a narrow side panel and shows up
// clipped. Returning to the tab must snap it back to the panel's viewport.
const CAPTURE_VIEWPORT = { width: 1440, height: 900 };
const tabButton = (name: string): Target => ({ role: "button", label: new RegExp(`^Select tab: .*viewport-probe=${name}$`) });

test("a visible built-in browser tab left with an automation viewport snaps back to the panel when the user returns to it", async ({ world, user, step }) => {
  const tab = await world.openTab("first");
  await user.see(tabButton(tab.name), { timeoutMs: 30_000 });
  const panelViewport = await world.readViewport(tab);
  expect(panelViewport.width).toBeGreaterThan(0);
  expect(panelViewport.width).toBeLessThan(CAPTURE_VIEWPORT.width);

  await step("An automation client leaves a capture viewport on the visible tab", async () => {
    await world.leaveViewportEmulation(tab, CAPTURE_VIEWPORT);
    expect(await world.readViewport(tab)).toEqual(CAPTURE_VIEWPORT);
  });

  await step("Selecting the tab renders it at the panel's viewport again", async () => {
    await user.click(tabButton(tab.name));
    const recovered = await eventually(() => world.readViewport(tab), {
      within: 15_000,
      until: (viewport) => viewport.width === panelViewport.width,
      label: "built-in browser tab viewport matches the panel",
    });
    expect(recovered).toEqual(panelViewport);
  });
});
