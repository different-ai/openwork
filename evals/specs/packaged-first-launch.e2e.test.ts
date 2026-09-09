import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRenderCrash, packagedFirstLaunchWorld } from "../worlds/packaged-first-launch.ts";
import type { PackagedFlavor } from "../worlds/packaged-first-launch.ts";

const test = spec.world(packagedFirstLaunchWorld, { timeout: 180_000 });

/**
 * What a brand-new machine sees on first launch. The cloud and enterprise
 * flavors render a gate above the routes, before any provider that needs a
 * signed-in or activated desktop exists. 0.18.43 and 0.18.44 shipped with the
 * enterprise gate throwing during render, which left customers a blank window.
 * The public flavor has no gate and is covered by app-smoke.
 */
const FIRST_LAUNCH_HEADING: Partial<Record<PackagedFlavor, string>> = {
  cloud: "Welcome to OpenWork",
  enterprise: "Link this app to your organization",
};

test("a packaged flavor renders its first-launch gate without a render crash", async ({ world, user, probe, evidence }) => {
  const flavor = await probe.eventually(() => world.flavor(), {
    within: 30_000,
    label: "packaged distribution flavor",
    until: (value) => value !== null,
  });
  if (flavor === null) throw new Error("The packaged desktop did not report its distribution flavor");
  const heading = FIRST_LAUNCH_HEADING[flavor];
  if (!heading) throw new Error(`The ${flavor} flavor has no first-launch gate; point OPENWORK_EVAL_ELECTRON_BINARY at a cloud or enterprise build`);

  // A render throw unmounts the whole tree, so an empty #root and the crash
  // arrive together. Stop on the first crash so the failure names it instead of
  // timing out on a blank window.
  const rootText = await probe.eventually(() => world.rootText(), {
    within: 60_000,
    label: `${flavor} first-launch gate mounted in #root`,
    until: (text) => text.includes(heading) || world.exceptions().some(isRenderCrash),
  });
  const exceptions = world.exceptions();
  const crashes = exceptions.filter(isRenderCrash);
  const contextCrashes = exceptions.filter((exception) => /context is missing|must be used within/i.test(`${exception.text} ${exception.description}`));
  expect(contextCrashes, "a provider context was missing during first launch").toEqual([]);
  expect(crashes, "the renderer threw during first launch").toEqual([]);

  expect(rootText).toContain(heading);
  await user.see({ text: heading });
  await user.notSee({ text: /Something went wrong/ });
  await user.screenshot();

  const rejections = exceptions.length - crashes.length;
  evidence.recordAssertionEvidence(
    `The ${flavor} desktop mounts "${heading}" on first launch without a render crash`,
    `#root text: ${JSON.stringify(rootText.slice(0, 200))}; render crashes: ${crashes.length}; unhandled promise rejections (not gating): ${rejections}`,
    crashes.length === 0,
  );
});
