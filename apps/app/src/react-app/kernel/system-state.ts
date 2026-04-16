import { useCallback, useMemo, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";

import type {
  ReloadReason,
  ReloadTrigger,
  ResetOpenworkMode,
} from "../../app/types";
import { resetOpenworkState } from "../../app/lib/tauri";
import {
  addOpencodeCacheHint,
  isTauriRuntime,
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
  markReloadRequired: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  clearReloadRequired: () => void;
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
  const [reloadBusy] = useState(false);
  const [reloadError] = useState<string | null>(null);

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
  }, []);

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
      if (isTauriRuntime()) {
        await resetOpenworkState(resetModalMode);
      }
      clearOpenworkLocalStorage(resetModalMode);
      if (isTauriRuntime()) {
        await relaunch();
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
      markReloadRequired,
      clearReloadRequired,
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
      reloadBusy,
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
