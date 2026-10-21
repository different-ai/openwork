import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appWebProfileDisposal } from "../worlds/app-web-profile-disposal.ts";

const test = spec.world(appWebProfileDisposal, {
  resources: { surfaces: ["appWeb"], services: [] },
  timeout: 180_000,
});

test("a headless app test releases its browser cache when the fixture finishes, keeping its log", async ({ world, user, step, evidence }) => {
  await step("given a real headless app with browser profile data on disk", async () => {
    await user.see("composer", { timeoutMs: 60_000 });
    expect(world.beforeBytes).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("the browser really created profile data", `profile bytes before final disposal=${world.beforeBytes}`, world.beforeBytes > 0);
    await user.screenshot();
  });

  let receipt: Awaited<ReturnType<typeof world.finish>> | null = null;
  await step("when the test finishes its fixture, the owned browser really stops", async () => {
    receipt = await world.finish();
    evidence.recordAssertionEvidence("final fixture disposal stopped the owned browser", `browser stopped=${receipt.browserStopped}`, receipt.browserStopped);
    expect(receipt.browserStopped).toBe(true);
  });

  await step("after: the browser profile is gone and its diagnostic log remains", async () => {
    if (!receipt) throw new Error("Final fixture disposal did not return a receipt.");
    const removed = receipt.profileRemoved;
    const kept = receipt.logPreserved;
    evidence.recordAssertionEvidence("only browser data is released", `profile removed=${removed}; log preserved=${kept}; retained log bytes=${receipt.logBytes}`, removed && kept);
    expect(removed).toBe(true);
    expect(kept).toBe(true);
  });
});
