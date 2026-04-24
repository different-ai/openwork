const PENDING_CHANGES_SESSION_KEY = "openwork.settings.environment.pendingChanges";

export function readOpenworkEnvPendingChanges(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(PENDING_CHANGES_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeOpenworkEnvPendingChanges(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.sessionStorage.setItem(PENDING_CHANGES_SESSION_KEY, "1");
    } else {
      window.sessionStorage.removeItem(PENDING_CHANGES_SESSION_KEY);
    }
  } catch {
    // ignore persistence failures
  }
}
