import { create } from "zustand";
import type { ReleaseChannel } from "../../../../app/types";
import { isAlphaUpdateAllowed, isUpdateAllowed } from "../../../../app/lib/version-gate";
import { isElectronRuntime, safeStringify } from "../../../../app/utils";
import type { SettingsUpdateStatus } from "./electron-updater-state";
import type { DenDesktopConfig } from "../../../../app/lib/den";

type ElectronUpdaterBridge = NonNullable<Window["__OPENWORK_ELECTRON__"]>["updater"] & {
  onDownloadProgress?: (callback: (data: { transferred: number; total: number; percent: number; bytesPerSecond: number }) => void) => (() => void);
};

function electronUpdaterBridge(): ElectronUpdaterBridge | null {
  if (typeof window === "undefined") return null;
  return window.__OPENWORK_ELECTRON__?.updater ?? null;
}

function releaseNotesToText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && "note" in entry) {
          const note = String((entry as { note?: unknown }).note ?? "");
          return note ? [note] : [];
        }
        return [];
      })
      .join("\n\n") || undefined;
  }
  return undefined;
}

function describeError(error: unknown) {
  if (error instanceof Error) return error.message;
  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : String(error);
}

export type ElectronUpdaterStore = {
  appVersion: string | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  updateStatus: SettingsUpdateStatus;
  
  setAppVersion: (appVersion: string | null) => void;
  setUpdateEnv: (updateEnv: { supported?: boolean; reason?: string | null }) => void;
  setUpdateStatus: (updateStatus: SettingsUpdateStatus | ((prev: SettingsUpdateStatus) => SettingsUpdateStatus)) => void;
  
  checkForUpdates: (options: {
    releaseChannel: ReleaseChannel;
    desktopConfig: DenDesktopConfig | null | undefined;
    updateAutoDownload?: boolean;
    onReleaseChannelChange?: (channel: ReleaseChannel) => void;
    setError?: (message: string | null) => void;
  }) => Promise<void>;
  
  downloadUpdate: (options: {
    releaseChannel: ReleaseChannel;
    desktopConfig: DenDesktopConfig | null | undefined;
    setError?: (message: string | null) => void;
  }) => Promise<void>;
  
  installUpdateAndRestart: (options?: {
    setError?: (message: string | null) => void;
  }) => Promise<void>;
};

