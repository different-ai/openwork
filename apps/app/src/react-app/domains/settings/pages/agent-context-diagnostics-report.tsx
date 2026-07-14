/** @jsxImportSource react */
import { CheckCircle2, CircleAlert, CircleX, Copy, ShieldCheck } from "lucide-react";
import type {
  AgentContextDiagnosticCheck,
  AgentContextDiagnosticCheckId,
  AgentContextDiagnosticEvidenceKind,
  AgentContextDiagnosticOverall,
  AgentContextDiagnosticOwner,
  AgentContextDiagnosticStatus,
  AgentContextDiagnosticsReport,
  AgentContextOrganizationConnectionSummary,
  AgentContextToolPermission,
} from "@openwork/types/agent-context-diagnostics";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { SettingsInset, SettingsNotice, SettingsSection } from "../settings-section";

const EXPECTED_CLOUD_TOOL_IDS = ["search_capabilities", "execute_capability"];

const STATUS_LABEL_KEYS: Record<AgentContextDiagnosticStatus | AgentContextDiagnosticOverall, string> = {
  passed: "connect.diagnostics_status_passed",
  warning: "connect.diagnostics_status_warning",
  failed: "connect.diagnostics_status_failed",
  skipped: "connect.diagnostics_status_skipped",
};

const EVIDENCE_LABEL_KEYS: Record<AgentContextDiagnosticEvidenceKind, string> = {
  observed: "connect.diagnostics_evidence_observed",
  "client-observed": "connect.diagnostics_evidence_client_observed",
  expected: "connect.diagnostics_evidence_expected",
  derived: "connect.diagnostics_evidence_derived",
  unavailable: "connect.diagnostics_evidence_unavailable",
};

const OWNER_LABEL_KEYS: Record<AgentContextDiagnosticOwner, string> = {
  "openwork-client": "connect.diagnostics_owner_openwork_client",
  "openwork-server": "connect.diagnostics_owner_openwork_server",
  "opencode-engine": "connect.diagnostics_owner_opencode_engine",
  "network-admin": "connect.diagnostics_owner_network_admin",
  "organization-admin": "connect.diagnostics_owner_organization_admin",
  member: "connect.diagnostics_owner_member",
  "member-and-organization-admin": "connect.diagnostics_owner_member_and_organization_admin",
  "openwork-support": "connect.diagnostics_owner_openwork_support",
};

const PERMISSION_LABEL_KEYS: Record<AgentContextToolPermission, string> = {
  allowed: "connect.diagnostics_permission_allowed",
  "approval-required": "connect.diagnostics_permission_approval_required",
  denied: "connect.diagnostics_permission_denied",
  unspecified: "connect.diagnostics_permission_unspecified",
};

const SYNC_STATUS_LABEL_KEYS: Record<AgentContextDiagnosticsReport["mcps"][number]["syncStatus"], string> = {
  connected: "connect.diagnostics_sync_status_connected",
  disabled: "connect.diagnostics_sync_status_disabled",
  failed: "connect.diagnostics_sync_status_failed",
  "needs-auth": "connect.diagnostics_sync_status_needs_auth",
  "needs-client-registration": "connect.diagnostics_sync_status_needs_client_registration",
  "not-recorded": "connect.diagnostics_sync_status_not_recorded",
  "not-applicable": "connect.diagnostics_sync_status_not_applicable",
};

const PROBE_STATUS_LABEL_KEYS: Record<AgentContextDiagnosticsReport["organizationConnectionsProbe"]["status"], string> = {
  observed: "connect.diagnostics_probe_status_observed",
  unavailable: "connect.diagnostics_probe_status_unavailable",
  skipped: "connect.diagnostics_probe_status_skipped",
};

const PROBE_CODE_LABEL_KEYS: Record<NonNullable<AgentContextDiagnosticsReport["organizationConnectionsProbe"]["code"]>, string> = {
  signed_out: "connect.diagnostics_probe_code_signed_out",
  list_failed: "connect.diagnostics_probe_code_list_failed",
  not_attempted: "connect.diagnostics_probe_code_not_attempted",
  remote_workspace_privacy: "connect.diagnostics_probe_code_remote_workspace_privacy",
};

