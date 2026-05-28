/** @jsxImportSource react */
import { useMutation } from "@tanstack/react-query";
import { Info } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { revealDesktopItemInDir } from "@/app/lib/desktop";
import { isDesktopRuntime, isMacPlatform, isWindowsPlatform } from "@/app/utils";
import { t } from "@/i18n";
import { SettingsInset, SettingsNotice } from "../settings-section";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutStack,
} from "../settings-layout";

export type RecoveryViewProps = {
  anyActiveRuns: boolean;
  workspaceConfigPath: string;
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
  const revealConfigMutation = useMutation({
    mutationFn: (path: string) => revealDesktopItemInDir(path),
  });

  return (
    <LayoutStack>
      {!isDesktopRuntime() && (
        <Alert>
          <Info />
          <AlertTitle>{t("settings.recovery_requires_desktop_title")}</AlertTitle>
          <AlertDescription>{t("settings.recovery_requires_desktop")}</AlertDescription>
        </Alert>
      )}
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("settings.workspace_config_title")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("settings.workspace_config_desc")}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Button
              variant="outline"
              size="sm"
              onClick={() => revealConfigMutation.mutate(props.workspaceConfigPath)}
              disabled={!isDesktopRuntime() || revealConfigMutation.isPending || !props.workspaceConfigPath}
            >
              {isWindowsPlatform()
                  ? t("workspace_list.reveal_explorer")
                  : isMacPlatform()
                    ? t("workspace_list.reveal_finder")
                    : t("workspace_list.reveal_file_manager")}
            </Button>
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void props.onResetAppConfigDefaults()}
                  // TODO: Restore the conditional disabled state once this action is wired into the React settings route.
                  // disabled={props.resetConfigBusy || props.anyActiveRuns}
                  disabled
                >
                  {props.resetConfigBusy ? t("settings.resetting") : t("settings.reset_config_defaults")}
                </Button>
              </TooltipTrigger>
              {props.anyActiveRuns && (
                <TooltipContent>{t("settings.stop_runs_before_reset_config")}</TooltipContent>
              )}
            </Tooltip>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>

        <SettingsInset className="break-all font-mono text-[11px] text-muted-foreground">
          {props.workspaceConfigPath || t("settings.no_active_workspace")}
        </SettingsInset>

        <Alert>
          <Info />
          <AlertDescription>{t("settings.recovery_reset_config_unavailable")}</AlertDescription>
        </Alert>
        {revealConfigMutation.isError || props.configActionStatus ? (
          <SettingsNotice tone={revealConfigMutation.isError ? "error" : "neutral"}>
            {revealConfigMutation.isError
              ? revealConfigMutation.error?.message || t("mcp.reveal_config_failed")
              : props.configActionStatus}
          </SettingsNotice>
        ) : null}
      </LayoutSectionItem>

      <Separator />

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("settings.opencode_cache")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("settings.opencode_cache_description")}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void props.onRepairOpencodeCache()}
              // TODO: Restore the conditional disabled state once this action is wired into the React settings route.
              // disabled={props.cacheRepairBusy || !isDesktopRuntime()}
              disabled
            >
              {props.cacheRepairBusy ? t("settings.repairing_cache") : t("settings.repair_cache")}
            </Button>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>

        <Alert>
          <Info />
          <AlertDescription>{t("settings.recovery_cache_repair_unavailable")}</AlertDescription>
        </Alert>
        {props.cacheRepairResult ? <SettingsNotice>{props.cacheRepairResult}</SettingsNotice> : null}
      </LayoutSectionItem>

      <Separator />

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("settings.docker_containers_title")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("settings.docker_containers_desc")}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void props.onCleanupOpenworkDockerContainers()}
                  // TODO: Restore the conditional disabled state once this action is wired into the React settings route.
                  // disabled={props.dockerCleanupBusy || props.anyActiveRuns || !isDesktopRuntime()}
                  disabled
                >
                  {props.dockerCleanupBusy
                    ? t("settings.removing_containers")
                    : t("settings.delete_containers")}
                </Button>
              </TooltipTrigger>
              {isDesktopRuntime() && props.anyActiveRuns && (
                <TooltipContent>{t("settings.stop_runs_before_cleanup")}</TooltipContent>
              )}
            </Tooltip>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>

        <Alert>
          <Info />
          <AlertDescription>{t("settings.recovery_docker_cleanup_unavailable")}</AlertDescription>
        </Alert>
        {props.dockerCleanupResult ? <SettingsNotice>{props.dockerCleanupResult}</SettingsNotice> : null}
      </LayoutSectionItem>
    </LayoutStack>
  );
}