export const useElectronUpdaterStore = create<ElectronUpdaterStore>((set, get) => {
  let isDownloadProgressSubscribed = false;
  let unsubDownloadProgress: (() => void) | null = null;

  return {
    appVersion: null,
    updateEnv: null,
    updateStatus: null,

    setAppVersion: (appVersion) => set({ appVersion }),
    setUpdateEnv: (updateEnv) => set({ updateEnv }),
    setUpdateStatus: (updateStatus) => {
      if (typeof updateStatus === "function") {
        set((state) => ({ updateStatus: updateStatus(state.updateStatus) }));
      } else {
        set({ updateStatus });
      }
    },

    checkForUpdates: async (options) => {
      const { releaseChannel, desktopConfig, updateAutoDownload, onReleaseChannelChange, setError } = options;
      const bridge = electronUpdaterBridge();
      if (!bridge?.check) {
        const message = "Electron update checks are available only in the Electron desktop app.";
        set({ updateStatus: { state: "error", message } });
        setError?.(message);
        return;
      }

      set({ updateStatus: { state: "checking" } });
      try {
        const result = await bridge.check(releaseChannel);
        set({ appVersion: result.currentVersion ?? null });
        if (result.channel && result.channel !== releaseChannel) {
          onReleaseChannelChange?.(result.channel);
        }
        if (result.reason === "unavailable") {
          set({
            updateStatus: {
              state: "idle",
              message: "Auto-updates are available in packaged builds only.",
            },
          });
          return;
        }
        if (result.reason) {
          set({ updateStatus: { state: "error", message: result.reason } });
          setError?.(result.reason);
          return;
        }

        const checkedReleaseChannel = result.channel ?? releaseChannel;
        const availableAllowed = result.available && result.latestVersion
          ? checkedReleaseChannel === "alpha"
            ? await isAlphaUpdateAllowed(result.latestVersion, desktopConfig)
            : await isUpdateAllowed(result.latestVersion, desktopConfig)
          : result.available;

        const parsedNotes = releaseNotesToText(result.releaseNotes);
        const nextStatus: Exclude<SettingsUpdateStatus, null> = availableAllowed
          ? {
              state: "available",
              lastCheckedAt: Date.now(),
              version: result.latestVersion ?? undefined,
              date: result.releaseDate ?? undefined,
              notes: parsedNotes,
            }
          : {
              state: "idle",
              lastCheckedAt: Date.now(),
              version: result.latestVersion ?? undefined,
              date: result.releaseDate ?? undefined,
              notes: parsedNotes,
            };

        set({ updateStatus: nextStatus });
        if (availableAllowed && updateAutoDownload) {
          void get().downloadUpdate({
            releaseChannel: checkedReleaseChannel,
            desktopConfig,
            setError,
          });
        }
      } catch (error) {
        const msg = describeError(error);
        set({ updateStatus: { state: "error", message: msg } });
        setError?.(msg);
      }
    },

    downloadUpdate: async (options) => {
      const { releaseChannel, desktopConfig, setError } = options;
      const bridge = electronUpdaterBridge();
      if (!bridge?.download) {
        const message = "Electron updater downloads are available only in the Electron desktop app.";
        set({ updateStatus: { state: "error", message } });
        setError?.(message);
        return;
      }

      // Store pending release notes and version to localStorage right before we start/complete downloading,
      // so on reboot we can check if version matches and display What's New modal.
      const currentStatus = get().updateStatus;
      if (currentStatus?.version && currentStatus?.notes) {
        localStorage.setItem("openwork:pending-release-version", currentStatus.version);
        localStorage.setItem("openwork:pending-release-notes", currentStatus.notes);
      }

      if (bridge.onDownloadProgress && !isDownloadProgressSubscribed) {
        isDownloadProgressSubscribed = true;
        unsubDownloadProgress = bridge.onDownloadProgress((data) => {
          set((state) => {
            const current = state.updateStatus;
            return {
              updateStatus: {
                ...(current ?? {}),
                state: "downloading",
                downloadedBytes: data.transferred ?? 0,
                totalBytes: data.total ?? current?.totalBytes ?? null,
              },
            };
          });
        });
      }

      set((state) => {
        const current = state.updateStatus;
        return {
          updateStatus: {
            ...(current ?? {}),
            state: "downloading",
            downloadedBytes: current?.downloadedBytes ?? 0,
            totalBytes: current?.totalBytes ?? null,
          },
        };
      });

      try {
        const result = await bridge.download();
        if (!result?.ok) {
          set({ updateStatus: { state: "error", message: result?.reason ?? "Update download failed." } });
          setError?.(result?.reason ?? "Update download failed.");
          return;
        }
        set((state) => ({
          updateStatus: {
            ...(state.updateStatus ?? {}),
            state: "ready",
          },
        }));
      } catch (error) {
        const msg = describeError(error);
        set({ updateStatus: { state: "error", message: msg } });
        setError?.(msg);
      } finally {
        if (unsubDownloadProgress) {
          unsubDownloadProgress();
          unsubDownloadProgress = null;
          isDownloadProgressSubscribed = false;
        }
      }
    },

    installUpdateAndRestart: async (options) => {
      const { setError } = options ?? {};
      const bridge = electronUpdaterBridge();
      if (!bridge?.installAndRestart) {
        const message = "Electron update install is available only in the Electron desktop app.";
        set({ updateStatus: { state: "error", message } });
        setError?.(message);
        return;
      }
      const result = await bridge.installAndRestart();
      if (!result?.ok) {
        const message = result?.reason ?? "Update install failed.";
        set({ updateStatus: { state: "error", message } });
        setError?.(message);
      }
    },
  };
});

if (typeof window !== "undefined") {
  (window as any).__useElectronUpdaterStore = useElectronUpdaterStore;
}
