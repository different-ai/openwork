import { createEffect, onCleanup, onMount, type Accessor } from "solid-js";

import { getVersion } from "@tauri-apps/api/app";

import { currentLocale, t } from "../../i18n";
import { HIDE_TITLEBAR_PREF_KEY, MODEL_PREF_KEY, THINKING_PREF_KEY, VARIANT_PREF_KEY } from "../constants";
import { DEFAULT_MODEL } from "../constants";
import { deepLinkBridgeEvent, drainPendingDeepLinks, type DeepLinkBridgeDetail } from "../lib/deep-link-bridge";
import {
  updaterEnvironment,
  type UpdaterEnvironment,
} from "../lib/tauri";
import {
  applyThemeMode,
  persistThemeMode,
  subscribeToSystemTheme,
  type ThemeMode,
} from "../theme";
import type { ModelRef, StartupPreference } from "../types";
import { normalizeModelBehaviorValue } from "../lib/model-behavior";
import {
  formatModelRef,
  isTauriRuntime,
  parseModelRef,
  readStartupPreference,
} from "../utils";

type UpdateStatusSnapshot = {
  state: "idle";
  lastCheckedAt: number | null;
};

type UseAppBootstrapOptions = {
  themeMode: Accessor<ThemeMode>;
  launchUpdateCheckTriggered: Accessor<boolean>;
  setRememberStartupChoice: (value: boolean) => void;
  setStartupPreference: (value: StartupPreference) => void;
  setBaseUrl: (value: string) => void;
  setClientDirectory: (value: string) => void;
  setEngineSource: (value: "path" | "sidecar" | "custom") => void;
  setEngineCustomBinPath: (value: string) => void;
  setEngineRuntime: (value: "direct" | "openwork-orchestrator") => void;
  setOpencodeEnableExa: (value: boolean) => void;
  setDefaultModel: (value: ModelRef) => void;
  setLegacyDefaultModel: (value: ModelRef) => void;
  setShowThinking: (value: boolean) => void;
  setHideTitlebar: (value: boolean) => void;
  setModelVariantMap: (value: Record<string, string>) => void;
  setUpdateAutoCheck: (value: boolean) => void;
  setUpdateAutoDownload: (value: boolean) => void;
  setUpdateStatus: (value: UpdateStatusSnapshot) => void;
  setNotionStatus: (value: "disconnected" | "connecting" | "connected" | "error") => void;
  setNotionStatusDetail: (value: string | null) => void;
  setNotionSkillInstalled: (value: boolean) => void;
  setAppVersion: (value: string | null) => void;
  setUpdateEnv: (value: UpdaterEnvironment | null) => void;
  setLaunchUpdateCheckTriggered: (value: boolean) => void;
  refreshMcpServers: () => Promise<unknown>;
  checkForUpdates: (options: { quiet: boolean }) => Promise<unknown>;
  consumeDeepLinks: (urls: readonly string[] | null | undefined) => void;
  bootstrapOnboarding: () => Promise<unknown>;
  setBooting: (value: boolean) => void;
};

const readStoredBooleanJson = (storage: Storage, key: string) => {
  const raw = storage.getItem(key);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : null;
  } catch {
    return null;
  }
};

export function useAppBootstrap(options: UseAppBootstrapOptions) {
  onMount(() => {
    const startupPref = readStartupPreference();
    if (startupPref) {
      options.setRememberStartupChoice(true);
      options.setStartupPreference(startupPref);
    }

    const unsubscribeTheme = subscribeToSystemTheme((isDark) => {
      if (options.themeMode() !== "system") return;
      applyThemeMode(isDark ? "dark" : "light");
    });

    onCleanup(() => {
      unsubscribeTheme();
    });

    if (typeof window !== "undefined") {
      void hydrateStoredPreferences(options, window.localStorage);
    }

    if (isTauriRuntime()) {
      void hydrateDesktopBootstrap(options);
    }

    if (typeof window !== "undefined") {
      const handleDeepLinkEvent = (event: Event) => {
        const detail = (event as CustomEvent<DeepLinkBridgeDetail>).detail;
        options.consumeDeepLinks(detail?.urls ?? []);
      };

      options.consumeDeepLinks(drainPendingDeepLinks(window));
      window.addEventListener(deepLinkBridgeEvent, handleDeepLinkEvent as EventListener);
      onCleanup(() => {
        window.removeEventListener(deepLinkBridgeEvent, handleDeepLinkEvent as EventListener);
      });
    }

    void options.bootstrapOnboarding().finally(() => options.setBooting(false));
  });

  createEffect(() => {
    const next = options.themeMode();
    persistThemeMode(next);
    applyThemeMode(next);
  });
}

