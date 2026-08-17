import type { SessionCloudMcpMaintenanceState } from "./use-session-mcp-maintenance";
import { t } from "@/i18n";

export type OpenWorkConnectStateStatus = "available" | "missing" | "invalid" | "unreadable";

export type OpenWorkConnectStateSummary = {
  status: "ready" | "not_configured" | "disabled" | "unavailable";
  statusLabel: string;
  tone: "ready" | "neutral" | "error";
  stageLabel: string;
  recommendedAction: string;
};

export function resolveOpenWorkConnectStateSummary(
  status: OpenWorkConnectStateStatus,
  connectEnabled: boolean,
): OpenWorkConnectStateSummary {
  if (status === "missing") {
    return {
      status: "not_configured",
      statusLabel: t("connect.state_not_configured_label"),
      tone: "neutral",
      stageLabel: t("connect.state_not_configured_stage"),
      recommendedAction: t("connect.state_not_configured_action"),
    };
  }
  if (status === "invalid" || status === "unreadable") {
    return {
      status: "unavailable",
      statusLabel: t("connect.state_unavailable_label"),
      tone: "error",
      stageLabel: t("connect.state_unavailable_stage"),
      recommendedAction: t("connect.state_unavailable_action"),
    };
  }
  if (!connectEnabled) {
    return {
      status: "disabled",
      statusLabel: t("connect.state_disabled_label"),
      tone: "neutral",
      stageLabel: t("connect.state_disabled_stage"),
      recommendedAction: t("connect.state_disabled_action"),
    };
  }
  return {
    status: "ready",
    statusLabel: t("connect.state_ready_label"),
    tone: "ready",
    stageLabel: t("connect.state_ready_stage"),
    recommendedAction: t("connect.state_ready_action"),
  };
}

export type OpenWorkConnectStatus = {
  state: "checking" | "ready" | "needs_attention";
  label: string;
  description: string;
};

export function openWorkConnectAttentionTitle(description: string): string {
  return t("connect.status_attention_title", { description });
}

export function resolveOpenWorkConnectStatus(
  signedIn: boolean,
  maintenance: SessionCloudMcpMaintenanceState | undefined,
): OpenWorkConnectStatus | null {
  if (!signedIn) return null;

  // Den authentication is ready, but maintenance itself is workspace-scoped.
  // When there is no active workspace, report the verified Cloud connection
  // without claiming that connected-service delivery was checked.
  if (!maintenance || maintenance.status === "idle") {
    return {
      state: "ready",
      label: t("connect.status_ready"),
      description: t("connect.status_signed_in_desc"),
    };
  }

  if (maintenance.status === "ready") {
    return {
      state: "ready",
      label: t("connect.status_ready"),
      description: t("connect.status_tools_ready_desc"),
    };
  }

  if (maintenance.status === "failed" || maintenance.status === "skipped") {
    return {
      state: "needs_attention",
      label: t("connect.status_needs_attention"),
      description: maintenance.issue?.message
        ?? t("connect.status_tools_failed_desc"),
    };
  }

  return {
    state: "checking",
    label: t("connect.status_checking"),
    description: maintenance.status === "retrying"
      ? t("connect.status_restoring_tools", { attempt: maintenance.attempt, maxAttempts: maintenance.maxAttempts })
      : t("connect.status_checking_tools"),
  };
}
