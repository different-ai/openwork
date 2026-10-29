/** @jsxImportSource react */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "../../../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../../components/ui/tooltip";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "../../../../components/ui/alert-dialog";
import { t } from "../../../../i18n";
import { useLocal } from "../../../kernel/local-provider";
import { useDesktopConfig } from "../../cloud/desktop-config-provider";
import { useEnterpriseActivationRequired } from "../../cloud/enterprise-activation-gate";
import { useBrandAppName } from "../../cloud/brand-theme";
import { notifyAlert } from "../../../shell/notifications";
import { useElectronUpdaterState } from "./electron-updater-state";
import { UpdateDownloadProgress } from "../pages/updates-view";
import { useDesktopFeature } from "../../session/status/use-desktop-feature";

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
  // This provider mounts above the enterprise activation gate. Before activation
  // no Den is known, and until the desktop config has resolved once (or failed
  // and fallen back to the last known one) the organization's allowed desktop
  // versions cannot be honoured, so no update check (and therefore no
  // download) may run yet.
  const allowedVersionsKnown = !useEnterpriseActivationRequired() && !desktopConfig.loading;
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
    allowedVersionsKnown,
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
  return <DesktopUpdaterContext.Provider value={updater}>{children}</DesktopUpdaterContext.Provider>;
}

export function DesktopUpdateButton() {
  const updater = useContext(DesktopUpdaterContext);
  const appName = useBrandAppName();
  const downloadWindow = useDesktopFeature("desktopUpdateDownloadWindow");
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const restartingRef = useRef(false);
  const attemptRef = useRef(0);
  const stepRef = useRef<"download" | "install" | null>(null);
  const status = updater?.updateStatus;
  const state = status?.state;

  const stopRestart = useCallback(() => {
    restartingRef.current = false;
    stepRef.current = null;
    setRestarting(false);
  }, []);

  // With desktopUpdateDownloadWindow on, a restart asked for before the update
  // is downloaded downloads it in a small window with its progress, then
  // installs. The install itself still fetches a newer build first when one
  // shipped after the staged download, and that download shows here too.
  useEffect(() => {
    if (!restarting || !updater) return;
    if (state === "available") {
      if (stepRef.current !== "download") {
        stepRef.current = "download";
        void updater.downloadUpdate();
      }
      return;
    }
    if (state === "ready") {
      if (stepRef.current === "install") return;
      stepRef.current = "install";
      const attempt = attemptRef.current;
      const current = () => restartingRef.current && attemptRef.current === attempt;
      void updater.installUpdateAndRestart(current).finally(() => {
        if (current()) stopRestart();
      });
      return;
    }
    if (state === "downloading" || state === "checking") return;
    // Failures already raise the updater's own notification.
    stopRestart();
  }, [restarting, state, stopRestart, updater]);

  const shown = state === "ready" || (downloadWindow && (state === "available" || state === "downloading"));
  if (!updater || !shown) return null;
  const downloading = state === "downloading";
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={
          <Button
            variant="ghost"
            size="sm"
            data-update-button
            onClick={() => setConfirmRestart(true)}
            className="mac:titlebar-no-drag h-7 gap-1.5 rounded-lg border border-foreground/[0.06] bg-foreground/[0.04] px-2.5 text-xs font-medium text-foreground/80 shadow-none transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <RotateCw className="size-3.5 opacity-70" strokeWidth={1.75} aria-hidden="true" />
            {t("settings.update_restart_button")}
          </Button>
        } />
        <TooltipContent side="bottom" align="end">
          {state === "ready" ? t("settings.update_on_quit_hint") : t("settings.update_downloading")}
        </TooltipContent>
      </Tooltip>
      <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialogContent className="max-w-[340px] gap-0 rounded-[15px] border border-border p-6 ring-0 sm:max-w-[340px]">
          <RotateCw className="mb-3 size-6 text-muted-foreground" aria-hidden="true" />
          <AlertDialogTitle className="mb-2 text-[19px] leading-tight tracking-tight">{t("settings.update_restart_now_title", undefined, { appName })}</AlertDialogTitle>
          <AlertDialogDescription className="text-xs leading-[1.75]">{t("settings.update_restart_now_message", undefined, { appName })}</AlertDialogDescription>
          <AlertDialogFooter className="mt-5">
            <AlertDialogCancel variant="ghost" size="sm" className="rounded-[7px] text-[11px] text-muted-foreground">{t("settings.update_keep_working")}</AlertDialogCancel>
            <AlertDialogAction size="sm" className="rounded-[7px] text-[11px]" onClick={() => {
              setConfirmRestart(false);
              if (!downloadWindow) {
                void updater.installUpdateAndRestart();
                return;
              }
              attemptRef.current += 1;
              stepRef.current = null;
              restartingRef.current = true;
              setRestarting(true);
            }}>{t("settings.update_restart_confirm_action")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={restarting} onOpenChange={(open) => { if (!open) stopRestart(); }}>
        <AlertDialogContent data-update-download-window className="max-w-[340px] gap-0 rounded-[15px] border border-border p-6 ring-0 sm:max-w-[340px]">
          <AlertDialogTitle className="mb-2 text-[15px] leading-tight tracking-tight">
            {downloading ? t("settings.update_download_window_title") : t("settings.update_download_window_preparing")}
          </AlertDialogTitle>
          <AlertDialogDescription className="mb-4 text-xs leading-[1.75]">{t("settings.update_download_window_message", undefined, { appName })}</AlertDialogDescription>
          <UpdateDownloadProgress
            downloadedBytes={downloading ? status?.downloadedBytes ?? 0 : null}
            totalBytes={status?.totalBytes ?? null}
          />
          <AlertDialogFooter className="mt-5">
            <AlertDialogCancel variant="ghost" size="sm" className="rounded-[7px] text-[11px] text-muted-foreground">{t("settings.update_keep_working")}</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
