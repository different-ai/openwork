import { probeAppState } from "./app-state.ts";
import { callFunction, DEFAULT_CDP_PROBE_TIMEOUT_MS, connect, debuggerUrlFor, evaluate, pickAppTarget } from "./cdp.ts";
import { firstPageTarget, targetById, waitForCdp } from "./targets.ts";
import type { AppStateProbe } from "./app-state.ts";
import type { CdpClient, CdpFunctionArgument, CdpTarget, EvaluateOptions } from "./cdp.ts";

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

const REATTACH_FLOOR_MS = 8_000;
const HTTP_LIVENESS_TIMEOUT_MS = 4_000;

async function connectToAppTarget(handle: SurfaceHandle, timeoutMs = 30_000, preferredTargetId?: string): Promise<CdpClient> {
  const startedAt = Date.now();
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - startedAt));
  const fallbackTarget = () => handle.kind === "electron"
    ? pickAppTarget(handle.cdpUrl, { timeoutMs: remaining() })
    : firstPageTarget(handle.cdpUrl, { timeoutMs: remaining() });
  const target: CdpTarget = preferredTargetId
    ? await targetById(handle.cdpUrl, preferredTargetId, { timeoutMs: remaining() }).catch(fallbackTarget)
    : await fallbackTarget();
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
  const client = await connectToAppTarget(handle, Math.max(1, timeoutMs - (Date.now() - startedAt)));
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
  const targetId = surface.client.targetId ?? undefined;
  try {
    surface.client.close();
  } catch {
    // The old client is already gone; that is the case we are recovering from.
  }
  const client = await connectToAppTarget(surface.handle, Math.max(1, opts.timeoutMs ?? 30_000), targetId);
  surface.client = client;
}

function isRecoverableTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timed out|timeout|CDP socket is not open|CDP transport stalled|CDP websocket (failed|closed)/i.test(error.message);
}

async function isCdpHttpAlive(cdpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/version`, {
      signal: AbortSignal.timeout(HTTP_LIVENESS_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function readOnSurface<T>(
  surface: Surface,
  read: (client: CdpClient, timeoutMs: number) => Promise<T>,
  { timeoutMs, reattachAttempts }: { timeoutMs: number; reattachAttempts: number },
): Promise<T> {
  const startedAt = Date.now();
  const remaining = () => Math.max(0, timeoutMs - (Date.now() - startedAt));
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= reattachAttempts; attempt += 1) {
    try {
      const attemptTimeoutMs = attempt === 0 ? Math.max(1, remaining()) : Math.max(remaining(), REATTACH_FLOOR_MS);
      return await read(surface.client, attemptTimeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt === reattachAttempts || !isRecoverableTransportError(error)) break;
      if (!await isCdpHttpAlive(surface.handle.cdpUrl)) throw error;
      surface.client.abort?.(error instanceof Error ? error : undefined);
      await reattachSurface(surface, { timeoutMs: Math.max(remaining(), REATTACH_FLOOR_MS) }).catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Surface read failed.");
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
  return readOnSurface(
    surface,
    (client, attemptTimeoutMs) => evaluate(client, expression, { ...evaluateOptions, timeoutMs: attemptTimeoutMs }),
    { timeoutMs: Math.max(1, timeoutMs), reattachAttempts },
  );
}

export async function callFunctionOnSurface(
  surface: Surface,
  functionDeclaration: string,
  args: readonly CdpFunctionArgument[] = [],
  opts: EvaluateOptions & { reattachAttempts?: number } = {},
): Promise<unknown> {
  const { reattachAttempts = 1, timeoutMs = DEFAULT_CDP_PROBE_TIMEOUT_MS, ...callOptions } = opts;
  return readOnSurface(
    surface,
    (client, attemptTimeoutMs) => callFunction(client, functionDeclaration, args, { ...callOptions, timeoutMs: attemptTimeoutMs }),
    { timeoutMs: Math.max(1, timeoutMs), reattachAttempts },
  );
}

export async function probeAppStateOnSurface(
  surface: Surface,
  opts: EvaluateOptions & { reattachAttempts?: number } = {},
): Promise<AppStateProbe> {
  const { reattachAttempts = 1, timeoutMs = DEFAULT_CDP_PROBE_TIMEOUT_MS, ...probeOptions } = opts;
  return readOnSurface(
    surface,
    (client, attemptTimeoutMs) => probeAppState(client, { ...probeOptions, timeoutMs: attemptTimeoutMs }),
    { timeoutMs: Math.max(1, timeoutMs), reattachAttempts },
  );
}
