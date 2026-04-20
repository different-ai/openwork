/** @jsxImportSource react */
import { formatBytes, formatRelativeTime, isTauriRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import type { ReleaseChannel } from "../../../../app/types";
import { Button } from "../../../design-system/button";

const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";

export type UpdatesViewProps = {
  busy: boolean;
  webDeployment: boolean;
  appVersion: string | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  updateAutoCheck: boolean;
  toggleUpdateAutoCheck: () => void;
  updateAutoDownload: boolean;
  toggleUpdateAutoDownload: () => void;
  updateStatus: {
    state: string;
    lastCheckedAt?: number | null;
    version?: string;
    date?: string;
    notes?: string;
    totalBytes?: number | null;
    downloadedBytes?: number;
    message?: string;
  } | null;
  anyActiveRuns: boolean;
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  installUpdateAndRestart: () => void;
  /** Currently selected release channel. Optional; callers may omit. */
  releaseChannel?: ReleaseChannel;
  /**
   * Change the release channel. When not provided, the channel row is
   * rendered read-only — useful for contexts where the pref can't be
   * mutated (e.g. web preview).
   */
  onReleaseChannelChange?: (next: ReleaseChannel) => void;
  /**
   * Whether the alpha channel is available on this platform. Alpha is
   * macOS-only today; other platforms should receive `false` so the
   * toggle is hidden.
   */
  alphaChannelSupported?: boolean;
};

export function UpdatesView(props: UpdatesViewProps) {
  const updateState = props.updateStatus?.state ?? "idle";
  const updateVersion = props.updateStatus?.version ?? null;
  const updateDate = props.updateStatus?.date ?? null;
  const updateLastCheckedAt = props.updateStatus?.lastCheckedAt ?? null;
  const updateDownloadedBytes = props.updateStatus?.downloadedBytes ?? null;
  const updateTotalBytes = props.updateStatus?.totalBytes ?? null;
  const updateErrorMessage = props.updateStatus?.message ?? null;
  const updateNotes = props.updateStatus?.notes ?? null;

  const updateRestartBlockedMessage =
    updateState === "ready" && props.anyActiveRuns
      ? t("settings.restart_blocked_message")
      : null;

  return (
    <div className="space-y-6">
      <div className={`${settingsPanelClass} space-y-3`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-gray-12">{t("settings.updates_title")}</div>
            <div className="text-xs text-gray-10">{t("settings.updates_desc")}</div>
          </div>
          <div className="font-mono text-xs text-gray-7">{props.appVersion ? `v${props.appVersion}` : ""}</div>
        </div>

        {props.webDeployment ? (
          <div className="rounded-xl border border-gray-6 bg-gray-1/20 p-3 text-sm text-gray-11">
            {t("settings.updates_desktop_only")}
          </div>
        ) : props.updateEnv && props.updateEnv.supported === false ? (
          <div className="rounded-xl border border-gray-6 bg-gray-1/20 p-3 text-sm text-gray-11">
            {props.updateEnv.reason ?? t("settings.updates_not_supported")}
          </div>
        ) : (
          <>
            {props.alphaChannelSupported && props.releaseChannel ? (
              <div className="flex items-center justify-between rounded-xl border border-gray-6 bg-gray-1 p-3">
                <div className="space-y-0.5">
                  <div className="text-sm text-gray-12">Release channel</div>
                  <div className="text-xs text-gray-7">
                    Stable is the default. Alpha auto-updates from every merge to{" "}
                    <code className="rounded bg-gray-2 px-1 py-0.5 text-[11px]">dev</code>{" "}
                    (macOS only).
                  </div>
                </div>
                <div className="flex items-center gap-1 rounded-full border border-gray-6/60 bg-gray-1/70 p-0.5 text-xs">
                  {(["stable", "alpha"] as const).map((value) => {
                    const active = props.releaseChannel === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        className={`rounded-full px-3 py-1 font-medium transition-colors ${
                          active
                            ? "bg-gray-12/12 text-gray-12 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]"
                            : "text-gray-10 hover:bg-gray-2/70 hover:text-gray-12"
                        } ${!props.onReleaseChannelChange ? "cursor-default opacity-70" : ""}`}
                        onClick={() => props.onReleaseChannelChange?.(value)}
                        disabled={!props.onReleaseChannelChange}
                      >
                        {value === "stable" ? "Stable" : "Alpha"}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="flex items-center justify-between rounded-xl border border-gray-6 bg-gray-1 p-3">
              <div className="space-y-0.5">
                <div className="text-sm text-gray-12">{t("settings.background_checks_title")}</div>
                <div className="text-xs text-gray-7">{t("settings.background_checks_desc")}</div>
              </div>
              <button
                type="button"
                className={`min-w-[70px] rounded-full border px-4 py-1.5 text-xs font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] transition-colors ${
                  props.updateAutoCheck
                    ? "border-gray-6/30 bg-gray-12/12 text-gray-12"
                    : "border-gray-6/60 bg-gray-1/70 text-gray-10 hover:bg-gray-2/70 hover:text-gray-12"
                }`}
                onClick={props.toggleUpdateAutoCheck}
              >
                {props.updateAutoCheck ? t("settings.on") : t("settings.off")}
              </button>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-gray-6 bg-gray-1 p-3">
              <div className="space-y-0.5">
                <div className="text-sm text-gray-12">{t("settings.auto_update_title")}</div>
                <div className="text-xs text-gray-7">{t("settings.auto_update_desc")}</div>
              </div>
              <button
                type="button"
                className={`min-w-[70px] rounded-full border px-4 py-1.5 text-xs font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] transition-colors ${
                  props.updateAutoDownload
                    ? "border-gray-6/30 bg-gray-12/12 text-gray-12"
                    : "border-gray-6/60 bg-gray-1/70 text-gray-10 hover:bg-gray-2/70 hover:text-gray-12"
                }`}
                onClick={props.toggleUpdateAutoDownload}
              >
                {props.updateAutoDownload ? t("settings.on") : t("settings.off")}
              </button>
            </div>

            <div className="space-y-3 rounded-xl border border-gray-6 bg-gray-1 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="text-sm text-gray-12">
                    {updateState === "checking"
                      ? t("settings.update_checking")
                      : updateState === "available"
                        ? t("settings.update_available_version", undefined, { version: updateVersion ?? "" })
                        : updateState === "downloading"
                          ? t("settings.update_downloading")
                          : updateState === "ready"
                            ? t("settings.update_ready_version", undefined, { version: updateVersion ?? "" })
                            : updateState === "error"
                              ? t("settings.update_check_failed")
                              : t("settings.update_uptodate")}
                  </div>

                  {updateState === "idle" && updateLastCheckedAt ? (
                    <div className="text-xs text-gray-7">
                      {t("settings.update_last_checked", undefined, {
                        time: formatRelativeTime(updateLastCheckedAt),
                      })}
                    </div>
                  ) : null}

                  {updateState === "available" && updateDate ? (
                    <div className="text-xs text-gray-7">
                      {t("settings.update_published", undefined, { date: updateDate })}
                    </div>
                  ) : null}

                  {updateState === "downloading" ? (
                    <div className="text-xs text-gray-7">
                      {formatBytes(updateDownloadedBytes ?? 0)}
                      {updateTotalBytes != null ? ` / ${formatBytes(updateTotalBytes)}` : ""}
                    </div>
                  ) : null}

                  {updateState === "error" && updateErrorMessage ? (
                    <div className="text-xs text-red-11">{updateErrorMessage}</div>
                  ) : null}
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    className="h-9 rounded-full border-gray-6/60 bg-gray-1/70 px-4 py-0 text-xs hover:bg-gray-2/70"
                    onClick={props.checkForUpdates}
                    disabled={props.busy || updateState === "checking" || updateState === "downloading"}
                  >
                    {t("settings.update_check_button")}
                  </Button>

                  {updateState === "available" ? (
                    <Button
                      variant="secondary"
                      className="h-9 rounded-full px-4 py-0 text-xs"
                      onClick={props.downloadUpdate}
                      disabled={props.busy}
                    >
                      {t("settings.update_download_button")}
                    </Button>
                  ) : null}

                  {updateState === "ready" ? (
                    <Button
                      variant="secondary"
                      className="h-9 rounded-full px-4 py-0 text-xs"
                      onClick={props.installUpdateAndRestart}
                      disabled={props.busy || props.anyActiveRuns}
                      title={updateRestartBlockedMessage ?? ""}
                    >
                      {t("settings.update_install_button")}
                    </Button>
                  ) : null}
                </div>
              </div>

              {updateRestartBlockedMessage ? (
                <div className="rounded-xl border border-amber-7/25 bg-amber-3/10 px-3 py-2 text-xs leading-relaxed text-amber-11">
                  {updateRestartBlockedMessage}
                </div>
              ) : null}
            </div>

            {updateState === "available" && updateNotes ? (
              <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl border border-gray-6 bg-gray-1/20 p-3 text-xs text-gray-11">
                {updateNotes}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
