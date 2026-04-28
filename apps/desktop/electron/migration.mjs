import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import path from "node:path";

const MIGRATION_SNAPSHOT_FILENAME = "migration-snapshot.v1.json";
const MIGRATION_SNAPSHOT_DONE_FILENAME = "migration-snapshot.v1.done.json";

function migrationSnapshotPath(app, done = false) {
  return path.join(
    app.getPath("userData"),
    done ? MIGRATION_SNAPSHOT_DONE_FILENAME : MIGRATION_SNAPSHOT_FILENAME,
  );
}

// Migration snapshot: one-way handoff from the last Tauri release into the
// first Electron launch. The Tauri shell writes migration-snapshot.v1.json
// into app_data_dir before it kicks off the Electron installer. Electron
// renders the workspace list / session-by-workspace preferences from it on
// first boot and then marks it .done so subsequent boots don't re-import.
export function registerMigrationIpc({ app, ipcMain }) {
  ipcMain.handle("openwork:migration:read", async () => {
    const snapshotPath = migrationSnapshotPath(app);
    if (!existsSync(snapshotPath)) return null;
    try {
      const raw = await readFile(snapshotPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.version === 1) {
        return parsed;
      }
      return null;
    } catch (error) {
      console.warn("[migration] failed to read snapshot", error);
      return null;
    }
  });

  ipcMain.handle("openwork:migration:ack", async () => {
    const snapshotPath = migrationSnapshotPath(app);
    const donePath = migrationSnapshotPath(app, true);
    if (!existsSync(snapshotPath)) return { ok: true, moved: false };
    try {
      await rename(snapshotPath, donePath);
      return { ok: true, moved: true };
    } catch (error) {
      console.warn("[migration] failed to rename snapshot", error);
      return { ok: false, moved: false };
    }
  });
}
