"use client";

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react";

const THEME_KEY = "openwork.theme";
type Theme = "light" | "dark" | "system";

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {}
  return "system";
}

function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
}

function subscribeToSystem(callback: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

type ThemeContextValue = {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (theme: Theme) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSnapshot(): Theme {
  const stored = getStoredTheme();
  if (stored !== "system") return stored;
  return resolveTheme(stored) === "dark" ? "dark" : "light";
}

function subscribe(callback: () => void) {
  const cb = () => { callback(); };
  window.addEventListener("storage", cb);
  const unsub = subscribeToSystem(cb);
  return () => {
    window.removeEventListener("storage", cb);
    unsub();
  };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const resolved: "light" | "dark" = useSyncExternalStore(
    subscribe,
    () => resolveTheme(getStoredTheme()),
    () => "light",
  );

  const theme: Theme = useSyncExternalStore(
    subscribe,
    () => getStoredTheme(),
    () => "system",
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const listener = () => {
      if (getStoredTheme() === "system") applyTheme("system");
    };
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {}
    applyTheme(t);
    window.dispatchEvent(new Event("storage"));
  }, []);

  const toggle = useCallback(() => {
    const current = getStoredTheme();
    const nextResolved = current === "system"
      ? (resolveTheme("system") === "dark" ? "light" : "dark")
      : (current === "dark" ? "light" : "dark");
    setTheme(nextResolved);
  }, [setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
