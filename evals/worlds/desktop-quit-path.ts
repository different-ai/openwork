import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { allocateFreePort, attachSurface } from "@openwork/cdp";
import type { AttachedSurface, SurfaceExit, SurfaceHandle } from "@openwork/cdp";
import { SkipError } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { localHost } from "@openwork/hosts";
import type { ElectronSurfaceOptions } from "@openwork/hosts";

/**
 * A packaged enterprise desktop that is asked to quit. Two stimuli match what
 * happens in the field: `kill <pid>` (SIGTERM to the main process only, the
 * eval-host cleanup and supervisor path) and Chromium's own `Browser.close`
 * (the Cmd+Q / Quit-menu path without touching any other instance of the app on
 * this machine). Two install states cover the teardown that runs on each: a
 * fresh install that never activated has no runtime to stop, so its
 * `before-quit` teardown settles without leaving the microtask queue; an
 * activated install stops a real local server first.
 *
 * `desktop()` cannot be used because its readiness probe only recognises
 * signed-in surfaces, so launches attach directly.
 */

export type InstallState = "fresh" | "activated";

/** Where macOS writes a crash report for a SIGTRAP/SIGSEGV'd process (ReportCrash). */
export const DIAGNOSTIC_REPORTS_DIR = join(homedir(), "Library", "Logs", "DiagnosticReports");

/** Only macOS produces crash reports the test can read; the exit signal is the witness elsewhere. */
export const CRASH_REPORTS_OBSERVABLE = process.platform === "darwin";

export interface ExitObservation {
  exit: SurfaceExit | null;
  elapsedMs: number;
}

async function newCrashReports(since: number): Promise<string[]> {
  if (!CRASH_REPORTS_OBSERVABLE) return [];
  const names = await readdir(DIAGNOSTIC_REPORTS_DIR).catch(() => []);
  const reports: string[] = [];
  for (const name of names) {
    if (!name.startsWith("OpenWork") || !name.endsWith(".ips")) continue;
    const info = await stat(join(DIAGNOSTIC_REPORTS_DIR, name)).catch(() => null);
    if (info && info.mtimeMs >= since) reports.push(name);
  }
  return reports;
}

async function launchPackagedEnterprise(name: string, bootstrap?: ElectronSurfaceOptions["bootstrap"]) {
  if (!process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim()) {
    throw new SkipError("OPENWORK_EVAL_ELECTRON_BINARY points at a packaged enterprise desktop binary");
  }
  const host = localHost();
  const launchedAt = Date.now();
  const handle: SurfaceHandle = await host.spawnElectron(name, {
    profile: "fresh",
    prepareSharedResources: false,
    env: { OPENWORK_DEV_MODE: "0", OPENWORK_ELECTRON_START_URL: "", ELECTRON_START_URL: "" },
    ...(bootstrap ? { bootstrap } : {}),
  });
  const pid = handle.pid;
  const exit = handle.exit;
  if (pid === undefined || exit === undefined) {
    await host.disposeSurface(handle);
    throw new Error("The packaged desktop surface did not expose its process id and exit");
  }
  let app: AttachedSurface | null = null;
  const dispose = async () => {
    try {
      await app?.stop();
    } finally {
      // A process that already exited is left alone; a lingering one is killed and its profile removed.
      await host.disposeSurface(handle);
    }
  };
  try {
    app = await attachSurface(handle, { timeoutMs: 60_000 });
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  const attached = app;
  return {
    app: attached,
    pid,
    /** What `kill <pid>` does: the signal reaches the main process only, never its helpers. */
    sigterm() {
      process.kill(pid, "SIGTERM");
    },
    /**
     * Chromium's own shutdown, as Cmd+Q ends up requesting. The reply never
     * arrives (the socket closes with the process), so the request is not
     * awaited: the exit itself is the observation.
     */
    quitNormally() {
      void attached.client.send("Browser.close").catch(() => undefined);
    },
    /** Exit status of the main process, or null when it outlived the bound measured from `since`. */
    async waitForExit(boundMs: number, since: number = Date.now()): Promise<ExitObservation> {
      const remainingMs = Math.max(0, since + boundMs - Date.now());
      const observed = await Promise.race([
        exit,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remainingMs)),
      ]);
      return { exit: observed, elapsedMs: Date.now() - since };
    },
    /** Crash reports macOS wrote for this app since it launched; always empty where they are not observable. */
    crashReports: () => newCrashReports(launchedAt),
    [Symbol.asyncDispose]: dispose,
  };
}

export type QuitLaunch = Awaited<ReturnType<typeof launchPackagedEnterprise>>;

/** Activation stamp of an install already linked to a private Den on a closed local port. */
async function activatedBootstrap(): Promise<NonNullable<ElectronSurfaceOptions["bootstrap"]>> {
  const denBaseUrl = `http://127.0.0.1:${await allocateFreePort()}`;
  return {
    baseUrl: denBaseUrl,
    apiBaseUrl: denBaseUrl,
    requireSignin: true,
    enterpriseActivation: { activatedAt: new Date().toISOString(), denBaseUrl },
  };
}

export async function desktopQuitPathWorld(_seed: Seed) {
  const launches: QuitLaunch[] = [];
  return {
    async launch(state: InstallState): Promise<QuitLaunch> {
      const launch = await launchPackagedEnterprise(
        `desktop-quit-${state}-${launches.length + 1}`,
        state === "activated" ? await activatedBootstrap() : undefined,
      );
      launches.push(launch);
      return launch;
    },
    [Symbol.asyncDispose]: async () => {
      for (const launch of launches.reverse()) {
        await launch[Symbol.asyncDispose]().catch(() => undefined);
      }
    },
  };
}
