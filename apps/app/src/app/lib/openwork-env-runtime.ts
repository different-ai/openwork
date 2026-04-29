const PENDING_CHANGES_KEY = "openwork.settings.environment.pendingChanges";

type PendingChangesState = {
  pending: boolean;
  runtimeKey?: string;
};

function getStorage(kind: "localStorage" | "sessionStorage"): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window[kind] ?? null;
  } catch {
    return null;
  }
}

function parsePendingChangesState(raw: string | null): PendingChangesState {
  if (!raw) return { pending: false };
  if (raw === "1") return { pending: true };
  try {
    const parsed = JSON.parse(raw) as { pending?: unknown; runtimeKey?: unknown };
    return {
      pending: parsed.pending === true,
      runtimeKey: typeof parsed.runtimeKey === "string" && parsed.runtimeKey.trim()
        ? parsed.runtimeKey.trim()
        : undefined,
    };
  } catch {
    return { pending: false };
  }
}

export function buildOpenworkEnvRuntimeKey(input: {
  baseUrl?: string | null;
  pid?: number | null;
  port?: number | null;
}): string | undefined {
  const baseUrl = (input.baseUrl?.trim() ?? "").replace(/\/+$/, "");
  const pid = typeof input.pid === "number" && Number.isFinite(input.pid) && input.pid > 0
    ? `pid:${input.pid}`
    : "";
  const port = !pid && typeof input.port === "number" && Number.isFinite(input.port) && input.port > 0
    ? `port:${input.port}`
    : "";
  const runtime = pid || port;
  if (!baseUrl && !runtime) return undefined;
  return `${baseUrl || "openwork"}::${runtime || "runtime"}`;
}

export function readOpenworkEnvPendingChanges(runtimeKey?: string | null): boolean {
  const localStorage = getStorage("localStorage");
  const sessionStorage = getStorage("sessionStorage");
  const state = parsePendingChangesState(localStorage?.getItem(PENDING_CHANGES_KEY) ?? null);
  const legacySessionState = parsePendingChangesState(
    sessionStorage?.getItem(PENDING_CHANGES_KEY) ?? null,
  );
  const pending = state.pending ? state : legacySessionState;
  if (!pending.pending) return false;

  const currentRuntimeKey = runtimeKey?.trim() || undefined;
  if (currentRuntimeKey && pending.runtimeKey && pending.runtimeKey !== currentRuntimeKey) {
    writeOpenworkEnvPendingChanges(false);
    return false;
  }

  return true;
}

export function writeOpenworkEnvPendingChanges(value: boolean, runtimeKey?: string | null): void {
  const localStorage = getStorage("localStorage");
  const sessionStorage = getStorage("sessionStorage");
  try {
    if (value) {
      const payload = {
        pending: true,
        changedAt: Date.now(),
        ...(runtimeKey?.trim() ? { runtimeKey: runtimeKey.trim() } : {}),
      };
      localStorage?.setItem(PENDING_CHANGES_KEY, JSON.stringify(payload));
      sessionStorage?.removeItem(PENDING_CHANGES_KEY);
    } else {
      localStorage?.removeItem(PENDING_CHANGES_KEY);
      sessionStorage?.removeItem(PENDING_CHANGES_KEY);
    }
  } catch {
    // ignore persistence failures
  }
}
