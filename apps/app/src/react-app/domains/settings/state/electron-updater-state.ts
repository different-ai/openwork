/** @jsxImportSource react */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { DenDesktopConfig } from "../../../../app/lib/den";
import { isAlphaUpdateAllowed, isUpdateAllowed } from "../../../../app/lib/version-gate";
import type { ReleaseChannel } from "../../../../app/types";
import { isElectronRuntime, safeStringify } from "../../../../app/utils";
import { useUpdateCheckRequestStore } from "./update-check-request";

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
type UseElectronUpdaterStateOptions = {
  releaseChannel: ReleaseChannel;
  onReleaseChannelChange: (next: ReleaseChannel) => void;
  updateAutoCheck: boolean;
  updateAutoDownload: boolean;
  desktopConfig: DenDesktopConfig | null | undefined;
  setError: (message: string | null) => void;
};

type ElectronUpdaterEnvState = {
  appVersion: string | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
};

type ElectronUpdaterEnvAction =
  | { type: "app-version"; appVersion: string | null }
  | { type: "unsupported"; reason: string };

function electronUpdaterEnvReducer(
  state: ElectronUpdaterEnvState,
  action: ElectronUpdaterEnvAction,
): ElectronUpdaterEnvState {
  switch (action.type) {
    case "app-version":
      return { ...state, appVersion: action.appVersion };
    case "unsupported":
      return {
        ...state,
        updateEnv: { supported: false, reason: action.reason },
      };
  }
}

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
  const { releaseChannel, onReleaseChannelChange, updateAutoCheck, updateAutoDownload, desktopConfig, setError } = options;
  const [updateStatus, setUpdateStatus] = useState<SettingsUpdateStatus>(null);
  const [envState, dispatchEnvState] = useReducer(electronUpdaterEnvReducer, {
    appVersion: null,
    updateEnv: null,
  });
  const { appVersion, updateEnv } = envState;
  const autoCheckKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isElectronRuntime()) return;
    const bridge = electronUpdaterBridge();
    if (!bridge?.getChannel) {
      dispatchEnvState({ type: "unsupported", reason: "Electron updater bridge is unavailable." });
      return;
    }
    let cancelled = false;
    void bridge
      .getChannel()
      .then(async (state) => {
        if (cancelled) return;
        dispatchEnvState({ type: "app-version", appVersion: state.currentVersion ?? null });
        if (state.channel && state.channel !== releaseChannel && bridge.setChannel) {
          const nextState = await bridge.setChannel(releaseChannel);
          if (cancelled) return;
          dispatchEnvState({ type: "app-version", appVersion: nextState.currentVersion ?? null });
          if (nextState.channel && nextState.channel !== releaseChannel) {
            onReleaseChannelChange(nextState.channel);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          dispatchEnvState({ type: "unsupported", reason: "Electron updater bridge is unavailable." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onReleaseChannelChange, releaseChannel]);

  const downloadUpdate = useCallback(async (channelOverride?: ReleaseChannel) => {
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
  }, [desktopConfig, releaseChannel, setError]);

  const checkForUpdates = useCallback(async (channelOverride?: ReleaseChannel) => {
    const activeReleaseChannel = channelOverride ?? releaseChannel;
    const bridge = electronUpdaterBridge();
    if (!bridge?.check) {
      const message = "Electron update checks are available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message });
      setError(message);
      return;
    }

    setUpdateStatus({ state: "checking" });
    try {
      const result = await bridge.check(activeReleaseChannel);
      dispatchEnvState({ type: "app-version", appVersion: result.currentVersion ?? null });
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

      const checkedReleaseChannel = result.channel ?? activeReleaseChannel;
      const availableAllowed = result.available && result.latestVersion
        ? checkedReleaseChannel === "alpha"
          ? await isAlphaUpdateAllowed(result.latestVersion, desktopConfig)
          : await isUpdateAllowed(result.latestVersion, desktopConfig)
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
        await downloadUpdate(checkedReleaseChannel);
      }
    } catch (error) {
      setUpdateStatus({ state: "error", message: describeError(error) });
    }
  }, [desktopConfig, downloadUpdate, onReleaseChannelChange, releaseChannel, setError, updateAutoDownload]);

  useEffect(() => {
    if (!updateAutoCheck || updateEnv?.supported === false) return;
    const key = `${releaseChannel}:${appVersion ?? "unknown"}`;
    if (autoCheckKeyRef.current === key) return;
    autoCheckKeyRef.current = key;
    void checkForUpdates();
  }, [appVersion, checkForUpdates, releaseChannel, updateAutoCheck, updateEnv?.supported]);

  // Run a check when the native "Check for Updates..." menu item was used.
  const updateCheckRequestedAt = useUpdateCheckRequestStore((state) => state.requestedAt);
  useEffect(() => {
    if (updateCheckRequestedAt == null) return;
    useUpdateCheckRequestStore.getState().clearUpdateCheckRequest();
    void checkForUpdates();
  }, [checkForUpdates, updateCheckRequestedAt]);

  const installUpdateAndRestart = useCallback(async () => {
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
        dispatchEnvState({ type: "app-version", appVersion: state.currentVersion ?? null });
        if (state.channel && state.channel !== next) {
          onReleaseChannelChange(state.channel);
        }
        await checkForUpdates(state.channel ?? next);
      } catch (error) {
        setUpdateStatus({ state: "error", message: describeError(error) });
      }
    },
    [checkForUpdates, onReleaseChannelChange],
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
