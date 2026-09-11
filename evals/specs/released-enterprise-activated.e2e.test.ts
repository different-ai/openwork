import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Probe } from "@openwork/testkit";
import { isRenderCrash, releasedEnterpriseActivatedWorld } from "../worlds/released-enterprise-activated.ts";
import type { ReleasedLaunch } from "../worlds/released-enterprise-activated.ts";

/**
 * What an EXISTING enterprise user sees: an installation already activated
 * against its private Den boots past the activation gate into the sign-in
 * surface, and after an in-place update the same profile still boots. The
 * fresh-machine gate (packaged-first-launch) stops at the activation page, so
 * the providers mounted only for activated installations are proven here.
 */
const test = spec.world(releasedEnterpriseActivatedWorld, {
  timeout: 300_000,
  needs: { env: ["OPENWORK_EVAL_ELECTRON_BINARY"] },
});
const updateTest = spec.world(releasedEnterpriseActivatedWorld, {
  timeout: 300_000,
  needs: { env: ["OPENWORK_EVAL_ELECTRON_BINARY", "OPENWORK_EVAL_RELEASED_BASELINE_BINARY"] },
});

/** Heading of the enterprise activation page (enterprise-activation-gate.tsx); an activated install must not show it. */
const ACTIVATION_HEADING = "Link this app to your organization";
/** Heading of the root error boundary's recovery screen (app-error-boundary.tsx). */
const RECOVERY_HEADING = /OpenWork hit an unexpected error/;
/** The forced sign-in surface (den-signin-surface.tsx, fullscreen variant). */
const SIGN_IN_BUTTON = /^Sign in to /m;

interface Settled {
  rootText: string;
  crashes: number;
  contextCrashes: number;
  rejections: number;
}

/**
 * Wait until the launch either shows a usable surface or fails in one of the
 * ways a render crash fails: empty tree plus an uncaught exception, or the
 * recovery screen. Stopping on the first of those names the crash instead of
 * timing out on a blank window. Returns the facts every claim below is made of.
 */
async function settle(launch: ReleasedLaunch, probe: Probe, label: string): Promise<Settled> {
  const rootText = await probe.eventually(() => launch.rootText(), {
    within: 90_000,
    label,
    until: (text) => SIGN_IN_BUTTON.test(text) || text.includes(ACTIVATION_HEADING) || RECOVERY_HEADING.test(text)
      || launch.exceptions().some(isRenderCrash),
  });
  const exceptions = launch.exceptions();
  const crashes = exceptions.filter(isRenderCrash);
  const contextCrashes = exceptions.filter((exception) => /context is missing|must be used within/i.test(`${exception.text} ${exception.description}`));
  expect(contextCrashes, `a provider context was missing (${label})`).toEqual([]);
  expect(crashes, `the renderer threw (${label})`).toEqual([]);
  expect(rootText, `the root error boundary caught a render crash (${label})`).not.toMatch(RECOVERY_HEADING);
  expect(rootText, `an activated installation showed the activation page again (${label})`).not.toContain(ACTIVATION_HEADING);
  return { rootText, crashes: crashes.length, contextCrashes: contextCrashes.length, rejections: exceptions.length - crashes.length };
}

async function expectSignInSurface(launch: ReleasedLaunch, probe: Probe, label: string): Promise<Settled> {
  const settled = await settle(launch, probe, label);
  expect(settled.rootText, `the forced sign-in surface did not mount (${label})`).toMatch(SIGN_IN_BUTTON);
  const state = await probe.eventually(() => launch.state(), {
    within: 30_000,
    label: `${label}: interactive sign-in surface`,
    until: (value) => value.controlReady && value.surface === "welcome",
  });
  expect(state.route, `the activated installation is held at the sign-in route (${label})`).toMatch(/^\/signin/);
  return settled;
}

async function expectReleaseUnderTest(launch: ReleasedLaunch, expectedVersion: string | null): Promise<string> {
  const flavor = await launch.flavor();
  expect(flavor, "the packaged artifact is the enterprise flavor").toBe("enterprise");
  const build = await launch.buildInfo();
  if (!build) throw new Error("The running desktop did not report its build info");
  if (expectedVersion) expect(build.version, "the executable that booted is the release under test").toBe(expectedVersion);
  return build.version;
}

test("an activated enterprise installation boots past the gate to its sign-in surface without a render crash", async ({ world, user, probe, evidence, step }) => {
  const launch = await world.launch({ binary: world.binary, profileDir: world.newProfileDir("fresh-activated"), seedBootstrap: true });
  const version = await step("the release under test is what booted", () => expectReleaseUnderTest(launch, world.expectedVersion));

  await step("the desktop received the activation stamp through its bootstrap", async () => {
    const activation = await probe.eventually(() => launch.activation(), { within: 30_000, label: "enterprise activation in the renderer bootstrap", until: (value) => value !== null });
    expect(activation?.activatedAt).toBe(world.activatedAt);
    expect(activation?.denBaseUrl).toBe(world.den.ref.webUrl);
  });

  const settled = await step("the sign-in surface mounts instead of the activation page or a crash", () => expectSignInSurface(launch, probe, "activated first launch"));
  const screen = user.on(launch.app);
  await screen.see({ text: SIGN_IN_BUTTON });
  await screen.notSee({ text: RECOVERY_HEADING });
  await screen.notSee({ text: ACTIVATION_HEADING });
  await screen.screenshot();

  evidence.recordAssertionEvidence(
    `The activated enterprise desktop ${version} boots to its sign-in surface without a render crash`,
    `binary: ${world.binary}; Den: ${world.den.ref.webUrl}; #root text: ${JSON.stringify(settled.rootText.slice(0, 200))}; render crashes: ${settled.crashes}; missing-context crashes: ${settled.contextCrashes}; unhandled promise rejections (not gating): ${settled.rejections}`,
    settled.crashes === 0 && settled.contextCrashes === 0,
  );
});

