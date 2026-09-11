import { expect } from "vitest";
import { sleep, spec } from "@openwork/testkit";
import {
  KNOWN_LAUNCH_REJECTIONS,
  describeException,
  isKnownRejection,
  isRenderCrash,
  packagedFirstLaunchWorld,
} from "../worlds/packaged-first-launch.ts";
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

/** Heading of the root error boundary's recovery screen (app-error-boundary.tsx). */
const RECOVERY_HEADING = /OpenWork hit an unexpected error/;

/** Late boot work (config refresh, bridge calls) settles well inside this after the gate mounts. */
const REJECTION_SETTLE_MS = 3_000;

test("a packaged flavor renders its first-launch gate without a render crash", async ({ world, user, probe, evidence }) => {
  const flavor = await probe.eventually(() => world.flavor(), {
    within: 30_000,
    label: "packaged distribution flavor",
    until: (value) => value !== null,
  });
  if (flavor === null) throw new Error("The packaged desktop did not report its distribution flavor");
  const heading = FIRST_LAUNCH_HEADING[flavor];
  if (!heading) throw new Error(`The ${flavor} flavor has no first-launch gate; point OPENWORK_EVAL_ELECTRON_BINARY at a cloud or enterprise build`);

  // A render throw either unmounts the whole tree (empty #root plus an uncaught
  // exception) or, with the root error boundary, mounts the recovery screen.
  // Stop on the first of those so the failure names the crash instead of
  // timing out on a blank window.
  const rootText = await probe.eventually(() => world.rootText(), {
    within: 60_000,
    label: `${flavor} first-launch gate mounted in #root`,
    until: (text) => text.includes(heading) || RECOVERY_HEADING.test(text) || world.exceptions().some(isRenderCrash),
  });
  const mounted = world.exceptions();
  const crashes = mounted.filter(isRenderCrash);
  const contextCrashes = mounted.filter((exception) => /context is missing|must be used within/i.test(`${exception.text} ${exception.description}`));
  expect(contextCrashes, "a provider context was missing during first launch").toEqual([]);
  expect(crashes.map(describeException), "the renderer threw during first launch").toEqual([]);
  expect(rootText, "the root error boundary caught a first-launch render crash").not.toMatch(RECOVERY_HEADING);

  expect(rootText).toContain(heading);
  await user.see({ text: heading });
  await user.notSee({ text: RECOVERY_HEADING });
  await user.screenshot();

  // A rejected bootstrap promise can leave the app unusable without ever
  // throwing during render, so only exactly-matched known rejections pass.
  await sleep(REJECTION_SETTLE_MS);
  const exceptions = world.exceptions();
  const knownRejections = exceptions.filter(isKnownRejection);
  const unexpected = exceptions.filter((exception) => !isRenderCrash(exception) && !isKnownRejection(exception));
  expect(unexpected.map(describeException), `an unhandled promise rejection outside KNOWN_LAUNCH_REJECTIONS (${KNOWN_LAUNCH_REJECTIONS.length} allowed) during ${flavor} first launch`).toEqual([]);
  expect(exceptions.filter(isRenderCrash).map(describeException), "the renderer threw after the first-launch gate mounted").toEqual([]);

  evidence.recordAssertionEvidence(
    `The ${flavor} desktop mounts "${heading}" on first launch without a render crash or an unexpected unhandled rejection`,
    `#root text: ${JSON.stringify(rootText.slice(0, 200))}; render crashes: ${crashes.length}; allowlisted rejections: ${knownRejections.length} of ${KNOWN_LAUNCH_REJECTIONS.length} known; unexpected rejections: ${unexpected.length}`,
    crashes.length === 0 && unexpected.length === 0,
  );
});
