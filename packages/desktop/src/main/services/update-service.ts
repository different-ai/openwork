import { app, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";

import type { UpdaterEnvironment } from "../../../../app/src/app/lib/desktop-contract";
import type {
  DesktopUpdateCheckResult,
  DesktopUpdateStatusEvent,
} from "../../../../app/src/app/lib/openwork-desktop";
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

type UpdateServiceOptions = {
  emitStatus: (event: DesktopUpdateStatusEvent) => void;
};

type PendingUpdateInfo = {
  checkedAt: number;
  version: string;
  notes?: string | null;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  return Promise.race<T>([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Update check timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

export function createUpdateService(options: UpdateServiceOptions) {
  autoUpdater.autoDownload = false;
  const state: {
    lastCheckedAt: number | null;
    pendingUpdate: PendingUpdateInfo | null;
  } = {
    lastCheckedAt: null,
    pendingUpdate: null,
  };

  autoUpdater.on("download-progress", (progress) => {
    if (!state.pendingUpdate) {
      return;
    }

    options.emitStatus({
      state: "downloading",
      checkedAt: state.pendingUpdate.checkedAt,
      version: state.pendingUpdate.version,
      downloadedBytes: progress.transferred,
      totalBytes: Number.isFinite(progress.total) ? progress.total : null,
      notes: state.pendingUpdate.notes ?? undefined,
    });
  });

  autoUpdater.on("update-downloaded", () => {
    if (!state.pendingUpdate) {
      return;
    }

    options.emitStatus({
      state: "ready",
      checkedAt: state.pendingUpdate.checkedAt,
      version: state.pendingUpdate.version,
      notes: state.pendingUpdate.notes ?? undefined,
    });
  });

  autoUpdater.on("error", (error) => {
    options.emitStatus({
      state: "error",
      checkedAt: state.lastCheckedAt,
      message: error?.message ?? String(error),
    });
  });

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
      state.lastCheckedAt = checkedAt;
      if (!environment.supported) {
        state.pendingUpdate = null;
        return { available: false, checkedAt };
      }

      options.emitStatus({ state: "checking" });
      const result = await withTimeout(autoUpdater.checkForUpdates(), _input?.timeoutMs);
      const info = result?.updateInfo;
      if (!info) {
        state.pendingUpdate = null;
        options.emitStatus({ state: "idle", checkedAt });
        return { available: false, checkedAt };
      }

      const notes = extractReleaseNotes(info.releaseNotes);
      state.pendingUpdate = {
        checkedAt,
        version: info.version,
        notes,
      };
      options.emitStatus({
        state: "available",
        checkedAt,
        version: info.version,
        date: info.releaseDate ?? null,
        notes: notes ?? undefined,
      });

      return {
        available: true,
        checkedAt,
        version: info.version,
        date: info.releaseDate ?? null,
        notes,
      };
    },

    async download() {
      if (!state.pendingUpdate) {
        return;
      }

      options.emitStatus({
        state: "downloading",
        checkedAt: state.pendingUpdate.checkedAt,
        version: state.pendingUpdate.version,
        downloadedBytes: 0,
        totalBytes: null,
        notes: state.pendingUpdate.notes ?? undefined,
      });
      await autoUpdater.downloadUpdate();
    },

    async installAndRelaunch() {
      autoUpdater.quitAndInstall(false, true);
    },
  };
}

export type UpdateService = ReturnType<typeof createUpdateService>;

export function registerUpdateIpc(service: UpdateService) {
  ipcMain.handle(IPC_CHANNELS.updates("getEnvironment"), () => service.getEnvironment());
  ipcMain.handle(IPC_CHANNELS.updates("check"), (_event, input?: { timeoutMs?: number }) => service.check(input));
  ipcMain.handle(IPC_CHANNELS.updates("download"), () => service.download());
  ipcMain.handle(IPC_CHANNELS.updates("installAndRelaunch"), () => service.installAndRelaunch());
}
