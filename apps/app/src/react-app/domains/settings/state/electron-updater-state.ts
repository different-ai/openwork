/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";

import type { DenDesktopConfig } from "../../../../app/lib/den";
import { isUpdateAllowed } from "../../../../app/lib/version-gate";
import type { ReleaseChannel } from "../../../../app/types";
import { isElectronRuntime, isTauriRuntime, safeStringify } from "../../../../app/utils";

export type SettingsUpdateStatus = {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  lastCheckedAt?: number | null;
  version?: string;
  date?: string;
  notes?: string;
  totalBytes?: number | null;
  downloadedBytes?: number;
  message?: string;
} | null;

type ElectronUpdaterBridge = NonNullable<Window["__OPENWORK_ELECTRON__"]>["updater"] & {
  onDownloadProgress?: (callback: (data: { transferred: number; total: number; percent: number; bytesPerSecond: number }) => void) => (() => void);
};
type TauriUpdate = {
  version?: string;
  date?: string;
  body?: string;
  downloadAndInstall?: (handler?: (event: unknown) => void) => Promise<void>;
};

type UseElectronUpdaterStateOptions = {
  releaseChannel: ReleaseChannel;
  onReleaseChannelChange: (next: ReleaseChannel) => void;
  updateAutoDownload: boolean;
  desktopConfig: DenDesktopConfig | null | undefined;
  setError: (message: string | null) => void;
};

function electronUpdaterBridge(): ElectronUpdaterBridge | null {
  if (typeof window === "undefined") return null;
  return window.__OPENWORK_ELECTRON__?.updater ?? null;
}

function describeError(error: unknown) {
  if (error instanceof Error) return error.message;
  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : String(error);
}

function releaseNotesToText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && "note" in entry) {
          return String((entry as { note?: unknown }).note ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n") || undefined;
  }
  return undefined;
}

function updateProgress(event: unknown): { downloaded?: number; total?: number } | null {
  if (!event || typeof event !== "object") return null;
  const data = event as { data?: unknown };
  if (!data.data || typeof data.data !== "object") return null;
  const payload = data.data as { chunkLength?: unknown; contentLength?: unknown };
  return {
    downloaded: typeof payload.chunkLength === "number" ? payload.chunkLength : undefined,
    total: typeof payload.contentLength === "number" ? payload.contentLength : undefined,
  };
}

