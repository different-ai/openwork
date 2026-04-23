/** @jsxImportSource react */
import { FolderOpen } from "lucide-react";

import { isDesktopRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";

const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";

export type RecoveryViewProps = {
  anyActiveRuns: boolean;
  workspaceConfigPath: string;
  revealConfigBusy: boolean;
  onRevealWorkspaceConfig: () => void | Promise<void>;
  resetConfigBusy: boolean;
  onResetAppConfigDefaults: () => void | Promise<void>;
  configActionStatus: string | null;
  cacheRepairBusy: boolean;
  cacheRepairResult: string | null;
  onRepairOpencodeCache: () => void | Promise<void>;
  dockerCleanupBusy: boolean;
  dockerCleanupResult: string | null;
  onCleanupOpenworkDockerContainers: () => void | Promise<void>;
};

export function RecoveryView(props: RecoveryViewProps) {
  return (
    <div className="space-y-6">
      <div className={`${settingsPanelClass} space-y-3`}>
        <div className="text-sm font-medium text-gray-12">{t("settings.workspace_config_title")}</div>
        <div className="text-xs text-gray-10">{t("settings.workspace_config_desc")}</div>
        <div className="break-all font-mono text-[11px] text-gray-7">
          {props.workspaceConfigPath || t("settings.no_active_workspace")}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="h-8 px-3 py-0 text-xs"
            onClick={() => void props.onRevealWorkspaceConfig()}
            disabled={!isDesktopRuntime() || props.revealConfigBusy || !props.workspaceConfigPath}
            title={!isDesktopRuntime() ? t("settings.reveal_config_requires_desktop") : ""}
          >
            <FolderOpen size={13} className="mr-1.5" />
            {props.revealConfigBusy ? t("settings.opening") : t("settings.reveal_config")}
          </Button>
          <Button
            variant="danger"
            className="h-8 px-3 py-0 text-xs"
            onClick={() => void props.onResetAppConfigDefaults()}
            disabled={props.resetConfigBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? t("settings.stop_runs_before_reset_config") : ""}
          >
            {props.resetConfigBusy ? t("settings.resetting") : t("settings.reset_config_defaults")}
          </Button>
        </div>
        {props.configActionStatus ? (
          <div className="text-xs text-gray-10">{props.configActionStatus}</div>
        ) : null}
      </div>

      <div className="flex flex-col gap-4 rounded-2xl border border-gray-6/50 bg-gray-2/30 p-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="text-sm text-gray-12">{t("settings.opencode_cache")}</div>
          <div className="text-xs text-gray-7">{t("settings.opencode_cache_description")}</div>
          {props.cacheRepairResult ? (
            <div className="mt-2 text-xs text-gray-11">{props.cacheRepairResult}</div>
          ) : null}
        </div>
        <Button
          variant="secondary"
          className="h-8 shrink-0 px-3 py-0 text-xs"
          onClick={() => void props.onRepairOpencodeCache()}
          disabled={props.cacheRepairBusy || !isDesktopRuntime()}
          title={isDesktopRuntime() ? "" : t("settings.cache_repair_requires_desktop")}
        >
          {props.cacheRepairBusy ? t("settings.repairing_cache") : t("settings.repair_cache")}
        </Button>
      </div>

      <div className="flex flex-col gap-4 rounded-2xl border border-gray-6/50 bg-gray-2/30 p-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="text-sm text-gray-12">{t("settings.docker_containers_title")}</div>
          <div className="text-xs text-gray-7">{t("settings.docker_containers_desc")}</div>
          {props.dockerCleanupResult ? (
            <div className="mt-2 text-xs text-gray-11">{props.dockerCleanupResult}</div>
          ) : null}
        </div>
        <Button
          variant="danger"
          className="h-8 shrink-0 px-3 py-0 text-xs"
          onClick={() => void props.onCleanupOpenworkDockerContainers()}
          disabled={props.dockerCleanupBusy || props.anyActiveRuns || !isDesktopRuntime()}
          title={
            !isDesktopRuntime()
              ? t("settings.docker_requires_desktop")
              : props.anyActiveRuns
                ? t("settings.stop_runs_before_cleanup")
                : ""
          }
        >
          {props.dockerCleanupBusy
            ? t("settings.removing_containers")
            : t("settings.delete_containers")}
        </Button>
      </div>
    </div>
  );
}
