import os from "node:os"
import path from "node:path"
import {
  desktopBootstrapPath as resolveDesktopBootstrapPath,
  legacyDesktopBootstrapPath as resolveLegacyDesktopBootstrapPath,
} from "@openwork/paths"

export function desktopBootstrapPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== process.platform) {
    const override = env.OPENWORK_DESKTOP_BOOTSTRAP_PATH?.trim()
    if (override) return override
    const configHome =
      env.XDG_CONFIG_HOME?.trim() ||
      (platform === "win32" ? env.LOCALAPPDATA?.trim() : "") ||
      path.join(os.homedir(), platform === "win32" ? path.join("AppData", "Local") : ".config")
    return path.join(configHome, "openwork", "desktop-bootstrap.json")
  }
  return resolveDesktopBootstrapPath({ env, platform })
}

export function legacyDesktopBootstrapPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== process.platform) {
    const home = (platform === "win32" ? env.USERPROFILE?.trim() : env.HOME?.trim()) || os.homedir()
    return path.join(home, ".config", "openwork", "desktop-bootstrap.json")
  }
  return resolveLegacyDesktopBootstrapPath({ env, platform })
}
