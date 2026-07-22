/** @jsxImportSource react */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { DenDesktopConfig } from "../../../../app/lib/den";
import {
  isAlphaChannelAllowedByDesktopConfig,
  isAlphaUpdateAllowed,
  isUpdateAllowed,
  isUpdateAllowedByDesktopConfig,
  resolveAutomaticStableDesktopUpdate,
  resolveDesktopUpdateChannel,
  resolveFreshStableDesktopUpdate,
} from "../../../../app/lib/version-gate";
import type { ReleaseChannel } from "../../../../app/types";
import { isElectronRuntime, safeStringify } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { useUpdateCheckRequestStore } from "./update-check-request";

export type SettingsUpdateStatus = {
  state: "idle" | "checking" | "available" | "blocked" | "downloading" | "ready" | "error";
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

declare global {
  interface Window {
    __openworkUpdaterEvalBridge?: ElectronUpdaterBridge;
  }
}

type UseElectronUpdaterStateOptions = {
  releaseChannel: ReleaseChannel;
  onReleaseChannelChange: (next: ReleaseChannel) => void;
  updateAutoCheck: boolean;
  updateAutoDownload: boolean;
  desktopConfig: DenDesktopConfig | null | undefined;
  refreshDesktopConfig: () => Promise<DenDesktopConfig>;
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
  if (import.meta.env.DEV && window.__openworkUpdaterEvalBridge) {
    return window.__openworkUpdaterEvalBridge;
  }
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
  const {
    releaseChannel,
    onReleaseChannelChange,
    updateAutoCheck,
    updateAutoDownload,
    desktopConfig,
    refreshDesktopConfig,
    setError,
  } = options;
  const [updateStatus, setUpdateStatus] = useState<SettingsUpdateStatus>(null);
  const [envState, dispatchEnvState] = useReducer(electronUpdaterEnvReducer, {
    appVersion: null,
    updateEnv: null,
  });
  const { appVersion, updateEnv } = envState;
  const autoCheckKeyRef = useRef<string | null>(null);
  const availableReleaseChannelRef = useRef<ReleaseChannel | null>(null);
  const downloadedReleaseChannelRef = useRef<ReleaseChannel | null>(null);
  const desktopConfigRef = useRef(desktopConfig);
  desktopConfigRef.current = desktopConfig;
  const policyReleaseChannel = resolveDesktopUpdateChannel(
    releaseChannel,
    desktopConfig,
  );

  const resolvePolicyReleaseChannel = useCallback(
    async (channel: ReleaseChannel) => {
      if (
        channel !== "alpha" ||
        !isAlphaChannelAllowedByDesktopConfig(desktopConfig)
      ) {
        return {
          channel: resolveDesktopUpdateChannel(channel, desktopConfig),
          desktopConfig,
        };
      }

      const freshDesktopConfig = await refreshDesktopConfig();
      return {
        channel: resolveDesktopUpdateChannel(channel, freshDesktopConfig),
        desktopConfig: freshDesktopConfig,
      };
    },
    [desktopConfig, refreshDesktopConfig],
  );

  useEffect(() => {
    if (policyReleaseChannel !== releaseChannel) {
      onReleaseChannelChange(policyReleaseChannel);
    }
    if (isAlphaChannelAllowedByDesktopConfig(desktopConfig)) return;
    if (
      availableReleaseChannelRef.current === "alpha" ||
      downloadedReleaseChannelRef.current === "alpha"
    ) {
      availableReleaseChannelRef.current = null;
      downloadedReleaseChannelRef.current = null;
      setUpdateStatus(null);
    }
  }, [
    desktopConfig,
    onReleaseChannelChange,
    policyReleaseChannel,
    releaseChannel,
  ]);

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
        if (state.channel && state.channel !== policyReleaseChannel && bridge.setChannel) {
          const nextState = await bridge.setChannel(policyReleaseChannel);
          if (cancelled) return;
          dispatchEnvState({ type: "app-version", appVersion: nextState.currentVersion ?? null });
          if (nextState.channel && nextState.channel !== policyReleaseChannel) {
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
  }, [onReleaseChannelChange, policyReleaseChannel]);

  const downloadUpdate = useCallback(async (channelOverride?: ReleaseChannel) => {
    const bridge = electronUpdaterBridge();
    if (!bridge?.download) {
      const message = "Electron updater downloads are available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message });
      setError(message);
      return;
    }

    const requestedReleaseChannel =
      channelOverride ??
      availableReleaseChannelRef.current ??
      releaseChannel;
    const releaseChannelResolution = await resolvePolicyReleaseChannel(
      requestedReleaseChannel,
    ).catch((error: unknown) => {
      setUpdateStatus({ state: "error", message: describeError(error) });
      return null;
    });
    if (!releaseChannelResolution) return;
    if (releaseChannelResolution.channel !== requestedReleaseChannel) {
      onReleaseChannelChange(releaseChannelResolution.channel);
      await bridge.setChannel?.(releaseChannelResolution.channel);
      availableReleaseChannelRef.current = null;
      downloadedReleaseChannelRef.current = null;
      setUpdateStatus(null);
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
      if (
        releaseChannelResolution.channel === "alpha" &&
        !isAlphaChannelAllowedByDesktopConfig(desktopConfigRef.current)
      ) {
        onReleaseChannelChange("stable");
        await bridge.setChannel?.("stable");
        availableReleaseChannelRef.current = null;
        downloadedReleaseChannelRef.current = null;
        setUpdateStatus(null);
        return;
      }
      availableReleaseChannelRef.current = null;
      downloadedReleaseChannelRef.current = releaseChannelResolution.channel;
      setUpdateStatus((current) => ({
        ...(current ?? {}),
        state: "ready",
      }));
    } catch (error) {
      setUpdateStatus({ state: "error", message: describeError(error) });
    } finally {
      unsubProgress?.();
    }
  }, [
    onReleaseChannelChange,
    releaseChannel,
    resolvePolicyReleaseChannel,
    setError,
  ]);

  const runCheckForUpdates = useCallback(async (
    channelOverride?: ReleaseChannel,
    manual = false,
  ) => {
    const requestedReleaseChannel = channelOverride ?? releaseChannel;
    const bridge = electronUpdaterBridge();
    if (!bridge?.check) {
      const message = "Electron update checks are available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message });
      setError(message);
      return;
    }

    setUpdateStatus({ state: "checking" });
    try {
      let targetVersion: string | undefined;
      const releaseChannelResolution = await resolvePolicyReleaseChannel(
        requestedReleaseChannel,
      );
      const activeReleaseChannel = releaseChannelResolution.channel;
      const freshDesktopConfig = releaseChannelResolution.desktopConfig;
      if (activeReleaseChannel !== requestedReleaseChannel) {
        onReleaseChannelChange(activeReleaseChannel);
        await bridge.setChannel?.(activeReleaseChannel);
      }
      if (manual && activeReleaseChannel === "stable") {
        const channelState = await bridge.getChannel?.();
        const currentVersion = channelState?.currentVersion ?? appVersion;
        if (!currentVersion) {
          throw new Error("Could not determine the installed OpenWork version.");
        }

        const selection = await resolveFreshStableDesktopUpdate({
          currentVersion,
          refreshDesktopConfig,
        });
        if (!selection) {
          throw new Error("Den returned an invalid desktop release inventory.");
        }
        if (selection.kind === "blocked") {
          setUpdateStatus({
            state: "blocked",
            lastCheckedAt: Date.now(),
            version: selection.latestPublishedVersion,
            message: t("settings.update_blocked_org", undefined, {
              version: selection.latestPublishedVersion,
            }),
          });
          return;
        }
        if (selection.kind === "current") {
          setUpdateStatus({
            state: "idle",
            lastCheckedAt: Date.now(),
            version: selection.latestPublishedVersion,
          });
          return;
        }
        targetVersion = selection.targetVersion;
      }

      let result = await bridge.check(activeReleaseChannel, targetVersion);
      dispatchEnvState({ type: "app-version", appVersion: result.currentVersion ?? null });
      if (result.channel && result.channel !== releaseChannel) {
        onReleaseChannelChange(result.channel);
      }
      let checkedReleaseChannel = result.channel ?? activeReleaseChannel;
      if (
        !result.reason &&
        !manual &&
        checkedReleaseChannel === "stable" &&
        result.available &&
        result.latestVersion &&
        !targetVersion &&
        !isUpdateAllowedByDesktopConfig(result.latestVersion, freshDesktopConfig)
      ) {
        const currentVersion = result.currentVersion ?? appVersion;
        const fallbackTargetVersion = currentVersion
          ? await resolveAutomaticStableDesktopUpdate({
              currentVersion,
              latestVersion: result.latestVersion,
              desktopConfig: freshDesktopConfig,
            })
          : null;
        if (fallbackTargetVersion) {
          targetVersion = fallbackTargetVersion;
          result = await bridge.check(checkedReleaseChannel, targetVersion);
          dispatchEnvState({ type: "app-version", appVersion: result.currentVersion ?? null });
          if (result.channel && result.channel !== releaseChannel) {
            onReleaseChannelChange(result.channel);
          }
          checkedReleaseChannel = result.channel ?? checkedReleaseChannel;
        }
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
      const latestDesktopConfig = checkedReleaseChannel === "alpha"
        ? desktopConfigRef.current
        : freshDesktopConfig;
      const availableAllowed = result.available && result.latestVersion
        ? targetVersion
          ? result.latestVersion === targetVersion
          : checkedReleaseChannel === "alpha"
            ? await isAlphaUpdateAllowed(result.latestVersion, latestDesktopConfig)
            : await isUpdateAllowed(result.latestVersion, latestDesktopConfig)
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
      availableReleaseChannelRef.current = availableAllowed
        ? checkedReleaseChannel
        : null;
      downloadedReleaseChannelRef.current = null;
      setUpdateStatus(nextStatus);
      if (availableAllowed && updateAutoDownload) {
        await downloadUpdate(checkedReleaseChannel);
      }
    } catch (error) {
      setUpdateStatus({ state: "error", message: describeError(error) });
    }
  }, [appVersion, downloadUpdate, onReleaseChannelChange, refreshDesktopConfig, releaseChannel, resolvePolicyReleaseChannel, setError, updateAutoDownload]);

  const checkForUpdates = useCallback(
    (channelOverride?: ReleaseChannel) => runCheckForUpdates(channelOverride, true),
    [runCheckForUpdates],
  );

  useEffect(() => {
    if (!updateAutoCheck || updateEnv?.supported === false) return;
    const key = `${policyReleaseChannel}:${appVersion ?? "unknown"}`;
    if (autoCheckKeyRef.current === key) return;
    autoCheckKeyRef.current = key;
    void runCheckForUpdates(undefined, false);
  }, [appVersion, policyReleaseChannel, runCheckForUpdates, updateAutoCheck, updateEnv?.supported]);

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
    try {
      if (downloadedReleaseChannelRef.current === "alpha") {
        const releaseChannelResolution = await resolvePolicyReleaseChannel("alpha");
        if (releaseChannelResolution.channel !== "alpha") {
          onReleaseChannelChange(releaseChannelResolution.channel);
          await bridge.setChannel?.(releaseChannelResolution.channel);
          downloadedReleaseChannelRef.current = null;
          setUpdateStatus(null);
          return;
        }
      }
      const result = await bridge.installAndRestart();
      if (!result?.ok) {
        setUpdateStatus({ state: "error", message: result?.reason ?? "Update install failed." });
      }
    } catch (error) {
      setUpdateStatus({ state: "error", message: describeError(error) });
    }
  }, [onReleaseChannelChange, resolvePolicyReleaseChannel, setError]);

  const setReleaseChannel = useCallback(
    async (next: ReleaseChannel) => {
      const bridge = electronUpdaterBridge();
      try {
        const releaseChannelResolution = await resolvePolicyReleaseChannel(next);
        const allowedReleaseChannel = releaseChannelResolution.channel;
        onReleaseChannelChange(allowedReleaseChannel);
        if (!bridge?.setChannel) return;
        const state = await bridge.setChannel(allowedReleaseChannel);
        dispatchEnvState({ type: "app-version", appVersion: state.currentVersion ?? null });
        if (state.channel && state.channel !== allowedReleaseChannel) {
          onReleaseChannelChange(state.channel);
        }
        await checkForUpdates(state.channel ?? allowedReleaseChannel);
      } catch (error) {
        setUpdateStatus({ state: "error", message: describeError(error) });
      }
    },
    [checkForUpdates, onReleaseChannelChange, resolvePolicyReleaseChannel],
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
