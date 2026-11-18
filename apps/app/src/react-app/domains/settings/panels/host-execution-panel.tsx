/** @jsxImportSource react */
import { useId } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { t } from "@/i18n";
import type { OpenworkSandboxSettingsResponse } from "../../../../app/lib/openwork-server";
import { SettingsNotice } from "../settings-section";
import { LayoutSectionItem, LayoutSectionItemDescription, LayoutSectionItemHeader, LayoutSectionItemTitle, LayoutSectionItemFootnote } from "../settings-layout";
import { canPrepareSandbox, canRetrySandbox, hostExecutionRow, sandboxRuntimeStatus } from "./host-execution-panel-state";
import { useSandboxSettingsActions, type SandboxSettingsOptions } from "./use-sandbox-settings";
import { useSandboxSettings } from "@/react-app/infra/use-sandbox-settings";

export type HostExecutionPanelProps = SandboxSettingsOptions & { onUpdated: () => void };

export type SandboxExecutionSectionProps = {
  settings: OpenworkSandboxSettingsResponse | null;
  loading: boolean;
  unavailable: boolean;
  error: boolean;
  saving: boolean;
  saveError: boolean;
  preparing: boolean;
  prepareError: boolean;
  onSelect: (allowHostExecution: boolean) => void;
  onRetry: () => void;
  onReload: () => void;
};

