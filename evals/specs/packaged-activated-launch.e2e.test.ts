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
 *
 * This is the activated half of a pair: packaged-first-launch boots the same
 * enterprise artifact with no bootstrap and requires the activation gate
 * heading, so a gate that always stepped aside would fail there. packaged-smoke
 * runs both against one binary.
 */
const ACTIVATION_GATE_HEADING = "Link this app to your organization";
const SIGN_IN_HEADING = "Welcome to OpenWork";

/** Heading of the root error boundary's recovery screen (app-error-boundary.tsx). */
const RECOVERY_HEADING = /OpenWork hit an unexpected error|OpenWork couldn't start/;

/** Bounded observation window, not a guarantee against faults after it ends. */
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
  const final = await world.health();
  expect(final.rootText, "startup recovery appeared during settle").not.toMatch(RECOVERY_HEADING);
  expect(final.rootText, "the activated sign-in surface disappeared during settle").toContain(SIGN_IN_HEADING);
  expect(final.rootText, "an activated install returned to the activation gate").not.toContain(ACTIVATION_GATE_HEADING);
  const usable = final.controls.filter((control) => control.visible && control.enabled);
  expect(usable.some((control) => control.tag === "button" && control.text === "Sign in to OpenWork"), "Sign in must remain visible and enabled").toBe(true);
  expect(usable.some((control) => control.tag === "button" && control.text === "Paste sign-in code"), "Sign-in code disclosure must remain visible and enabled").toBe(true);
  const exceptions = world.exceptions();
  const knownRejections = exceptions.filter(isKnownRejection);
  const unexpected = exceptions.filter((exception) => !isRenderCrash(exception) && !isKnownRejection(exception));
  expect(unexpected.map(describeException), `an unhandled promise rejection outside KNOWN_LAUNCH_REJECTIONS (${KNOWN_LAUNCH_REJECTIONS.length} allowed) while booting an activated enterprise install`).toEqual([]);
  expect(exceptions.filter(isRenderCrash).map(describeException), "the renderer threw after the activated enterprise routes mounted").toEqual([]);

  evidence.recordAssertionEvidence(
    `An activated enterprise install with Den at ${world.denBaseUrl} (closed port) mounts "${SIGN_IN_HEADING}" and never shows "${ACTIVATION_GATE_HEADING}"`,
    `Final #root after ${REJECTION_SETTLE_MS} ms: ${JSON.stringify(final.rootText.slice(0, 200))}; visible enabled controls: ${JSON.stringify(usable)}; render crashes: ${exceptions.filter(isRenderCrash).length}; allowlisted rejections: ${knownRejections.length} of ${KNOWN_LAUNCH_REJECTIONS.length} known; unexpected rejections: ${unexpected.length}`,
    exceptions.filter(isRenderCrash).length === 0 && unexpected.length === 0 && !final.rootText.includes(ACTIVATION_GATE_HEADING),
  );
});