const BRANCH_LABEL_KEYS: Record<AgentContextDiagnosticsReport["connect"]["expectedBranch"], string> = {
  "cloud-active": "connect.diagnostics_branch_cloud_active",
  "cloud-disconnected": "connect.diagnostics_branch_cloud_disconnected",
  "extensions-only": "connect.diagnostics_branch_extensions_only",
};

const AGENT_STATE_LABEL_KEYS: Record<AgentContextDiagnosticsReport["agent"]["configuredOpenworkAgent"]["state"], string> = {
  present: "connect.diagnostics_agent_state_present",
  missing: "connect.diagnostics_agent_state_missing",
  "configured-disabled": "connect.diagnostics_agent_state_configured_disabled",
};

const CHECK_LABEL_KEYS: Record<AgentContextDiagnosticCheckId, string> = {
  "request-safety": "connect.diagnostics_check_request_safety",
  "workspace-runtime": "connect.diagnostics_check_workspace_runtime",
  "connect-steering-scope": "connect.diagnostics_check_connect_steering_scope",
  "agent-resolution": "connect.diagnostics_check_agent_resolution",
  "agent-prompt-markers": "connect.diagnostics_check_agent_prompt_markers",
  "agent-connect-tool-permissions": "connect.diagnostics_check_agent_connect_tool_permissions",
  "plugin-registration": "connect.diagnostics_check_plugin_registration",
  "mcp-inventory": "connect.diagnostics_check_mcp_inventory",
  "engine-config": "connect.diagnostics_check_engine_config",
  "engine-agent": "connect.diagnostics_check_engine_agent",
  "engine-plugin-tools": "connect.diagnostics_check_engine_plugin_tools",
  "engine-mcp-sync": "connect.diagnostics_check_engine_mcp_sync",
  "engine-mcp-status": "connect.diagnostics_check_engine_mcp_status",
  "cloud-tool-catalog": "connect.diagnostics_check_cloud_tool_catalog",
  "organization-connections": "connect.diagnostics_check_organization_connections",
  "report-safety": "connect.diagnostics_check_report_safety",
};

function statusLabel(status: AgentContextDiagnosticStatus | AgentContextDiagnosticOverall) {
  return t(STATUS_LABEL_KEYS[status]);
}

function evidenceLabel(kind: AgentContextDiagnosticEvidenceKind) {
  return t(EVIDENCE_LABEL_KEYS[kind]);
}

function ownerLabel(owner: AgentContextDiagnosticOwner) {
  return t(OWNER_LABEL_KEYS[owner]);
}

function checkLabel(id: AgentContextDiagnosticCheckId, effectiveEngineObserved = false) {
  if (effectiveEngineObserved) {
    if (id === "agent-connect-tool-permissions") {
      return t("connect.diagnostics_check_agent_connect_tool_permissions_effective");
    }
    if (id === "agent-prompt-markers") {
      return t("connect.diagnostics_check_agent_prompt_markers_effective");
    }
    if (id === "agent-resolution") return t("connect.diagnostics_check_agent_resolution_effective");
    if (id === "engine-agent") return t("connect.diagnostics_check_engine_agent_effective");
    if (id === "engine-config") return t("connect.diagnostics_check_engine_config_effective");
    if (id === "mcp-inventory") return t("connect.diagnostics_check_mcp_inventory_effective");
    if (id === "plugin-registration") return t("connect.diagnostics_check_plugin_registration_effective");
  }
  return t(CHECK_LABEL_KEYS[id]);
}

export function hasObservedEffectiveEngineConfiguration(report: AgentContextDiagnosticsReport) {
  return report.agent.evidenceSource === "effective-engine";
}

function durationLabel(durationMs: number) {
  if (durationMs < 1_000) return t("connect.diagnostics_duration_ms", { count: durationMs });
  return t("connect.diagnostics_duration_seconds", { count: (durationMs / 1_000).toFixed(1) });
}

function booleanLabel(value: boolean) {
  return value ? t("connect.diagnostics_yes") : t("connect.diagnostics_no");
}

