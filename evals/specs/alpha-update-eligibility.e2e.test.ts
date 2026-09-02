import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { alphaUpdateWorld } from "../worlds/first-run.ts";

const test = spec.world(alphaUpdateWorld, { needs: { placement: "local" }, timeout: 120_000 });

test("the macOS updater surfaces eligible and gated Alpha builds accurately", async ({ world, user, seed, probe, step }) => {
  await user.click({ label: "Release channel" });
  await user.click("Alpha");

  await step("A newer build on the installed Alpha release is offered", async () => {
    await user.see({ text: /Update available: v0\.18\.37-alpha\.2492\+4921a02/ }, { timeoutMs: 30_000 });
    await user.see("Download");
    await user.notSee({ text: /You're up to date/ });
  });

  // TODO(primitive): update the controlled updater candidate.
  await seed.evalIn(world.app, `window.__openworkAlphaUpdateEligibilityEvalState.latestVersion = "0.18.38-alpha.2493+abcdef0"`);
  await user.click("Check now");

  await step("A gated Alpha release stays blocked without a false current status", async () => {
    await user.see({ text: /Update available: v0\.18\.38-alpha\.2493\+abcdef0/ }, { timeoutMs: 30_000 });
    await user.see({ text: /this installation is not eligible for it yet/ });
    await user.notSee("Download");
    await user.notSee({ text: /You're up to date/ });
  });

  // TODO(primitive): inspect updater witness calls.
  const alphaChecks = await probe.eval(`window.__openworkAlphaUpdateEligibilityEvalState.checks.filter((channel) => channel === "alpha").length`);
  expect(alphaChecks).toBe(2);
});
