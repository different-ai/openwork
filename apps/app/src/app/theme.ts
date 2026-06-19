export type ThemeMode = "light" | "dark" | "system";
export type ResolvedThemeMode = "light" | "dark";

const THEME_PREF_KEY = "openwork.react.settings.theme-mode";
const LEGACY_THEME_PREF_KEYS = ["openwork.themePref"];

const mediaQuery = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();
let currentMode: ThemeMode | null = null;
let systemThemeCleanup: (() => void) | null = null;

const getMediaQueryList = () =>
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia(mediaQuery);

const isThemeMode = (value: string | null): value is ThemeMode =>
  value === "light" || value === "dark" || value === "system";

const readStoredMode = (): ThemeMode => {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_PREF_KEY);
    if (isThemeMode(stored)) {
      return stored;
    }

    for (const key of LEGACY_THEME_PREF_KEYS) {
      const legacyStored = window.localStorage.getItem(key);
      if (isThemeMode(legacyStored)) {
        window.localStorage.setItem(THEME_PREF_KEY, legacyStored);
        return legacyStored;
      }
    }
  } catch {
    // ignore
  }
  return "system";
};

const resolveMode = (mode: ThemeMode): ResolvedThemeMode => {
  if (mode !== "system") return mode;
  return getMediaQueryList()?.matches ? "dark" : "light";
};

const applyTheme = (mode: ThemeMode) => {
  if (typeof document === "undefined") return;
  const resolved = resolveMode(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
};

const emitThemeChange = () => {
  for (const listener of listeners) {
    listener();
  }
};

const syncNativeTheme = (mode: ThemeMode) => {
  if (typeof window === "undefined") return;
  void window.__OPENWORK_ELECTRON__?.invokeDesktop?.("__setNativeTheme", mode);
};

const getCurrentMode = () => {
  if (currentMode === null) {
    currentMode = readStoredMode();
  }
  return currentMode;
};

const handleSystemThemeChange = () => {
  if (getCurrentMode() !== "system") return;
  applyTheme("system");
  syncNativeTheme("system");
  emitThemeChange();
};

const ensureSystemThemeSubscription = () => {
  if (systemThemeCleanup || typeof window === "undefined") return;

  const list = getMediaQueryList();
  if (!list) return;

  list.addEventListener("change", handleSystemThemeChange);
  systemThemeCleanup = () => list.removeEventListener("change", handleSystemThemeChange);
};

export const bootstrapTheme = () => {
  const mode = getCurrentMode();
  applyTheme(mode);
  syncNativeTheme(mode);
  ensureSystemThemeSubscription();
};

export const getInitialThemeMode = () => getCurrentMode();

export const getResolvedThemeMode = () => resolveMode(getCurrentMode());

const persistThemeMode = (mode: ThemeMode) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_PREF_KEY, mode);
  } catch {
    // ignore
  }
};

export const subscribeToTheme = (onChange: () => void) => {
  ensureSystemThemeSubscription();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
};

export const setThemeMode = (mode: ThemeMode) => {
  currentMode = mode;
  persistThemeMode(mode);
  applyTheme(mode);
  syncNativeTheme(mode);
  ensureSystemThemeSubscription();
  emitThemeChange();
};
