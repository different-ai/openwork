/** @jsxImportSource react */
import { useId } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import type {
  OpenworkSandboxSettingsResponse,
  OpenworkServerClient,
  OpenworkServerStatus,
} from "../../../../app/lib/openwork-server";
import { safeStringify } from "../../../../app/utils";
import { SettingsNotice } from "../settings-section";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemFootnote,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "../settings-layout";
import { hostExecutionRow, withOwnHostExecutionSetting, type HostExecutionRowNote } from "./host-execution-panel-state";

export type HostExecutionPanelProps = {
  openworkServerClient: OpenworkServerClient | null;
  openworkServerStatus: OpenworkServerStatus;
  runtimeWorkspaceId: string | null;
  sandboxRolloutEnabled: boolean;
  onUpdated: () => void;
};

const NOTE_KEYS = {
  managed: "context_panel.host_execution_managed",
  sandbox_unavailable: "context_panel.host_execution_sandbox_unavailable",
  sandbox_only: "context_panel.host_execution_sandbox_only",
} as const satisfies Record<NonNullable<HostExecutionRowNote>, string>;

export function HostExecutionPanel(props: HostExecutionPanelProps) {
  const noteId = useId();
  const queryClient = useQueryClient();
  const client = props.openworkServerClient;
  const workspaceId = props.runtimeWorkspaceId;
  const queryKey = ["openwork-server", "sandbox-settings", workspaceId];

  const settings = useQuery({
    queryKey,
    queryFn: () => client && workspaceId ? client.getSandboxSettings(workspaceId) : null,
    enabled: props.openworkServerStatus === "connected" && Boolean(client) && Boolean(workspaceId),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const save = useMutation({
    mutationFn: (allowHostExecution: boolean) => {
      if (!client || !workspaceId) throw new Error(t("context_panel.no_server_workspace"));
      return client.setSandboxSettings(workspaceId, allowHostExecution);
    },
    onMutate: (allowHostExecution) => {
      const previous = queryClient.getQueryData<OpenworkSandboxSettingsResponse | null>(queryKey) ?? null;
      if (previous) queryClient.setQueryData(queryKey, withOwnHostExecutionSetting(previous, allowHostExecution));
      return { previous };
    },
    onError: (_error, _allowHostExecution, context) => {
      queryClient.setQueryData(queryKey, context?.previous ?? null);
    },
    onSuccess: (next) => {
      queryClient.setQueryData(queryKey, next);
      props.onUpdated();
    },
  });

  const row = hostExecutionRow(settings.data ?? null, props.sandboxRolloutEnabled);
  if (!row.visible) return null;

  return (
    <div
      data-testid="host-execution-row"
      data-host-execution={row.hostToolsAllowed ? "allow" : "deny"}
      data-host-execution-managed={row.lockedByOrganization ? "true" : "false"}
    >
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("context_panel.host_execution")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("context_panel.host_execution_desc")}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Switch
              data-testid="host-execution-switch"
              aria-label={t("context_panel.host_execution")}
              aria-describedby={row.note ? noteId : undefined}
              checked={row.hostToolsAllowed}
              disabled={row.lockedByOrganization || save.isPending}
              onCheckedChange={(checked) => save.mutate(checked)}
            />
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
        {row.note ? (
          <LayoutSectionItemFootnote className="flex items-center gap-1.5">
            {row.lockedByOrganization ? <Lock className="size-3.5 shrink-0" aria-hidden="true" /> : null}
            <span id={noteId} data-testid="host-execution-note" data-host-execution-note={row.note}>{t(NOTE_KEYS[row.note])}</span>
          </LayoutSectionItemFootnote>
        ) : null}
        {save.isSuccess ? (
          <LayoutSectionItemFootnote>
            <span data-testid="host-execution-saved" role="status">{t("context_panel.host_execution_saved")}</span>
          </LayoutSectionItemFootnote>
        ) : null}
        {save.isError ? (
          <SettingsNotice tone="error">{save.error instanceof Error ? save.error.message : safeStringify(save.error)}</SettingsNotice>
        ) : null}
      </LayoutSectionItem>
    </div>
  );
}
