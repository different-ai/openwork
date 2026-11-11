import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { record } from "../worlds/org-invite.ts";
import { deviceLoginStartupCache } from "../worlds/device-login-startup-cache.ts";

const test = spec.world(deviceLoginStartupCache, {
  resources: {
    surfaces: ["desktop"], services: ["den"],
    nativeReason: "Fresh packaged GUI and terminal processes must start back-to-back on one native host; seed.desktop readiness would remove the startup race being verified.",
  },
  needs: { placement: "daytona", env: ["OPENWORK_EVAL_ELECTRON_BINARY", "OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX"] },
  timeout: 900_000,
});

test("fresh desktop login waits for readiness, offers approval on flag-on Den, and refuses a genuinely flag-off Den", async ({ world, evidence, step }) => {
  const enabledTrials: Awaited<ReturnType<typeof world.trial>>[] = [];
  for (const mode of ["default", "same-url"] satisfies Array<"default" | "same-url">) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await step(`natural immediate ${mode} attempt ${attempt}: launch without a renderer or feature wait`, async () => {
        const trial = await world.trial(mode);
        enabledTrials.push(trial);
        evidence.recordJsonArtifact(`natural-${mode}-${attempt}`, trial);
      });
    }
  }
  for (const mode of ["default", "same-url"] satisfies Array<"default" | "same-url">) {
    await step(`bridge-registered comparison ${mode}: no feature-readiness wait`, async () => {
      const trial = await world.trial(mode, true);
      enabledTrials.push(trial);
      evidence.recordJsonArtifact(`bridge-registered-comparison-${mode}`, trial);
    });
  }
  const disabledTrial = await step("flag-off: confirm real Den is disabled, launch a fresh profile, and check genuine refusal after action registration", async () => {
    const trial = await world.flagOffTrial();
    evidence.recordJsonArtifact("flag-off-action-registered", trial);
    return trial;
  });
  evidence.recordJsonArtifact("real-den-request-metadata", await world.featureRequestMetadata());
  const trials = [...enabledTrials, disabledTrial];
  evidence.recordJsonArtifact("all-startup-trials-classified", trials.map(trial => {
    const result = record(trial.result);
    return {
      kind: trial.kind, mode: trial.mode, enabled: trial.featureConfirmation.enabled,
      exitCode: result.cliExitCode,
      classification: result.setupFailure ? "setup-failure"
        : result.publicInstructionsSeen && result.cliExitCode === 130 ? "valid-instructions-pending-cancelled"
        : result.cliExitCode === 4 ? "unsupported"
        : result.cliExitCode === 1 ? "unavailable-or-startup-error"
        : result.timedOut ? "timeout" : "other-observed-exit",
      publicInstructionsSeen: result.publicInstructionsSeen,
      guiSpawnAt: result.guiSpawnAt, cliSpawnAt: result.cliSpawnAt,
      firstStdoutAt: result.firstStdoutAt, firstOutputAt: result.firstOutputAt,
      firstInstructionsAt: result.firstInstructionsAt, exitAt: result.exitAt,
      observedAuthPostCount: trial.observedAuthPostCount,
    };
  }));
  expect(enabledTrials).toHaveLength(8);
  expect(trials).toHaveLength(9);
  for (const trial of trials) {
    const result = record(trial.result);
    expect(result.setupFailure, "A setup failure cannot satisfy a device-login regression").toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.cliHasDisplay).toBe(false);
    expect(result.cliHasNodeMode).toBe(false);
  }
  const enabledSucceeded = enabledTrials.every(trial => {
    const result = record(trial.result);
    return result.publicInstructionsSeen === true && result.cliExitCode === 130
      && typeof result.stdout === "string" && result.stdout.includes("Waiting for approval…")
      && typeof result.stderr === "string" && !result.stderr.includes("Device sign-in is not available");
  });
  evidence.recordAssertionEvidence("All flag-on fresh startups reach public approval instructions", "six immediate default/exact-same-URL launches and two action-registered comparisons; every command prints real instructions then intentionally cancels with SIGINT/130, without availability errors", enabledSucceeded);
  for (const trial of enabledTrials) {
    const result = record(trial.result);
    expect(trial.featureConfirmation).toEqual({ status: 200, enabled: true });
    expect(result.publicInstructionsSeen, `${trial.kind}/${trial.mode} must reach actual instructions`).toBe(true);
    expect(result.cliExitCode, "Pending approval is intentionally cancelled, not a successful enrollment").toBe(130);
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    expect(stdout).toContain("Waiting for approval…");
    expect(stderr).not.toContain("Device sign-in is not available");
    const url = stdout.match(/^(https?:\/\/\S+)$/m)?.[1];
    expect(url).toBeDefined();
    if (!url) throw new Error("The real command omitted its public verification URL.");
    expect(new URL(url).origin).toBe(new URL(world.den.ref.webUrl).origin);
    if (trial.kind === "bridge-registered-startup-comparison") {
      expect(result.controlReadyAt).toBeTypeOf("number");
      expect(record(result.publicConfigurationObserved).registered).toBe(true);
    }
  }
  const disabled = record(disabledTrial.result);
  const disabledSucceeded = disabledTrial.featureConfirmation.enabled === false
    && record(disabled.publicConfigurationObserved).registered === true
    && disabled.cliExitCode === 4 && disabled.publicInstructionsSeen === false;
  evidence.recordAssertionEvidence("A genuinely disabled deployment refuses sign-in after the real actions exist", "anonymous prelaunch features=HTTP 200/false; fresh profile; both status/start action metadata observed before command; refusal=exit 4 with no public code or approval instructions", disabledSucceeded);
  expect(disabledTrial.featureConfirmation).toEqual({ status: 200, enabled: false });
  expect(record(disabled.publicConfigurationObserved).registered).toBe(true);
  expect(disabled.cliExitCode).toBe(4);
  expect(disabled.publicInstructionsSeen).toBe(false);
  expect(disabled.firstInstructionsAt).toBeNull();
  expect(disabled.stderr).toContain("Device sign-in is not available on this server");
  expect(disabled.stdout).not.toMatch(/Then check the code|^https?:\/\//m);
  // Some access logs normalize Better Auth to a wildcard. Only infer zero
  // auth/device-code POSTs if those POSTs were actually visible in controls.
  const authPostsObservable = enabledTrials.some(trial => trial.observedAuthPostCount > 0);
  evidence.recordJsonArtifact("flag-off-auth-post-observability", { authPostsObservable, observedOffAuthPosts: disabledTrial.observedAuthPostCount, scope: disabledTrial.authRouteObservation });
  if (authPostsObservable) expect(disabledTrial.observedAuthPostCount).toBe(0);
});
