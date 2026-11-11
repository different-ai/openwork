import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { record } from "../worlds/org-invite.ts";
import { deviceLoginStartupCache } from "../worlds/device-login-startup-cache.ts";

const test = spec.world(deviceLoginStartupCache, {
  resources: {
    surfaces: ["desktop"], services: ["den"],
    nativeReason: "Fresh packaged GUI and terminal processes must start back-to-back on one native host; seed.desktop readiness would remove the startup race being observed.",
  },
  needs: { placement: "daytona", env: ["OPENWORK_EVAL_ELECTRON_BINARY", "OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX"] },
  timeout: 900_000,
});

test("a flag-on configured deployment is not falsely called unsupported during fresh desktop startup", async ({ world, evidence, step }) => {
  const trials: Awaited<ReturnType<typeof world.trial>>[] = [];
  for (const mode of ["default", "same-url"] satisfies Array<"default" | "same-url">) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await step(`natural immediate ${mode} attempt ${attempt}: observe without waiting for renderer or features`, async () => {
        const trial = await world.trial(mode);
        trials.push(trial);
        evidence.recordJsonArtifact(`natural-${mode}-${attempt}`, trial);
      });
    }
  }
  for (const mode of ["default", "same-url"] satisfies Array<"default" | "same-url">) {
    await step(`bridge-ready comparison ${mode}: run once control registration exists, without a feature-readiness wait`, async () => {
      const trial = await world.trial(mode, true);
      trials.push(trial);
      evidence.recordJsonArtifact(`bridge-registered-comparison-${mode}`, trial);
    });
  }
  evidence.recordJsonArtifact("real-den-feature-request-metadata", await world.featureRequestMetadata());
  const classified = trials.map(trial => {
    const result = record(trial.result);
    return {
      kind: trial.kind, mode: trial.mode,
      exitCode: result.cliExitCode,
      classification: result.setupFailure ? "setup-failure"
        : result.cliExitCode === 4 ? "unsupported"
        : result.publicInstructionsSeen && result.cliExitCode === 130 ? "valid-instructions-pending-cancelled"
        : result.cliExitCode === 1 ? "unavailable-or-startup-error-not-unsupported"
        : result.timedOut ? "timeout" : "other-observed-exit",
      publicInstructionsSeen: result.publicInstructionsSeen,
      guiSpawnAt: result.guiSpawnAt, cliSpawnAt: result.cliSpawnAt,
      firstStdoutAt: result.firstStdoutAt, firstOutputAt: result.firstOutputAt,
      firstInstructionsAt: result.firstInstructionsAt, exitAt: result.exitAt,
    };
  });
  evidence.recordJsonArtifact("all-startup-trials-classified", classified);
  expect(trials).toHaveLength(8);
  for (const trial of trials) {
    expect(trial.featureConfirmation).toEqual({ status: 200, enabled: true });
    const result = record(trial.result);
    expect(result.setupFailure, "A setup failure is not a reproduction of unsupported").toBeUndefined();
    expect(result.cliHasDisplay).toBe(false);
    expect(result.cliHasNodeMode).toBe(false);
    expect(result.cliExitCode).toBeTypeOf("number");
    if (result.publicInstructionsSeen) expect(result.cliExitCode, "A real pending login must cancel normally").toBe(130);
  }
  const controlled = trials.filter(trial => trial.kind === "bridge-registered-startup-comparison");
  expect(controlled.every(trial => Boolean(record(trial.result).controlReadyAt))).toBe(true);
  expect(controlled.some(trial => record(trial.result).cliExitCode === 4 || record(trial.result).publicInstructionsSeen), "Controlled trials must reach either the observed unsupported gate or actual public instructions, not only unavailable bridges").toBe(true);
  const unsupported = classified.filter(trial => trial.exitCode === 4);
  evidence.recordAssertionEvidence("An enabled configured deployment is not reported unsupported at startup", `natural default=3; natural exact-same-url=3; separate bridge-registered comparisons=2 (no feature-cache wait or HTTP faults); observed unsupported exits=${unsupported.length}; exit-1 startup failures are not counted as unsupported`, unsupported.length === 0);
  expect(unsupported, "Real flag-on startup was reported unsupported; inspect all original trial outputs/timestamps, not only this subset").toEqual([]);
});
