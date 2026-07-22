import os from "node:os"
import path from "node:path"

/**
 * Where the desktop app reads its deployment config. Must agree byte-for-byte
 * with the Electron shell (apps/desktop/electron/workspace-store.mjs) and the
 * bootstrap CLI (packages/openwork-bootstrap/bin/openwork.mjs): XDG_CONFIG_HOME
 * everywhere, then LOCALAPPDATA on Windows, then the conventional per-OS default.
 */
export function desktopBootstrapPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.OPENWORK_DESKTOP_BOOTSTRAP_PATH?.trim()
  if (override) return override

  const configHome =
    env.XDG_CONFIG_HOME?.trim() ||
    (platform === "win32" ? env.LOCALAPPDATA?.trim() : "") ||
    path.join(os.homedir(), platform === "win32" ? path.join("AppData", "Local") : ".config")
  return path.join(configHome, "openwork", "desktop-bootstrap.json")
}

export function legacyDesktopBootstrapPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = (platform === "win32" ? env.USERPROFILE?.trim() : env.HOME?.trim()) || os.homedir()
  return path.join(home, ".config", "openwork", "desktop-bootstrap.json")
}
