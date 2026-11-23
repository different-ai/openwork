import type { BasisMode } from "./context-breakdown";

const STORAGE_KEY = "openwork.contextUsage.basis.v1";

export function readContextBasis(): BasisMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "occupied" ? "occupied" : "window";
  } catch {
    return "window";
  }
}

export function writeContextBasis(basis: BasisMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, basis);
  } catch {
    return;
  }
}
