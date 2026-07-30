import { captureException } from "../../observability/runtime.js"

type TelemetryDimension = {
  type: string
  value?: string
  label: string
  metadata?: Record<string, unknown>
}

type TelemetrySentryEvent = {
  type: string
  source?: string
  durationMs?: number
  dimensions?: TelemetryDimension[]
}

type CaptureException = (
  error: unknown,
  fields?: Readonly<Record<string, unknown>>,
) => void

const CLOUD_MCP_CONTEXT_FIELDS = new Map([
  ["cloud_mcp.failure_code", "failure_code"],
  ["cloud_mcp.failure_stage", "failure_stage"],
  ["cloud_mcp.retryable", "retryable"],
  ["cloud_mcp.health_phase", "health_phase"],
  ["cloud_mcp.engine_status", "engine_status"],
  ["cloud_mcp.delivery_state", "delivery_state"],
  ["cloud_mcp.direct_probe", "direct_probe"],
  ["cloud_mcp.versions", "versions"],
])
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
])
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
])
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
])
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
])
const CLOUD_MCP_DELIVERY_STATES = new Set([
  "not_desired",
  "pending",
  "registering",
  "ready",
  "failed",
  "stale",
])
const DIRECT_PROBE_PATTERN = /^(?:not_checked|passed|failed|(?:initialize|initialized_notice|tools_list)_(?:failed|http_[1-5][0-9]{2}))$/u
const VERSIONS_PATTERN = /^app_[a-z0-9][a-z0-9_.:-]{0,39}__server_[a-z0-9][a-z0-9_.:-]{0,39}__engine_[a-z0-9][a-z0-9_.:-]{0,39}$/u

function allowlistedValue(value: string, allowed: ReadonlySet<string>, fallback: string) {
  return allowed.has(value) ? value : fallback
}

function safeContextValue(type: string, value: string): string | null {
  switch (type) {
    case "cloud_mcp.failure_code":
      return allowlistedValue(value, CLOUD_MCP_FAILURE_CODES, "connect_failure")
    case "cloud_mcp.failure_stage":
      return allowlistedValue(value, CLOUD_MCP_FAILURE_STAGES, "unknown")
    case "cloud_mcp.retryable":
      return value === "true" || value === "false" ? value : "unknown"
    case "cloud_mcp.health_phase":
      return allowlistedValue(value, CLOUD_MCP_HEALTH_PHASES, "unknown")
    case "cloud_mcp.engine_status":
      return allowlistedValue(value, CLOUD_MCP_ENGINE_STATUSES, "unknown")
    case "cloud_mcp.delivery_state":
      return allowlistedValue(value, CLOUD_MCP_DELIVERY_STATES, "unknown")
    case "cloud_mcp.direct_probe":
      return DIRECT_PROBE_PATTERN.test(value) ? value : "unknown"
    case "cloud_mcp.versions":
      return VERSIONS_PATTERN.test(value) ? value : "unknown"
    default:
      return null
  }
}

export class CloudMcpReconciliationFailure extends Error {
  constructor(code: string, stage: string) {
    super(`OpenWork Cloud MCP reconciliation failed: ${code} at ${stage}`)
    this.name = "CloudMcpReconciliationFailure"
  }
}

export function cloudMcpFailureSentryFields(
  event: TelemetrySentryEvent,
): Record<string, string | number | boolean | null> {
  const fields: Record<string, string | number | boolean | null> = {
    component: "openwork_cloud_mcp",
    event_type: "connect.mcp_failed",
    source: event.source === "app" ? "app" : "unknown",
    duration_ms: typeof event.durationMs === "number" ? event.durationMs : null,
  }
  for (const item of event.dimensions ?? []) {
    const field = CLOUD_MCP_CONTEXT_FIELDS.get(item.type)
    const value = safeContextValue(item.type, item.value?.trim().toLowerCase() ?? "")
    if (field && value !== null) {
      fields[field] = value
    }
  }
  return fields
}

export function captureTelemetrySentryEvent(
  event: TelemetrySentryEvent,
  capture: CaptureException = captureException,
): boolean {
  if (event.type !== "connect.mcp_failed") return false
  const fields = cloudMcpFailureSentryFields(event)
  const code = typeof fields.failure_code === "string" ? fields.failure_code : "unknown"
  const stage = typeof fields.failure_stage === "string" ? fields.failure_stage : "unknown"
  try {
    capture(new CloudMcpReconciliationFailure(code, stage), fields)
    return true
  } catch {
    return false
  }
}
