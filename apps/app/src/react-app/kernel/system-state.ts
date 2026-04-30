import { useCallback, useMemo, useState } from "react";

import type {
  ReloadReason,
  ReloadTrigger,
  ResetOpenworkMode,
} from "../../app/types";
import { relaunchDesktopApp, resetOpenworkState } from "../../app/lib/desktop";
import {
  addOpencodeCacheHint,
  isDesktopRuntime,
  safeStringify,
} from "../../app/utils";
import { t } from "../../i18n";

export type ReloadState = {
  reloadPending: boolean;
  reloadReasons: ReloadReason[];
  reloadLastTriggeredAt: number | null;
  reloadTrigger: ReloadTrigger | null;
  reloadBusy: boolean;
  reloadError: string | null;
};

export type ResetState = {
  resetModalOpen: boolean;
  resetModalMode: ResetOpenworkMode;
  resetModalText: string;
  resetModalBusy: boolean;
};

export type SystemStateControls = {
  reload: ReloadState;
  reloadCopy: { title: string; body: string };
  markReloadRequired: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  clearReloadRequired: () => void;
  reloadWorkspaceEngine: () => Promise<void>;
  canReloadWorkspaceEngine: boolean;
  reset: ResetState;
  openResetModal: (mode: ResetOpenworkMode) => void;
  closeResetModal: () => void;
  setResetModalText: (value: string) => void;
  confirmReset: () => Promise<void>;
  setError: (message: string | null) => void;
};

function clearOpenworkLocalStorage(mode: ResetOpenworkMode) {
  if (typeof window === "undefined") return;
  try {
    if (mode === "all") {
      window.localStorage.clear();
      return;
    }
    const keys = Object.keys(window.localStorage);
    for (const key of keys) {
      if (key.includes("openwork")) window.localStorage.removeItem(key);
    }
    window.localStorage.removeItem("openwork_mode_pref");
  } catch {
    // ignore
  }
}

type UseSystemStateOptions = {
  hasActiveRuns: () => boolean;
  reloadWorkspaceEngine?: () => Promise<boolean>;
  canReloadWorkspaceEngine?: () => boolean;
  onReloadComplete?: () => void | Promise<void>;
  setError: (message: string | null) => void;
};

