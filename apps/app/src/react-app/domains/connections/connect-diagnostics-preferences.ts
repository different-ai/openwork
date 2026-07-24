import { CONNECT_DIAGNOSTIC_CLIENT_RETENTION_MS } from "@openwork/types/den/connect-diagnostics";

import { LOCAL_PREFERENCES_KEY } from "@/react-app/kernel/local-preferences-storage";

export const CONNECT_DIAGNOSTIC_CLIENT_ID_KEY = "openwork.connectDiagnostics.clientId";
export const CONNECT_DIAGNOSTIC_QUEUE_KEY = "openwork.connectDiagnostics.queue.v1";
export const CONNECT_DIAGNOSTIC_FAILURE_STATE_KEY = "openwork.connectDiagnostics.failureState.v1";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function localStorageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function isConnectDiagnosticsEnabled(): boolean {
  if (!localStorageAvailable()) return false;
  try {
    const raw = window.localStorage.getItem(LOCAL_PREFERENCES_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return true;
    return (parsed as { connectionDiagnosticsEnabled?: unknown }).connectionDiagnosticsEnabled !== false;
  } catch {
    return true;
  }
}

function createUuid(): string | null {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return null;
}

/**
 * A random per-install identifier. Den hashes it before forwarding and the
 * diagnostics service never receives the raw value.
 */
export function getConnectDiagnosticsClientId(): string | null {
  if (!isConnectDiagnosticsEnabled()) return null;
  try {
    const existing = window.localStorage.getItem(CONNECT_DIAGNOSTIC_CLIENT_ID_KEY)?.trim() ?? "";
    if (UUID_V4_PATTERN.test(existing)) return existing;
    const created = createUuid();
    if (!created) return null;
    window.localStorage.setItem(CONNECT_DIAGNOSTIC_CLIENT_ID_KEY, created);
    return created;
  } catch {
    return null;
  }
}

export function clearConnectDiagnosticLocalData(): void {
  if (!localStorageAvailable()) return;
  try {
    window.localStorage.removeItem(CONNECT_DIAGNOSTIC_CLIENT_ID_KEY);
    window.localStorage.removeItem(CONNECT_DIAGNOSTIC_QUEUE_KEY);
    window.localStorage.removeItem(CONNECT_DIAGNOSTIC_FAILURE_STATE_KEY);
  } catch {
    // Best effort: storage may be unavailable or read-only.
  }
}

export function connectDiagnosticClientRetentionMs(): number {
  return CONNECT_DIAGNOSTIC_CLIENT_RETENTION_MS;
}
