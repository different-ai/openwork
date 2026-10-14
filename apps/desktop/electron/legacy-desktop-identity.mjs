// Migration only: restore stock shortcuts without applying custom identity.
// Keep dormant icon files/metadata intact so an older desktop can roll back.
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

export function isOwnedLegacyShortcut(shell, shortcutPath, appIdentifier, executablePath) {
  try {
    const details = shell.readShortcutLink(shortcutPath);
    const appId = details.appUserModelId;
    const brandPrefix = `${appIdentifier}.brand.`;
    const ownedAppId = appId === appIdentifier
      || (typeof appId === "string" && appId.startsWith(brandPrefix)
        && /^[a-f0-9]{16}$/.test(appId.slice(brandPrefix.length)));
    return ownedAppId && typeof details.target === "string"
      && path.isAbsolute(details.target)
      && path.normalize(details.target).toLowerCase() === path.normalize(executablePath).toLowerCase();
  } catch {
    // Missing, invalid, or unreadable shortcuts cannot prove ownership. Leave
    // them untouched and discard the obsolete marker without creating a link.
    return false;
  }
}

export async function cleanupLegacyDesktopIdentity({
  userDataPath,
  programsPath,
  appName,
  appIdentifier,
  executablePath,
  shell,
  restoreStockShortcut,
}) {
  const markerPath = path.join(userDataPath, "windows-brand-shortcut.txt");
  const shortcutPath = (await readFile(markerPath, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  })).trim();

  if (programsPath && shortcutPath) {
    // A direct Programs .lnk is only a candidate: a stale/corrupt marker can
    // point at another app. Require both our native ID and executable target.
    const isLegacyShortcut = path.dirname(shortcutPath).toLowerCase() === programsPath.toLowerCase()
      && path.extname(shortcutPath).toLowerCase() === ".lnk"
      && isOwnedLegacyShortcut(shell, shortcutPath, appIdentifier, executablePath);
    if (isLegacyShortcut) {
      const stockShortcutPath = path.join(programsPath, `${appName}.lnk`);
      if (restoreStockShortcut) {
        if (existsSync(stockShortcutPath)
          && !isOwnedLegacyShortcut(shell, stockShortcutPath, appIdentifier, executablePath)) {
          throw new Error("Could not restore the OpenWork shortcut: existing shortcut is not owned by OpenWork.");
        }
        // Older builds replaced the installer's stock shortcut too. Restore it
        // before removing the old one; failures leave the marker for next boot.
        const written = shell.writeShortcutLink(stockShortcutPath, "create", {
          target: executablePath,
          cwd: path.dirname(executablePath),
          description: appName,
          icon: executablePath,
          iconIndex: 0,
          appUserModelId: appIdentifier,
        });
        if (!written) throw new Error("Could not restore the OpenWork shortcut.");
      }
      if (!restoreStockShortcut || shortcutPath.toLowerCase() !== stockShortcutPath.toLowerCase()) {
        await rm(shortcutPath, { force: true });
      }
    }
  }

  // This derived shortcut marker is not a source setting. Removing it makes
  // subsequent boots inert; retain the image cache and its source URL/hash
  // sidecar unchanged for the older native code's automatic cache restore.
  await rm(markerPath, { force: true });
}
