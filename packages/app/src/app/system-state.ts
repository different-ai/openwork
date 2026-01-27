import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";

import type { Session } from "@opencode-ai/sdk/v2/client";
import type { ProviderListItem } from "./types";

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import type { Client, Mode, PluginScope, ReloadReason, ResetOpenworkMode, UpdateHandle } from "./types";
import { addOpencodeCacheHint, isTauriRuntime, safeStringify } from "./utils";
import { mapConfigProvidersToList } from "./utils/providers";
import { createUpdaterState } from "./context/updater";
import { resetOpenworkState, resetOpencodeCache } from "./lib/tauri";
import { unwrap, waitForHealthy } from "./lib/opencode";

export type NotionState = {
  status: Accessor<"disconnected" | "connecting" | "connected" | "error">;
  setStatus: (value: "disconnected" | "connecting" | "connected" | "error") => void;
  statusDetail: Accessor<string | null>;
  setStatusDetail: (value: string | null) => void;
  skillInstalled: Accessor<boolean>;
  setTryPromptVisible: (value: boolean) => void;
};

export function createSystemState(options: {
  client: Accessor<Client | null>;
  mode: Accessor<Mode | null>;
  sessions: Accessor<Session[]>;
  sessionStatusById: Accessor<Record<string, string>>;
  refreshPlugins: (scopeOverride?: PluginScope) => Promise<void>;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshMcpServers?: () => Promise<void>;
  reloadWorkspaceEngine?: () => Promise<boolean>;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setError: (value: string | null) => void;
  notion?: NotionState;
}) {
  const [reloadRequired, setReloadRequired] = createSignal(false);
  const [reloadReasons, setReloadReasons] = createSignal<ReloadReason[]>([]);
  const [reloadLastTriggeredAt, setReloadLastTriggeredAt] = createSignal<number | null>(null);
  const [reloadBusy, setReloadBusy] = createSignal(false);
  const [reloadError, setReloadError] = createSignal<string | null>(null);

  const [cacheRepairBusy, setCacheRepairBusy] = createSignal(false);
  const [cacheRepairResult, setCacheRepairResult] = createSignal<string | null>(null);

  const updater = createUpdaterState();
  const {
    updateAutoCheck,
    setUpdateAutoCheck,
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
    return options.sessions().some((s) => statuses[s.id] === "running" || statuses[s.id] === "retry");
  });

  function clearOpenworkLocalStorage() {
    if (typeof window === "undefined") return;

    try {
      const keys = Object.keys(window.localStorage);
      for (const key of keys) {
        if (key.startsWith("openwork.")) {
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
      options.setError("Stop active runs before resetting.");
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
      options.setError("Stop active runs before resetting.");
      return;
    }

    if (resetModalTextValue().trim().toUpperCase() !== "RESET") return;

    setResetModalBusy(true);
    options.setError(null);

    try {
      if (isTauriRuntime()) {
        await resetOpenworkState(resetModalMode());
      }

      clearOpenworkLocalStorage();

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

  function markReloadRequired(reason: ReloadReason) {
    setReloadRequired(true);
    setReloadLastTriggeredAt(Date.now());
    setReloadReasons((current) => (current.includes(reason) ? current : [...current, reason]));
  }

  function clearReloadRequired() {
    setReloadRequired(false);
    setReloadReasons([]);
    setReloadError(null);
  }

  const reloadCopy = createMemo(() => {
    const reasons = reloadReasons();
    if (!reasons.length) {
      return {
        title: "Reload required",
        body: "OpenWork detected changes that require reloading the OpenCode instance.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "plugins") {
      return {
        title: "Reload required",
        body: "OpenCode loads npm plugins at startup. Reload the engine to apply opencode.json changes.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "skills") {
      return {
        title: "Reload required",
        body: "OpenCode can cache skill discovery/state. Reload the engine to make newly installed skills available.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "config") {
      return {
        title: "Reload required",
        body: "OpenCode reads opencode.json at startup. Reload the engine to apply configuration changes.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "mcp") {
      return {
        title: "Reload required",
        body: "OpenCode loads MCP servers at startup. Reload the engine to activate the new connection.",
      };
    }

    return {
      title: "Reload required",
      body: "OpenWork detected OpenCode configuration changes. Reload the engine to apply them.",
    };
  });

  const canReloadEngine = createMemo(() => {
    if (!reloadRequired()) return false;
    if (!options.client()) return false;
    if (reloadBusy()) return false;
    if (options.mode() !== "host") return false;
    return true;
  });

  // Keep this mounted so the reload banner UX remains in the app.
  createEffect(() => {
    reloadRequired();
  });

  async function reloadEngineInstance() {
    const initialClient = options.client();
    if (!initialClient) return;

    if (options.mode() !== "host") {
      setReloadError("Reload is only available in Host mode.");
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
          setReloadError("Failed to reload the engine.");
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

      try {
        const providerList = unwrap(await nextClient.provider.list());
        options.setProviders(providerList.all);
        options.setProviderDefaults(providerList.default);
        options.setProviderConnectedIds(providerList.connected);
      } catch {
        try {
          const cfg = unwrap(await nextClient.config.providers());
          options.setProviders(mapConfigProvidersToList(cfg.providers));
          options.setProviderDefaults(cfg.default);
          options.setProviderConnectedIds([]);
        } catch {
          options.setProviders([]);
          options.setProviderDefaults({});
          options.setProviderConnectedIds([]);
        }
      }

      await options.refreshPlugins("project").catch(() => undefined);
      await options.refreshSkills({ force: true }).catch(() => undefined);
      await options.refreshMcpServers?.().catch(() => undefined);

      if (options.notion) {
        let nextStatus = options.notion.status();
        if (nextStatus === "connecting") {
          nextStatus = "connected";
          options.notion.setStatus(nextStatus);
        }

        if (nextStatus === "connected") {
          options.notion.setStatusDetail(options.notion.statusDetail() ?? "Workspace connected");
        }

        try {
          window.localStorage.setItem("openwork.notionStatus", nextStatus);
          if (nextStatus === "connected" && options.notion.statusDetail()) {
            window.localStorage.setItem("openwork.notionStatusDetail", options.notion.statusDetail() || "");
          }
        } catch {
          // ignore
        }
      }

      clearReloadRequired();
      if (options.notion && options.notion.status() === "connected" && options.notion.skillInstalled()) {
        options.notion.setTryPromptVisible(true);
      }
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setReloadBusy(false);
    }
  }

  async function reloadWorkspaceEngine() {
    await reloadEngineInstance();
  }

  async function repairOpencodeCache() {
    if (!isTauriRuntime()) {
      setCacheRepairResult("Cache repair requires the desktop app.");
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
        setCacheRepairResult("OpenCode cache repaired. Restart the engine if it was running.");
      } else {
        setCacheRepairResult("No OpenCode cache found. Nothing to repair.");
      }
    } catch (e) {
      setCacheRepairResult(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setCacheRepairBusy(false);
    }
  }

  async function checkForUpdates(optionsCheck?: { quiet?: boolean }) {
    if (!isTauriRuntime()) return;

    const env = updateEnv();
    if (env && !env.supported) {
      if (!optionsCheck?.quiet) {
        setUpdateStatus({
          state: "error",
          lastCheckedAt:
            updateStatus().state === "idle"
              ? (updateStatus() as { state: "idle"; lastCheckedAt: number | null }).lastCheckedAt
              : null,
          message: env.reason ?? "Updates are not supported in this environment.",
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

    options.setError(null);

    const state = updateStatus();
    const lastCheckedAt = state.state === "available" ? state.lastCheckedAt : Date.now();

    setUpdateStatus({
      state: "downloading",
      lastCheckedAt,
      version: pending.version,
      totalBytes: null,
      downloadedBytes: 0,
      notes: pending.notes,
    });

    try {
      await pending.update.download((event: any) => {
        if (!event || typeof event !== "object") return;
        const record = event as Record<string, any>;

        setUpdateStatus((current) => {
          if (current.state !== "downloading") return current;

          if (record.event === "Started") {
            const total =
              record.data && typeof record.data.contentLength === "number" ? record.data.contentLength : null;
            return { ...current, totalBytes: total };
          }

          if (record.event === "Progress") {
            const chunk = record.data && typeof record.data.chunkLength === "number" ? record.data.chunkLength : 0;
            return { ...current, downloadedBytes: current.downloadedBytes + chunk };
          }

          return current;
        });
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
      options.setError("Stop active runs before installing an update.");
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
    reloadRequired,
    reloadReasons,
    reloadLastTriggeredAt,
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
    updateAutoCheck,
    setUpdateAutoCheck,
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
