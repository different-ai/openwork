/**
 * Main-process provenance for Open with choices. A renderer may select an app
 * the desktop listed for this file, not supply an arbitrary executable. Keep
 * choices bound to the requesting WebContents and the canonical file path.
 *
 * @param {{ now?: () => number; ttlMs?: number }} [options]
 */
export function createOpenWithApplications(options = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  /** @type {Map<number, Map<string, { apps: Set<string>; expires: number }>>} */
  const owners = new Map();
  return {
    /** @param {number} owner @param {string} target @param {string[]} apps */
    remember(owner, target, apps) {
      let choices = owners.get(owner);
      if (!choices) {
        // Bound storage even when a caller repeatedly creates new windows/files.
        const oldestOwner = owners.keys().next().value;
        if (owners.size >= 16 && oldestOwner !== undefined) owners.delete(oldestOwner);
        choices = new Map();
        owners.set(owner, choices);
      }
      choices.delete(target);
      const oldestTarget = choices.keys().next().value;
      if (choices.size >= 32 && oldestTarget !== undefined) choices.delete(oldestTarget);
      choices.set(target, { apps: new Set(apps), expires: now() + ttlMs });
    },
    /** @param {number} owner @param {string} target @param {string} appPath */
    allows(owner, target, appPath) {
      const choices = owners.get(owner);
      const entry = choices?.get(target);
      if (!entry || entry.expires <= now()) {
        choices?.delete(target);
        return false;
      }
      return entry.apps.has(appPath);
    },
  };
}

/**
 * Linux launches a verified installed desktop entry through GIO, not a raw
 * renderer-supplied Exec string or a shell command. macOS uses an installed
 * .app bundle discovered by the desktop.
 * @param {NodeJS.Platform} platform
 * @param {string} appPath
 * @param {string} target
 * @returns {{ command: string; args: string[] } | null}
 */
export function installedApplicationCommand(platform, appPath, target) {
  if (platform === "darwin" && appPath.endsWith(".app")) return { command: "open", args: ["-a", appPath, target] };
  if (platform === "linux" && appPath.endsWith(".desktop")) return { command: "gio", args: ["launch", appPath, target] };
  return null;
}
