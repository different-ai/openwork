import { useSyncExternalStore } from "react";

import { STARTER_BOOTSTRAP_PREF_KEY } from "../../app/constants";

const DEFAULT_ENABLED = true;

function readFromStorage(): boolean {
  if (typeof window === "undefined") return DEFAULT_ENABLED;
  try {
    const raw = window.localStorage.getItem(STARTER_BOOTSTRAP_PREF_KEY);
    if (raw === null) return DEFAULT_ENABLED;
    return raw !== "0";
  } catch {
    return DEFAULT_ENABLED;
  }
}

function writeToStorage(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STARTER_BOOTSTRAP_PREF_KEY, value ? "1" : "0");
    window.dispatchEvent(new Event("openwork:starter-bootstrap-changed"));
  } catch {
    // ignore quota/security errors
  }
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener("storage", handler);
  window.addEventListener("openwork:starter-bootstrap-changed", handler);
  return () => {
    window.removeEventListener("storage", handler);
    window.removeEventListener("openwork:starter-bootstrap-changed", handler);
  };
}

export function getStarterBootstrapEnabled(): boolean {
  return readFromStorage();
}

export function setStarterBootstrapEnabled(value: boolean): void {
  writeToStorage(value);
}

export function useStarterBootstrapEnabled(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, readFromStorage, () => DEFAULT_ENABLED);
  return [value, setStarterBootstrapEnabled];
}

/**
 * Returns the effective workspace preset after applying the starter bootstrap toggle.
 * When the toggle is off and preset is "starter", it is downgraded to "minimal".
 */
export function effectivePreset(preset: string, enabled: boolean = readFromStorage()): string {
  if (!enabled && preset === "starter") return "minimal";
  return preset;
}
