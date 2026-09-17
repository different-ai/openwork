import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { unmanagedPrimaryLinkWorld } from "../worlds/browser-panel.ts";

const test = spec.world(unmanagedPrimaryLinkWorld);

test("a trusted primary HTTPS click on an affirmatively unmanaged desktop opens only the default browser", async ({ world, user, evidence }) => {
  const link = { role: "link" as const, text: world.linkUrl };
  await user.see(link, { timeoutMs: 30_000 });
  expect(await world.externalOpens()).toEqual([]);
  const before = await world.readBrowserState();

  await user.click(link);

  const opened = await eventually(() => world.externalOpens(), {
    within: 15_000,
    until: (urls) => urls.length === 1,
    label: "the trusted primary click reaches the default-browser boundary",
  });
  expect(opened).toEqual([world.linkUrl]);
  expect(await world.readBrowserState()).toEqual(before);
  await user.click("composer");
  await user.see(link);
  evidence.recordAssertionEvidence(
    "An affirmatively unmanaged primary HTTPS link preserves the desktop-browser default",
    `One trusted left click emitted exactly ${world.linkUrl} to the captured external-open boundary, created no built-in tab, showed no blocking native modal, and left the transcript interactive.`,
    true,
  );
});