function permissionLabel(value: AgentContextToolPermission) {
  return t(PERMISSION_LABEL_KEYS[value]);
}

function detailLabel(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("-", " ")
    .replace(/^./, (value) => value.toUpperCase());
}

function detailValue(value: AgentContextDiagnosticCheck["details"][string]) {
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : t("connect.diagnostics_none");
  if (typeof value === "boolean") return booleanLabel(value);
  if (value === null) return t("connect.diagnostics_not_observed");
  return String(value);
}

function StatusChip(props: {
  label: string;
  status: AgentContextDiagnosticStatus | AgentContextDiagnosticOverall;
}) {
  const Icon = props.status === "passed"
    ? CheckCircle2
    : props.status === "failed"
      ? CircleX
      : CircleAlert;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
        props.status === "passed" && "border-green-7/30 bg-green-2 text-green-11",
        props.status === "warning" && "border-amber-7/30 bg-amber-2 text-amber-11",
        props.status === "failed" && "border-red-7/30 bg-red-2 text-red-11",
        props.status === "skipped" && "border-gray-7/30 bg-gray-2 text-gray-11",
      )}
    >
      <Icon size={13} />
      {props.label}
    </span>
  );
}

function EvidenceChip(props: { kind: AgentContextDiagnosticEvidenceKind }) {
  return (
    <span className="rounded-full border border-dls-border bg-dls-hover px-2 py-0.5 text-[11px] font-medium text-dls-secondary">
      {evidenceLabel(props.kind)}
    </span>
  );
}

function Fact(props: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-dls-secondary">{props.label}</div>
      <div className="break-words text-sm text-dls-text">{props.value}</div>
    </div>
  );
}

function Marker(props: { label: string; value: boolean }) {
  return (
    <span
      aria-label={`${props.label}: ${booleanLabel(props.value)}`}
      data-marker-value={props.value ? "true" : "false"}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
        props.value ? "bg-green-3 text-green-11" : "bg-red-3 text-red-11",
      )}
    >
      {props.value ? <CheckCircle2 aria-hidden="true" size={12} /> : <CircleX aria-hidden="true" size={12} />}
      {props.label}
    </span>
  );
}

export function AgentContextDiagnosticsErrorNotice(props: { message: string }) {
  return (
    <div
      data-testid="agent-diagnostics-error"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
    >
      <SettingsNotice tone="error">{props.message}</SettingsNotice>
    </div>
  );
}

function DiagnosticCheckRow(props: {
  check: AgentContextDiagnosticCheck;
  effectiveEngineObserved: boolean;
}) {
  return (
    <div
      data-testid="agent-diagnostics-check"
      data-check-id={props.check.id}
      className="space-y-3 rounded-xl border border-dls-border bg-dls-surface p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="break-words text-sm font-semibold text-dls-text">
              {checkLabel(props.check.id, props.effectiveEngineObserved)}
            </div>
            <EvidenceChip kind={props.check.evidenceKind} />
          </div>
          <div className="break-words text-xs text-dls-secondary">{props.check.message}</div>
        </div>
        <StatusChip status={props.check.status} label={statusLabel(props.check.status)} />
      </div>

      {Object.keys(props.check.details).length > 0 ? (
        <div className="grid gap-2 rounded-lg bg-dls-hover p-2.5 sm:grid-cols-2">
          {Object.entries(props.check.details).map(([key, value]) => (
            <Fact key={key} label={detailLabel(key)} value={detailValue(value)} />
          ))}
        </div>
      ) : null}

      <div className="grid gap-2 border-t border-dls-border pt-2 text-xs sm:grid-cols-2">
        <div data-testid="agent-diagnostics-check-owner" className="min-w-0 break-words">
          <span className="font-semibold text-dls-text">{t("connect.diagnostics_owner_label")}: </span>
          <span className="text-dls-secondary">{ownerLabel(props.check.owner)}</span>
        </div>
        <div data-testid="agent-diagnostics-check-action" className="min-w-0 break-words">
          <span className="font-semibold text-dls-text">{t("connect.diagnostics_action_label")}: </span>
          <span className="text-dls-secondary">{props.check.action}</span>
        </div>
      </div>
    </div>
  );
}

