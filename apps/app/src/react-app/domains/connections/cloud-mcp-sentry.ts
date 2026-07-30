import {
  type TelemetryDimensionInput,
  type TelemetryEventFields,
  trackTelemetryEvent,
} from "../../../app/lib/den-telemetry";
import { sanitizeDiagnosticString } from "../../../app/lib/diagnostic-sanitizer";
import type {
  OpenworkCloudMcpFailure,
  OpenworkCloudMcpHealth,
} from "../../../app/lib/openwork-server";

type CloudMcpFailureSummary = Pick<OpenworkCloudMcpFailure, "code" | "stage" | "retryable">;
type CloudMcpTelemetryTrack = (type: string, fields: TelemetryEventFields) => void;

const lastReportedFingerprintByTarget = new Map<string, string>();
const SAFE_DIMENSION_VALUE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;
const SAFE_VERSION_PATTERN = /^[a-z0-9][a-z0-9.+_() -]{0,39}$/iu;
const CLOUD_MCP_FAILURE_CODES = new Set([
  "cloud_desired_missing",
  "cloud_mcp_missing",
  "cloud_mcp_disabled",
  "cloud_endpoint_invalid",
  "cloud_token_org_mismatch",
  "cloud_mcp_needs_auth",
  "invalid_mcp_token",
  "missing_mcp_token",
  "mcp_session_revoked",
  "mcp_membership_revoked",
  "insufficient_mcp_scope",
  "wrong_mcp_resource",
  "workspace_directory_ambiguous",
  "opencode_unconfigured",
  "opencode_engine_unreachable",
  "opencode_unreachable",
  "opencode_mcp_sync_failed",
  "cloud_status_missing",
  "cloud_disabled",
  "openwork_cloud_auth_required",
  "openwork_cloud_auth_invalid",
  "openwork_cloud_token_expired",
  "openwork_cloud_membership_required",
  "openwork_cloud_scope_missing",
  "openwork_cloud_resource_forbidden",
  "openwork_cloud_resource_not_found",
  "openwork_cloud_client_registration_required",
  "cloud_connection_failed",
  "cloud_registration_failed",
  "cloud_tools_denied",
  "opencode_tool_ids_unsupported",
  "opencode_tool_ids_unavailable",
  "cloud_tools_missing",
  "provider_projection_unavailable",
  "provider_projection_missing",
  "provider_tool_projection_missing",
  "extensions_plugin_missing",
  "probe_unreachable",
  "cloud_mcp_token_mint_failed",
  "cloud_mcp_maintenance_failed",
]);
const CLOUD_MCP_FAILURE_STAGES = new Set([
  "prerequisites",
  "token_mint",
  "desired_config",
  "engine_delivery",
  "transport_auth",
  "tool_registration",
  "provider_projection",
  "plugin_load",
  "steering",
  "desired",
  "workspace",
  "configuration",
  "registration",
  "engine_status",
  "tool_ids",
  "plugin_canary",
]);
const CLOUD_MCP_HEALTH_PHASES = new Set([
  "missing_desired",
  "workspace_ambiguous",
  "engine_unconfigured",
  "engine_unreachable",
  "engine_missing",
  "engine_disabled",
  "engine_needs_auth",
  "engine_needs_client_registration",
  "engine_failed",
  "registration_failed",
  "denied_by_tools",
  "tool_ids_unsupported",
  "cloud_tools_missing",
  "provider_projection_missing",
  "extensions_plugin_missing",
  "ready",
]);
const CLOUD_MCP_ENGINE_STATUSES = new Set([
  "not_checked",
  "missing",
  "connected",
  "disabled",
  "failed",
  "needs_auth",
  "needs_client_registration",
  "unreachable",
  "unknown",
]);
const CLOUD_MCP_DELIVERY_STATES = new Set([
  "not_desired",
  "pending",
  "registering",
  "ready",
  "failed",
  "stale",
]);
const CLOUD_MCP_PROBE_STEPS = new Set(["initialize", "initialized_notice", "tools_list"]);

function safeDimensionValue(value: unknown, fallback: string): string {
  const sanitized = sanitizeDiagnosticString(String(value ?? "")).trim().toLowerCase();
  const normalized = sanitized
    .replace(/[^a-z0-9_.:-]+/gu, "_")
    .replace(/^[_:.-]+|[_:.-]+$/gu, "")
    .slice(0, 128);
  return SAFE_DIMENSION_VALUE_PATTERN.test(normalized) ? normalized : fallback;
}

