import { attachSurface, describeAppState, isInteractive, probeAppState } from "@openwork/cdp";
import { resolveHost } from "./resolve.ts";
import type { AppStateProbe, AppSurfaceState, AttachedSurface, Surface, SurfaceHandle } from "@openwork/cdp";
import type { Host } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logCleanupError(name: string, error: unknown): void {
  console.warn(`[openwork/evals] Desktop ${name} cleanup failed: ${messageText(error)}`);
}

export interface DesktopOptions {
  name?: string;
  mode?: "spawn" | "attach";
  bootstrap?: {
    baseUrl: string;
    apiBaseUrl?: string;
    requireSignin?: boolean;
  };
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface AppReadiness {
  state: AppSurfaceState;
  workspaceId: string | null;
  route: string;
}

export interface DesktopHandle extends AttachedSurface {
  readiness: AppReadiness;
  stop(): Promise<void>;
}

async function waitForReadiness(app: Surface, timeoutMs: number): Promise<AppReadiness> {
  const deadline = Date.now() + timeoutMs;
  // Give each probe room to answer while the app is busy; the poll's own
  // deadline is what bounds the wait, not a per-call default.
  const probeTimeoutMs = Math.min(Math.max(timeoutMs, 20_000), 120_000);
  let last: AppStateProbe = { controlReady: false, transitional: null, surface: null, workspaceId: null, route: "", text: "" };
  while (Date.now() < deadline) {
    try {
      last = await probeAppState(app.client, { timeoutMs: probeTimeoutMs });
      if (isInteractive(last) && last.surface) {
        return { state: last.surface, workspaceId: last.workspaceId, route: last.route };
      }
    } catch {
      // Navigations briefly destroy the execution context while the app boots.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`OpenWork desktop did not become ready after ${timeoutMs}ms: ${describeAppState(last)}`);
}

async function closeSpawnedSurface(
  attached: AttachedSurface | null,
  host: Host | null,
  handle: SurfaceHandle,
): Promise<void> {
  try {
    await attached?.stop();
  } finally {
    await host?.disposeSurface(handle);
  }
}

export async function desktop(opts: DesktopOptions = {}): Promise<DesktopHandle> {
  const mode = opts.mode ?? "spawn";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let host: Host | null = null;
  let handle: SurfaceHandle;

  if (mode === "attach") {
    const cdpUrl = process.env.OPENWORK_EVAL_CDP_URL?.trim();
    if (!cdpUrl) {
      throw new Error('desktop({ mode: "attach" }) requires OPENWORK_EVAL_CDP_URL to point at a running Electron app.');
    }
    handle = {
      name: opts.name ?? "attached-app",
      kind: "electron",
      hostKind: "attached",
      cdpUrl,
    };
  } else {
    host = await resolveHost();
    handle = await host.spawnElectron(opts.name ?? "spec", {
      profile: "fresh",
      bootstrap: opts.bootstrap,
      env: opts.env,
    });
  }

  let attached: AttachedSurface | null = null;
  try {
    attached = await attachSurface(handle, { timeoutMs });
    const readiness = await waitForReadiness(attached, timeoutMs);
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await closeSpawnedSurface(attached, host, handle);
    };
    const dispose = async (): Promise<void> => {
      await stop().catch((error: unknown) => logCleanupError(handle.name, error));
    };
    return {
      handle: attached.handle,
      client: attached.client,
      readiness,
      stop,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await closeSpawnedSurface(attached, host, handle)
      .catch((cleanupError: unknown) => logCleanupError(handle.name, cleanupError));
    throw error;
  }
}
