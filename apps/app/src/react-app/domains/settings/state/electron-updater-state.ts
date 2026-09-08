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
  failedAction?: "check" | "download" | "install";
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

export type ElectronUpdaterEnvState = {
  appVersion: string | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
};

export const ELECTRON_UPDATER_UNSUPPORTED_REASON = "Electron updater bridge is unavailable.";

export function unsupportedElectronUpdaterEnvState(): ElectronUpdaterEnvState {
  return {
    appVersion: null,
    updateEnv: { supported: false, reason: ELECTRON_UPDATER_UNSUPPORTED_REASON },
  };
}

export function shouldScheduleElectronUpdateAutoCheck(input: {
  updateAutoCheck: boolean;
  updateEnv: ElectronUpdaterEnvState["updateEnv"];
  autoCheckKey: string | null;
  nextAutoCheckKey: string;
}) {
  return input.updateAutoCheck &&
    input.updateEnv?.supported !== false &&
    input.autoCheckKey !== input.nextAutoCheckKey;
}

export function resolveCheckedUpdateState(input: {
  available: boolean;
  allowed: boolean;
}): "idle" | "available" | "blocked" {
  if (!input.available) return "idle";
  return input.allowed ? "available" : "blocked";
}

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
    updateEnv: isElectronRuntime()
      ? null
      : { supported: false, reason: ELECTRON_UPDATER_UNSUPPORTED_REASON },
  });
  const { appVersion, updateEnv } = envState;
  const updateStatusRef = useRef(updateStatus);
  updateStatusRef.current = updateStatus;
  const lastAutoCheckAtRef = useRef(0);
  const autoCheckInFlightRef = useRef(false);
  const autoCheckKeyRef = useRef<string | null>(null);
  const checkRequestRef = useRef(0);
  const releaseChannelRequestRef = useRef(0);
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
    if (!isElectronRuntime()) {
      dispatchEnvState({ type: "unsupported", reason: ELECTRON_UPDATER_UNSUPPORTED_REASON });
      return;
    }
    const bridge = electronUpdaterBridge();
    if (!bridge?.getChannel) {
      dispatchEnvState({ type: "unsupported", reason: ELECTRON_UPDATER_UNSUPPORTED_REASON });
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
          dispatchEnvState({ type: "unsupported", reason: ELECTRON_UPDATER_UNSUPPORTED_REASON });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onReleaseChannelChange, policyReleaseChannel]);

  const downloadUpdate = useCallback(async (channelOverride?: ReleaseChannel) => {
    const releaseChannelRequestId = releaseChannelRequestRef.current;
    const isCurrentReleaseChannel = () =>
      releaseChannelRequestRef.current === releaseChannelRequestId;
    const bridge = electronUpdaterBridge();
    if (!bridge?.download) {
      const message = "Electron updater downloads are available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message, failedAction: "download" });
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
      if (isCurrentReleaseChannel()) {
        setUpdateStatus({
          state: "error",
          message: describeError(error),
          failedAction: "download",
        });
      }
      return null;
    });
    if (!releaseChannelResolution || !isCurrentReleaseChannel()) return;
    if (releaseChannelResolution.channel !== requestedReleaseChannel) {
      onReleaseChannelChange(releaseChannelResolution.channel);
      await bridge.setChannel?.(releaseChannelResolution.channel);
      if (!isCurrentReleaseChannel()) return;
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
        if (!isCurrentReleaseChannel()) return;
        setUpdateStatus((current) => ({
          ...(current ?? {}),
          state: "downloading",
          downloadedBytes: data.transferred ?? 0,
          totalBytes: data.total ?? current?.totalBytes ?? null,
        }));
      });
    }

    if (!isCurrentReleaseChannel()) return;
    setUpdateStatus((current) => ({
      ...(current ?? {}),
      state: "downloading",
      downloadedBytes: current?.downloadedBytes ?? 0,
      totalBytes: current?.totalBytes ?? null,
    }));
    try {
      const result = await bridge.download();
      if (!isCurrentReleaseChannel()) return;
      if (!result?.ok) {
        setUpdateStatus({
          state: "error",
          message: result?.reason ?? "Update download failed.",
          failedAction: "download",
        });
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
      if (!isCurrentReleaseChannel()) return;
      setUpdateStatus({
        state: "error",
        message: describeError(error),
        failedAction: "download",
      });
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
    if (!isElectronRuntime()) return;
    const requestId = checkRequestRef.current + 1;
    checkRequestRef.current = requestId;
    const isCurrentRequest = () => checkRequestRef.current === requestId;
    const requestedReleaseChannel = channelOverride ?? releaseChannel;
    const bridge = electronUpdaterBridge();
    if (!bridge?.check) {
      const message = "Electron update checks are available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message, failedAction: "check" });
      setError(message);
      return;
    }

    setUpdateStatus({ state: "checking" });
    try {
      let targetVersion: string | undefined;
      const releaseChannelResolution = await resolvePolicyReleaseChannel(
        requestedReleaseChannel,
      );
      if (!isCurrentRequest()) return;
      const activeReleaseChannel = releaseChannelResolution.channel;
      const freshDesktopConfig = releaseChannelResolution.desktopConfig;
      if (activeReleaseChannel !== requestedReleaseChannel) {
        onReleaseChannelChange(activeReleaseChannel);
        await bridge.setChannel?.(activeReleaseChannel);
        if (!isCurrentRequest()) return;
      }
      if (manual && activeReleaseChannel === "stable") {
        const channelState = await bridge.getChannel?.();
        if (!isCurrentRequest()) return;
        const currentVersion = channelState?.currentVersion ?? appVersion;
        if (!currentVersion) {
          throw new Error("Could not determine the installed OpenWork version.");
        }

        const selection = await resolveFreshStableDesktopUpdate({
          currentVersion,
          refreshDesktopConfig,
        });
        if (!isCurrentRequest()) return;
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
      if (!isCurrentRequest()) return;
      dispatchEnvState({ type: "app-version", appVersion: result.currentVersion ?? null });
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
        if (!isCurrentRequest()) return;
        if (fallbackTargetVersion) {
          targetVersion = fallbackTargetVersion;
          result = await bridge.check(checkedReleaseChannel, targetVersion);
          if (!isCurrentRequest()) return;
          dispatchEnvState({ type: "app-version", appVersion: result.currentVersion ?? null });
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
        setUpdateStatus({
          state: "error",
          message: result.reason,
          failedAction: "check",
        });
        return;
      }
      const latestDesktopConfig = checkedReleaseChannel === "alpha"
        ? desktopConfigRef.current
        : freshDesktopConfig;
      const availableAllowed = result.available && result.latestVersion
        ? targetVersion
          ? result.latestVersion === targetVersion
          : checkedReleaseChannel === "alpha"
            ? await isAlphaUpdateAllowed(
                result.latestVersion,
                latestDesktopConfig,
                result.currentVersion ?? appVersion,
              )
            : await isUpdateAllowed(result.latestVersion, latestDesktopConfig)
        : result.available;
      if (!isCurrentRequest()) return;
      const checkedUpdateState = resolveCheckedUpdateState({
        available: result.available,
        allowed: Boolean(availableAllowed),
      });
      const nextStatus: Exclude<SettingsUpdateStatus, null> = {
        state: checkedUpdateState,
        lastCheckedAt: Date.now(),
        version: result.latestVersion ?? undefined,
        date: result.releaseDate ?? undefined,
        notes: releaseNotesToText(result.releaseNotes),
        ...(checkedUpdateState === "blocked"
          ? {
              message: t("settings.update_blocked_policy", undefined, {
                version: result.latestVersion ?? "",
              }),
            }
          : {}),
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
      if (!isCurrentRequest()) return;
      setUpdateStatus({
        state: "error",
        message: describeError(error),
        failedAction: "check",
      });
    }
  }, [appVersion, downloadUpdate, onReleaseChannelChange, refreshDesktopConfig, releaseChannel, resolvePolicyReleaseChannel, setError, updateAutoDownload]);

  const checkForUpdates = useCallback(
    (channelOverride?: ReleaseChannel) => {
      const state = updateStatusRef.current?.state;
      if (!channelOverride && (state === "downloading" || state === "ready")) return Promise.resolve();
      return runCheckForUpdates(channelOverride, true);
    },
    [runCheckForUpdates],
  );

  useEffect(() => {
    if (!updateAutoCheck || updateEnv?.supported === false || !appVersion) return;
    const key = `${policyReleaseChannel}:${appVersion}`;
    const interval = 15 * 60 * 1000;
    const check = () => {
      const state = updateStatusRef.current?.state;
      if (autoCheckInFlightRef.current || state === "checking" || state === "downloading" || state === "ready") return;
      if (autoCheckKeyRef.current === key && Date.now() - lastAutoCheckAtRef.current < interval) return;
      autoCheckKeyRef.current = key;
      lastAutoCheckAtRef.current = Date.now();
      autoCheckInFlightRef.current = true;
      void runCheckForUpdates(undefined, false).finally(() => {
        autoCheckInFlightRef.current = false;
      });
    };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    check();
    const timer = window.setInterval(check, interval);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [appVersion, policyReleaseChannel, runCheckForUpdates, updateAutoCheck, updateEnv?.supported]);

  // Run a check when the native "Check for Updates..." menu item was used.
  const updateCheckRequestedAt = useUpdateCheckRequestStore((state) => state.requestedAt);
  useEffect(() => {
    if (updateCheckRequestedAt == null || updateEnv?.supported === false) return;
    useUpdateCheckRequestStore.getState().clearUpdateCheckRequest();
    void checkForUpdates();
  }, [checkForUpdates, updateCheckRequestedAt, updateEnv?.supported]);

  const installUpdateAndRestart = useCallback(async () => {
    const releaseChannelRequestId = releaseChannelRequestRef.current;
    const isCurrentReleaseChannel = () =>
      releaseChannelRequestRef.current === releaseChannelRequestId;
    const bridge = electronUpdaterBridge();
    if (!bridge?.installAndRestart) {
      const message = "Electron update install is available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message, failedAction: "install" });
      setError(message);
      return;
    }
    try {
      if (downloadedReleaseChannelRef.current === "alpha") {
        const releaseChannelResolution = await resolvePolicyReleaseChannel("alpha");
        if (!isCurrentReleaseChannel()) return;
        if (releaseChannelResolution.channel !== "alpha") {
          onReleaseChannelChange(releaseChannelResolution.channel);
          await bridge.setChannel?.(releaseChannelResolution.channel);
          if (!isCurrentReleaseChannel()) return;
          downloadedReleaseChannelRef.current = null;
          setUpdateStatus(null);
          return;
        }
      }
      const result = await bridge.installAndRestart();
      if (!isCurrentReleaseChannel()) return;
      if (!result?.ok) {
        if (result?.reason === "update-not-downloaded") {
          // The main-side staged download was invalidated; re-check so the UI
          // returns to a working stable-targeted download/install flow.
          downloadedReleaseChannelRef.current = null;
          availableReleaseChannelRef.current = null;
          await runCheckForUpdates(undefined, true);
          return;
        }
        setUpdateStatus({
          state: "error",
          message: result?.reason ?? "Update install failed.",
          failedAction: "install",
        });
      }
    } catch (error) {
      if (!isCurrentReleaseChannel()) return;
      setUpdateStatus({
        state: "error",
        message: describeError(error),
        failedAction: "install",
      });
    }
  }, [onReleaseChannelChange, resolvePolicyReleaseChannel, runCheckForUpdates, setError]);

  const setReleaseChannel = useCallback(
    async (next: ReleaseChannel) => {
      const requestId = releaseChannelRequestRef.current + 1;
      releaseChannelRequestRef.current = requestId;
      checkRequestRef.current += 1;
      const bridge = electronUpdaterBridge();
      try {
        const releaseChannelResolution = await resolvePolicyReleaseChannel(next);
        if (releaseChannelRequestRef.current !== requestId) return;
        const allowedReleaseChannel = releaseChannelResolution.channel;
        onReleaseChannelChange(allowedReleaseChannel);
        if (!bridge?.setChannel) return;
        const state = await bridge.setChannel(allowedReleaseChannel);
        if (releaseChannelRequestRef.current !== requestId) return;
        dispatchEnvState({ type: "app-version", appVersion: state.currentVersion ?? null });
        if (state.channel && state.channel !== allowedReleaseChannel) {
          onReleaseChannelChange(state.channel);
        }
        await checkForUpdates(state.channel ?? allowedReleaseChannel);
      } catch (error) {
        if (releaseChannelRequestRef.current !== requestId) return;
        setUpdateStatus({
          state: "error",
          message: describeError(error),
          failedAction: "check",
        });
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
