/** @jsxImportSource react */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "../../../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../../components/ui/tooltip";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "../../../../components/ui/alert-dialog";
import { t } from "../../../../i18n";
import { useLocal } from "../../../kernel/local-provider";
import { useDesktopConfig } from "../../cloud/desktop-config-provider";
import { useBrandAppName } from "../../cloud/brand-theme";
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
  return <DesktopUpdaterContext.Provider value={updater}>{children}</DesktopUpdaterContext.Provider>;
}

export function DesktopUpdateButton() {
  const updater = useContext(DesktopUpdaterContext);
  const appName = useBrandAppName();
  const [confirmRestart, setConfirmRestart] = useState(false);
  if (updater?.updateStatus?.state !== "ready") return null;
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
        <TooltipContent side="bottom" align="end">{t("settings.update_on_quit_hint")}</TooltipContent>
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
              void updater.installUpdateAndRestart();
            }}>{t("settings.update_restart_confirm_action")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