export function organizationConnectionState(connection: AgentContextOrganizationConnectionSummary) {
  if (connection.missingFeatureCount > 0) {
    return connection.credentialMode === "per_member"
      ? { label: t("connect.diagnostics_connection_reconnect"), status: "warning" as const }
      : { label: t("connect.diagnostics_connection_not_ready"), status: "failed" as const };
  }
  if (connection.credentialMode === "shared") {
    return connection.connected
      ? { label: t("connect.diagnostics_connection_ready"), status: "passed" as const }
      : { label: t("connect.diagnostics_connection_not_ready"), status: "failed" as const };
  }
  if (connection.needsReconnect) {
    return { label: t("connect.diagnostics_connection_reconnect"), status: "warning" as const };
  }
  return connection.connectedForMe
    ? { label: t("connect.diagnostics_connection_ready"), status: "passed" as const }
    : { label: t("connect.diagnostics_connection_signin"), status: "warning" as const };
}

function AgentEvidence(props: {
  report: AgentContextDiagnosticsReport;
  effectiveEngineObserved: boolean;
}) {
  const agent = props.report.agent.configuredOpenworkAgent;
  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-dls-text">{t("connect.diagnostics_agent_title")}</div>
        <div className="text-xs text-dls-secondary">
          {t(props.effectiveEngineObserved
            ? "connect.diagnostics_agent_description_effective"
            : "connect.diagnostics_agent_description")}
        </div>
      </div>
      <div className="grid gap-3 rounded-xl border border-dls-border bg-dls-surface p-3 sm:grid-cols-2">
        <Fact
          label={t(props.effectiveEngineObserved
            ? "connect.diagnostics_default_agent_effective"
            : "connect.diagnostics_default_agent_configured")}
          value={props.report.agent.defaultAgent ?? t("connect.diagnostics_not_observed")}
        />
        <Fact
          label={t(props.effectiveEngineObserved
            ? "connect.diagnostics_effective_agent"
            : "connect.diagnostics_configured_agent")}
          value={agent.state === "missing"
            ? t("connect.diagnostics_not_observed")
            : `${agent.mode ?? t("connect.diagnostics_unknown")} · ${agent.state === "configured-disabled"
                ? t("connect.diagnostics_configured_disabled")
                : t(props.effectiveEngineObserved
                    ? "connect.diagnostics_effective_enabled"
                    : "connect.diagnostics_configured_enabled")}`}
        />
        <Fact label={t("connect.diagnostics_prompt_length")} value={String(agent.prompt.length)} />
        <Fact label={t("connect.diagnostics_prompt_sha")} value={agent.prompt.sha256 ?? t("connect.diagnostics_not_observed")} />
        <Fact
          label={t("connect.diagnostics_search_permission")}
          value={permissionLabel(agent.connectToolPermissions.searchCapabilities)}
        />
        <Fact
          label={t("connect.diagnostics_execute_permission")}
          value={permissionLabel(agent.connectToolPermissions.executeCapability)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Marker label="search_capabilities" value={agent.prompt.markers.searchCapabilities} />
        <Marker label="execute_capability" value={agent.prompt.markers.executeCapability} />
        <Marker label={t("connect.diagnostics_memory_marker")} value={agent.prompt.markers.memoryBank} />
      </div>
      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-dls-secondary">
          {t(props.effectiveEngineObserved
            ? "connect.diagnostics_effective_plugins"
            : "connect.diagnostics_registered_plugins")}
        </div>
        {props.report.agent.pluginLabels.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {props.report.agent.pluginLabels.map((label) => (
              <span key={label} data-testid="agent-diagnostics-plugin-label" className="min-w-0 max-w-full break-all rounded-md bg-dls-surface px-2 py-1 font-mono text-xs text-dls-text">
                {label}
              </span>
            ))}
          </div>
        ) : (
          <div className="text-xs text-dls-secondary">{t("connect.diagnostics_none")}</div>
        )}
      </div>
      <SettingsNotice>
        {t("connect.diagnostics_prompt_redacted")}
      </SettingsNotice>
    </div>
  );
}

