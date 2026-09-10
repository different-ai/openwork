import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  CRASH_REPORTS_OBSERVABLE,
  DIAGNOSTIC_REPORTS_DIR,
  desktopQuitPathWorld,
} from "../worlds/desktop-quit-path.ts";
import type { InstallState, QuitLaunch } from "../worlds/desktop-quit-path.ts";

/**
 * A packaged enterprise desktop must actually exit when asked to quit, on every
 * teardown path, without tripping a Chromium CHECK.
 *
 * Released 0.18.42-0.18.46 failed both halves. A fresh, never-activated install
 * sent SIGTERM stayed alive with no window until it was SIGKILLed: its
 * `before-quit` teardown had nothing to stop, so `app.quit()` re-entered
 * Electron's `Browser::Quit()` from inside the `before-quit` emit and the outer
 * call reset `is_quitting_`. Instances whose app bundle had already been removed
 * from disk crashed with SIGTRAP instead (`ElectronBrowserClient::
 * AppendExtraCommandLineSwitches`, `CHECK_EQ(program, child_path)`), because the
 * quit path navigated the window to a data: URL and so spawned a renderer.
 *
 * The bound sits above the 10 s teardown deadline in quit-sequence.mjs (a quit
 * that arrives while the local runtime is still booting waits for that boot
 * behind the lifecycle queue, which the deadline caps) and far below the
 * failure, where the process never exits at all. The fix itself quits in
 * ~200 ms once the runtime is idle.
 */
const EXIT_BOUND_MS = 15_000;

/** ReportCrash writes asynchronously; a report for a SIGTRAP arrived within ~1-3 s in every observed case. */
const CRASH_REPORT_SETTLE_MS = 4_000;

const test = spec.world(desktopQuitPathWorld, { timeout: 240_000 });

type Stimulus = "SIGTERM" | "normal quit";

async function quitAndObserve(launch: QuitLaunch, stimulus: Stimulus) {
  const stimulusAt = Date.now();
  if (stimulus === "SIGTERM") launch.sigterm();
  else launch.quitNormally();
  const observation = await launch.waitForExit(EXIT_BOUND_MS, stimulusAt);
  if (CRASH_REPORTS_OBSERVABLE) await new Promise((resolve) => setTimeout(resolve, CRASH_REPORT_SETTLE_MS));
  const crashReports = await launch.crashReports();
  return { ...observation, crashReports };
}

function describeExit(observation: { exit: { code: number | null; signal: string | null } | null; elapsedMs: number }): string {
  if (!observation.exit) return `still running after ${observation.elapsedMs}ms`;
  return `exit code ${observation.exit.code} signal ${observation.exit.signal} after ${observation.elapsedMs}ms`;
}

const cases: ReadonlyArray<{ state: InstallState; stimulus: Stimulus }> = [
  { state: "fresh", stimulus: "SIGTERM" },
  { state: "fresh", stimulus: "normal quit" },
  { state: "activated", stimulus: "SIGTERM" },
  { state: "activated", stimulus: "normal quit" },
];

for (const { state, stimulus } of cases) {
  test(`a ${state} enterprise install exits within ${EXIT_BOUND_MS / 1000}s of ${stimulus} without crashing`, async ({ world, evidence }) => {
    const launch = await world.launch(state);
    const observed = await quitAndObserve(launch, stimulus);

    // The positive half: the main process is gone, cleanly, inside the bound.
    expect(observed.exit, `the ${state} install was ${describeExit(observed)} after ${stimulus}`).not.toBeNull();
    expect(observed.exit?.signal, `the ${state} install died from a signal (${describeExit(observed)}); SIGTRAP is a Chromium CHECK failure`).toBeNull();
    expect(observed.exit?.code, `the ${state} install exited non-zero (${describeExit(observed)})`).toBe(0);
    expect(observed.elapsedMs).toBeLessThanOrEqual(EXIT_BOUND_MS);
    evidence.recordAssertionEvidence(
      `A ${state} enterprise install exits with code 0 within ${EXIT_BOUND_MS}ms of ${stimulus}`,
      describeExit(observed),
      observed.exit !== null && observed.exit.code === 0 && observed.exit.signal === null && observed.elapsedMs <= EXIT_BOUND_MS,
    );

    // The negative half: macOS wrote no crash report for it. Linux CI has no
    // DiagnosticReports, so there the exit signal above is the only witness.
    if (CRASH_REPORTS_OBSERVABLE) {
      expect(observed.crashReports, `macOS wrote a crash report for the ${state} install after ${stimulus}`).toEqual([]);
      evidence.recordAssertionEvidence(
        `No crash report appears in ${DIAGNOSTIC_REPORTS_DIR} for the ${state} install after ${stimulus}`,
        observed.crashReports.length === 0 ? "no new OpenWork*.ips" : observed.crashReports.join(", "),
        observed.crashReports.length === 0,
      );
    } else {
      evidence.recordAssertionEvidence(
        `Crash-report check skipped — needs: macOS DiagnosticReports (${process.platform} has none); the exit signal is the witness here`,
        describeExit(observed),
        observed.exit?.signal === null,
      );
    }
  });
}
