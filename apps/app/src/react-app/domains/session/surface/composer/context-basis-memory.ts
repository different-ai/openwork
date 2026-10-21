import type { BasisMode } from "./context-breakdown";

const STORAGE_KEY = "openwork.contextUsage.basis.v1";

/**
 * Which base the breakdown percentages use, remembered per person on this
 * device. The window is the default (as in Claude); storage may be blocked or
 * empty, and the popover works without it.
 */
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
    // Storage can be disabled or full; the choice then lasts until the popover closes.
  }
}
