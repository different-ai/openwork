import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";

import type { Session } from "@opencode-ai/sdk/v2/client";
import type { ProviderListItem } from "./types";
import { t } from "../i18n";

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import type {
  Client,
  PluginScope,
  ReloadReason,
  ReloadTrigger,
  ResetOpenworkMode,
  UpdateHandle,
} from "./types";
import { addOpencodeCacheHint, isTauriRuntime, safeStringify } from "./utils";
import { filterProviderList, mapConfigProvidersToList } from "./utils/providers";
import { createUpdaterState, type UpdateStatus } from "./context/updater";
import {
  resetOpenworkState,
  resetOpencodeCache,
  sandboxCleanupOpenworkContainers,
} from "./lib/tauri";
import { unwrap, waitForHealthy } from "./lib/opencode";

function throttle<T extends (...args: any[]) => any>(
  fn: T,
  delayMs: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    lastArgs = args;

    if (now - lastCall >= delayMs) {
      lastCall = now;
      fn(...args);
    } else if (!timeoutId){
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        timeoutId = null;
        if (lastArgs) fn(...lastArgs);
      }, delayMs - (now - lastCall));
    }
  }
}

function forcedDevUpdateStatus(): UpdateStatus | null {
  if (!import.meta.env.DEV) return null;

  const forcedState = String(import.meta.env.VITE_FORCE_UPDATE_STATUS ?? "").trim().toLowerCase();
  if (forcedState !== "available") return null;

  const version = String(import.meta.env.VITE_FORCE_UPDATE_VERSION ?? "0.11.999").trim() || "0.11.999";
  return {
    state: "available",
    lastCheckedAt: Date.now(),
    version,
    notes: "Dev-only forced update state",
  };
}

