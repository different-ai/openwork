const PENDING_CHANGES_KEY = "openwork.settings.environment.pendingChanges";

function getStorage(kind: "localStorage" | "sessionStorage"): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window[kind] ?? null;
  } catch {
    return null;
  }
}

export function readOpenworkEnvPendingChanges(): boolean {
  return (
    getStorage("localStorage")?.getItem(PENDING_CHANGES_KEY) === "1" ||
    getStorage("sessionStorage")?.getItem(PENDING_CHANGES_KEY) === "1"
  );
}

export function writeOpenworkEnvPendingChanges(value: boolean): void {
  const localStorage = getStorage("localStorage");
  const sessionStorage = getStorage("sessionStorage");
  try {
    if (value) {
      localStorage?.setItem(PENDING_CHANGES_KEY, "1");
      sessionStorage?.removeItem(PENDING_CHANGES_KEY);
    } else {
      localStorage?.removeItem(PENDING_CHANGES_KEY);
      sessionStorage?.removeItem(PENDING_CHANGES_KEY);
    }
  } catch {
    // ignore persistence failures
  }
}
