/** @jsxImportSource react */
import { useEffect, useState } from "react";
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
  const updateErrorTitle = props.updateStatus?.failedAction === "install"
    ? t("settings.update_install_failed")
    : props.updateStatus?.failedAction === "download"
      ? t("settings.update_download_failed")
      : t("settings.update_check_failed");
  const checkingForNewer = updateState === "ready" && props.updateStatus?.checkingForNewer;
  const checkError = props.updateStatus?.checkError;
  const checkCooldown = updateState === "ready" && Boolean(props.updateStatus?.checkCooldownUntil);
  const candidate = updateState === "ready" ? props.updateStatus?.candidate : undefined;
  const releaseDate = candidate?.date ?? (updateState === "available" ? updateDate : null);
  const candidateSize = candidate?.totalBytes != null && candidate.totalBytes > 0
    ? formatBytes(candidate.totalBytes)
    : null;
  const installLabel = t("settings.update_install_button");
  const checking = updateState === "checking" || Boolean(checkingForNewer);
  const observedLatestVersion = checking || checkError || updateState === "error"
    ? null
    : candidate?.version ?? updateVersion;
  const [lastKnownVersion, setLastKnownVersion] = useState<{
    channel: ReleaseChannel | undefined;
    version: string;
  } | null>(null);

  useEffect(() => {
    if (observedLatestVersion) {
      setLastKnownVersion({ channel: props.releaseChannel, version: observedLatestVersion });
    }
  }, [observedLatestVersion, props.releaseChannel]);

  const latestVersion = observedLatestVersion ?? (
    lastKnownVersion?.channel === props.releaseChannel ? lastKnownVersion?.version : null
  );
  const updatesSupported = !props.webDeployment && props.updateEnv?.supported !== false;
  const canDownload = updateState === "available" || Boolean(candidate);
  const statusLabel = checking
    ? t("settings.update_checking")
    : updateState === "available"
      ? t("updates.available")
      : updateState === "blocked"
        ? t("settings.update_blocked_version", undefined, { version: updateVersion ?? "" })
        : updateState === "downloading"
          ? t("settings.update_downloading")
          : updateState === "ready"
            ? t(props.updateStatus?.newest ? "updates.ready_newest" : "settings.update_ready_version", undefined, { version: updateVersion ?? "" })
            : updateState === "error"
              ? updateErrorTitle
              : latestVersion ? t("settings.update_uptodate") : null;

  const updateRestartActiveRunsMessage =
    updateState === "ready" && props.anyActiveRuns
      ? t("settings.update_restart_active_tasks")
      : null;

  return (
    <LayoutStack>
      <LayoutSectionItem>
        <dl data-testid="updates-versions" className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-6 gap-y-3 text-sm">
          <dt className="font-medium">{t("updates.current_version")}</dt>
          <dd data-testid="updates-current-version" className="min-w-0 break-all text-right font-mono text-muted-foreground">
            {props.appVersion ? `v${props.appVersion}` : "—"}
          </dd>
          <dt className="font-medium">{t("updates.latest_version")}</dt>
          <dd data-testid="updates-latest-version" className="min-w-0 break-all text-right font-mono text-muted-foreground">
            {latestVersion ? `v${latestVersion}` : t("updates.not_checked")}
          </dd>
        </dl>

        <LayoutSectionItemHeader>
          <div data-testid="updates-status" role="status" className="min-h-9 min-w-0 pt-2 text-sm text-muted-foreground">
            {checkingForNewer
              ? t("settings.update_ready_version", undefined, { version: updateVersion ?? "" })
              : statusLabel}
            {checkingForNewer ? <p>{t("settings.update_checking")}</p> : null}
          </div>
          <LayoutSectionItemHeaderActions className="row-span-1">
            <div data-testid="updates-actions" className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => void props.checkForUpdates()}
                disabled={!updatesSupported || props.busy || checking || updateState === "downloading" || checkCooldown}
                aria-busy={checking}
                title={checkCooldown ? t("updates.check_cooldown") : undefined}
              >
                {t("settings.update_check_button")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void props.downloadUpdate()}
                disabled={!updatesSupported || props.busy || checking || !canDownload}
              >
                {t("settings.update_download_button")}
              </Button>
              <Button
                onClick={() => {
                  if (props.anyActiveRuns) {
                    setConfirmRestartOpen(true);
                    return;
                  }
                  void props.installUpdateAndRestart();
                }}
                disabled={!updatesSupported || props.busy || updateState !== "ready"}
              >
                {installLabel}
              </Button>
            </div>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>

        {(updateState === "idle" || updateState === "blocked") && updateLastCheckedAt ? (
          <LayoutSectionItemDescription>
            {t("settings.update_last_checked", undefined, { time: formatRelativeTime(updateLastCheckedAt) })}
          </LayoutSectionItemDescription>
        ) : null}

        {releaseDate || candidateSize ? (
          <LayoutSectionItemDescription className="flex flex-wrap gap-x-3">
            {releaseDate ? <span>{t("settings.update_published", undefined, { date: releaseDate })}</span> : null}
            {candidateSize ? <span>{candidateSize}</span> : null}
          </LayoutSectionItemDescription>
        ) : null}

        {updateState === "downloading" ? (
          <UpdateDownloadProgress downloadedBytes={updateDownloadedBytes} totalBytes={updateTotalBytes} />
        ) : null}

        {updateState === "ready" && checkError ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{checkError}</AlertDescription>
          </Alert>
        ) : null}

        {updateState === "error" && updateErrorMessage ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{updateErrorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {updateState === "blocked" && updateErrorMessage ? (
          <Alert>
            <Info />
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
          message={`${t("settings.update_ready_version", undefined, { version: updateVersion ?? "" })}. ${t("settings.update_restart_confirm_message")}`}
          confirmLabel={installLabel}
          cancelLabel={t("common.cancel")}
          onConfirm={() => {
            setConfirmRestartOpen(false);
            void props.installUpdateAndRestart();
          }}
          onCancel={() => setConfirmRestartOpen(false)}
        />
      </LayoutSectionItem>

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
