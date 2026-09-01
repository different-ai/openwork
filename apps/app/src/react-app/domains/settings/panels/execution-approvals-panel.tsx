/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { t } from "@/i18n";
import type {
  OpenworkRunMode,
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
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "../settings-layout";

const RUN_MODE_VALUES: readonly OpenworkRunMode[] = ["approve", "run-everything"];

function isRunMode(value: unknown): value is OpenworkRunMode {
  return value === "approve" || value === "run-everything";
}

function runModeLabel(mode: OpenworkRunMode): string {
  return mode === "run-everything"
    ? t("settings.run_mode.run_everything")
    : t("settings.run_mode.approve");
}

export type ExecutionApprovalsPanelProps = {
  openworkServerClient: OpenworkServerClient | null;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  runtimeWorkspaceId: string | null;
  onConfigUpdated: () => void;
};

export function ExecutionApprovalsPanel(props: ExecutionApprovalsPanelProps) {
  const [mode, setMode] = useState<OpenworkRunMode>("approve");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openworkServerReady = props.openworkServerStatus === "connected";
  const openworkServerWorkspaceReady = Boolean(props.runtimeWorkspaceId);
  const canReadConfig =
    openworkServerReady &&
    openworkServerWorkspaceReady &&
    (props.openworkServerCapabilities?.config?.read ?? false);
  const canWriteConfig =
    openworkServerReady &&
    openworkServerWorkspaceReady &&
    (props.openworkServerCapabilities?.config?.write ?? false);

  const accessHint = useMemo(() => {
    if (!openworkServerReady) return t("context_panel.server_disconnected");
    if (!openworkServerWorkspaceReady) return t("context_panel.no_server_workspace");
    if (!canReadConfig) return t("context_panel.config_access_unavailable");
    if (!canWriteConfig) return t("context_panel.config_read_only");
    return null;
  }, [canReadConfig, canWriteConfig, openworkServerReady, openworkServerWorkspaceReady]);

  useEffect(() => {
    const openworkClient = props.openworkServerClient;
    const openworkWorkspaceId = props.runtimeWorkspaceId;

    if (!openworkClient || !openworkWorkspaceId || !canReadConfig) {
      setMode("approve");
      setStatus(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const response = await openworkClient.getRunMode(openworkWorkspaceId);
        if (cancelled) return;
        setMode(response.mode);
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : safeStringify(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canReadConfig, props.openworkServerClient, props.runtimeWorkspaceId]);

  const changeMode = useCallback(async (nextMode: OpenworkRunMode) => {
    const openworkClient = props.openworkServerClient;
    const openworkWorkspaceId = props.runtimeWorkspaceId;
    if (!openworkClient || !openworkWorkspaceId || !canWriteConfig) {
      setError(t("context_panel.writable_workspace_required"));
      return;
    }

    const previousMode = mode;
    setMode(nextMode);
    setSaving(true);
    setError(null);
    setStatus(t("settings.run_mode.saving"));

    try {
      const response = await openworkClient.setRunMode(openworkWorkspaceId, nextMode);
      setMode(response.mode);
      setStatus(t("settings.run_mode.updated"));
      props.onConfigUpdated();
    } catch (saveError) {
      setMode(previousMode);
      setStatus(null);
      setError(saveError instanceof Error ? saveError.message : safeStringify(saveError));
    } finally {
      setSaving(false);
    }
  }, [canWriteConfig, mode, props.onConfigUpdated, props.openworkServerClient, props.runtimeWorkspaceId]);

  const runModeItems = RUN_MODE_VALUES.map((value) => ({
    value,
    label: runModeLabel(value),
  }));

  return (
    <LayoutSectionItem className="gap-6">
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("settings.run_mode.mode")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>
          {t("settings.run_mode.section_desc")}{" "}
          {mode === "run-everything"
            ? t("settings.run_mode.run_everything_desc")
            : t("settings.run_mode.approve_desc")}
        </LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <div className="w-52 max-w-full">
            <Select
              value={mode}
              items={runModeItems}
              onValueChange={(value) => {
                if (isRunMode(value) && value !== mode) {
                  void changeMode(value);
                }
              }}
              disabled={loading || saving || !canWriteConfig}
            >
              <SelectTrigger className="w-full" aria-label={t("settings.run_mode.mode")}>
                <SelectValue placeholder={t("settings.run_mode.approve")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {runModeItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>

      {accessHint ? (
        <SettingsNotice>{accessHint}</SettingsNotice>
      ) : mode === "run-everything" ? (
        <SettingsNotice>{t("settings.run_mode.run_everything_warning")}</SettingsNotice>
      ) : null}
      {status ? <SettingsNotice>{status}</SettingsNotice> : null}
      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
    </LayoutSectionItem>
  );
}
