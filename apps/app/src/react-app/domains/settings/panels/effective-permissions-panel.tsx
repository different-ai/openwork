/** @jsxImportSource react */
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import type {
  OpenworkEffectivePermissionKey,
  OpenworkEffectivePermissionRow,
  OpenworkEffectivePermissionsResponse,
  OpenworkPermissionAction,
  OpenworkPermissionSource,
  OpenworkServerCapabilities,
  OpenworkServerClient,
  OpenworkServerStatus,
} from "../../../../app/lib/openwork-server";
import { safeStringify } from "../../../../app/utils";
import { SettingsNotice } from "../settings-section";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings-layout";

const ROW_LABEL_KEYS = {
  shell: "context_panel.effective_permission_shell",
  edit: "context_panel.effective_permission_edit",
  web: "context_panel.effective_permission_web",
  mcp: "context_panel.effective_permission_mcp",
  outside_folders: "context_panel.effective_permission_outside_folders",
  env_files: "context_panel.effective_permission_env_files",
  doom_loop: "context_panel.effective_permission_doom_loop",
} as const satisfies Record<OpenworkEffectivePermissionKey, string>;

const ACTION_LABEL_KEYS = {
  allow: "context_panel.permission_action_allow",
  ask: "context_panel.permission_action_ask",
  deny: "context_panel.permission_action_deny",
} as const satisfies Record<OpenworkPermissionAction, string>;

const SOURCE_LABEL_KEYS = {
  engine: "context_panel.permission_source_engine",
  global: "context_panel.permission_source_global",
  openwork: "context_panel.permission_source_openwork",
  workspace: "context_panel.permission_source_workspace",
} as const satisfies Record<OpenworkPermissionSource, string>;

function actionBadgeVariant(action: OpenworkPermissionAction): "secondary" | "outline" | "destructive" {
  if (action === "deny") return "destructive";
  if (action === "ask") return "outline";
  return "secondary";
}

export type EffectivePermissionsPanelProps = {
  openworkServerClient: OpenworkServerClient | null;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  runtimeWorkspaceId: string | null;
  /** Bump to re-read after a permission-affecting change elsewhere in Settings. */
  refreshToken?: number;
};

function EffectivePermissionRowItem({ row }: { row: OpenworkEffectivePermissionRow }) {
  return (
    <li
      className="flex flex-row items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3"
      data-effective-permission={row.key}
      data-effective-action={row.action}
      data-effective-source={row.source ?? "none"}
    >
      <div className="min-w-0 flex flex-col gap-1">
        <span className="truncate text-sm font-medium text-dls-text">{t(ROW_LABEL_KEYS[row.key])}</span>
        <span className="truncate text-xs text-muted-foreground">
          {row.source ? t(SOURCE_LABEL_KEYS[row.source]) : t("context_panel.permission_source_engine")}
          {row.exceptions > 0
            ? ` · ${t("context_panel.effective_permissions_exceptions", undefined, { count: String(row.exceptions) })}`
            : null}
        </span>
      </div>
      <Badge variant={actionBadgeVariant(row.action)}>{t(ACTION_LABEL_KEYS[row.action])}</Badge>
    </li>
  );
}

export function EffectivePermissionsPanel(props: EffectivePermissionsPanelProps) {
  const [response, setResponse] = useState<OpenworkEffectivePermissionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    props.openworkServerStatus === "connected"
    && Boolean(props.runtimeWorkspaceId)
    && (props.openworkServerCapabilities?.config?.read ?? false);

  useEffect(() => {
    const client = props.openworkServerClient;
    const workspaceId = props.runtimeWorkspaceId;
    if (!client || !workspaceId || !ready) {
      setResponse(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const next = await client.getEffectivePermissions(workspaceId);
        if (!cancelled) setResponse(next);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : safeStringify(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.openworkServerClient, props.runtimeWorkspaceId, props.refreshToken, ready]);

  return (
    <LayoutSectionItem className="gap-6">
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("context_panel.effective_permissions")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>
          {t("context_panel.effective_permissions_desc")}
          {response ? ` ${t("context_panel.effective_permissions_agent", undefined, { agent: response.agent })}` : null}
        </LayoutSectionItemDescription>
      </LayoutSectionItemHeader>

      {!ready ? (
        <SettingsNotice>{t("context_panel.effective_permissions_unavailable")}</SettingsNotice>
      ) : error ? (
        <SettingsNotice tone="error">{error}</SettingsNotice>
      ) : response ? (
        <ul className="flex flex-col gap-2" data-effective-permissions-agent={response.agent}>
          {response.rows.map((row) => (
            <EffectivePermissionRowItem key={row.key} row={row} />
          ))}
        </ul>
      ) : loading ? (
        <SettingsNotice>{t("context_panel.effective_permissions_loading")}</SettingsNotice>
      ) : null}
    </LayoutSectionItem>
  );
}
