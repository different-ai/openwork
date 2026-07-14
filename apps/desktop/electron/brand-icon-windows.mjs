import { createHash } from "node:crypto";

const WINDOWS_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const WINDOWS_APP_USER_MODEL_ID_MAX_LENGTH = 128;

function assertPng(buffer, size) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`Windows brand icon ${size}x${size} did not encode as PNG.`);
  }
}

export function encodeWindowsIcon(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Windows brand icon needs at least one image.");
  }

  const headerSize = 6;
  const entrySize = 16;
  const directory = Buffer.alloc(headerSize + entrySize * entries.length);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(entries.length, 4);

  let imageOffset = directory.length;
  for (const [index, entry] of entries.entries()) {
    const size = Number(entry?.size);
    const png = entry?.png;
    if (!Number.isInteger(size) || size < 1 || size > 256) {
      throw new Error(`Invalid Windows brand icon size: ${entry?.size}`);
    }
    assertPng(png, size);

    const offset = headerSize + index * entrySize;
    directory.writeUInt8(size === 256 ? 0 : size, offset);
    directory.writeUInt8(size === 256 ? 0 : size, offset + 1);
    directory.writeUInt8(0, offset + 2);
    directory.writeUInt8(0, offset + 3);
    directory.writeUInt16LE(1, offset + 4);
    directory.writeUInt16LE(32, offset + 6);
    directory.writeUInt32LE(png.length, offset + 8);
    directory.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += png.length;
  }

  return Buffer.concat([directory, ...entries.map((entry) => entry.png)]);
}

export function windowsIconFromNativeImage(image) {
  return encodeWindowsIcon(WINDOWS_ICON_SIZES.map((size) => ({
    size,
    png: image.resize({ width: size, height: size, quality: "best" }).toPNG(),
  })));
}

export function windowsBrandAppUserModelId(baseAppId, sourceUrl) {
  const base = String(baseAppId ?? "").trim();
  if (!base) throw new Error("Windows brand icon requires an App User Model ID.");
  const source = String(sourceUrl ?? "").trim();
  if (!source) return base;

  // A window-level AppUserModelID overrides the process/installed-shortcut
  // identity. Without a distinct ID, Windows keeps rendering the executable's
  // stock icon for the taskbar group even after WM_SETICON updates the title
  // bar and Alt-Tab image.
  const suffix = `.brand.${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
  return `${base.slice(0, WINDOWS_APP_USER_MODEL_ID_MAX_LENGTH - suffix.length)}${suffix}`;
}

export function windowsBrandShortcutFileName(appName) {
  const safeName = String(appName ?? "OpenWork")
    .replace(/[<>:"/\\|?*]/g, "-")
    .trim() || "OpenWork";
  return `${safeName}.lnk`;
}

export function windowsInstalledShortcutFileName(appName) {
  const safeName = String(appName ?? "OpenWork")
    .replace(/[<>:"/\\|?*]/g, "-")
    .trim() || "OpenWork";
  return `${safeName}.lnk`;
}

export function windowsInstalledExecutablePath({ packaged, execPath, resourcesPath, shortcutPath }) {
  if (!packaged) return execPath;
  return [
    shortcutPath.split(/[\\/]AppData[\\/]/i)[0],
    "AppData",
    "Local",
    "Programs",
    resourcesPath.replace(/[\\/]resources$/i, "").split(/[\\/]/).pop(),
    execPath.split(/[\\/]/).pop(),
  ].join("\\");
}

export function windowsBrandShortcutDetails({ target, appId, appIconPath, appName }) {
  return {
    target,
    cwd: target.replace(/[\\/][^\\/]+$/, ""),
    description: `${appName} organization desktop`,
    icon: appIconPath,
    iconIndex: 0,
    appUserModelId: appId,
  };
}

export function writeWindowsBrandShortcut(shellApi, shortcutPath, details, shortcutExists) {
  return shellApi.writeShortcutLink(shortcutPath, shortcutExists ? "replace" : "create", details);
}

const WINDOWS_TASKBAR_REFRESH_DELAY_MS = 250;

function waitForWindowsTaskbarRefresh() {
  return new Promise((resolve) => setTimeout(resolve, WINDOWS_TASKBAR_REFRESH_DELAY_MS));
}

export async function applyWindowsTaskbarIcon(window, {
  image,
  appId,
  appIconPath,
  relaunchCommand,
  relaunchDisplayName,
}, waitForRefresh = waitForWindowsTaskbarRefresh) {
  const refreshVisibleButton = window.isVisible() && typeof window.setSkipTaskbar === "function";

  // Explorer coalesces a synchronous true -> false toggle and retains its
  // cached EXE icon. Remove the live button first, then give Explorer a turn
  // on each side of staging the new window identity.
  if (refreshVisibleButton) window.setSkipTaskbar(true);

  try {
    if (refreshVisibleButton) await waitForRefresh();
    // Chromium's SetAppDetailsForWindow writes AppUserModel.ID before the
    // relaunch properties. Windows treats the ID write as the taskbar refresh
    // event, so a single call refreshes too early and can keep the EXE icon.
    // Stage every relaunch property first, then make the desired ID the final
    // write after RelaunchIconResource is already present.
    window.setAppDetails({
      appIconPath,
      appIconIndex: 0,
      relaunchCommand,
      relaunchDisplayName,
    });
    window.setAppDetails({ appId });
    window.setIcon(image);

    if (refreshVisibleButton) await waitForRefresh();
  } finally {
    // Never strand the app outside the taskbar if native staging fails.
    if (refreshVisibleButton) window.setSkipTaskbar(false);
  }
}

export { WINDOWS_APP_USER_MODEL_ID_MAX_LENGTH, WINDOWS_ICON_SIZES };