export function createSystemState(options: {
  client: Accessor<Client | null>;
  sessions: Accessor<Session[]>;
  sessionStatusById: Accessor<Record<string, string>>;
  refreshPlugins: (scopeOverride?: PluginScope) => Promise<void>;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshMcpServers?: () => Promise<void>;
  reloadWorkspaceEngine?: () => Promise<boolean>;
  canReloadWorkspaceEngine?: () => boolean;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setError: (value: string | null) => void;
}) {
  const isActiveSessionStatus = (status: string | null | undefined) =>
    status === "running" || status === "retry";

  const [reloadPending, setReloadPending] = createSignal(false);
  const [reloadReasons, setReloadReasons] = createSignal<ReloadReason[]>([]);
  const [reloadLastTriggeredAt, setReloadLastTriggeredAt] = createSignal<number | null>(null);
  const [reloadLastFinishedAt, setReloadLastFinishedAt] = createSignal<number | null>(null);
  const [reloadTrigger, setReloadTrigger] = createSignal<ReloadTrigger | null>(null);
  const [reloadBusy, setReloadBusy] = createSignal(false);
  const [reloadError, setReloadError] = createSignal<string | null>(null);

  const [cacheRepairBusy, setCacheRepairBusy] = createSignal(false);
  const [cacheRepairResult, setCacheRepairResult] = createSignal<string | null>(null);
  const [dockerCleanupBusy, setDockerCleanupBusy] = createSignal(false);
  const [dockerCleanupResult, setDockerCleanupResult] = createSignal<string | null>(null);

  const updater = createUpdaterState();
  const {
    updateAutoCheck,
    setUpdateAutoCheck,
    updateAutoDownload,
    setUpdateAutoDownload,
    updateStatus,
    setUpdateStatus,
    pendingUpdate,
    setPendingUpdate,
    updateEnv,
    setUpdateEnv,
  } = updater;

  const [resetModalOpen, setResetModalOpen] = createSignal(false);
  const [resetModalMode, setResetModalMode] = createSignal<ResetOpenworkMode>("onboarding");
  const [resetModalText, setResetModalText] = createSignal("");
  const [resetModalBusy, setResetModalBusy] = createSignal(false);

  const resetModalTextValue = resetModalText;

  const anyActiveRuns = createMemo(() => {
    const statuses = options.sessionStatusById();
    return options.sessions().some((s) => isActiveSessionStatus(statuses[s.id]));
  });

  function clearOpenworkLocalStorage(mode: ResetOpenworkMode) {
    if (typeof window === "undefined") return;

    try {
      if (mode === "all") {
        window.localStorage.clear();
        return;
      }

      const keys = Object.keys(window.localStorage);
      for (const key of keys) {
        if (key.includes("openwork")) {
          window.localStorage.removeItem(key);
        }
      }
      // Legacy compatibility key
      window.localStorage.removeItem("openwork_mode_pref");
    } catch {
      // ignore
    }
  }

  function openResetModal(mode: ResetOpenworkMode) {
    if (anyActiveRuns()) {
      options.setError(t("system.stop_active_runs_before_reset"));
      return;
    }

    options.setError(null);
    setResetModalMode(mode);
    setResetModalText("");
    setResetModalOpen(true);
  }

  async function confirmReset() {
    if (resetModalBusy()) return;

    if (anyActiveRuns()) {
      options.setError(t("system.stop_active_runs_before_reset"));
      return;
    }

    if (resetModalTextValue().trim().toUpperCase() !== "RESET") return;

    setResetModalBusy(true);
    options.setError(null);

    try {
      if (isTauriRuntime()) {
        await resetOpenworkState(resetModalMode());
      }

      clearOpenworkLocalStorage(resetModalMode());

      if (isTauriRuntime()) {
        await relaunch();
      } else {
        window.location.reload();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      setResetModalBusy(false);
    }
  }

  function markReloadRequired(reason: ReloadReason, trigger?: ReloadTrigger) {
    setReloadPending(true);
    setReloadLastTriggeredAt(Date.now());
    setReloadReasons((current) => (current.includes(reason) ? current : [...current, reason]));
    if (trigger) {
      setReloadTrigger(trigger);
    } else {
      setReloadTrigger({
        type:
          reason === "plugins"
            ? "plugin"
            : reason === "skills"
              ? "skill"
              : reason === "agents"
                ? "agent"
                : reason === "commands"
                  ? "command"
                  : reason,
      });
    }
  }

  function clearReloadRequired() {
    setReloadPending(false);
    setReloadReasons([]);
    setReloadError(null);
    setReloadTrigger(null);
  }

  const reloadCopy = createMemo(() => {
    const title = t("system.reload_required");
    const reasons = reloadReasons();

    const bodyKey =
      reasons.length === 1 && reasons[0] === "plugins" ? "system.reload_body_plugins"
      : reasons.length === 1 && reasons[0] === "skills" ? "system.reload_body_skills"
      : reasons.length === 1 && reasons[0] === "agents" ? "system.reload_body_agents"
      : reasons.length === 1 && reasons[0] === "commands" ? "system.reload_body_commands"
      : reasons.length === 1 && reasons[0] === "config" ? "system.reload_body_config"
      : reasons.length === 1 && reasons[0] === "mcp" ? "system.reload_body_mcp"
      : reasons.length > 0 ? "system.reload_body_mixed"
      : "system.reload_body_default";

    return { title, body: t(bodyKey) };
  });

  const canReloadEngine = createMemo(() => {
    if (!reloadPending()) return false;
    if (reloadBusy()) return false;
    const override = options.canReloadWorkspaceEngine?.();
    if (override === true) return true;
    if (override === false) return false;
    if (!options.client()) return false;
    return true;
  });

  // Keep this mounted so the reload banner UX remains in the app.
  createEffect(() => {
    reloadPending();
  });

  async function reloadEngineInstance() {
    const initialClient = options.client();
    if (!initialClient) return;

    const override = options.canReloadWorkspaceEngine?.();
    if (override === false) {
      setReloadError(t("system.reload_unavailable"));
      return;
    }

    // if (anyActiveRuns()) {
    //   setReloadError("Waiting for active tasks to complete before reloading.");
    //   return;
    // }

    setReloadBusy(true);
    setReloadError(null);

    try {
      if (options.reloadWorkspaceEngine) {
        const ok = await options.reloadWorkspaceEngine();
        if (ok === false) {
          setReloadError(t("system.reload_failed"));
          return;
        }
      } else {
        unwrap(await initialClient.instance.dispose());
      }

      const nextClient = options.client();
      if (!nextClient) {
        throw new Error("OpenCode client unavailable after reload.");
      }

      await waitForHealthy(nextClient, { timeoutMs: 12_000 });
      let disabledProviders: string[] = [];
      try {
        const config = unwrap(await nextClient.config.get()) as {
          disabled_providers?: string[];
        };
        disabledProviders = Array.isArray(config.disabled_providers) ? config.disabled_providers : [];
      } catch {
        // ignore config read failures and continue with provider discovery
      }

      try {
        const providerList = filterProviderList(
          unwrap(await nextClient.provider.list()),
          disabledProviders,
        );
        options.setProviders(providerList.all);
        options.setProviderDefaults(providerList.default);
        options.setProviderConnectedIds(providerList.connected);
      } catch {
        try {
          const cfg = unwrap(await nextClient.config.providers()) as {
            providers: Parameters<typeof mapConfigProvidersToList>[0];
            default: Record<string, string>;
          };
          const providerList = filterProviderList(
            { all: mapConfigProvidersToList(cfg.providers), default: cfg.default, connected: [] },
            disabledProviders,
          );
          options.setProviders(providerList.all);
          options.setProviderDefaults(providerList.default);
          options.setProviderConnectedIds(providerList.connected);
        } catch {
          options.setProviders([]);
          options.setProviderDefaults({});
          options.setProviderConnectedIds([]);
        }
      }

      await options.refreshPlugins("project").catch(() => undefined);
      await options.refreshSkills({ force: true }).catch(() => undefined);
      await options.refreshMcpServers?.().catch(() => undefined);

      clearReloadRequired();
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setReloadBusy(false);
      setReloadLastFinishedAt(Date.now());
    }
  }

  async function reloadWorkspaceEngine() {
    await reloadEngineInstance();
  }

  async function repairOpencodeCache() {
    if (!isTauriRuntime()) {
      setCacheRepairResult(t("system.cache_repair_requires_desktop"));
      return;
    }

    if (cacheRepairBusy()) return;

    setCacheRepairBusy(true);
    setCacheRepairResult(null);
    options.setError(null);

    try {
      const result = await resetOpencodeCache();
      if (result.errors.length) {
        setCacheRepairResult(result.errors[0]);
        return;
      }

      if (result.removed.length) {
        setCacheRepairResult(t("settings.cache_repaired"));
      } else {
        setCacheRepairResult(t("settings.cache_nothing_to_repair"));
      }
    } catch (e) {
      setCacheRepairResult(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setCacheRepairBusy(false);
    }
  }

  async function cleanupOpenworkDockerContainers() {
    if (!isTauriRuntime()) {
      setDockerCleanupResult(t("system.docker_cleanup_requires_desktop"));
      return;
    }

    if (dockerCleanupBusy()) return;

    setDockerCleanupBusy(true);
    setDockerCleanupResult(null);
    options.setError(null);

    try {
      const result = await sandboxCleanupOpenworkContainers();
      if (!result.candidates.length) {
        setDockerCleanupResult("No OpenWork Docker containers found.");
        return;
      }

      const removedCount = result.removed.length;
      if (result.errors.length) {
        const first = result.errors[0];
        setDockerCleanupResult(
          `Removed ${removedCount}/${result.candidates.length} containers. ${first}`,
        );
        return;
      }

      setDockerCleanupResult(`Removed ${removedCount} OpenWork Docker container(s).`);
    } catch (e) {
      setDockerCleanupResult(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setDockerCleanupBusy(false);
    }
  }

  async function checkForUpdates(optionsCheck?: { quiet?: boolean }) {
    if (!isTauriRuntime()) return;

    const forcedStatus = forcedDevUpdateStatus();
    if (forcedStatus) {
      setPendingUpdate(null);
      setUpdateStatus(forcedStatus);
      return;
    }

    const env = updateEnv();
    if (env && !env.supported) {
      if (!optionsCheck?.quiet) {
        setUpdateStatus({
          state: "error",
          lastCheckedAt:
            updateStatus().state === "idle"
              ? (updateStatus() as { state: "idle"; lastCheckedAt: number | null }).lastCheckedAt
              : null,
          message: env.reason ?? t("system.updates_not_supported"),
        });
      }
      return;
    }

    const prev = updateStatus();
    setUpdateStatus({ state: "checking", startedAt: Date.now() });

    try {
      const update = (await check({ timeout: 8_000 })) as unknown as UpdateHandle | null;
      const checkedAt = Date.now();

      if (!update) {
        setPendingUpdate(null);
        setUpdateStatus({ state: "idle", lastCheckedAt: checkedAt });
        return;
      }

      const notes = typeof update.body === "string" ? update.body : undefined;
      setPendingUpdate({ update, version: update.version, notes });
      setUpdateStatus({
        state: "available",
        lastCheckedAt: checkedAt,
        version: update.version,
        date: update.date,
        notes,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);

      if (optionsCheck?.quiet) {
        setUpdateStatus(prev);
        return;
      }

      setPendingUpdate(null);
      setUpdateStatus({ state: "error", lastCheckedAt: null, message });
    }
  }

  async function downloadUpdate() {
    const pending = pendingUpdate();
    if (!pending) return;

    const state = updateStatus();
    if (state.state === "downloading" || state.state === "ready") return;

    options.setError(null);
    const lastCheckedAt = state.state === "available" ? state.lastCheckedAt : Date.now();

    setUpdateStatus({
      state: "downloading",
      lastCheckedAt,
      version: pending.version,
      totalBytes: null,
      downloadedBytes: 0,
      notes: pending.notes,
    });
    
    let accumulatedBytes = 0;
    let totalBytes: number | null = null;

    const throttledUpdateProgress = throttle(() => {
      setUpdateStatus((current) => {
        if (current.state !== "downloading") return current;
        return {
          ...current,
          totalBytes,
          downloadedBytes: accumulatedBytes,
        };
      });
    }, 100);

    try {
      await pending.update.download((event: any) => {
        if (!event || typeof event !== "object") return;
        const record = event as Record<string, any>;

        if (record.event === "Started") {
          const newTotal =
            record.data && typeof record.data.contentLength === "number"
              ? record.data.contentLength
              : null;
          totalBytes = newTotal;
          throttledUpdateProgress();
        }

        if (record.event === "Progress") {
          const chunk =
            record.data && typeof record.data.chunkLength === "number"
              ? record.data.chunkLength
              : 0;
          accumulatedBytes += chunk;
          throttledUpdateProgress();
        }
      });

      setUpdateStatus({
        state: "ready",
        lastCheckedAt,
        version: pending.version,
        notes: pending.notes,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setUpdateStatus({ state: "error", lastCheckedAt, message });
    }
  }

  async function installUpdateAndRestart() {
    const pending = pendingUpdate();
    if (!pending) return;

    if (anyActiveRuns()) {
      options.setError(t("system.stop_runs_before_update"));
      return;
    }

    options.setError(null);
    try {
      await pending.update.install();
      await pending.update.close();
      await relaunch();
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setUpdateStatus({ state: "error", lastCheckedAt: null, message });
    }
  }

  return {
    reloadPending,
    reloadReasons,
    reloadLastTriggeredAt,
    reloadLastFinishedAt,
    setReloadLastFinishedAt,
    reloadTrigger,
    reloadBusy,
    reloadError,
    reloadCopy,
    canReloadEngine,
    markReloadRequired,
    clearReloadRequired,
    reloadEngineInstance,
    reloadWorkspaceEngine,
    cacheRepairBusy,
    cacheRepairResult,
    repairOpencodeCache,
    dockerCleanupBusy,
    dockerCleanupResult,
    cleanupOpenworkDockerContainers,
    updateAutoCheck,
    setUpdateAutoCheck,
    updateAutoDownload,
    setUpdateAutoDownload,
    updateStatus,
    setUpdateStatus,
    pendingUpdate,
    setPendingUpdate,
    updateEnv,
    setUpdateEnv,
    checkForUpdates,
    downloadUpdate,
    installUpdateAndRestart,
    resetModalOpen,
    setResetModalOpen,
    resetModalMode,
    setResetModalMode,
    resetModalText: resetModalTextValue,
    setResetModalText,
    resetModalBusy,
    openResetModal,
    confirmReset,
    anyActiveRuns,
  };
}