export function useElectronUpdaterState(options: UseElectronUpdaterStateOptions) {
  const { releaseChannel, onReleaseChannelChange, updateAutoDownload, desktopConfig, setError } = options;
  const [updateStatus, setUpdateStatus] = useState<SettingsUpdateStatus>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateEnv, setUpdateEnv] = useState<{ supported?: boolean; reason?: string | null } | null>(null);
  const tauriUpdateRef = useRef<TauriUpdate | null>(null);

  useEffect(() => {
    if (isTauriRuntime()) {
      let cancelled = false;
      void import("@tauri-apps/api/app")
        .then(({ getVersion }) => getVersion())
        .then((version) => {
          if (!cancelled) setAppVersion(version ?? null);
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }

    if (!isElectronRuntime()) return;
    const bridge = electronUpdaterBridge();
    if (!bridge?.getChannel) {
      setUpdateEnv({ supported: false, reason: "Electron updater bridge is unavailable." });
      return;
    }
    let cancelled = false;
    void bridge
      .getChannel()
      .then((state) => {
        if (cancelled) return;
        setAppVersion(state.currentVersion ?? null);
        if (state.channel && state.channel !== releaseChannel) {
          onReleaseChannelChange(state.channel);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUpdateEnv({ supported: false, reason: "Electron updater bridge is unavailable." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onReleaseChannelChange, releaseChannel]);

  const downloadUpdate = useCallback(async () => {
    if (isTauriRuntime()) {
      let update = tauriUpdateRef.current;
      if (!update) {
        const { check } = await import("@tauri-apps/plugin-updater");
        update = (await check()) as TauriUpdate | null;
        tauriUpdateRef.current = update;
      }
      if (!update?.downloadAndInstall) {
        setUpdateStatus({ state: "idle", lastCheckedAt: Date.now() });
        return;
      }
      if (update.version && !(await isUpdateAllowed(update.version, desktopConfig))) {
        tauriUpdateRef.current = null;
        setUpdateStatus({ state: "idle", lastCheckedAt: Date.now() });
        return;
      }
      let downloadedBytes = 0;
      setUpdateStatus({
        state: "downloading",
        version: update.version,
        date: update.date,
        notes: update.body,
        downloadedBytes: 0,
        totalBytes: null,
      });
      await update.downloadAndInstall((event) => {
        const progress = updateProgress(event);
        if (!progress) return;
        downloadedBytes += progress.downloaded ?? 0;
        setUpdateStatus((current) => ({
          ...(current ?? {}),
          state: "downloading",
          downloadedBytes,
          totalBytes: progress.total ?? current?.totalBytes ?? null,
        }));
      });
      setUpdateStatus((current) => ({
        ...(current ?? {}),
        state: "ready",
        downloadedBytes,
      }));
      return;
    }

    const bridge = electronUpdaterBridge();
    if (!bridge?.download) {
      const message = "Electron updater downloads are available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message });
      setError(message);
      return;
    }

    // Subscribe to incremental progress events from the main process so
    // the UI updates in real time instead of staying stuck at 0 bytes.
    let unsubProgress: (() => void) | null = null;
    if (bridge.onDownloadProgress) {
      unsubProgress = bridge.onDownloadProgress((data) => {
        setUpdateStatus((current) => ({
          ...(current ?? {}),
          state: "downloading",
          downloadedBytes: data.transferred ?? 0,
          totalBytes: data.total ?? current?.totalBytes ?? null,
        }));
      });
    }

    setUpdateStatus((current) => ({
      ...(current ?? {}),
      state: "downloading",
      downloadedBytes: current?.downloadedBytes ?? 0,
      totalBytes: current?.totalBytes ?? null,
    }));
    try {
      const result = await bridge.download();
      if (!result?.ok) {
        setUpdateStatus({ state: "error", message: result?.reason ?? "Update download failed." });
        return;
      }
      setUpdateStatus((current) => ({
        ...(current ?? {}),
        state: "ready",
      }));
    } finally {
      unsubProgress?.();
    }
  }, [desktopConfig, setError]);

  const checkForUpdates = useCallback(async () => {
    if (isTauriRuntime()) {
      setUpdateStatus({ state: "checking" });
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = (await check()) as TauriUpdate | null;
        const allowed = update?.version
          ? await isUpdateAllowed(update.version, desktopConfig)
          : true;
        if (!allowed) {
          tauriUpdateRef.current = null;
          setUpdateStatus({ state: "idle", lastCheckedAt: Date.now() });
          return;
        }
        tauriUpdateRef.current = update;
        const nextStatus: Exclude<SettingsUpdateStatus, null> = update
          ? {
              state: "available",
              lastCheckedAt: Date.now(),
              version: update.version,
              date: update.date,
              notes: update.body,
            }
          : { state: "idle", lastCheckedAt: Date.now() };
        setUpdateStatus(nextStatus);
        if (update && updateAutoDownload) {
          await downloadUpdate();
        }
      } catch (error) {
        setUpdateStatus({ state: "error", message: describeError(error) });
      }
      return;
    }

    const bridge = electronUpdaterBridge();
    if (!bridge?.check) {
      const message = "Electron update checks are available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message });
      setError(message);
      return;
    }

    setUpdateStatus({ state: "checking" });
    try {
      const result = await bridge.check();
      setAppVersion(result.currentVersion ?? null);
      if (result.channel && result.channel !== releaseChannel) {
        onReleaseChannelChange(result.channel);
      }
      if (result.reason === "unavailable") {
        setUpdateStatus({
          state: "idle",
          message: "Auto-updates are available in packaged builds only.",
        });
        return;
      }
      if (result.reason) {
        setUpdateStatus({ state: "error", message: result.reason });
        return;
      }

      const availableAllowed = result.available && result.latestVersion
        ? await isUpdateAllowed(result.latestVersion, desktopConfig)
        : result.available;
      const nextStatus: Exclude<SettingsUpdateStatus, null> = availableAllowed
        ? {
            state: "available",
            lastCheckedAt: Date.now(),
            version: result.latestVersion ?? undefined,
            date: result.releaseDate ?? undefined,
            notes: releaseNotesToText(result.releaseNotes),
          }
        : {
            state: "idle",
            lastCheckedAt: Date.now(),
            version: result.latestVersion ?? undefined,
            date: result.releaseDate ?? undefined,
            notes: releaseNotesToText(result.releaseNotes),
          };
      setUpdateStatus(nextStatus);
      if (availableAllowed && updateAutoDownload) {
        await downloadUpdate();
      }
    } catch (error) {
      setUpdateStatus({ state: "error", message: describeError(error) });
    }
  }, [desktopConfig, downloadUpdate, onReleaseChannelChange, releaseChannel, setError, updateAutoDownload]);

  const installUpdateAndRestart = useCallback(async () => {
    if (isTauriRuntime()) {
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch (error) {
        setUpdateStatus({ state: "error", message: describeError(error) });
      }
      return;
    }

    const bridge = electronUpdaterBridge();
    if (!bridge?.installAndRestart) {
      const message = "Electron update install is available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message });
      setError(message);
      return;
    }
    const result = await bridge.installAndRestart();
    if (!result?.ok) {
      setUpdateStatus({ state: "error", message: result?.reason ?? "Update install failed." });
    }
  }, [setError]);

  const setReleaseChannel = useCallback(
    async (next: ReleaseChannel) => {
      onReleaseChannelChange(next);
      const bridge = electronUpdaterBridge();
      if (!bridge?.setChannel) return;
      try {
        const state = await bridge.setChannel(next);
        setAppVersion(state.currentVersion ?? null);
        if (state.channel && state.channel !== next) {
          onReleaseChannelChange(state.channel);
        }
        setUpdateStatus({ state: "idle", lastCheckedAt: null });
      } catch (error) {
        setUpdateStatus({ state: "error", message: describeError(error) });
      }
    },
    [onReleaseChannelChange],
  );

  return {
    appVersion,
    updateEnv,
    updateStatus,
    checkForUpdates,
    downloadUpdate,
    installUpdateAndRestart,
    setReleaseChannel,
  };
}
