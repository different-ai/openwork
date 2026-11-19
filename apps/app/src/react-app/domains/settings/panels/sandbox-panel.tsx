/** @jsxImportSource react */
import { useCallback, useId, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Folder, Lock } from "lucide-react";

import { OpenworkServerError, type OpenworkServerClient } from "@/app/lib/openwork-server";
import { Button } from "@/components/ui/button";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { sandboxEffectiveMode } from "@/react-app/kernel/sandbox-chat";
import { sandboxSettingsQuery, useSandboxSettings, useSandboxStatus } from "@/react-app/infra/use-sandbox";
import { LayoutSectionItem, LayoutSectionItemDescription, LayoutSectionItemFootnote, LayoutSectionItemHeader, LayoutSectionItemHeaderActions, LayoutSectionItemTitle, LayoutSectionTitle } from "../settings-layout";
import { sandboxEditableToggleUpdate, sandboxPanelState, sandboxPanelVisibility, sandboxSavedChoiceMatches, sandboxStatusView, sandboxToggleUpdate, type SandboxToggle } from "./sandbox-panel-state";

type SandboxPanelProps = {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  connecting: boolean;
  rollout: boolean | undefined;
  onUpdated: () => void;
};

function SandboxSwitch({ setting, checked, note, saving, onChange }: {
  setting: "use" | "force";
  checked: boolean;
  note: "managed" | "included" | null;
  saving: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const label = setting === "use" ? t("sandbox.use") : t("sandbox.force");
  return (
    <LayoutSectionItem className="gap-1 border-t border-border py-2">
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{label}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription><span id={id}>{setting === "use" ? t("sandbox.use_description") : t("sandbox.force_description")}</span></LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Switch data-testid={`sandbox-${setting}-switch`} aria-label={label} aria-describedby={note ? `${id} ${id}-note` : id}
            checked={checked} disabled={Boolean(note) || saving} onCheckedChange={onChange} />
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
      {note ? (
        <LayoutSectionItemFootnote className="flex items-center gap-1.5">
          {note === "managed" ? <Lock className="size-3.5" aria-hidden="true" /> : null}
          <span id={`${id}-note`} data-testid={note === "managed" ? `sandbox-${setting}-managed` : undefined}>
            {note === "managed" ? t("sandbox.managed") : t("sandbox.included")}
          </span>
        </LayoutSectionItemFootnote>
      ) : null}
    </LayoutSectionItem>
  );
}

function Retry({ onClick, disabled, testId }: { onClick: () => void; disabled?: boolean; testId?: string }) {
  return <Button variant="link" size="sm" className="h-auto px-1" data-testid={testId} disabled={disabled} onClick={onClick}>{t("common.retry")}</Button>;
}

export function SandboxPanel({ client, workspaceId, connecting, rollout, onUpdated }: SandboxPanelProps) {
  const queryClient = useQueryClient();
  const connection = { client, workspaceId };
  const { settings, queryKey } = useSandboxSettings(connection);
  const loading = settings.data === undefined && (connecting || (Boolean(client && workspaceId) && settings.isPending));
  const { visible, ready } = sandboxPanelVisibility(rollout, settings.isError ? "error" : loading ? "loading" : "settled", settings.data);
  const observeStatus = visible && (settings.data?.pending === true || sandboxEffectiveMode(settings.data) !== "off");
  const { status, queryKey: statusKey } = useSandboxStatus(connection, observeStatus);
  const settingsSaved = (reconciled: boolean) => {
    void queryClient.invalidateQueries({ queryKey, refetchType: reconciled ? "none" : "active" });
    void queryClient.invalidateQueries({ queryKey: statusKey });
    onUpdated();
  };
  const recoveryKey = [...queryKey, "reconcile"];
  const reconcile = useMutation({
    mutationFn: async (toggle: SandboxToggle) => {
      const next = await queryClient.fetchQuery({ ...sandboxSettingsQuery(connection), queryKey: recoveryKey, gcTime: 0 });
      if (next) queryClient.setQueryData(queryKey, next);
      if (!sandboxSavedChoiceMatches(next, sandboxToggleUpdate(toggle.setting, toggle.checked))) {
        throw new Error(t("sandbox.save_error"));
      }
    },
    onSuccess: () => settingsSaved(true),
  });
  const save = useMutation({
    mutationFn: async (toggle: SandboxToggle) => {
      const current = queryClient.getQueryData(queryKey);
      const update = current && sandboxEditableToggleUpdate(current, toggle);
      if (!client || !workspaceId || !update) return null;
      return client.setSandboxSettings(workspaceId, update);
    },
    onMutate: async () => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey, exact: true }),
        queryClient.cancelQueries({ queryKey: recoveryKey, exact: true }),
      ]);
    },
    onError: (error, toggle) => {
      if (error instanceof OpenworkServerError) void queryClient.invalidateQueries({ queryKey });
      else reconcile.mutate(toggle);
    },
    onSuccess: (next) => {
      if (!next) return;
      queryClient.setQueryData(queryKey, next);
      settingsSaved(false);
    },
  });
  const saveToggle = (toggle: SandboxToggle) => {
    if (!settings.data || !sandboxEditableToggleUpdate(settings.data, toggle)) return;
    reconcile.reset();
    save.mutate(toggle);
  };
  const prepare = useMutation({
    mutationFn: () => {
      if (!client || !workspaceId) throw new Error(t("context_panel.no_server_workspace"));
      return client.prepareSandbox(workspaceId);
    },
    onMutate: () => queryClient.cancelQueries({ queryKey: statusKey }),
    onSuccess: (next) => queryClient.setQueryData(statusKey, next),
  });
  const optimistic = save.isPending ? sandboxToggleUpdate(save.variables.setting, save.variables.checked) : undefined;
  const row = settings.data ? sandboxPanelState(settings.data, optimistic) : null;
  const failedToggle = reconcile.isError ? reconcile.variables : save.isError && save.error instanceof OpenworkServerError ? save.variables : null;
  const marked = useRef(false);
  const markReady = useCallback((element: HTMLElement | null) => {
    if (!element || !ready || marked.current) return;
    marked.current = true;
    performance.mark("openwork:permissions:sandbox-ready");
  }, [ready]);
  if (!visible) return <div ref={markReady} data-testid="sandbox-panel" data-ready={ready ? "true" : undefined} hidden />;

  const saving = (setting: SandboxToggle["setting"]) => save.isPending || (reconcile.isPending && reconcile.variables.setting === setting);
  const view = sandboxStatusView(status.data, observeStatus && Boolean(row?.use));
  return (
    <section ref={markReady} data-testid="sandbox-panel" data-ready={ready ? "true" : undefined} className="flex flex-col gap-2">
      <LayoutSectionTitle>{t("sandbox.title")}</LayoutSectionTitle>
      {loading ? <div aria-hidden="true" className="flex flex-col gap-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div> : null}
      {settings.isError ? <LayoutSectionItemFootnote>{t("sandbox.settings_error")} <Retry onClick={() => void settings.refetch()} disabled={settings.isFetching} /></LayoutSectionItemFootnote> : null}
      {row ? <>
        <SandboxSwitch setting="use" checked={row.use} note={row.useNote} saving={saving("use")} onChange={(checked) => saveToggle({ setting: "use", checked })} />
        <SandboxSwitch setting="force" checked={row.force} note={row.forceNote} saving={saving("force")} onChange={(checked) => saveToggle({ setting: "force", checked })} />
        {row.unavailable ? <LayoutSectionItemFootnote>{t("sandbox.unavailable")}</LayoutSectionItemFootnote> : null}
        {row.pending ? <LayoutSectionItemFootnote><span role="status" data-testid="sandbox-pending">{t("sandbox.pending")} {row.pending === "sandbox" ? t("sandbox.pending_sandbox") : t("sandbox.pending_computer")}</span></LayoutSectionItemFootnote> : null}
        {row.verification === "checking" ? <LayoutSectionItemFootnote>{t("sandbox.checking")}</LayoutSectionItemFootnote> : null}
        {row.verification === "unavailable" ? <LayoutSectionItemFootnote>{t("sandbox.verification_unavailable")} <Retry onClick={() => void settings.refetch()} disabled={settings.isFetching} /></LayoutSectionItemFootnote> : null}
        {failedToggle ? <LayoutSectionItemFootnote className="text-destructive">{t("sandbox.save_error")} <Retry onClick={() => saveToggle(failedToggle)} disabled={Boolean(settings.data && !sandboxEditableToggleUpdate(settings.data, failedToggle))} /></LayoutSectionItemFootnote> : null}
      </> : null}
      <div data-testid="sandbox-status" className="flex flex-col gap-2" aria-live="polite">
        {observeStatus && status.isError ? <LayoutSectionItemFootnote>{t("sandbox.status_error")} <Retry onClick={() => void status.refetch()} disabled={status.isFetching} /></LayoutSectionItemFootnote> : null}
        {observeStatus && row?.use && status.isPending ? <Skeleton className="h-12 w-full" /> : null}
        {view.kind === "progress" ? <>
          {view.steps.map((step) => (
            <Progress key={step.id} data-testid={`sandbox-step-${step.id}`} data-state={step.state} value={step.value} className={step.value === null ? "gap-1 [&_[data-slot=progress-indicator]]:w-1/4 [&_[data-slot=progress-indicator]]:bg-muted-foreground/30" : "gap-1"}>
              <ProgressLabel className={step.state === "active" ? "text-foreground" : "text-muted-foreground"}>{step.label}</ProgressLabel>
            </Progress>
          ))}
          {view.estimate ? <LayoutSectionItemFootnote>{view.estimate}</LayoutSectionItemFootnote> : null}
          <LayoutSectionItemFootnote>{t("sandbox.background")}</LayoutSectionItemFootnote>
        </> : null}
        {view.kind === "ready" ? <>
          <span className="text-sm font-medium" data-testid="sandbox-ready">{t("sandbox.ready")}</span>
          <ul className="divide-y divide-border">
            {view.folders.map((folder) => (
              <li key={folder.path} data-testid="sandbox-folder" className="flex min-h-10 items-center gap-2 py-2 text-xs">
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={folder.path}>{folder.path}</span>
                {folder.kind === "workspace" ? <span className="text-muted-foreground">{t("context_panel.workspace_root_badge")}</span> : null}
                <span>{folder.access === "rw" ? t("sandbox.can_edit") : t("sandbox.view_only")}</span>
              </li>
            ))}
          </ul>
        </> : null}
        {view.kind === "failed" || view.kind === "unsupported" ? (
          <div data-testid="sandbox-error" className={view.kind === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {view.error?.message ?? t("sandbox.status_error")} {view.error?.action}
            {view.retry ? <Retry testId="sandbox-retry" onClick={() => prepare.mutate()} disabled={prepare.isPending} /> : null}
          </div>
        ) : null}
        {prepare.isError ? <LayoutSectionItemFootnote>{t("sandbox.retry_error")}</LayoutSectionItemFootnote> : null}
      </div>
    </section>
  );
}
