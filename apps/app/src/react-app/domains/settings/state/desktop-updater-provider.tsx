/** @jsxImportSource react */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "../../../../components/ui/button";
import { t } from "../../../../i18n";
import { useLocal } from "../../../kernel/local-provider";
import { useDesktopConfig } from "../../cloud/desktop-config-provider";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { notifyAlert } from "../../../shell/notifications";
import { useElectronUpdaterState } from "./electron-updater-state";

function useUpdatePreference(key: string) {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(key) !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, enabled ? "1" : "0"); } catch { /* Keep the session preference. */ }
  }, [enabled, key]);
  return [enabled, setEnabled] as const;
}

function useUpdater() {
  const local = useLocal();
  const desktopConfig = useDesktopConfig();
  const [updateAutoCheck, setUpdateAutoCheck] = useUpdatePreference("openwork.react.settings.update-auto-check");
  // Older Settings wrote "0" even when the user never touched the old opt-in.
  // Start the automatic-download default once, then retain future opt-outs.
  const [updateAutoDownload, setUpdateAutoDownload] = useUpdatePreference("openwork.react.settings.update-auto-download.v2");
  const onReleaseChannelChange = useCallback((next: "stable" | "alpha") => {
    local.setPrefs((previous) => ({ ...previous, releaseChannel: next }));
  }, [local.setPrefs]);
  const setError = useCallback((message: string | null) => {
    if (message) notifyAlert({
      kind: "update", title: t("notifications.updater_error"), body: message, dedupeKey: "updater-error",
    });
  }, []);
  const updater = useElectronUpdaterState({
    releaseChannel: local.prefs.releaseChannel ?? "stable",
    onReleaseChannelChange,
    updateAutoCheck,
    updateAutoDownload,
    desktopConfig: desktopConfig.config,
    refreshDesktopConfig: desktopConfig.refreshFresh,
    setError,
  });
  return { ...updater, updateAutoCheck, setUpdateAutoCheck, updateAutoDownload, setUpdateAutoDownload };
}

const DesktopUpdaterContext = createContext<ReturnType<typeof useUpdater> | null>(null);

export function useDesktopUpdater() {
  const updater = useContext(DesktopUpdaterContext);
  if (!updater) throw new Error("DesktopUpdaterProvider is missing.");
  return updater;
}

export function DesktopUpdaterProvider({ children }: { children: ReactNode }) {
  const updater = useUpdater();
  const [confirmRestart, setConfirmRestart] = useState(false);
  return (
    <DesktopUpdaterContext.Provider value={updater}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">{children}</div>
        {updater.updateStatus?.state === "ready" ? (
          <aside aria-label={t("settings.update_ready_notice")} className="flex shrink-0 items-center justify-end gap-3 border-t border-border bg-background px-4 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium">{t("settings.update_ready_notice")}</p>
              <p className="text-xs text-muted-foreground">{t("settings.update_install_on_quit")}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setConfirmRestart(true)}>{t("settings.update_restart_now")}</Button>
          </aside>
        ) : null}
      </div>
      <ConfirmModal
        open={confirmRestart}
        title={t("settings.update_restart_now_title")}
        message={t("settings.update_restart_now_message")}
        confirmLabel={t("settings.update_install_button")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          setConfirmRestart(false);
          void updater.installUpdateAndRestart();
        }}
        onCancel={() => setConfirmRestart(false)}
      />
    </DesktopUpdaterContext.Provider>
  );
}
