import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, stat, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { dormantDesktopBrandSettings } from "./dormant-desktop-brand.mjs";

const CACHE_FILES = ["brand-icon.json", "brand-icon.png", "brand-icon.ico", "openwork-stock.ico"];

// Old Electron restores its root-level image cache before renderer startup,
// without checking the Den target. On a target switch quarantine that cache
// together with the original settings, never delete the source data. No archive
// is read/applied automatically by this version or by the old cache loader.
export async function archiveDesktopBrandForTargetSwitch({ userDataPath, previous }) {
  const settings = dormantDesktopBrandSettings(previous);
  const files = [];
  for (const name of CACHE_FILES) {
    try {
      await stat(path.join(userDataPath, name));
      files.push(name);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!files.length && !Object.values(settings).some((value) => typeof value === "string")) return null;
  const target = {
    baseUrl: previous.baseUrl,
    ...(previous.apiBaseUrl ? { apiBaseUrl: previous.apiBaseUrl } : {}),
    organizationId: previous.prepared?.orgId ?? previous.handoff?.orgId ?? null,
  };
  const targetKey = createHash("sha256").update(JSON.stringify(target)).digest("hex");
  const parent = path.join(userDataPath, "desktop-brand-rollback", targetKey);
  await mkdir(parent, { recursive: true });
  const archivePath = await mkdtemp(path.join(parent, "snapshot-"));
  await writeFile(path.join(archivePath, "settings.json"), `${JSON.stringify({ ...target, ...settings }, null, 2)}\n`, { mode: 0o600 });
  const moved = [];
  try {
    // Disable the old loader first. Renaming within userData retains the exact
    // source bytes and file metadata, including the sidecar's source URL/hash.
    for (const name of files) {
      await rename(path.join(userDataPath, name), path.join(archivePath, name));
      moved.push(name);
    }
  } catch (error) {
    // Fail the connection write. Restore any moved source files before retry.
    for (const name of moved.reverse()) await rename(path.join(archivePath, name), path.join(userDataPath, name));
    await rm(archivePath, { recursive: true, force: true });
    throw error;
  }
  return archivePath;
}

export async function restoreDesktopBrandArchive({ userDataPath, archivePath }) {
  if (!archivePath) return [];
  // archivePath comes only from the shell's in-memory snapshot table, never IPC.
  const copied = [];
  try {
    // Publish the sidecar last: older builds require it to activate a cache.
    for (const name of [...CACHE_FILES.slice(1), CACHE_FILES[0]]) {
      try {
        await copyFile(path.join(archivePath, name), path.join(userDataPath, name));
        copied.push(name);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    await Promise.all(copied.map((name) => rm(path.join(userDataPath, name), { force: true })));
    throw error;
  }
  return copied;
}
