import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Probe } from "@openwork/testkit";
import { isRenderCrash } from "../worlds/packaged-first-launch.ts";
import { packagedUpdateInstallWorld } from "../worlds/packaged-update-install.ts";
import type { UpdateLaunch } from "../worlds/packaged-update-install.ts";

/**
 * An existing enterprise customer is updated by the app itself: an activated
 * install finds a newer build on its release feed, downloads it, Squirrel.Mac
 * accepts and stages it, quitting installs it, and the next launch is the new
 * version on the same profile. packaged-preactivation-updater proves only that
 * the check starts; this proves the rest on a real, signed .app bundle.
 *
 * packaged-smoke-macos.mjs builds the installed release and the newer one with
 * one signing identity and serves nothing but them, so no published release,
 * network, or Den policy takes part.
 */
const test = spec.world(packagedUpdateInstallWorld, {
  resources: {
    surfaces: ["desktop"],
    services: [],
    nativeReason: "Squirrel.Mac replaces a signed .app bundle on quit; only an installed macOS desktop can download, stage, and apply its own update.",
  },
  timeout: 600_000,
  needs: { platform: "darwin", env: ["OPENWORK_EVAL_ELECTRON_BINARY", "OPENWORK_EVAL_UPDATE_FEED_DIR"] },
});

const ACTIVATION_HEADING = "Link this app to your organization";
const RECOVERY_HEADING = /OpenWork hit an unexpected error/;
/** The forced sign-in surface an activated, signed-out install holds at (den-signin-surface.tsx). */
const SIGN_IN_BUTTON = /^Sign in to /m;

/** Automatic check, a ~340 MB loopback download, and Squirrel's own signature check and unzip. */
const STAGE_BOUND_MS = 300_000;
/** ShipIt swaps the bundle after the main process is gone. */
const INSTALL_BOUND_MS = 120_000;

async function settledSignIn(launch: UpdateLaunch, probe: Probe, label: string) {
  const rootText = await probe.eventually(() => launch.rootText(), {
    within: 90_000,
    label,
    until: (text) => SIGN_IN_BUTTON.test(text) || text.includes(ACTIVATION_HEADING) || RECOVERY_HEADING.test(text)
      || launch.exceptions().some(isRenderCrash),
  });
  const crashes = launch.exceptions().filter(isRenderCrash);
  expect(crashes, `the renderer threw (${label})`).toEqual([]);
  expect(rootText, `the root error boundary caught a render crash (${label})`).not.toMatch(RECOVERY_HEADING);
  expect(rootText, `an activated install showed the activation page (${label})`).not.toContain(ACTIVATION_HEADING);
  expect(rootText, `the forced sign-in surface did not mount (${label})`).toMatch(SIGN_IN_BUTTON);
  return { rootText, crashes: crashes.length };
}

test("an activated enterprise install downloads a newer build, installs it on quit, and boots it on the same profile", async ({ world, user, probe, evidence, step }) => {
  const installed = await step("the installed release is older than the build on its feed", async () => {
    const onDisk = await world.bundleVersion();
    expect(onDisk, "the feed must offer a different version than the one installed").not.toBe(world.updateVersion);
    const launch = await world.launch(true);
    const build = await probe.eventually(() => launch.buildInfo(), { within: 30_000, label: "running build version", until: (value) => value !== null });
    expect(build?.version).toBe(onDisk);
    await settledSignIn(launch, probe, `${onDisk} first launch`);
    return { launch, version: onDisk };
  });

  const staged = await step("the update downloads and is staged without any user action", async () => {
    const activity = await probe.eventually(() => installed.launch.updaterActivity(), {
      within: STAGE_BOUND_MS,
      intervalMs: 2_000,
      label: "update downloaded and staged by Squirrel.Mac",
      until: (value) => value.staged > 0 || value.lines.some((line) => line.startsWith("[updater] error")),
    });
    const zipRequests = world.feedRequests().filter((request) => request.path.endsWith(".zip") && request.status === 200);
    const versionRequests = world.denRequests().filter((request) => request.path.endsWith("/v1/app-version"));
    expect(activity.checks, `no update check: ${activity.lines.join(" | ")}`).toBeGreaterThan(0);
    expect(activity.downloads, `no download started: ${activity.lines.join(" | ")}`).toBeGreaterThan(0);
    expect(activity.staged, `the download was not staged: ${activity.lines.join(" | ")}`).toBeGreaterThan(0);
    expect(zipRequests.length, "the update zip was fetched from the feed").toBeGreaterThan(0);
    expect(versionRequests.length, "the renderer asked the Den which versions are published").toBeGreaterThan(0);
    await user.on(installed.launch.app).screenshot();
    evidence.recordAssertionEvidence(
      `An activated enterprise install ${installed.version} checks, downloads ${world.updateVersion}, and stages it without user action`,
      `checks=${activity.checks} downloads=${activity.downloads} staged=${activity.staged}; feed requests: ${JSON.stringify(world.feedRequests())}; main-process updater lines: ${JSON.stringify(activity.lines)}`,
      activity.checks > 0 && activity.downloads > 0 && activity.staged > 0 && zipRequests.length > 0,
    );
    return activity;
  });

  const applied = await step("quitting installs the staged build into the same bundle", async () => {
    const { exited } = await installed.launch.quit();
    expect(exited, "the app exited after the quit").toBe(true);
    const onDisk = await probe.eventually(() => world.bundleVersion(), {
      within: INSTALL_BOUND_MS,
      intervalMs: 1_000,
      label: "Squirrel.Mac replaced the installed bundle",
      until: (value) => value === world.updateVersion,
    });
    await world.waitForShipIt();
    expect(onDisk).toBe(world.updateVersion);
    evidence.recordAssertionEvidence(
      `Quitting installs ${world.updateVersion} over ${installed.version} in place`,
      `${world.installedBundle}: CFBundleShortVersionString ${installed.version} -> ${onDisk}`,
      onDisk === world.updateVersion,
    );
    return onDisk;
  });

  await step("the updated app boots the same activated profile", async () => {
    const launch = await world.launch(false);
    const build = await probe.eventually(() => launch.buildInfo(), { within: 30_000, label: "relaunched build version", until: (value) => value !== null });
    expect(build?.version, "the relaunched executable is the update").toBe(world.updateVersion);
    const activation = await launch.activation();
    expect(activation, "the activation persisted by the previous version is what booted").toEqual({ activatedAt: world.activatedAt, denBaseUrl: world.denUrl });
    const settled = await settledSignIn(launch, probe, `${world.updateVersion} relaunch`);
    const screen = user.on(launch.app);
    await screen.see({ text: SIGN_IN_BUTTON });
    await screen.notSee({ text: ACTIVATION_HEADING });
    await screen.screenshot();
    evidence.recordAssertionEvidence(
      `After the update the app reports ${world.updateVersion} and boots the profile ${installed.version} activated, without a render crash`,
      `running version ${installed.version} -> ${build?.version}; bundle ${applied}; activation ${JSON.stringify(activation)}; render crashes ${settled.crashes}; downloads before restart ${staged.downloads}`,
      build?.version === world.updateVersion && activation?.activatedAt === world.activatedAt && settled.crashes === 0,
    );
    await launch.quit();
  });
});
