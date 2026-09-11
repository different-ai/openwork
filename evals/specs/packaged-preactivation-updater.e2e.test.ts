import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Probe } from "@openwork/testkit";
import {
  packagedActivatedUpdaterWorld,
  packagedPreactivationUpdaterWorld,
} from "../worlds/packaged-preactivation-updater.ts";

/**
 * An enterprise install must not check for or stage an update before it is
 * activated. Until activation no Den is known, so the organization's
 * allowed-versions policy cannot be honoured; an early check would stage the
 * newest enterprise release and defeat that containment. 0.18.43 moved the
 * updater above the activation gate, which is exactly when this started.
 *
 * Both halves boot the same packaged enterprise binary on a fresh profile. The
 * first has no bootstrap, so the activation gate is on screen and the updater
 * is never invoked. The second seeds an activation stamp for an unreachable Den
 * with nobody signed in: the updater does run there, but since #4767 a managed
 * install whose organization policy cannot be verified must stop at the policy
 * gate in the main process instead of fetching the release manifest (the
 * "activated managed, signed out" row of that issue). That refusal is logged,
 * so the same watch proves the updater ran and where it stopped.
 */
const ACTIVATION_HEADING = "Link this app to your organization";

/** The unfixed build checked and started a download within ~2 s of the renderer booting. */
const QUIET_WINDOW_MS = 20_000;

const preactivation = spec.world(packagedPreactivationUpdaterWorld, { timeout: 180_000 });
const activated = spec.world(packagedActivatedUpdaterWorld, { timeout: 180_000 });

async function requireEnterpriseFlavor(world: { flavor: () => Promise<string | null> }, probe: Probe) {
  const flavor = await probe.eventually(() => world.flavor(), {
    within: 30_000,
    label: "packaged distribution flavor",
    until: (value) => value !== null,
  });
  if (flavor !== "enterprise") {
    throw new Error(`Activation gates only the enterprise flavor; OPENWORK_EVAL_ELECTRON_BINARY points at a ${flavor ?? "unknown"} build`);
  }
}

preactivation("an unactivated enterprise install does not check for or download updates", async ({ world, user, probe, evidence }) => {
  await requireEnterpriseFlavor(world, probe);
  await probe.eventually(() => world.rootText(), {
    within: 60_000,
    label: "enterprise activation gate mounted in #root",
    until: (text) => text.includes(ACTIVATION_HEADING),
  });
  await user.see({ text: ACTIVATION_HEADING });

  // The renderer (and its updater provider) is up. Watch the main process for
  // the whole quiet window, stopping early only if a check does appear.
  const quietUntil = Date.now() + QUIET_WINDOW_MS;
  const activity = await probe.eventually(() => world.updaterActivity(), {
    within: QUIET_WINDOW_MS + 10_000,
    intervalMs: 1_000,
    label: "updater activity before activation",
    until: (value) => value.checks > 0 || Date.now() >= quietUntil,
  });
  // The install is still unactivated at the end of the window, so any activity
  // above happened before the organization's policy could be known.
  await user.see({ text: ACTIVATION_HEADING });
  await user.screenshot();

  expect(activity.checks, `update checks started before activation: ${activity.lines.join(" | ")}`).toBe(0);
  expect(activity.downloads, `update downloads started before activation: ${activity.lines.join(" | ")}`).toBe(0);
  evidence.recordAssertionEvidence(
    `An unactivated enterprise install starts no update check or download within ${QUIET_WINDOW_MS / 1000}s of showing "${ACTIVATION_HEADING}"`,
    `main-process updater lines: ${JSON.stringify(activity.lines)}`,
    activity.checks === 0 && activity.downloads === 0,
  );
});

activated("an activated enterprise install with no verified organization policy stops at the policy gate instead of checking", async ({ world, user, probe, evidence }) => {
  await requireEnterpriseFlavor(world, probe);

  // Same binary, same watch: once activated the renderer asks for a check
  // without any user action. Nobody is signed in and the Den is unreachable, so
  // the main process must refuse at the policy gate; the refusal line is the
  // proof the updater ran, and the absence of "Checking for update" is the
  // proof it never reached the release manifest.
  const activity = await probe.eventually(() => world.updaterActivity(), {
    within: 90_000,
    intervalMs: 1_000,
    label: "updater policy gate after activation",
    until: (value) => value.policyRefusals > 0 || value.checks > 0,
  });
  const rootText = await world.rootText();
  await user.notSee({ text: ACTIVATION_HEADING }, { timeoutMs: 1_000 });
  await user.screenshot();

  expect(rootText, "the activation gate must not be on screen for an activated install").not.toContain(ACTIVATION_HEADING);
  expect(activity.policyRefusals, `updater lines: ${activity.lines.join(" | ")}`).toBeGreaterThan(0);
  expect(activity.checks, `update checks reached the network without a verified policy: ${activity.lines.join(" | ")}`).toBe(0);
  expect(activity.downloads, `update downloads started without a verified policy: ${activity.lines.join(" | ")}`).toBe(0);
  evidence.recordAssertionEvidence(
    "An activated enterprise install with nobody signed in runs its automatic update check, is refused at the main-process policy gate, and never fetches the release manifest",
    `main-process updater lines: ${JSON.stringify(activity.lines)}`,
    activity.policyRefusals > 0 && activity.checks === 0 && activity.downloads === 0,
  );
});