async function hydrateStoredPreferences(options: UseAppBootstrapOptions, storage: Storage) {
  try {
    if (!isTauriRuntime()) {
      const storedBaseUrl = storage.getItem("openwork.baseUrl");
      if (storedBaseUrl) {
        options.setBaseUrl(storedBaseUrl);
      }
    }

    const storedClientDir = storage.getItem("openwork.clientDirectory");
    if (storedClientDir) {
      options.setClientDirectory(storedClientDir);
    }

    const storedEngineSource = storage.getItem("openwork.engineSource");
    const storedEngineCustomBinPath = storage.getItem("openwork.engineCustomBinPath");
    if (storedEngineCustomBinPath) {
      options.setEngineCustomBinPath(storedEngineCustomBinPath);
    }

    if (
      storedEngineSource === "path" ||
      storedEngineSource === "sidecar" ||
      storedEngineSource === "custom"
    ) {
      if (storedEngineSource === "custom" && !(storedEngineCustomBinPath ?? "").trim()) {
        options.setEngineSource(isTauriRuntime() ? "sidecar" : "path");
      } else {
        options.setEngineSource(storedEngineSource);
      }
    }

    const storedEngineRuntime = storage.getItem("openwork.engineRuntime");
    if (storedEngineRuntime === "direct" || storedEngineRuntime === "openwork-orchestrator") {
      options.setEngineRuntime(storedEngineRuntime);
    }

    const storedOpencodeEnableExa = storage.getItem("openwork.opencodeEnableExa");
    if (storedOpencodeEnableExa === "0" || storedOpencodeEnableExa === "1") {
      options.setOpencodeEnableExa(storedOpencodeEnableExa === "1");
    }

    const storedDefaultModel = storage.getItem(MODEL_PREF_KEY);
    const parsedDefaultModel = parseModelRef(storedDefaultModel);
    if (parsedDefaultModel) {
      options.setDefaultModel(parsedDefaultModel);
      options.setLegacyDefaultModel(parsedDefaultModel);
    } else {
      options.setDefaultModel(DEFAULT_MODEL);
      options.setLegacyDefaultModel(DEFAULT_MODEL);
      try {
        storage.setItem(MODEL_PREF_KEY, formatModelRef(DEFAULT_MODEL));
      } catch {
        // ignore
      }
    }

    const storedThinking = readStoredBooleanJson(storage, THINKING_PREF_KEY);
    if (storedThinking != null) {
      options.setShowThinking(storedThinking);
    }

    const storedHideTitlebar = readStoredBooleanJson(storage, HIDE_TITLEBAR_PREF_KEY);
    if (storedHideTitlebar != null) {
      options.setHideTitlebar(storedHideTitlebar);
    }

    const storedVariant = storage.getItem(VARIANT_PREF_KEY);
    if (storedVariant && storedVariant.trim()) {
      try {
        const parsed = JSON.parse(storedVariant);
        if (typeof parsed === "object" && parsed !== null) {
          options.setModelVariantMap(parsed as Record<string, string>);
        } else {
          options.setModelVariantMap({
            [`${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.modelID}`]: normalizeModelBehaviorValue(storedVariant)!,
          });
        }
      } catch {
        options.setModelVariantMap({
          [`${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.modelID}`]: normalizeModelBehaviorValue(storedVariant)!,
        });
      }
    }

    const storedUpdateAutoCheck = storage.getItem("openwork.updateAutoCheck");
    if (storedUpdateAutoCheck === "0" || storedUpdateAutoCheck === "1") {
      options.setUpdateAutoCheck(storedUpdateAutoCheck === "1");
    }

    const storedUpdateAutoDownload = storage.getItem("openwork.updateAutoDownload");
    if (storedUpdateAutoDownload === "0" || storedUpdateAutoDownload === "1") {
      const enabled = storedUpdateAutoDownload === "1";
      options.setUpdateAutoDownload(enabled);
      if (enabled) {
        options.setUpdateAutoCheck(true);
      }
    }

    const storedUpdateCheckedAt = storage.getItem("openwork.updateLastCheckedAt");
    if (storedUpdateCheckedAt) {
      const parsed = Number(storedUpdateCheckedAt);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.setUpdateStatus({ state: "idle", lastCheckedAt: parsed });
      }
    }

    const storedNotionStatus = storage.getItem("openwork.notionStatus");
    if (
      storedNotionStatus === "disconnected" ||
      storedNotionStatus === "connected" ||
      storedNotionStatus === "connecting" ||
      storedNotionStatus === "error"
    ) {
      options.setNotionStatus(storedNotionStatus);
    }

    const storedNotionDetail = storage.getItem("openwork.notionStatusDetail");
    if (storedNotionDetail) {
      options.setNotionStatusDetail(storedNotionDetail);
    } else if (storedNotionStatus === "connecting") {
      options.setNotionStatusDetail(t("mcp.connecting", currentLocale()));
    }

    await options.refreshMcpServers();

    if (storage.getItem("openwork.notionSkillInstalled") === "1") {
      options.setNotionSkillInstalled(true);
    }
  } catch {
    // ignore
  }
}

async function hydrateDesktopBootstrap(options: UseAppBootstrapOptions) {
  try {
    options.setAppVersion(await getVersion());
  } catch {
    // ignore
  }

  try {
    options.setUpdateEnv(await updaterEnvironment());
  } catch {
    // ignore
  }

  if (options.launchUpdateCheckTriggered()) return;
  options.setLaunchUpdateCheckTriggered(true);
  options.checkForUpdates({ quiet: true }).catch(() => undefined);
}