function dimension(type: string, value: unknown, fallback = "unknown"): TelemetryDimensionInput {
  const safeValue = safeDimensionValue(value, fallback);
  return { type, value: safeValue, label: safeValue };
}

function allowlistedDimensionValue(value: unknown, allowed: ReadonlySet<string>, fallback: string): string {
  const safeValue = safeDimensionValue(value, fallback);
  return allowed.has(safeValue) ? safeValue : fallback;
}

function directProbeSummary(health: OpenworkCloudMcpHealth | null): string {
  const direct = health?.tools?.direct;
  if (!direct?.checked && !direct?.trace) return "not_checked";
  const failedStep = direct.trace?.steps.find((step) => !step.ok);
  if (failedStep) {
    const step = allowlistedDimensionValue(failedStep.step, CLOUD_MCP_PROBE_STEPS, "unknown_step");
    return failedStep.httpStatus === undefined
      ? `${step}_failed`
      : `${step}_http_${failedStep.httpStatus}`;
  }
  return direct.checked && direct.missing.length === 0 && direct.present.length > 0
    ? "passed"
    : "failed";
}

function safeVersion(value: unknown): string {
  const sanitized = sanitizeDiagnosticString(String(value ?? "")).trim().toLowerCase();
  if (!SAFE_VERSION_PATTERN.test(sanitized)) return "unknown";
  return sanitized.replace(/[^a-z0-9_.:-]+/gu, "_").replace(/_+/gu, "_").slice(0, 40);
}

function compatibilityVersions(health: OpenworkCloudMcpHealth | null): string {
  const appVersion = health?.compatibility?.openwork.app?.version;
  const serverVersion = health?.compatibility?.openwork.serverVersion;
  const engineVersion = health?.compatibility?.opencode.actualVersion;
  return [
    `app_${safeVersion(appVersion)}`,
    `server_${safeVersion(serverVersion)}`,
    `engine_${safeVersion(engineVersion)}`,
  ].join("__");
}

export function buildCloudMcpFailureTelemetryDimensions(input: {
  issue: CloudMcpFailureSummary;
  health: OpenworkCloudMcpHealth | null;
}): TelemetryDimensionInput[] {
  return [
    dimension(
      "cloud_mcp.failure_code",
      allowlistedDimensionValue(input.issue.code, CLOUD_MCP_FAILURE_CODES, "connect_failure"),
    ),
    dimension(
      "cloud_mcp.failure_stage",
      allowlistedDimensionValue(input.issue.stage, CLOUD_MCP_FAILURE_STAGES, "unknown"),
    ),
    dimension("cloud_mcp.retryable", input.issue.retryable ? "true" : "false"),
    dimension(
      "cloud_mcp.health_phase",
      allowlistedDimensionValue(input.health?.phase, CLOUD_MCP_HEALTH_PHASES, "unknown"),
    ),
    dimension(
      "cloud_mcp.engine_status",
      allowlistedDimensionValue(input.health?.engine?.status, CLOUD_MCP_ENGINE_STATUSES, "unknown"),
    ),
    dimension(
      "cloud_mcp.delivery_state",
      allowlistedDimensionValue(input.health?.delivery?.state, CLOUD_MCP_DELIVERY_STATES, "unknown"),
    ),
    dimension("cloud_mcp.direct_probe", directProbeSummary(input.health)),
    dimension("cloud_mcp.versions", compatibilityVersions(input.health)),
  ];
}

export function reportCloudMcpFailureToSentry(input: {
  targetKey: string;
  issue: CloudMcpFailureSummary;
  health: OpenworkCloudMcpHealth | null;
  track?: CloudMcpTelemetryTrack;
}): boolean {
  const dimensions = buildCloudMcpFailureTelemetryDimensions(input);
  const fingerprint = dimensions.map((item) => `${item.type}=${item.value}`).join("|");
  if (lastReportedFingerprintByTarget.get(input.targetKey) === fingerprint) return false;

  try {
    (input.track ?? trackTelemetryEvent)("connect.mcp_failed", {
      success: false,
      ...(typeof input.health?.durationMs === "number" && Number.isFinite(input.health.durationMs)
        ? { durationMs: Math.min(86_400_000, Math.max(0, Math.round(input.health.durationMs))) }
        : {}),
      dimensions,
    });
    lastReportedFingerprintByTarget.set(input.targetKey, fingerprint);
    return true;
  } catch {
    return false;
  }
}

export function clearCloudMcpSentryFailure(targetKey: string): void {
  lastReportedFingerprintByTarget.delete(targetKey);
}
