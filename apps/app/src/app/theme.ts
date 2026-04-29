export type ThemeMode = "light" | "dark" | "system" | "cyberpunk" | "matrix";

export const THEME_PREF_KEY = "openwork.themePref";

/** Historic key used by react settings route; synced with `{@link THEME_PREF_KEY}` on persist. */
export const REACT_THEME_SETTINGS_KEY = "openwork.react.settings.theme-mode";

const mediaQuery = "(prefers-color-scheme: dark)";

const getMediaQueryList = () =>
  typeof window === "undefined" ? null : window.matchMedia(mediaQuery);

function isStoredTheme(raw: string | null): raw is ThemeMode {
  return (
    raw === "light" || raw === "dark" || raw === "system" || raw === "matrix"
  );
}

const readStoredMode = (): ThemeMode => {
  if (typeof window === "undefined") return "system";
  try {
    const stored =
      window.localStorage.getItem(THEME_PREF_KEY) ??
      window.localStorage.getItem(REACT_THEME_SETTINGS_KEY);
    if (isStoredTheme(stored)) return stored;
  } catch {
    // ignore
  }
  return "system";
};

const resolveMode = (mode: ThemeMode) => {
  if (mode !== "system") return mode;
  return getMediaQueryList()?.matches ? "dark" : "light";
};

const applyTheme = (mode: ThemeMode) => {
  if (typeof document === "undefined") return;
  const resolved = resolveMode(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme =
    resolved === "light" ? "light" : "dark";
};

export const bootstrapTheme = () => {
  const mode = readStoredMode();
  applyTheme(mode);
};

export const getInitialThemeMode = () => readStoredMode();

export const persistThemeMode = (mode: ThemeMode) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_PREF_KEY, mode);
    window.localStorage.setItem(REACT_THEME_SETTINGS_KEY, mode);
  } catch {
    // ignore
  }
};

export const subscribeToSystemTheme = (onChange: (isDark: boolean) => void) => {
  const list = getMediaQueryList();
  if (!list) return () => undefined;

  const handler = (event: MediaQueryListEvent) => onChange(event.matches);
  list.addEventListener("change", handler);
  return () => list.removeEventListener("change", handler);
};

export const applyThemeMode = (mode: ThemeMode) => {
  applyTheme(mode);
};
