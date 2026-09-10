import { readFile } from "node:fs/promises";
import { attachSurface, evaluateOnSurface } from "@openwork/cdp";
import type { AttachedSurface, SurfaceHandle } from "@openwork/cdp";
import { SkipError } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { localHost } from "@openwork/hosts";
import type { ElectronSurfaceOptions } from "@openwork/hosts";

/**
 * A packaged enterprise desktop before and after activation, watched for update
 * traffic. The updater provider mounts above the activation gate (since #4482),
 * so an unactivated install could check and stage the newest enterprise release
 * before the organization's allowed-versions policy is known. `desktop()` cannot
 * be used because its readiness probe only recognises signed-in surfaces.
 *
 * The witness is the Electron main-process log: electron-updater logs
 * "Checking for update" when it fetches the release manifest and "Downloading
 * update from" when it starts staging one. Both happen in the main process, so
 * neither the renderer's Network domain nor its DOM can see them.
 */

export interface UpdaterActivity {
  /** Release-manifest fetches electron-updater started. */
  checks: number;
  /** Update downloads electron-updater started. */
  downloads: number;
  /** The matching log lines, for evidence. */
  lines: string[];
}

const UPDATER_LOG_LINE = /^(?:Checking for update|Found version |Downloading update from |Update for version )/;

export function updaterActivityFromLog(log: string): UpdaterActivity {
  const lines = log.split(/\r?\n/).filter((line) => UPDATER_LOG_LINE.test(line));
  return {
    checks: lines.filter((line) => line.startsWith("Checking for update")).length,
    downloads: lines.filter((line) => line.startsWith("Downloading update from")).length,
    lines,
  };
}

/** Activation stamp of an install already linked to a private Den that is not reachable here. */
export const ACTIVATED_ENTERPRISE_BOOTSTRAP: NonNullable<ElectronSurfaceOptions["bootstrap"]> = {
  baseUrl: "http://127.0.0.1:9",
  requireSignin: true,
  enterpriseActivation: { activatedAt: "2026-01-01T00:00:00.000Z", denBaseUrl: "http://127.0.0.1:9" },
};

async function launchPackagedEnterprise(name: string, bootstrap?: ElectronSurfaceOptions["bootstrap"]) {
  if (!process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim()) {
    throw new SkipError("OPENWORK_EVAL_ELECTRON_BINARY points at a packaged enterprise desktop binary");
  }
  const host = localHost();
  const handle: SurfaceHandle = await host.spawnElectron(name, {
    profile: "fresh",
    prepareSharedResources: false,
    env: { OPENWORK_DEV_MODE: "0", OPENWORK_ELECTRON_START_URL: "", ELECTRON_START_URL: "" },
    ...(bootstrap ? { bootstrap } : {}),
  });
  const logPath = handle.meta?.log;
  if (!logPath) {
    await host.disposeSurface(handle);
    throw new Error("The packaged desktop surface did not expose its main-process log");
  }
  let app: AttachedSurface | null = null;
  const dispose = async () => {
    try {
      await app?.stop();
    } finally {
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
    /** Flavor baked into the packaged artifact, as the renderer sees it. */
    flavor: () => evaluateOnSurface(attached, (): string | null => {
      const electron: unknown = Reflect.get(window, "__OPENWORK_ELECTRON__");
      if (typeof electron !== "object" || electron === null) return null;
      const meta: unknown = Reflect.get(electron, "meta");
      if (typeof meta !== "object" || meta === null) return null;
      const distribution: unknown = Reflect.get(meta, "distribution");
      if (typeof distribution !== "object" || distribution === null) return null;
      const flavor: unknown = Reflect.get(distribution, "flavor");
      return typeof flavor === "string" ? flavor : null;
    }),
    /** Text React actually mounted, as opposed to the body chrome. */
    rootText: () => evaluateOnSurface(attached, () => document.getElementById("root")?.innerText ?? ""),
    /** Update checks and downloads the main process has started so far. */
    updaterActivity: async () => updaterActivityFromLog(await readFile(logPath, "utf8")),
    [Symbol.asyncDispose]: dispose,
  };
}

/** First launch on a machine that has never run OpenWork: no bootstrap, so activation is required. */
export async function packagedPreactivationUpdaterWorld(_seed: Seed) {
  return launchPackagedEnterprise("packaged-preactivation-updater");
}

/** Positive control: the same binary already activated, so the updater may run. */
export async function packagedActivatedUpdaterWorld(_seed: Seed) {
  return launchPackagedEnterprise("packaged-activated-updater", ACTIVATED_ENTERPRISE_BOOTSTRAP);
}
