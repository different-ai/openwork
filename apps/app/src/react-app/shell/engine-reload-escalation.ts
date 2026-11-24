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
  restartEngine?: () => Promise<unknown>;
  isDesktop?: () => boolean;
};

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
