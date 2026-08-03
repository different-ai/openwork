import { DEFAULT_CDP_PROBE_TIMEOUT_MS, connect, debuggerUrlFor, evaluate, pickAppTarget } from "./cdp.ts";
import { firstPageTarget, waitForCdp } from "./targets.ts";
import type { CdpClient, CdpTarget, EvaluateOptions } from "./cdp.ts";

export type SurfaceKind = "electron" | "chrome";

export interface SurfaceHandle {
  name: string;
  kind: SurfaceKind;
  hostKind: string;
  cdpUrl: string;
  pid?: number;
  profileDir?: string;
  sandboxId?: string;
  meta?: Record<string, string>;
}

export interface Surface {
  handle: SurfaceHandle;
  client: CdpClient;
}

export interface AttachedSurface extends Surface, AsyncDisposable {
  stop(): Promise<void>;
}

async function connectToAppTarget(handle: SurfaceHandle, timeoutMs = 30_000): Promise<CdpClient> {
  const startedAt = Date.now();
  const remaining = () => Math.max(0, timeoutMs - (Date.now() - startedAt));
  const target: CdpTarget = handle.kind === "electron"
    ? await pickAppTarget(handle.cdpUrl, { timeoutMs: remaining() })
    : await firstPageTarget(handle.cdpUrl, { timeoutMs: remaining() });
  const client = await connect(debuggerUrlFor(handle.cdpUrl, target), {
    connectTimeoutMs: remaining(),
    sendTimeoutMs: remaining(),
  });
  await client.send("Page.enable", {}, { timeoutMs: remaining() }).catch(() => undefined);
  return client;
}

export async function attachSurface(handle: SurfaceHandle, opts: { timeoutMs?: number } = {}): Promise<AttachedSurface> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  await waitForCdp(handle.cdpUrl, { timeoutMs });
  const client = await connectToAppTarget(handle, Math.max(0, timeoutMs - (Date.now() - startedAt)));
  const surface: AttachedSurface = {
    handle,
    client,
    stop: async () => surface.client.close(),
    [Symbol.asyncDispose]: async () => surface.client.close(),
  };
  return surface;
}

/**
 * Re-attach to the app's CURRENT page target.
 *
 * The desktop recreates its page target during some transitions (finishing
 * onboarding, for example). Evaluations against the old target then hang rather
 * than fail, which looks exactly like a blocked renderer. The legacy runner had
 * the same escape hatch as `ctx.reconnect()`.
 */
export async function reattachSurface(surface: Surface, opts: { timeoutMs?: number } = {}): Promise<void> {
  try {
    surface.client.close();
  } catch {
    // The old client is already gone; that is the case we are recovering from.
  }
  surface.client = await connectToAppTarget(surface.handle, opts.timeoutMs ?? 30_000);
}

/**
 * Evaluate against a surface, healing a replaced page target.
 *
 * The desktop swaps its page target during transitions; evaluations against the
 * old one hang until they time out, which reads like a blocked renderer. Owning
 * that here means callers — behaviours, specs, the readiness gate — never carry
 * re-attach bookkeeping.
 */
export async function evaluateOnSurface(
  surface: Surface,
  expression: string,
  opts: EvaluateOptions & { reattachAttempts?: number } = {},
): Promise<unknown> {
  const { reattachAttempts = 1, timeoutMs = DEFAULT_CDP_PROBE_TIMEOUT_MS, ...evaluateOptions } = opts;
  const startedAt = Date.now();
  const remaining = () => Math.max(0, timeoutMs - (Date.now() - startedAt));
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= reattachAttempts; attempt += 1) {
    if (remaining() === 0) break;
    try {
      return await evaluate(surface.client, expression, { ...evaluateOptions, timeoutMs: remaining() });
    } catch (error) {
      lastError = error;
      if (attempt === reattachAttempts) break;
      // A dead target cannot answer; get the app's current one and try again.
      await reattachSurface(surface, { timeoutMs: remaining() }).catch(() => undefined);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Evaluation timed out after ${timeoutMs}ms: ${expression.replace(/\s+/g, " ").trim().slice(0, 160)}`);
}
