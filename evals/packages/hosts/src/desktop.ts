import { timed } from "@openwork/timeline";
import { attachSurface, describeAppState, dumpScreenState, isInteractive, probeAppState } from "@openwork/cdp";
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
  /**
   * Where this desktop runs. Defaults to the ambient host (`resolveHost()`).
   * Pass one from `localHost()` / `daytonaSandbox(id)` to place it explicitly —
   * that is the only way a spec can put two desktops in two sandboxes, or the
   * app and the browser in different places.
   */
  host?: Host;
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
  /**
   * The workspace root on the host running THIS app — use it for workspace
   * paths instead of `process.cwd()`, which is the driver's filesystem and may
   * not exist where the app runs. Null only in `mode: "attach"`, where the
   * host is unknown.
   */
  workspaceRoot: string | null;
  stop(): Promise<void>;
}

async function waitForReadiness(app: Surface, timeoutMs: number): Promise<AppReadiness> {
  const deadline = Date.now() + timeoutMs;
  // Short per-probe timeout so a briefly-busy renderer is retried rather than
  // consuming the whole readiness budget in one stuck call.
  let last: AppStateProbe = { controlReady: false, transitional: null, surface: null, workspaceId: null, route: "", text: "" };
  while (Date.now() < deadline) {
    try {
      last = await probeAppState(app.client, { timeoutMs: Math.min(8_000, Math.max(0, deadline - Date.now())) });
      if (isInteractive(last) && last.surface) {
        return { state: last.surface, workspaceId: last.workspaceId, route: last.route };
      }
    } catch {
      // Navigations briefly destroy the execution context while the app boots.
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `OpenWork desktop did not become ready after ${timeoutMs}ms: ${describeAppState(last)} On screen: ${await dumpScreenState(app)}.`,
  );
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
    host = opts.host ?? await resolveHost();
    handle = await host.spawnElectron(opts.name ?? "spec", {
      profile: "fresh",
      bootstrap: opts.bootstrap,
      env: opts.env,
    });
  }

  let attached: AttachedSurface | null = null;
  try {
    const surface = await attachSurface(handle, { timeoutMs });
    attached = surface;
    const readiness = await timed("app.readiness", () => waitForReadiness(surface, timeoutMs), handle.name);
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
      workspaceRoot: host?.workspaceRoot ?? null,
      stop,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await closeSpawnedSurface(attached, host, handle)
      .catch((cleanupError: unknown) => logCleanupError(handle.name, cleanupError));
    throw error;
  }
}
