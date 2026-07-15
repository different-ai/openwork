/**
 * Last-outcome bookkeeping for the background cloud MCP maintenance loop.
 *
 * The maintenance tick used to swallow every failure (`.catch(() =>
 * "skipped")`), so a wedged or permanently failing loop was invisible — in the
 * field a machine sat with an expired token for days with zero surfaced
 * signal. Each run now records its outcome per maintenance target so the
 * connection status UI and diagnostics (see the Live MCP Connection
 * Diagnostics work) can show when maintenance last ran and how it ended.
 */

const CLOUD_MCP_MAINTENANCE_OUTCOME_KEY = "openwork.den.mcp.lastMaintenanceOutcome";
const MAX_RECORDED_OUTCOMES = 8;
const MAX_DETAIL_LENGTH = 200;

export type CloudMcpMaintenanceOutcomeStatus = "ok" | "error" | "timed_out";

export type CloudMcpMaintenanceOutcome = {
  status: CloudMcpMaintenanceOutcomeStatus;
  detail?: string;
  at: number;
};

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

let storageOverrideForTest: StorageLike | null = null;

/**
 * Bun on Linux exposes a readonly `globalThis.window`, so tests cannot stub
 * the global. Inject a storage instead (pass null to restore the default).
 */
export function __setCloudMcpMaintenanceOutcomeStorageForTest(storage: StorageLike | null) {
  storageOverrideForTest = storage;
}

function getStorage(): StorageLike | null {
  if (storageOverrideForTest) return storageOverrideForTest;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOutcome(value: unknown): CloudMcpMaintenanceOutcome | null {
  if (!isRecord(value)) return null;
  if (value.status !== "ok" && value.status !== "error" && value.status !== "timed_out") return null;
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
  return {
    status: value.status,
    at: value.at,
    ...(typeof value.detail === "string" && value.detail ? { detail: value.detail } : {}),
  };
}

function readOutcomeMap(): Map<string, CloudMcpMaintenanceOutcome> {
  const outcomes = new Map<string, CloudMcpMaintenanceOutcome>();
  try {
    const raw = getStorage()?.getItem(CLOUD_MCP_MAINTENANCE_OUTCOME_KEY);
    if (!raw) return outcomes;
    const parsed: unknown = JSON.parse(raw);
    const entries = isRecord(parsed) && isRecord(parsed.outcomes) ? parsed.outcomes : {};
    for (const [targetKey, candidate] of Object.entries(entries)) {
      const outcome = parseOutcome(candidate);
      if (outcome) outcomes.set(targetKey, outcome);
    }
  } catch {
    // Storage unavailable or corrupt — treat as no recorded outcomes.
  }
  return outcomes;
}

export function recordCloudMcpMaintenanceOutcome(
  targetKey: string,
  outcome: { status: CloudMcpMaintenanceOutcomeStatus; detail?: string },
  now?: number,
): void {
  try {
    const outcomes = readOutcomeMap();
    const detail = outcome.detail?.trim().slice(0, MAX_DETAIL_LENGTH);
    outcomes.set(targetKey, {
      status: outcome.status,
      at: now ?? Date.now(),
      ...(detail ? { detail } : {}),
    });
    const kept = [...outcomes.entries()]
      .sort((left, right) => right[1].at - left[1].at)
      .slice(0, MAX_RECORDED_OUTCOMES);
    getStorage()?.setItem(
      CLOUD_MCP_MAINTENANCE_OUTCOME_KEY,
      JSON.stringify({ version: 1, outcomes: Object.fromEntries(kept) }),
    );
  } catch {
    // Storage unavailable — recording outcomes must never break maintenance.
  }
}

export function readCloudMcpMaintenanceOutcome(targetKey: string): CloudMcpMaintenanceOutcome | null {
  return readOutcomeMap().get(targetKey) ?? null;
}
