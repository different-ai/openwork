import { app, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";

import type { UpdaterEnvironment } from "../../../../app/src/app/lib/desktop-contract";
import type { DesktopUpdateCheckResult } from "../../../../app/src/app/lib/openwork-desktop";
import { IPC_CHANNELS } from "../ipc/channels";

function isMacDmgOrTranslocated(targetPath: string | null) {
  if (!targetPath) {
    return false;
  }

  return targetPath.includes("/Volumes/") || targetPath.includes("AppTranslocation");
}

function resolveAppBundlePath() {
  if (process.platform !== "darwin") {
    return null;
  }

  return path.resolve(process.execPath, "../../..");
}

function extractReleaseNotes(notes: unknown) {
  if (typeof notes === "string") {
    return notes;
  }

  if (Array.isArray(notes)) {
    return notes
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return "";
        }

        return typeof (entry as { note?: unknown }).note === "string"
          ? (entry as { note: string }).note
          : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  return null;
}

export function createUpdateService() {
  autoUpdater.autoDownload = false;

  return {
    getEnvironment(): UpdaterEnvironment {
      const executablePath = process.execPath;
      const appBundlePath = resolveAppBundlePath();

      if (!app.isPackaged) {
        return {
          supported: false,
          reason: "Updates are only supported in packaged desktop builds.",
          executablePath,
          appBundlePath,
        };
      }

      if (isMacDmgOrTranslocated(executablePath) || isMacDmgOrTranslocated(appBundlePath)) {
        return {
          supported: false,
          reason: "OpenWork is running from a mounted disk image. Install it to Applications to enable updates.",
          executablePath,
          appBundlePath,
        };
      }

      return {
        supported: true,
        reason: null,
        executablePath,
        appBundlePath,
      };
    },

    async check(_input?: { timeoutMs?: number }): Promise<DesktopUpdateCheckResult> {
      const checkedAt = Date.now();
      const environment = this.getEnvironment();
      if (!environment.supported) {
        return { available: false, checkedAt };
      }

      const result = await autoUpdater.checkForUpdates();
      const info = result?.updateInfo;
      if (!info) {
        return { available: false, checkedAt };
      }

      return {
        available: true,
        checkedAt,
        version: info.version,
        date: info.releaseDate ?? null,
        notes: extractReleaseNotes(info.releaseNotes),
      };
    },
  };
}

export type UpdateService = ReturnType<typeof createUpdateService>;

export function registerUpdateIpc(service: UpdateService) {
  ipcMain.handle(IPC_CHANNELS.updates("getEnvironment"), () => service.getEnvironment());
  ipcMain.handle(IPC_CHANNELS.updates("check"), (_event, input?: { timeoutMs?: number }) => service.check(input));
}
