/** @jsxImportSource react */
import { useState } from "react";
import { CircleAlert, Info } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { Button } from "@/components/ui/button";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatBytes, formatRelativeTime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import type { ReleaseChannel } from "../../../../app/types";
import type { SettingsUpdateStatus } from "../state/electron-updater-state";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutStack,
} from "../settings-layout";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "../settings-section";

const RELEASE_CHANNEL_OPTIONS: { label: string; value: ReleaseChannel }[] = [
  { label: "Stable", value: "stable" },
  { label: "Alpha", value: "alpha" },
];

type UpdateDownloadProgressProps = {
  downloadedBytes: number | null;
  totalBytes: number | null;
};

function UpdateDownloadProgress(props: UpdateDownloadProgressProps) {
  const downloadedBytes = props.downloadedBytes ?? 0;
  const progressPercent =
    props.totalBytes != null && props.totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / props.totalBytes) * 100)) : 0;
  const progressLabel = (
    <>
      {formatBytes(downloadedBytes)}
      {props.totalBytes != null ? ` / ${formatBytes(props.totalBytes)}` : ""}
    </>
  );

  return (
    <Progress value={progressPercent} className="w-full">
      <ProgressLabel className="text-sm text-muted-foreground font-normal">{progressLabel}</ProgressLabel>
      <ProgressValue className="text-sm" />
    </Progress>
  );
}

