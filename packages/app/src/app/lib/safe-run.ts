/**
 * Safe execution utilities for error handling.
 *
 * Replaces bare `catch {}` blocks with structured handling that
 * at least logs errors in development, while keeping the same
 * "swallow and continue" behavior in production.
 */

const isDev = typeof import.meta !== "undefined" && import.meta.env?.DEV;

/**
 * Run an async function, returning the result or a fallback on error.
 * Logs errors in development mode.
 *
 * @example
 * const sessions = await safeAsync(() => loadSessions(), []);
 */
export async function safeAsync<T>(
  fn: () => Promise<T>,
  fallback: T,
  label?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isDev) {
      console.warn(`[safeAsync]${label ? ` ${label}:` : ""}`, error);
    }
    return fallback;
  }
}

/**
 * Run a synchronous function, returning the result or a fallback on error.
 * Logs errors in development mode.
 *
 * @example
 * const parsed = safeSync(() => JSON.parse(raw), null);
 */
export function safeSync<T>(
  fn: () => T,
  fallback: T,
  label?: string,
): T {
  try {
    return fn();
  } catch (error) {
    if (isDev) {
      console.warn(`[safeSync]${label ? ` ${label}:` : ""}`, error);
    }
    return fallback;
  }
}

/**
 * Fire-and-forget an async operation. Logs errors in development.
 * Use for cleanup, best-effort writes, etc.
 *
 * @example
 * fireAndForget(() => saveDraft(content), "save draft");
 */
export function fireAndForget(
  fn: () => Promise<unknown>,
  label?: string,
): void {
  fn().catch((error) => {
    if (isDev) {
      console.warn(`[fireAndForget]${label ? ` ${label}:` : ""}`, error);
    }
  });
}
