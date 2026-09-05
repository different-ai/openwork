/** @jsxImportSource react */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, RotateCw, X } from "lucide-react";
import { Button } from "../../../../components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "../../../../components/ui/popover";
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

const UPDATE_ACCENT = "bg-[#eaf2ee] text-[#376d59] dark:bg-[#293e33] dark:text-[#91c7ad]";

export function DesktopUpdateCapsule() {
  const updater = useContext(DesktopUpdaterContext);
  const appName = useBrandAppName();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  if (updater?.updateStatus?.state !== "ready") return null;
  return (
    <>
      <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
        <PopoverTrigger render={
          <Button
            variant="ghost"
            size="xs"
            data-update-capsule
            className={`mac:titlebar-no-drag rounded-full border border-[#376d59]/15 px-2.5 text-[11px] font-medium hover:bg-[#e0ece5] hover:text-[#376d59] aria-expanded:text-[#376d59] dark:border-[#91c7ad]/15 dark:hover:bg-[#344b3e] dark:hover:text-[#91c7ad] dark:aria-expanded:text-[#91c7ad] ${UPDATE_ACCENT}`}
          />
        }>
          <ArrowUpRight className="size-3" aria-hidden="true" />
          {t("settings.update_ready_notice")}
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={10}
          className="relative w-[292px] max-w-[calc(100vw-24px)] gap-0 rounded-[14px] border border-border bg-background p-5 shadow-xl ring-0"
        >
          <Button variant="ghost" size="icon-xs" className="absolute right-3 top-3 text-muted-foreground" aria-label={t("settings.update_close_details")} onClick={() => setDetailsOpen(false)}>
            <X className="size-3.5" aria-hidden="true" />
          </Button>
          <div className={`mb-4 flex size-8 items-center justify-center rounded-[10px] ${UPDATE_ACCENT}`}>
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </div>
          <PopoverTitle className="mb-2 text-[20px] font-medium leading-tight tracking-[-0.65px]">{t("settings.update_ready_title")}</PopoverTitle>
          <PopoverDescription className="text-xs leading-[1.7]">{t("settings.update_install_on_quit")}</PopoverDescription>
          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" className="rounded-[7px] text-[11px]" onClick={() => {
              setDetailsOpen(false);
              setConfirmRestart(true);
            }}>{t("settings.update_restart_app", undefined, { appName })}</Button>
            <Button variant="ghost" size="sm" className="rounded-[7px] px-2 text-[11px] text-muted-foreground" onClick={() => setDetailsOpen(false)}>{t("settings.update_later")}</Button>
          </div>
          <div className="mt-4 flex items-center gap-1.5 border-t border-border pt-3 text-[11px] text-muted-foreground">
            <Check className="size-3 text-[#376d59] dark:text-[#91c7ad]" aria-hidden="true" />
            {t("settings.update_downloaded_notice")}
          </div>
        </PopoverContent>
      </Popover>
      <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialogContent className="max-w-[340px] gap-0 rounded-[15px] border border-border p-6 ring-0 sm:max-w-[340px]">
          <RotateCw className="mb-3 size-6 text-[#376d59] dark:text-[#91c7ad]" aria-hidden="true" />
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