export type UpdatesViewProps = {
  busy: boolean;
  webDeployment: boolean;
  appVersion: string | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  updateAutoCheck: boolean;
  toggleUpdateAutoCheck: () => void;
  updateAutoDownload: boolean;
  toggleUpdateAutoDownload: () => void;
  updateStatus: SettingsUpdateStatus;
  anyActiveRuns: boolean;
  checkForUpdates: () => void | Promise<void>;
  downloadUpdate: () => void | Promise<void>;
  installUpdateAndRestart: () => void | Promise<void>;
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
  const [confirmRestartOpen, setConfirmRestartOpen] = useState(false);
  const updateState = props.updateStatus?.state ?? "idle";
  const updateVersion = props.updateStatus?.version ?? null;
  const updateDate = props.updateStatus?.date ?? null;
  const updateLastCheckedAt = props.updateStatus?.lastCheckedAt ?? null;
  const updateDownloadedBytes = props.updateStatus?.downloadedBytes ?? null;
  const updateTotalBytes = props.updateStatus?.totalBytes ?? null;
  const updateErrorMessage = props.updateStatus?.message ?? null;
  const updateNotes = props.updateStatus?.notes ?? null;

  const updateRestartActiveRunsMessage =
    updateState === "ready" && props.anyActiveRuns
      ? t("settings.update_restart_active_tasks")
      : null;

  return (
    <LayoutStack>
      {props.appVersion ? (
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>Current version</LayoutSectionItemTitle>
            <LayoutSectionItemDescription className="font-mono">v{props.appVersion}</LayoutSectionItemDescription>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      ) : null}
      <LayoutSectionItem>
              <LayoutSectionItemHeader>
                <LayoutSectionItemTitle>
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
                </LayoutSectionItemTitle>
                <LayoutSectionItemDescription>
                  {updateState === "idle" && updateLastCheckedAt
                    ? t("settings.update_last_checked", undefined, {
                        time: formatRelativeTime(updateLastCheckedAt),
                      })
                    : updateState === "available" && updateDate
                      ? t("settings.update_published", undefined, { date: updateDate })
                      : null}
                </LayoutSectionItemDescription>
                <LayoutSectionItemHeaderActions>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() => void props.checkForUpdates()}
                      disabled={props.busy || updateState === "checking" || updateState === "downloading"}
                    >
                      {updateState === "checking" ? <Spinner className="size-4" /> : null}
                      {t("settings.update_check_button")}
                    </Button>

                    {updateState === "available" ? (
                      <Button
                        variant="secondary"
                        onClick={() => void props.downloadUpdate()}
                        disabled={props.busy}
                      >
                        {t("settings.update_download_button")}
                      </Button>
                    ) : null}

                    {updateState === "ready" ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          if (props.anyActiveRuns) {
                            setConfirmRestartOpen(true);
                            return;
                          }
                          void props.installUpdateAndRestart();
                        }}
                        disabled={props.busy}
                      >
                        {t("settings.update_install_button")}
                      </Button>
                    ) : null}
                  </div>
                </LayoutSectionItemHeaderActions>
              </LayoutSectionItemHeader>

              {updateState === "downloading" ? (
                <UpdateDownloadProgress downloadedBytes={updateDownloadedBytes} totalBytes={updateTotalBytes} />
              ) : null}

              {updateState === "error" && updateErrorMessage ? (
                <Alert variant="destructive">
                  <CircleAlert />
                  <AlertDescription>{updateErrorMessage}</AlertDescription>
                </Alert>
              ) : null}

              {updateRestartActiveRunsMessage ? (
                <Alert>
                  <Info />
                  <AlertDescription>{updateRestartActiveRunsMessage}</AlertDescription>
                </Alert>
              ) : null}

              <ConfirmModal
                open={confirmRestartOpen}
                title={t("settings.update_restart_confirm_title")}
                message={t("settings.update_restart_confirm_message")}
                confirmLabel={t("settings.update_install_button")}
                cancelLabel={t("common.cancel")}
                onConfirm={() => {
                  setConfirmRestartOpen(false);
                  void props.installUpdateAndRestart();
                }}
                onCancel={() => setConfirmRestartOpen(false)}
              />
            </LayoutSectionItem>

            {updateState === "available" && updateNotes ? (
              <LayoutSectionItem className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {updateNotes}
              </LayoutSectionItem>
            ) : null}

      {props.webDeployment ? (
        <Alert>
          <AlertDescription>{t("settings.updates_desktop_only")}</AlertDescription>
        </Alert>
      ) : props.updateEnv && props.updateEnv.supported === false ? (
        <Alert>
          <AlertDescription>{props.updateEnv.reason ?? t("settings.updates_not_supported")}</AlertDescription>
        </Alert>
      ) : (
        <>
        <Separator />
          {props.alphaChannelSupported && props.releaseChannel ? (
            <LayoutSectionItem>
              <LayoutSectionItemHeader>
                <LayoutSectionItemTitle>Release channel</LayoutSectionItemTitle>
                <LayoutSectionItemDescription>
                  Stable gets fully tested releases. Alpha includes the very latest changes but may be less polished (macOS only).
                </LayoutSectionItemDescription>
                <LayoutSectionItemHeaderActions>
                  <Select
                    value={props.releaseChannel}
                    items={RELEASE_CHANNEL_OPTIONS}
                    onValueChange={(value) => {
                      if (value === "stable" || value === "alpha") {
                        props.onReleaseChannelChange?.(value);
                      }
                    }}
                    disabled={!props.onReleaseChannelChange}
                  >
                    <SelectTrigger aria-label="Release channel" className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {RELEASE_CHANNEL_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </LayoutSectionItemHeaderActions>
              </LayoutSectionItemHeader>
            </LayoutSectionItem>
          ) : null}

            <LayoutSectionItem>
              <LayoutSectionItemHeader>
                <LayoutSectionItemTitle>{t("settings.background_checks_title")}</LayoutSectionItemTitle>
                <LayoutSectionItemDescription>{t("settings.background_checks_desc")}</LayoutSectionItemDescription>
                <LayoutSectionItemHeaderActions>
                  <Switch
                    aria-label={t("settings.background_checks_title")}
                    checked={props.updateAutoCheck}
                    onCheckedChange={props.toggleUpdateAutoCheck}
                  />
                </LayoutSectionItemHeaderActions>
              </LayoutSectionItemHeader>
            </LayoutSectionItem>

            <LayoutSectionItem>
              <LayoutSectionItemHeader>
                <LayoutSectionItemTitle>{t("settings.auto_update_title")}</LayoutSectionItemTitle>
                <LayoutSectionItemDescription>{t("settings.auto_update_desc")}</LayoutSectionItemDescription>
                <LayoutSectionItemHeaderActions>
                  <Switch
                    aria-label={t("settings.auto_update_title")}
                    checked={props.updateAutoDownload}
                    onCheckedChange={props.toggleUpdateAutoDownload}
                  />
                </LayoutSectionItemHeaderActions>
              </LayoutSectionItemHeader>
            </LayoutSectionItem>


          </>
      )}
    </LayoutStack>
  );
}
