import { expect } from "vitest";
import { sleep, spec } from "@openwork/testkit";
import {
  KNOWN_LAUNCH_REJECTIONS,
  describeException,
  isKnownRejection,
  isRenderCrash,
  packagedActivatedLaunchWorld,
} from "../worlds/packaged-first-launch.ts";

const test = spec.world(packagedActivatedLaunchWorld, { timeout: 180_000 });

/**
 * The path existing enterprise customers take after an update: the bootstrap
 * already carries an activation stamp, so the activation gate must step aside
 * and the routes behind it must mount. The seeded Den is a closed local port,
 * so this holds with no network at all; the sign-in surface it lands on reads
 * its heading from the bootstrap, not from Den.
 */
const ACTIVATION_GATE_HEADING = "Link this app to your organization";
const SIGN_IN_HEADING = "Welcome to OpenWork";

/** Heading of the root error boundary's recovery screen (app-error-boundary.tsx). */
const RECOVERY_HEADING = /OpenWork hit an unexpected error/;

/** Late boot work (config refresh, bridge calls) settles well inside this after the routes mount. */
const REJECTION_SETTLE_MS = 3_000;

test("an activated enterprise install boots past the activation gate without a render crash", async ({ world, user, probe, evidence }) => {
  const flavor = await probe.eventually(() => world.flavor(), {
    within: 30_000,
    label: "packaged distribution flavor",
    until: (value) => value !== null,
  });
  if (flavor !== "enterprise") throw new Error(`Activation only exists in the enterprise flavor; point OPENWORK_EVAL_ELECTRON_BINARY at an enterprise build (got ${flavor})`);

  // Stop on the first of: the sign-in surface, the activation gate, the recovery
  // screen, or a render crash, so a failure names what went wrong instead of
  // timing out on a blank window.
  const rootText = await probe.eventually(() => world.rootText(), {
    within: 60_000,
    label: "activated enterprise routes mounted in #root",
    until: (text) => text.includes(SIGN_IN_HEADING) || text.includes(ACTIVATION_GATE_HEADING) || RECOVERY_HEADING.test(text) || world.exceptions().some(isRenderCrash),
  });
  const mounted = world.exceptions();
  const crashes = mounted.filter(isRenderCrash);
  expect(crashes.map(describeException), "the renderer threw while booting an activated enterprise install").toEqual([]);
  expect(rootText, "the root error boundary caught a render crash on an activated enterprise install").not.toMatch(RECOVERY_HEADING);
  expect(rootText.trim(), "#root stayed empty on an activated enterprise install").not.toBe("");

  // Negative half: the seeded activation must be honoured, so the gate for an
  // unactivated machine must not appear.
  expect(rootText, "an already-activated install showed the activation gate").not.toContain(ACTIVATION_GATE_HEADING);
  expect(rootText).toContain(SIGN_IN_HEADING);
  await user.see({ text: SIGN_IN_HEADING });
  await user.notSee({ text: ACTIVATION_GATE_HEADING });
  await user.notSee({ text: RECOVERY_HEADING });
  await user.screenshot();

  await sleep(REJECTION_SETTLE_MS);
  const exceptions = world.exceptions();
  const knownRejections = exceptions.filter(isKnownRejection);
  const unexpected = exceptions.filter((exception) => !isRenderCrash(exception) && !isKnownRejection(exception));
  expect(unexpected.map(describeException), `an unhandled promise rejection outside KNOWN_LAUNCH_REJECTIONS (${KNOWN_LAUNCH_REJECTIONS.length} allowed) while booting an activated enterprise install`).toEqual([]);
  expect(exceptions.filter(isRenderCrash).map(describeException), "the renderer threw after the activated enterprise routes mounted").toEqual([]);

  evidence.recordAssertionEvidence(
    `An activated enterprise install with Den at ${world.denBaseUrl} (closed port) mounts "${SIGN_IN_HEADING}" and never shows "${ACTIVATION_GATE_HEADING}"`,
    `#root text: ${JSON.stringify(rootText.slice(0, 200))}; render crashes: ${crashes.length}; allowlisted rejections: ${knownRejections.length} of ${KNOWN_LAUNCH_REJECTIONS.length} known; unexpected rejections: ${unexpected.length}`,
    crashes.length === 0 && unexpected.length === 0 && !rootText.includes(ACTIVATION_GATE_HEADING),
  );
});
