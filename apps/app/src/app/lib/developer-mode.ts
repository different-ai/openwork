export const DESKTOP_DEVELOPER_MODE_STORAGE_KEY = "openwork.developerMode";
export const DESKTOP_EXACT_PROMPT_LOG_STORAGE_KEY = "openwork.promptObservabilityExact";
const DESKTOP_DEVELOPER_MODE_RESTART_KEY = "openwork.developerMode.engineRestartPending";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function localStorageOrNull(): BrowserStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readDesktopDeveloperMode(
  storage: BrowserStorage | null = localStorageOrNull(),
): boolean {
  try {
    return storage?.getItem(DESKTOP_DEVELOPER_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function readDesktopExactPromptLogging(
  storage: BrowserStorage | null = localStorageOrNull(),
): boolean {
  try {
    return storage?.getItem(DESKTOP_EXACT_PROMPT_LOG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function desktopExactPromptLoggingEnabled(
  storage: BrowserStorage | null = localStorageOrNull(),
): boolean {
  return readDesktopDeveloperMode(storage) && readDesktopExactPromptLogging(storage);
}

function desktopObservabilityPreferenceLevel(storage: BrowserStorage | null): "off" | "metadata" | "exact" {
  if (!readDesktopDeveloperMode(storage)) return "off";
  return readDesktopExactPromptLogging(storage) ? "exact" : "metadata";
}

function markRestartWhenEffectiveChanged(
  previous: "off" | "metadata" | "exact",
  next: "off" | "metadata" | "exact",
  storage: BrowserStorage | null,
): void {
  if (previous !== next) storage?.setItem(DESKTOP_DEVELOPER_MODE_RESTART_KEY, "1");
}

/** Persist Developer Mode. Turning it off also revokes exact prompt consent. */
export function writeDesktopDeveloperMode(
  enabled: boolean,
  storage: BrowserStorage | null = localStorageOrNull(),
): void {
  try {
    const previous = desktopObservabilityPreferenceLevel(storage);
    storage?.setItem(DESKTOP_DEVELOPER_MODE_STORAGE_KEY, enabled ? "1" : "0");
    if (!enabled) storage?.removeItem(DESKTOP_EXACT_PROMPT_LOG_STORAGE_KEY);
    markRestartWhenEffectiveChanged(previous, desktopObservabilityPreferenceLevel(storage), storage);
  } catch {
    // The UI preference remains in React state even when storage is unavailable.
  }
}

/** Exact prepared prompts require a separate, explicit consent under Dev Mode. */
export function writeDesktopExactPromptLogging(
  enabled: boolean,
  storage: BrowserStorage | null = localStorageOrNull(),
): void {
  try {
    const previous = desktopObservabilityPreferenceLevel(storage);
    const allowed = enabled && readDesktopDeveloperMode(storage);
    if (allowed) storage?.setItem(DESKTOP_EXACT_PROMPT_LOG_STORAGE_KEY, "1");
    else storage?.removeItem(DESKTOP_EXACT_PROMPT_LOG_STORAGE_KEY);
    markRestartWhenEffectiveChanged(previous, desktopObservabilityPreferenceLevel(storage), storage);
  } catch {
    // The UI state remains usable even when persistence is unavailable.
  }
}

export function desktopDeveloperModeRestartPending(
  storage: BrowserStorage | null = localStorageOrNull(),
): boolean {
  try {
    return storage?.getItem(DESKTOP_DEVELOPER_MODE_RESTART_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearDesktopDeveloperModeRestartPending(
  storage: BrowserStorage | null = localStorageOrNull(),
): void {
  try {
    storage?.removeItem(DESKTOP_DEVELOPER_MODE_RESTART_KEY);
  } catch {
    // A later restart attempt can safely retry the same desired mode.
  }
}

export function withDesktopDeveloperModeObservability(
  options: Record<string, unknown> | undefined,
  storage: BrowserStorage | null = localStorageOrNull(),
): Record<string, unknown> {
  return {
    ...(options ?? {}),
    openworkDeveloperMode: readDesktopDeveloperMode(storage),
    openworkPromptLog: desktopExactPromptLoggingEnabled(storage),
  };
}
