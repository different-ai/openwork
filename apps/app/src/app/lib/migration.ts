// One-way Tauri → Electron migration snapshot plumbing.
//
// The Tauri shell exports localStorage keys the user actively depends on
// (workspace list, selected workspace, per-workspace last-session, server
// list) into a JSON file in app_data_dir just before launching the
// Electron installer. Electron reads that file on first launch, hydrates
// localStorage for the keys that are still empty, then marks the file as
// acknowledged.
//
// Scope decision: we migrate *workspace* keys only. Everything else
// (theme, font zoom, sidebar widths, feature flags) is cheap to redo and
// not worth the complexity of a cross-origin localStorage transfer.

import { invoke } from "@tauri-apps/api/core";

export const MIGRATION_SNAPSHOT_VERSION = 1;

// Keep this list tiny and strict. Adding keys here expands blast radius
// if a later release renames them.
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

function collectMigrationKeysFromLocalStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof window === "undefined") return out;
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key || !matchesMigrationKey(key)) continue;
    const value = window.localStorage.getItem(key);
    if (value != null) out[key] = value;
  }
  return out;
}

/**
 * Tauri-only. Called by the last Tauri release right before it kicks off
 * the Electron installer. Snapshots the workspace-related localStorage
 * keys to <app_data_dir>/migration-snapshot.v1.json via a Rust command
 * that does the actual disk write (renderer can't write outside the
 * sandbox on its own).
 */
export async function writeMigrationSnapshotFromTauri(): Promise<{
  ok: boolean;
  keyCount: number;
  reason?: string;
}> {
  try {
    const keys = collectMigrationKeysFromLocalStorage();
    const snapshot: MigrationSnapshot = {
      version: MIGRATION_SNAPSHOT_VERSION,
      writtenAt: Date.now(),
      source: "tauri",
      keys,
    };
    await invoke("write_migration_snapshot", { snapshot });
    return { ok: true, keyCount: Object.keys(keys).length };
  } catch (error) {
    return {
      ok: false,
      keyCount: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
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
 *
 * Returns the number of keys hydrated. Returns 0 when there is no
 * snapshot, which is the steady-state case after the first launch.
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
        // localStorage write failures are non-fatal; the user just won't
        // see that key migrated this launch.
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

export type MigrateToElectronRequest = {
  /**
   * Download URL for the matching Electron artifact. On macOS a .zip.
   * On Windows, an NSIS .exe (TODO — stubbed today). On Linux, an AppImage
   * (TODO — stubbed today).
   */
  url: string;
  /** Optional sha256 to verify before touching the filesystem. */
  sha256?: string;
  /**
   * Override where the Electron .app ends up (macOS). Defaults to
   * replacing the currently-running .app bundle in place.
   */
  targetAppPath?: string;
};

/**
 * Tauri-only. Hand off to the new Electron build:
 *   1. Download + verify the installer
 *   2. Replace the running .app bundle
 *   3. Relaunch into the Electron binary
 *   4. Quit this Tauri process
 *
 * Callers should invoke `writeMigrationSnapshotFromTauri()` first so the
 * new Electron shell can hydrate localStorage on first launch.
 */
export async function migrateToElectron(
  request: MigrateToElectronRequest,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await invoke("migrate_to_electron", { request });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// Localstorage key that stores a "don't ask again until" epoch-ms.
// Users who click "Later" get a 24h reprieve; after that we nudge again.
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
