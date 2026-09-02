/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type {
  OpenworkPermissionAction,
  OpenworkServerCapabilities,
  OpenworkServerClient,
  OpenworkServerStatus,
  OpenworkWorkspacePermissionRule,
  OpenworkWorkspacePermissionRulesResponse,
} from "../../../../app/lib/openwork-server";
import { safeStringify } from "../../../../app/utils";
import { SettingsNotice } from "../settings-section";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings-layout";

const ACTION_LABEL_KEYS = {
  allow: "context_panel.permission_action_allow",
  ask: "context_panel.permission_action_ask",
  deny: "context_panel.permission_action_deny",
} as const satisfies Record<OpenworkPermissionAction, string>;

function actionBadgeVariant(action: OpenworkPermissionAction): "secondary" | "outline" | "destructive" {
  if (action === "deny") return "destructive";
  if (action === "ask") return "outline";
  return "secondary";
}

export type WorkspacePermissionRulesPanelProps = {
  openworkServerClient: OpenworkServerClient | null;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  runtimeWorkspaceId: string | null;
  /** Bump to re-read after the file changed elsewhere. */
  refreshToken?: number;
  onRulesChanged: () => void;
};

export function WorkspacePermissionRulesPanel(props: WorkspacePermissionRulesPanelProps) {
  const [response, setResponse] = useState<OpenworkWorkspacePermissionRulesResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const serverReady = props.openworkServerStatus === "connected" && Boolean(props.runtimeWorkspaceId);
  const canRead = serverReady && (props.openworkServerCapabilities?.config?.read ?? false);
  const canWrite = serverReady && (props.openworkServerCapabilities?.config?.write ?? false);

  useEffect(() => {
    const client = props.openworkServerClient;
    const workspaceId = props.runtimeWorkspaceId;
    if (!client || !workspaceId || !canRead) {
      setResponse(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const next = await client.listWorkspacePermissionRules(workspaceId);
        if (!cancelled) setResponse(next);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : safeStringify(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canRead, props.openworkServerClient, props.runtimeWorkspaceId, props.refreshToken]);

  const removeRule = useCallback(async (rule: OpenworkWorkspacePermissionRule) => {
    const client = props.openworkServerClient;
    const workspaceId = props.runtimeWorkspaceId;
    if (!client || !workspaceId || !canWrite) {
      setError(t("context_panel.writable_workspace_required"));
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const next = await client.removeWorkspacePermissionRule(workspaceId, { permission: rule.permission, pattern: rule.pattern });
      setResponse(next);
      setStatus(t("context_panel.workspace_rules_removed"));
      props.onRulesChanged();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : safeStringify(removeError));
    } finally {
      setBusy(false);
    }
  }, [canWrite, props.onRulesChanged, props.openworkServerClient, props.runtimeWorkspaceId]);

  return (
    <LayoutSectionItem className="gap-6">
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("context_panel.workspace_rules")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>
          {t("context_panel.workspace_rules_desc")}
          {response ? ` ${t("context_panel.workspace_rules_path", undefined, { path: response.path })}` : null}
        </LayoutSectionItemDescription>
      </LayoutSectionItemHeader>

      {!canRead ? (
        <SettingsNotice>{t("context_panel.workspace_rules_unavailable")}</SettingsNotice>
      ) : response && response.rules.length === 0 ? (
        <SettingsNotice>{t("context_panel.workspace_rules_empty")}</SettingsNotice>
      ) : response ? (
        <ul className="flex flex-col gap-2">
          {response.rules.map((rule) => (
            <li
              key={`${rule.permission}\u0000${rule.pattern}`}
              className="flex flex-row items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3"
              data-workspace-rule-permission={rule.permission}
              data-workspace-rule-pattern={rule.pattern}
            >
              <div className="min-w-0 flex flex-col gap-1">
                <span className="truncate text-sm font-medium text-dls-text">{rule.permission}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{rule.pattern}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={actionBadgeVariant(rule.action)}>{t(ACTION_LABEL_KEYS[rule.action])}</Badge>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => void removeRule(rule)}
                  disabled={busy || !canWrite}
                  aria-label={t("context_panel.workspace_rules_remove", undefined, { permission: rule.permission, pattern: rule.pattern })}
                >
                  <X size={14} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {status ? <SettingsNotice>{status}</SettingsNotice> : null}
      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
    </LayoutSectionItem>
  );
}