function McpInventory(props: {
  report: AgentContextDiagnosticsReport;
  effectiveEngineObserved: boolean;
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-dls-text">{t("connect.diagnostics_mcp_title")}</div>
        <div className="text-xs text-dls-secondary">
          {t(props.effectiveEngineObserved
            ? "connect.diagnostics_mcp_description_effective"
            : "connect.diagnostics_mcp_description")}
        </div>
      </div>
      {props.report.mcps.length === 0 ? (
        <SettingsNotice>{t("connect.diagnostics_mcp_empty")}</SettingsNotice>
      ) : (
        <div className="space-y-2">
          {props.report.mcps.map((mcp, index) => {
            const engineConfigRow = mcp.source === "engine.config";
            const state = mcp.disabledByTools
              ? "tool-policy"
              : mcp.enabled
                ? "enabled"
                : "disabled";
            return (
            <div
              key={`${mcp.source}:${mcp.name}:${index}`}
              data-testid="agent-diagnostics-mcp-row"
              data-mcp-name={mcp.name}
              className="grid gap-3 rounded-xl border border-dls-border bg-dls-surface p-3 sm:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]"
            >
              <div className="min-w-0">
                <div className="break-words text-sm font-semibold text-dls-text">{mcp.name}</div>
                <div className="break-words text-xs text-dls-secondary">
                  {mcp.source} · {mcp.type} · {mcp.oauthMode}
                </div>
                <div className="mt-1 text-xs text-dls-secondary">
                  {mcp.hasHeaders ? t("connect.diagnostics_credentials_redacted") : t("connect.diagnostics_no_headers")}
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
                <span className={cn(
                  "rounded-full px-2 py-1 text-xs font-medium",
                  state === "enabled" && engineConfigRow && "bg-green-3 text-green-11",
                  state === "enabled" && !engineConfigRow && "bg-blue-3 text-blue-11",
                  state === "tool-policy" && "bg-amber-3 text-amber-11",
                  state === "disabled" && "bg-gray-3 text-gray-11",
                )}>
                  {state === "tool-policy"
                    ? t("connect.diagnostics_disabled_by_tools")
                    : state === "enabled"
                      ? t(engineConfigRow
                          ? "connect.diagnostics_effective_enabled"
                          : "connect.diagnostics_configured_enabled")
                      : t(engineConfigRow
                          ? "connect.diagnostics_effective_disabled"
                          : "connect.diagnostics_configured_disabled")}
                </span>
                <span data-testid="agent-diagnostics-mcp-sync" className="rounded-full border border-dls-border px-2 py-1 text-xs font-medium text-dls-secondary">
                  {t("connect.diagnostics_sync_label")}: {t(SYNC_STATUS_LABEL_KEYS[mcp.syncStatus])}
                </span>
                <span data-testid="agent-diagnostics-mcp-live-status" className="rounded-full border border-dls-border px-2 py-1 text-xs font-medium text-dls-secondary">
                  {t(engineConfigRow
                    ? "connect.diagnostics_mcp_config_effective"
                    : "connect.diagnostics_mcp_status_unavailable")}
                </span>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CloudCatalog(props: {
  report: AgentContextDiagnosticsReport;
  effectiveEngineObserved: boolean;
}) {
  const observed = props.report.observedCloudToolIds;
  const cloudMcp = props.report.mcps.find(
    (mcp) => mcp.source === "config.remote" && mcp.name === "openwork-cloud" && mcp.path === "/mcp/agent",
  ) ?? props.report.mcps.find(
    (mcp) => mcp.name === "openwork-cloud" && mcp.path === "/mcp/agent",
  );
  const observedTerminalPath = cloudMcp?.path === "/mcp/agent" ? cloudMcp.path : null;
  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-dls-text">{t("connect.diagnostics_cloud_title")}</div>
        <div className="text-xs text-dls-secondary">{t("connect.diagnostics_cloud_description")}</div>
      </div>
      <div className="grid gap-3 rounded-xl border border-dls-border bg-dls-surface p-3 sm:grid-cols-2">
        <Fact label={t("connect.diagnostics_expected_endpoint_label")} value="/mcp/agent" />
        <div data-testid="agent-diagnostics-cloud-endpoint-expected" className="sr-only">/mcp/agent</div>
        <div data-testid="agent-diagnostics-cloud-endpoint">
          <Fact
            label={t(cloudMcp?.source === "config.remote"
              ? "connect.diagnostics_runtime_endpoint_label"
              : cloudMcp?.source === "engine.config"
                ? "connect.diagnostics_effective_endpoint_label"
                : "connect.diagnostics_configured_endpoint_label")}
            value={observedTerminalPath ?? t("connect.diagnostics_not_observed")}
          />
        </div>
        <Fact label={t("connect.diagnostics_expected_tools")} value={EXPECTED_CLOUD_TOOL_IDS.join(", ")} />
      </div>
      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-dls-secondary">
          {t("connect.diagnostics_observed_tools")}
        </div>
        {observed.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {observed.map((toolId) => (
              <span
                key={toolId}
                data-testid="agent-diagnostics-cloud-tool"
                data-expected={EXPECTED_CLOUD_TOOL_IDS.includes(toolId) ? "true" : "false"}
                className={cn(
                  "rounded-md px-2 py-1 font-mono text-xs",
                  EXPECTED_CLOUD_TOOL_IDS.includes(toolId)
                    ? "bg-green-3 text-green-11"
                    : "bg-red-3 text-red-11",
                )}
              >
                {toolId}
              </span>
            ))}
          </div>
        ) : (
          <SettingsNotice>{t("connect.diagnostics_cloud_not_observed")}</SettingsNotice>
        )}
      </div>
    </div>
  );
}

function OrganizationConnections(props: { report: AgentContextDiagnosticsReport }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-dls-text">{t("connect.diagnostics_org_title")}</div>
        <div className="text-xs text-dls-secondary">{t("connect.diagnostics_org_description")}</div>
      </div>
      <div data-testid="agent-diagnostics-org-probe" className="text-xs text-dls-secondary">
        {t("connect.diagnostics_observation_label")}: {t(PROBE_STATUS_LABEL_KEYS[props.report.organizationConnectionsProbe.status])}
        {props.report.organizationConnectionsProbe.code
          ? ` · ${t(PROBE_CODE_LABEL_KEYS[props.report.organizationConnectionsProbe.code])}`
          : ""}
        {props.report.organizationConnectionsProbe.status === "observed"
          ? ` · ${t("connect.diagnostics_org_count", {
              count: props.report.organizationConnections.length,
              total: props.report.organizationConnectionsProbe.totalCount,
            })}`
          : ""}
      </div>
      {props.report.organizationConnections.length === 0 ? (
        <SettingsNotice>{t("connect.diagnostics_org_empty")}</SettingsNotice>
      ) : (
        <div className="space-y-2">
          {props.report.organizationConnections.map((connection) => {
            const state = organizationConnectionState(connection);
            return (
              <div
                key={connection.id}
                data-testid="agent-diagnostics-org-connection"
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-dls-border bg-dls-surface p-3"
              >
                <div className="min-w-0">
                  <div className="break-words text-sm font-semibold text-dls-text">{connection.name}</div>
                  <div className="break-words text-xs text-dls-secondary">
                    {connection.credentialMode === "shared"
                      ? t("connect.diagnostics_org_shared")
                      : t("connect.diagnostics_org_per_member")}
                    {connection.missingFeatureCount > 0
                      ? ` · ${t("connect.diagnostics_missing_features", { count: connection.missingFeatureCount })}`
                      : ""}
                  </div>
                </div>
                <StatusChip label={state.label} status={state.status} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AgentContextDiagnosticsReportView(props: {
  report: AgentContextDiagnosticsReport;
  copied: boolean;
  copying: boolean;
  onCopy: () => void | Promise<void>;
}) {
  const firstFailure = props.report.firstFailedCheck;
  const agent = props.report.agent.configuredOpenworkAgent;
  const effectiveEngineObserved = hasObservedEffectiveEngineConfiguration(props.report);
  return (
    <SettingsSection>
      <div data-testid="agent-diagnostics-report">
        <div
          data-testid="agent-diagnostics-completion-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {t("connect.diagnostics_complete", { status: statusLabel(props.report.overall) })}
        </div>
        <div
          data-testid="agent-diagnostics-copy-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {props.copied ? t("connect.diagnostics_copy_succeeded") : ""}
        </div>
        <SettingsInset className="space-y-6 bg-dls-hover/40">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-base font-semibold text-dls-text">
              <ShieldCheck size={17} />
              {t("connect.diagnostics_report_title")}
            </div>
            <div className="break-words text-xs text-dls-secondary">
              {props.report.workspace.name} · {props.report.workspace.type} · {durationLabel(props.report.durationMs)}
            </div>
            <div className="break-all font-mono text-[11px] text-dls-secondary">
              {t("connect.diagnostics_run_id")}: {props.report.runId}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div data-testid="agent-diagnostics-overall">
              <StatusChip status={props.report.overall} label={statusLabel(props.report.overall)} />
            </div>
            <Button
              data-testid="agent-diagnostics-copy"
              size="sm"
              variant="outline"
              disabled={props.copying}
              aria-busy={props.copying}
              onClick={() => void props.onCopy()}
            >
              <Copy size={13} />
              {props.copied ? t("connect.diagnostics_copied") : t("connect.diagnostics_copy")}
            </Button>
          </div>
        </div>

        <SettingsNotice>
          {t("connect.diagnostics_read_only_notice")}
        </SettingsNotice>

        <div data-testid="agent-diagnostics-first-failure" className="text-xs text-dls-secondary">
          <span className="font-semibold text-dls-text">{t("connect.diagnostics_first_failure")}: </span>
          {firstFailure ? checkLabel(firstFailure, effectiveEngineObserved) : t("connect.diagnostics_none")}
        </div>

        <AgentEvidence report={props.report} effectiveEngineObserved={effectiveEngineObserved} />

        <div className="space-y-3">
          <div className="text-sm font-semibold text-dls-text">{t("connect.diagnostics_connect_title")}</div>
          <div className="grid gap-3 rounded-xl border border-dls-border bg-dls-surface p-3 sm:grid-cols-2">
            <Fact
              label={t("connect.diagnostics_expected_branch")}
              value={t(BRANCH_LABEL_KEYS[props.report.connect.expectedBranch])}
            />
            <Fact label={t("connect.diagnostics_connect_enabled")} value={booleanLabel(props.report.connect.connectEnabled)} />
            <Fact
              label={t("connect.diagnostics_legacy_google_workspace")}
              value={booleanLabel(props.report.connect.legacyGoogleWorkspaceConfigured)}
            />
            <Fact label={t("connect.diagnostics_global_cloud_mcp")} value={booleanLabel(props.report.connect.globalCloudMcpPresent)} />
            <Fact label={t("connect.diagnostics_workspace_cloud_mcp")} value={booleanLabel(props.report.connect.selectedWorkspaceCloudMcpPresent)} />
            <Fact label={t("connect.diagnostics_cross_workspace_drift")} value={booleanLabel(props.report.connect.crossWorkspaceSteeringDrift)} />
            <Fact
              label={t("connect.diagnostics_agent_state")}
              value={t(AGENT_STATE_LABEL_KEYS[agent.state])}
            />
          </div>
        </div>

        <McpInventory report={props.report} effectiveEngineObserved={effectiveEngineObserved} />
        <CloudCatalog report={props.report} effectiveEngineObserved={effectiveEngineObserved} />

        <div className="space-y-3">
          <div>
            <div className="text-sm font-semibold text-dls-text">{t("connect.diagnostics_plugin_tools_title")}</div>
            <div className="text-xs text-dls-secondary">{t("connect.diagnostics_plugin_tools_description")}</div>
          </div>
          <div data-testid="agent-diagnostics-plugin-tools-unavailable">
            <SettingsNotice>{t("connect.diagnostics_plugin_tools_empty")}</SettingsNotice>
          </div>
        </div>

        <OrganizationConnections report={props.report} />

        <div className="space-y-3">
          <div>
            <div className="text-sm font-semibold text-dls-text">{t("connect.diagnostics_checks_title")}</div>
            <div className="text-xs text-dls-secondary">{t("connect.diagnostics_checks_description")}</div>
          </div>
          <div className="space-y-2">
            {props.report.checks.map((check) => (
              <DiagnosticCheckRow
                key={check.id}
                check={check}
                effectiveEngineObserved={effectiveEngineObserved}
              />
            ))}
          </div>
        </div>

        <div className="grid gap-2 rounded-xl border border-amber-7/20 bg-amber-2 p-3 text-xs text-amber-11 sm:grid-cols-2">
          <div>{t("connect.diagnostics_safety_workspace_runtime_read_only")}: {booleanLabel(props.report.safety.diagnosticsWorkspaceRuntimeConfigurationReadOnly)}</div>
          <div>{t("connect.diagnostics_safety_tools_list")}: {booleanLabel(props.report.safety.cloudCatalogToolsListPerformed)}</div>
          <div>{t("connect.diagnostics_safety_non_cloud_fetch")}: {booleanLabel(!props.report.safety.directNonCloudMcpFetchPerformed)}</div>
          <div>{t("connect.diagnostics_safety_tool_call")}: {booleanLabel(!props.report.safety.directMcpToolCallPerformed)}</div>
          <div>{t("connect.diagnostics_safety_provider_operation")}: {booleanLabel(!props.report.safety.directProviderOperationPerformed)}</div>
          <div>{t("connect.diagnostics_safety_mutation")}: {booleanLabel(!props.report.safety.directConfigurationMutationPerformed)}</div>
          <div>{t("connect.diagnostics_safety_ephemeral_mint")}: {booleanLabel(!props.report.safety.directEphemeralCredentialMintPerformed)}</div>
          <div>{t("connect.diagnostics_safety_engine_api_read_performed")}: {booleanLabel(props.report.safety.engineApiReadPerformed)}</div>
          <div>{t("connect.diagnostics_safety_engine_bootstrap")}: {booleanLabel(props.report.safety.engineBootstrapMayHaveRun)}</div>
          <div>{t("connect.diagnostics_safety_engine_bootstrap_inspected")}: {booleanLabel(props.report.safety.engineBootstrapSideEffectsInspected)}</div>
          <div>{t("connect.diagnostics_safety_auth_activity")}: {booleanLabel(props.report.safety.authSessionActivityMayBeRecorded)}</div>
          <div>{t("connect.diagnostics_safety_token_values")}: {booleanLabel(!props.report.safety.tokenValuesIncluded)}</div>
          <div>{t("connect.diagnostics_safety_authorization_values")}: {booleanLabel(!props.report.safety.authorizationHeaderValuesIncluded)}</div>
          <div>{t("connect.diagnostics_safety_credential_values")}: {booleanLabel(!props.report.safety.credentialValuesIncluded)}</div>
          <div>{t("connect.diagnostics_safety_prompts")}: {booleanLabel(!props.report.safety.rawPromptsIncluded)}</div>
          <div>{t("connect.diagnostics_safety_provider_responses")}: {booleanLabel(!props.report.safety.providerResponsesIncluded)}</div>
          <div>{t("connect.diagnostics_safety_stack_traces")}: {booleanLabel(!props.report.safety.stackTracesIncluded)}</div>
          <div>{t("connect.diagnostics_safety_raw_engine_errors")}: {booleanLabel(!props.report.safety.rawEngineErrorsIncluded)}</div>
          <div>{t("connect.diagnostics_safety_secret_urls")}: {booleanLabel(!props.report.safety.secretBearingUrlsIncluded)}</div>
          <div>{t("connect.diagnostics_safety_input_validated")}: {booleanLabel(props.report.safety.inputStrictlyValidated)}</div>
        </div>
        </SettingsInset>
      </div>
    </SettingsSection>
  );
}
