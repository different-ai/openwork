/** @jsxImportSource react */
import { useCallback, useEffect, useRef } from "react";

import type { DenDesktopConfig } from "../../../../app/lib/den";
import type { ReleaseChannel } from "../../../../app/types";
import { isElectronRuntime } from "../../../../app/utils";
import { useUpdateCheckRequestStore } from "./update-check-request";
import { useElectronUpdaterStore } from "./electron-updater-store";

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

type UseElectronUpdaterStateOptions = {
  releaseChannel: ReleaseChannel;
  onReleaseChannelChange: (next: ReleaseChannel) => void;
  updateAutoCheck: boolean;
  updateAutoDownload: boolean;
  desktopConfig: DenDesktopConfig | null | undefined;
  setError: (message: string | null) => void;
};

export function useElectronUpdaterState(options: UseElectronUpdaterStateOptions) {
  const { releaseChannel, onReleaseChannelChange, updateAutoCheck, updateAutoDownload, desktopConfig, setError } = options;
  const store = useElectronUpdaterStore();
  const { appVersion, updateEnv, updateStatus } = store;
  const autoCheckKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isElectronRuntime()) return;
    const bridge = window.__OPENWORK_ELECTRON__?.updater;
    if (!bridge?.getChannel) {
      store.setUpdateEnv({ supported: false, reason: "Electron updater bridge is unavailable." });
      return;
    }
    let cancelled = false;
    void bridge
      .getChannel()
      .then(async (state) => {
        if (cancelled) return;
        store.setAppVersion(state.currentVersion ?? null);
        if (state.channel && state.channel !== releaseChannel && bridge.setChannel) {
          const nextState = await bridge.setChannel(releaseChannel);
          if (cancelled) return;
          store.setAppVersion(nextState.currentVersion ?? null);
          if (nextState.channel && nextState.channel !== releaseChannel) {
            onReleaseChannelChange(nextState.channel);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          store.setUpdateEnv({ supported: false, reason: "Electron updater bridge is unavailable." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onReleaseChannelChange, releaseChannel]);

  const checkForUpdates = useCallback(async (channelOverride?: ReleaseChannel) => {
    await store.checkForUpdates({
      releaseChannel: channelOverride ?? releaseChannel,
      desktopConfig,
      updateAutoDownload,
      onReleaseChannelChange,
      setError,
    });
  }, [desktopConfig, onReleaseChannelChange, releaseChannel, setError, updateAutoDownload, store]);

  const downloadUpdate = useCallback(async (channelOverride?: ReleaseChannel) => {
    await store.downloadUpdate({
      releaseChannel: channelOverride ?? releaseChannel,
      desktopConfig,
      setError,
    });
  }, [desktopConfig, releaseChannel, setError, store]);

  const installUpdateAndRestart = useCallback(async () => {
    await store.installUpdateAndRestart({ setError });
  }, [setError, store]);

  const setReleaseChannel = useCallback(
    async (next: ReleaseChannel) => {
      onReleaseChannelChange(next);
      const bridge = window.__OPENWORK_ELECTRON__?.updater;
      if (!bridge?.setChannel) return;
      try {
        const state = await bridge.setChannel(next);
        store.setAppVersion(state.currentVersion ?? null);
        if (state.channel && state.channel !== next) {
          onReleaseChannelChange(state.channel);
        }
        await checkForUpdates(state.channel ?? next);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        store.setUpdateStatus({ state: "error", message: msg });
      }
    },
    [checkForUpdates, onReleaseChannelChange, store],
  );

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
