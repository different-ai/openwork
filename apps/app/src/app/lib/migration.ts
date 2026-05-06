// Tauri → Electron migration snapshot ingestion (Electron side only).
//
// The Tauri shell used to export localStorage keys into a JSON file.
// Electron reads that file on first launch, hydrates localStorage for
// keys that are still empty, then marks the file as acknowledged.
//
// The Tauri-side write function has been removed. This module only
// contains the Electron ingestion path for users who previously ran
// the Tauri build.

export const MIGRATION_SNAPSHOT_VERSION = 1;

export const MIGRATION_KEY_PATTERNS: Array<RegExp> = [
  /^openwork\.react\.activeWorkspace$/,
  /^openwork\.react\.sessionByWorkspace$/,
  /^openwork\.server\.list$/,
  /^openwork\.server\.active$/,
  /^openwork\.server\.urlOverride$/,
  /^openwork\.server\.token$/,
];

export type MigrationSnapshot = {
  version: typeof MIGRATION_SNAPSHOT_VERSION;
  writtenAt: number;
  source: "tauri";
  keys: Record<string, string>;
};

function matchesMigrationKey(key: string) {
  return MIGRATION_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

type ElectronMigrationBridge = {
  readSnapshot: () => Promise<MigrationSnapshot | null>;
  ackSnapshot: () => Promise<{ ok: boolean; moved: boolean }>;
};

function electronMigrationBridge(): ElectronMigrationBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as {
    __OPENWORK_ELECTRON__?: { migration?: ElectronMigrationBridge };
  }).__OPENWORK_ELECTRON__;
  return bridge?.migration ?? null;
}

/**
 * Electron-only. Called once during app boot. Reads the migration
 * snapshot (if any), hydrates localStorage for keys that aren't already
 * set on the Electron install, and acks the file so we don't re-ingest
 * on subsequent launches.
 */
export async function ingestMigrationSnapshotOnElectronBoot(): Promise<number> {
  const bridge = electronMigrationBridge();
  if (!bridge) return 0;

  let snapshot: MigrationSnapshot | null = null;
  try {
    snapshot = await bridge.readSnapshot();
  } catch {
    return 0;
  }
  if (!snapshot || snapshot.version !== MIGRATION_SNAPSHOT_VERSION) return 0;

  const entries = Object.entries(snapshot.keys ?? {});
  let hydrated = 0;
  if (typeof window !== "undefined") {
    for (const [key, value] of entries) {
      if (!matchesMigrationKey(key)) continue;
      if (window.localStorage.getItem(key) != null) continue;
      try {
        window.localStorage.setItem(key, value);
        hydrated += 1;
      } catch {
        // non-fatal
      }
    }
  }

  try {
    await bridge.ackSnapshot();
  } catch {
    // A failed ack means we'll re-ingest on next launch, but the
    // "skip if already set" guard keeps that idempotent.
  }

  return hydrated;
}

// Localstorage key that stores a "don't ask again until" epoch-ms.
export const MIGRATION_DEFER_KEY = "openwork.migration.deferredUntil";
export const MIGRATION_DEFAULT_DEFER_MS = 24 * 60 * 60 * 1000;

export function isMigrationDeferred(now: number = Date.now()): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(MIGRATION_DEFER_KEY);
    if (!raw) return false;
    const until = Number.parseInt(raw, 10);
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
}

export function deferMigration(ms: number = MIGRATION_DEFAULT_DEFER_MS): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MIGRATION_DEFER_KEY, String(Date.now() + ms));
  } catch {
    // non-fatal
  }
}

export function clearMigrationDefer(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(MIGRATION_DEFER_KEY);
  } catch {
    // non-fatal
  }
}