updateTest("a profile created by the previous release still boots after updating and after a restart", async ({ world, user, probe, evidence, step }) => {
  const baseline = world.baselineBinary;
  if (!baseline) throw new Error("OPENWORK_EVAL_RELEASED_BASELINE_BINARY is required for the update path");
  const expectedVersion = world.expectedVersion;
  const profileDir = world.newProfileDir("update-profile");

  const { baselineVersion, baselineRoute } = await step("the previous release signs in and reaches the workspace surface on a fresh profile", async () => {
    const launch = await world.launch({ binary: baseline, profileDir, seedBootstrap: true });
    const build = await launch.buildInfo();
    if (!build) throw new Error("The baseline desktop did not report its build info");
    if (expectedVersion) expect(build.version, "the baseline is an older release than the one under test").not.toBe(expectedVersion);
    await expectSignInSurface(launch, probe, `baseline ${build.version} first launch`);
    const workspace = await world.signInAndSelectWorkspace(launch);
    const state = await launch.state();
    expect(state.surface, "the baseline reached the workspace surface").toBe("workspace");
    expect(state.workspaceId).toBe(workspace.workspaceId);
    await user.on(launch.app).screenshot();
    await launch.quit();
    return { baselineVersion: build.version, baselineRoute: state.route };
  });

  const updated = await step("the release under test opens that profile in place", async () => {
    const launch = await world.launch({ binary: world.binary, profileDir, seedBootstrap: false });
    const version = await expectReleaseUnderTest(launch, expectedVersion);
    const settledOrState = await settleSignedIn(launch, probe, `updated to ${version}`);
    // The session and workspace the previous release persisted are what the
    // update boots into; landing on sign-in again would mean the profile was lost.
    expect(settledOrState.surface, "the update restored the signed-in workspace").toBe("workspace");
    expect(settledOrState.route).toBe(baselineRoute);
    const screen = user.on(launch.app);
    await screen.notSee({ text: RECOVERY_HEADING });
    await screen.notSee({ text: ACTIVATION_HEADING });
    await screen.screenshot();
    await launch.quit();
    return { version, ...settledOrState };
  });

  const restarted = await step("the release under test restarts on the same profile", async () => {
    const launch = await world.launch({ binary: world.binary, profileDir, seedBootstrap: false });
    const version = await expectReleaseUnderTest(launch, expectedVersion);
    const settledOrState = await settleSignedIn(launch, probe, `restart of ${version}`);
    expect(settledOrState.surface, "the restart restored the signed-in workspace").toBe("workspace");
    expect(settledOrState.route).toBe(baselineRoute);
    const screen = user.on(launch.app);
    await screen.notSee({ text: RECOVERY_HEADING });
    await screen.notSee({ text: ACTIVATION_HEADING });
    await screen.screenshot();
    await launch.quit();
    return { version, ...settledOrState };
  });

  evidence.recordAssertionEvidence(
    `A profile created by ${baselineVersion} boots in ${updated.version} after the update and again after a restart, without a render crash`,
    `update launch: surface=${updated.surface} route=${updated.route} crashes=${updated.crashes} missing-context=${updated.contextCrashes}; restart launch: surface=${restarted.surface} route=${restarted.route} crashes=${restarted.crashes} missing-context=${restarted.contextCrashes}`,
    updated.crashes === 0 && restarted.crashes === 0 && updated.contextCrashes === 0 && restarted.contextCrashes === 0,
  );
});

/**
 * Wait for the persisted session to land on a settled surface, or for a crash
 * signature, then hand back the facts the caller asserts on. The task UI can
 * paint before the active workspace is hydrated, which reads as `no-workspace`
 * for a moment; only a settled workspace, or the sign-in surface (which would
 * mean the profile was lost), ends the wait, so a persistent `no-workspace` is
 * reported by the bound with that last value instead of being sampled early.
 */
async function settleSignedIn(launch: ReleasedLaunch, probe: Probe, label: string): Promise<Settled & { surface: string; route: string }> {
  const state = await probe.eventually(() => launch.state(), {
    within: 120_000,
    label: `${label}: interactive surface`,
    until: (value) => (value.controlReady && (value.surface === "welcome" || (value.surface === "workspace" && value.transitional === null)))
      || RECOVERY_HEADING.test(value.text) || launch.exceptions().some(isRenderCrash),
  });
  const rootText = await launch.rootText();
  const exceptions = launch.exceptions();
  const crashes = exceptions.filter(isRenderCrash);
  const contextCrashes = exceptions.filter((exception) => /context is missing|must be used within/i.test(`${exception.text} ${exception.description}`));
  expect(contextCrashes, `a provider context was missing (${label})`).toEqual([]);
  expect(crashes, `the renderer threw (${label})`).toEqual([]);
  expect(rootText, `the root error boundary caught a render crash (${label})`).not.toMatch(RECOVERY_HEADING);
  expect(rootText, `an activated installation showed the activation page again (${label})`).not.toContain(ACTIVATION_HEADING);
  expect(state.surface, `no interactive surface after ${label}`).not.toBeNull();
  return {
    rootText,
    crashes: crashes.length,
    contextCrashes: contextCrashes.length,
    rejections: exceptions.length - crashes.length,
    surface: state.surface ?? "none",
    route: state.route,
  };
}
