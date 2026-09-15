import { existsSync } from "node:fs";
import path from "node:path";

export function resolveBundledOpencodeV2Binary({
  appRoot,
  resourcesPath,
  isPackaged = false,
  platform = process.platform,
  fileExists = existsSync,
}) {
  const alias = platform === "win32" ? "opencode2.exe" : "opencode2";
  const directories = [
    resourcesPath ? path.join(resourcesPath, "sidecars") : null,
    !isPackaged && appRoot ? path.join(appRoot, "resources", "sidecars") : null,
  ].filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, alias);
    if (fileExists(candidate)) return candidate;
  }
  if (isPackaged) throw new Error("The packaged native engine is missing. Reinstall Open Coworker; a runtime download cannot repair this package.");
  return null;
}

/**
 * Where Electron keeps this app's profile (window state, renderer storage, the
 * single-instance lock, server tokens). `COWORKER_USER_DATA_DIR` is the app's
 * own override; `OPENWORK_ELECTRON_USERDATA` is the override the OpenWork
 * desktop and the eval hosts already use for isolated profiles. Electron
 * derives the default from the real account home, not `$HOME`, so without one
 * of these every isolated launch would still share one profile.
 */
export function resolveUserDataDir({ env, appDataDir, appIdentifier }) {
  const explicit = env.COWORKER_USER_DATA_DIR?.trim() || env.OPENWORK_ELECTRON_USERDATA?.trim();
  return explicit || path.join(appDataDir, appIdentifier);
}