export function useSystemState(
  options: UseSystemStateOptions,
): SystemStateControls {
  const [reloadPending, setReloadPending] = useState(false);
  const [reloadReasons, setReloadReasons] = useState<ReloadReason[]>([]);
  const [reloadLastTriggeredAt, setReloadLastTriggeredAt] = useState<
    number | null
  >(null);
  const [reloadTrigger, setReloadTrigger] = useState<ReloadTrigger | null>(null);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetModalMode, setResetModalMode] =
    useState<ResetOpenworkMode>("onboarding");
  const [resetModalText, setResetModalText] = useState("");
  const [resetModalBusy, setResetModalBusy] = useState(false);

  const markReloadRequired = useCallback(
    (reason: ReloadReason, trigger?: ReloadTrigger) => {
      setReloadPending(true);
      setReloadLastTriggeredAt(Date.now());
      setReloadReasons((current) =>
        current.includes(reason) ? current : [...current, reason],
      );
      setReloadTrigger(
        trigger ??
          ({
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
          } as ReloadTrigger),
      );
    },
    [],
  );

  const clearReloadRequired = useCallback(() => {
    setReloadPending(false);
    setReloadReasons([]);
    setReloadTrigger(null);
    setReloadError(null);
  }, []);

  const reloadCopy = useMemo(() => {
    const title = t("system.reload_required");
    const bodyKey =
      reloadReasons.length === 1 && reloadReasons[0] === "plugins"
        ? "system.reload_body_plugins"
        : reloadReasons.length === 1 && reloadReasons[0] === "skills"
          ? "system.reload_body_skills"
          : reloadReasons.length === 1 && reloadReasons[0] === "agents"
            ? "system.reload_body_agents"
            : reloadReasons.length === 1 && reloadReasons[0] === "commands"
              ? "system.reload_body_commands"
              : reloadReasons.length === 1 && reloadReasons[0] === "config"
                ? "system.reload_body_config"
                : reloadReasons.length === 1 && reloadReasons[0] === "mcp"
                  ? "system.reload_body_mcp"
                  : reloadReasons.length > 0
                    ? "system.reload_body_mixed"
                    : "system.reload_body_default";
    return { title, body: t(bodyKey) };
  }, [reloadReasons]);

  const canReloadWorkspaceEngine =
    !reloadBusy && options.canReloadWorkspaceEngine?.() !== false;

  const reloadWorkspaceEngine = useCallback(async () => {
    if (reloadBusy) return;
    if (options.canReloadWorkspaceEngine?.() === false) {
      setReloadError(t("system.reload_unavailable"));
      return;
    }
    setReloadBusy(true);
    setReloadError(null);
    options.setError(null);
    try {
      const ok = options.reloadWorkspaceEngine
        ? await options.reloadWorkspaceEngine()
        : false;
      if (ok === false) {
        setReloadError(t("system.reload_failed"));
        return;
      }
      await options.onReloadComplete?.();
      clearReloadRequired();
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      setReloadError(message || t("system.reload_failed"));
    } finally {
      setReloadBusy(false);
    }
  }, [clearReloadRequired, options, reloadBusy]);

  const openResetModal = useCallback(
    (mode: ResetOpenworkMode) => {
      if (options.hasActiveRuns()) {
        options.setError(t("system.stop_active_runs_before_reset"));
        return;
      }
      options.setError(null);
      setResetModalMode(mode);
      setResetModalText("");
      setResetModalOpen(true);
    },
    [options],
  );

  const closeResetModal = useCallback(() => {
    if (resetModalBusy) return;
    setResetModalOpen(false);
  }, [resetModalBusy]);

  const confirmReset = useCallback(async () => {
    if (resetModalBusy) return;
    if (options.hasActiveRuns()) {
      options.setError(t("system.stop_active_runs_before_reset"));
      return;
    }
    if (resetModalText.trim().toUpperCase() !== "RESET") return;

    setResetModalBusy(true);
    options.setError(null);

    try {
      if (isDesktopRuntime()) {
        await resetOpenworkState(resetModalMode);
      }
      clearOpenworkLocalStorage(resetModalMode);
      if (isDesktopRuntime()) {
        await relaunchDesktopApp();
      } else {
        window.location.reload();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : safeStringify(error);
      options.setError(addOpencodeCacheHint(message));
      setResetModalBusy(false);
    }
  }, [options, resetModalBusy, resetModalMode, resetModalText]);

  return useMemo<SystemStateControls>(
    () => ({
      reload: {
        reloadPending,
        reloadReasons,
        reloadLastTriggeredAt,
        reloadTrigger,
        reloadBusy,
        reloadError,
      },
      reloadCopy,
      markReloadRequired,
      clearReloadRequired,
      reloadWorkspaceEngine,
      canReloadWorkspaceEngine,
      reset: {
        resetModalOpen,
        resetModalMode,
        resetModalText,
        resetModalBusy,
      },
      openResetModal,
      closeResetModal,
      setResetModalText,
      confirmReset,
      setError: options.setError,
    }),
    [
      clearReloadRequired,
      closeResetModal,
      confirmReset,
      markReloadRequired,
      openResetModal,
      options.setError,
      reloadCopy,
      reloadBusy,
      reloadWorkspaceEngine,
      canReloadWorkspaceEngine,
      reloadError,
      reloadLastTriggeredAt,
      reloadPending,
      reloadReasons,
      reloadTrigger,
      resetModalBusy,
      resetModalMode,
      resetModalOpen,
      resetModalText,
    ],
  );
}
