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
      }
    }
  }

  try {
    await bridge.ackSnapshot();
  } catch {
  }

  return hydrated;
}

