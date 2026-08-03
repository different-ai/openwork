import { attachSurface } from "@openwork/cdp";
import { resolveHost } from "./resolve.ts";
import type { AttachedSurface, SurfaceHandle } from "@openwork/cdp";
import type { Host } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BrowserOptions {
  name?: string;
  /**
   * Where this browser runs. Defaults to the ambient host (`resolveHost()`).
   * Pass one from `localHost()` / `daytonaSandbox(id)` to place it somewhere
   * other than the app under test.
   */
  host?: Host;
  startUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
}

/**
 * A real browser, placed explicitly — the counterpart to `desktop()`.
 *
 * Owning disposal here matters: `attachSurface` only closes the CDP socket, so
 * hand-rolled `spawnChrome` + `attachSurface` left the browser PROCESS running
 * after every spec. Disposing this handle stops the client and then asks the
 * host to dispose the surface, which is what actually kills it.
 */
export async function chrome(opts: BrowserOptions = {}): Promise<AttachedSurface> {
  const host = opts.host ?? await resolveHost();
  const name = opts.name ?? "browser";
  const handle: SurfaceHandle = await host.spawnChrome(name, {
    profile: "fresh",
    startUrl: opts.startUrl,
    headless: opts.headless,
  });

  let surface: AttachedSurface;
  try {
    surface = await attachSurface(handle, { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch (error) {
    await host.disposeSurface(handle).catch(() => undefined);
    throw error;
  }

  // Mutate rather than copy: `reattachSurface`/`evaluateOnSurface` assign to
  // `surface.client`, so callers must hold the same object the CDP layer heals.
  let stopped = false;
  const closeClient = surface.stop.bind(surface);
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await closeClient();
    } finally {
      await host.disposeSurface(handle);
    }
  };
  surface.stop = stop;
  surface[Symbol.asyncDispose] = async (): Promise<void> => {
    await stop().catch((error: unknown) => {
      console.warn(`[openwork/evals] Browser ${name} cleanup failed: ${messageText(error)}`);
    });
  };
  return surface;
}
