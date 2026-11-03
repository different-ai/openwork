// Shared escalation policy for engine reload failures.
//
// A full desktop engine restart (engineRestart) kills every live session, so
// it is the last resort — only for server-reported states that a reload
// cannot recover from, and only after re-verifying that an "unreachable"
// engine is not a transient hiccup (mid-teardown, briefly overloaded, an
// aborted loopback fetch). opencode_reload_timeout deliberately never lands
// here: the server reports it while a dispose is still tearing down, and
// restarting mid-teardown would kill the very sessions being drained.
import { engineRestart } from "@/app/lib/desktop";
import { OpenworkServerError, type OpenworkServerClient } from "@/app/lib/openwork-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";

const UNREACHABLE_RETRY_DELAY_MS = 1500;

export function canRestartDesktopForReloadError(error: unknown) {
  return (
    error instanceof OpenworkServerError &&
    (error.code === "opencode_engine_unreachable" || error.code === "opencode_unconfigured")
  );
}

function isEngineUnreachableError(error: unknown) {
  return error instanceof OpenworkServerError && error.code === "opencode_engine_unreachable";
}

/**
 * Aborted or timed-out fetches are client→server transport blips (including
 * AbortSignal-cancelable fetch cancellations), not proof the engine is gone.
 * They must surface as errors, never as a restart.
 */
function isTransientTransportError(error: unknown) {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ReloadEngineFallbackResult = {
  restartedEngine: boolean;
};

export type ReloadEngineFallbackOptions = {
  retryDelayMs?: number;
  /** Injectable for tests; defaults to the desktop engineRestart bridge. */
  restartEngine?: () => Promise<unknown>;
  /** Injectable for tests; defaults to isDesktopRuntime. */
  isDesktop?: () => boolean;
};

/**
 * Reload the workspace engine; escalate to a full desktop engine restart only
 * when the reload keeps failing with a restartable server-reported code.
 * `opencode_engine_unreachable` gets one delayed retry first — if the engine
 * answers the second attempt, no session is disturbed.
 */
export async function reloadEngineWithDesktopFallback(
  client: Pick<OpenworkServerClient, "reloadEngine">,
  workspaceId: string,
  options?: ReloadEngineFallbackOptions,
): Promise<ReloadEngineFallbackResult> {
  const restartEngine = options?.restartEngine ?? (() => engineRestart({ diagnosticsCause: "reload-escalation" }));
  const isDesktop = options?.isDesktop ?? isDesktopRuntime;
  try {
    await client.reloadEngine(workspaceId);
    return { restartedEngine: false };
  } catch (error) {
    if (isTransientTransportError(error)) throw error;
    if (!canRestartDesktopForReloadError(error) || !isDesktop()) {
      throw error;
    }
    if (isEngineUnreachableError(error)) {
      await delay(options?.retryDelayMs ?? UNREACHABLE_RETRY_DELAY_MS);
      try {
        await client.reloadEngine(workspaceId);
        return { restartedEngine: false };
      } catch (retryError) {
        if (isTransientTransportError(retryError)) throw retryError;
        if (!canRestartDesktopForReloadError(retryError)) throw retryError;
      }
    }
    await restartEngine();
    return { restartedEngine: true };
  }
}