export function SandboxExecutionSection(props: SandboxExecutionSectionProps) {
  const id = useId();
  const row = hostExecutionRow(props.settings, true);
  const runtime = sandboxRuntimeStatus(props.settings);
  const preparationFailed = props.prepareError && !props.preparing && !row.hostToolsAllowed && !props.settings?.pending && (runtime === "idle" || runtime === null);
  const noteKey = row.note === "pending_host" ? "context_panel.host_execution_pending_host"
    : row.note === "pending_sandbox" ? "context_panel.host_execution_pending_sandbox"
    : row.note === "managed" ? "context_panel.host_execution_managed" : null;
  const disabled = !props.settings || props.loading || props.unavailable || props.error || row.lockedByOrganization || props.saving;
  const runtimeDetails = props.settings?.runtime;
  const preparing = runtime === "starting" || runtime === "idle" || props.preparing;
  const stageLabel = runtimeDetails?.stage === "preparing_files" ? t("context_panel.sandbox_stage_files")
    : runtimeDetails?.stage === "starting" ? t("context_panel.sandbox_stage_starting") : t("context_panel.sandbox_preparing");
  const progress = runtimeDetails?.progress;
  const measuredProgress = progress && Number.isFinite(progress.completed) && Number.isFinite(progress.total)
    && progress.total > 0 && progress.completed >= 0 && progress.completed <= progress.total ? progress : null;
  const runtimeKey = runtime === "ready" ? "context_panel.sandbox_ready"
    : runtime === "failed" ? "context_panel.sandbox_failed"
    : runtime === "unsupported" ? "context_panel.host_execution_sandbox_unavailable"
    : runtime === "starting" || runtime === "idle" || props.preparing ? "context_panel.sandbox_preparing" : null;
  return (
    <div data-testid="host-execution-row" data-host-execution={row.hostToolsAllowed ? "allow" : "deny"} data-host-execution-managed={row.lockedByOrganization ? "true" : "false"}>
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle><span id={`${id}-title`}>{t("context_panel.host_execution")}</span></LayoutSectionItemTitle>
          <LayoutSectionItemDescription><span id={`${id}-description`}>{t("context_panel.host_execution_desc")}</span></LayoutSectionItemDescription>
        </LayoutSectionItemHeader>
        {props.loading ? (
          <div data-testid="sandbox-settings-loading" className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-5 w-40" /><Skeleton className="h-5 w-48" />
          </div>
        ) : (
          <RadioGroup className="gap-0" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} value={props.settings ? row.desiredHostToolsAllowed ? "computer" : "sandbox" : undefined} disabled={disabled} onValueChange={(value) => props.onSelect(value === "computer")}>
            <div className="flex min-h-10 items-center gap-2">
              <RadioGroupItem id={`${id}-computer`} value="computer" aria-label={t("context_panel.execution_computer")} data-testid="sandbox-location-computer" />
              <Label htmlFor={`${id}-computer`}>{t("context_panel.execution_computer")}</Label>
            </div>
            <div className="flex min-h-10 items-center gap-2">
              <RadioGroupItem id={`${id}-sandbox`} value="sandbox" aria-label={t("context_panel.execution_sandbox")} disabled={!props.settings?.featureEnabled} data-testid="sandbox-location-sandbox" />
              <Label htmlFor={`${id}-sandbox`}>{t("context_panel.execution_sandbox")}</Label>
            </div>
          </RadioGroup>
        )}
        {noteKey ? <LayoutSectionItemFootnote className="flex items-center gap-1.5">
          {row.lockedByOrganization ? <Lock className="size-4 shrink-0" aria-hidden="true" /> : null}
          <span role="status" data-testid="host-execution-note" data-host-execution-note={row.note}>{t(noteKey)}</span>
        </LayoutSectionItemFootnote> : null}
        {row.lockedByOrganization && props.settings?.pending ? <LayoutSectionItemFootnote className="flex items-center gap-1.5"><Lock className="size-4" aria-hidden="true" />{t("context_panel.host_execution_managed")}</LayoutSectionItemFootnote> : null}
        {props.settings?.deviceRestricted ? <LayoutSectionItemFootnote><span data-testid="sandbox-device-restriction">{t("context_panel.sandbox_device_restricted")}</span></LayoutSectionItemFootnote> : null}
        {props.unavailable ? <SettingsNotice>{t("context_panel.sandbox_settings_unavailable")}</SettingsNotice> : null}
        {props.error ? <SettingsNotice tone="error"><span>{t("context_panel.sandbox_settings_error")}</span><Button variant="outline" size="sm" onClick={props.onReload}>{t("context_panel.sandbox_retry")}</Button></SettingsNotice> : null}
        {runtimeKey && !props.settings?.pending && !preparationFailed ? <div className="flex flex-col gap-2" data-testid="sandbox-runtime-status" data-sandbox-state={runtime}>
          <div className="flex min-h-10 items-center justify-between gap-3">
            <span role="status" className={runtime === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
              {(runtime === "unsupported" || runtime === "failed") && runtimeDetails?.message ? runtimeDetails.message : t(runtimeKey)}
            </span>
            {canRetrySandbox(props.settings) ? <Button variant="outline" size="sm" onClick={props.onRetry} disabled={props.preparing} data-testid="sandbox-retry">{t("context_panel.sandbox_retry")}</Button> : null}
          </div>
          {preparing && runtime !== "failed" && runtime !== "unsupported" && runtime !== "ready" ? <Progress
            value={measuredProgress?.completed ?? null}
            max={measuredProgress?.total}
            aria-label={t("context_panel.sandbox_preparing")}
            getAriaValueText={() => measuredProgress ? `${measuredProgress.completed} / ${measuredProgress.total}` : stageLabel}
            data-testid="sandbox-preparation-progress"
          >
            {runtimeDetails?.stage === "preparing_files" || runtimeDetails?.stage === "starting" ? <ProgressLabel>{stageLabel}</ProgressLabel> : null}
            {measuredProgress ? <span className="ms-auto text-sm text-muted-foreground tabular-nums" data-testid="sandbox-preparation-count">{measuredProgress.completed} / {measuredProgress.total}</span> : null}
          </Progress> : null}
        </div> : null}
        {props.saveError ? <SettingsNotice tone="error">{t("context_panel.sandbox_save_error")}</SettingsNotice> : null}
        {preparationFailed ? <SettingsNotice tone="error"><span>{t("context_panel.sandbox_failed")}</span>{canRetrySandbox(props.settings) || canPrepareSandbox(props.settings) ? <Button variant="outline" size="sm" onClick={props.onRetry}>{t("context_panel.sandbox_retry")}</Button> : null}</SettingsNotice> : null}
      </LayoutSectionItem>
    </div>
  );
}

export function HostExecutionPanel(props: HostExecutionPanelProps) {
  const settings = useSandboxSettings({ client: props.openworkServerClient, workspaceId: props.runtimeWorkspaceId, enabled: props.sandboxRolloutEnabled && props.openworkServerStatus === "connected" });
  const { save, prepare, preparation } = useSandboxSettingsActions(props, settings.data ?? null);
  if (!props.sandboxRolloutEnabled) return null;
  return <SandboxExecutionSection
    settings={settings.data ?? null}
    loading={settings.isLoading}
    unavailable={props.openworkServerStatus !== "connected" || !props.openworkServerClient || !props.runtimeWorkspaceId}
    error={settings.isError}
    saving={save.isPending}
    saveError={save.isError}
    preparing={prepare.isPending || preparation.isFetching}
    prepareError={prepare.isError || preparation.isError}
    onSelect={(allowHostExecution) => save.mutate(allowHostExecution)}
    onRetry={() => prepare.mutate()}
    onReload={() => {
      prepare.reset();
      void settings.refetch();
    }}
  />;
}
