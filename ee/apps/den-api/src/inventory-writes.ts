import { AsyncLocalStorage } from "node:async_hooks"

type InventoryWrites = { wrote: boolean; providerInventory: boolean; organizationIds: Set<string> }

const inventoryWrites = new AsyncLocalStorage<InventoryWrites>()

export const PROVIDER_INVENTORY_TABLES: ReadonlySet<string> = new Set([
  "gateway_providers", "gateway_provider_models", "gateway_provider_access", "gateway_provider_credentials",
  "gateway_model_groups", "gateway_model_group_models", "gateway_credential_sets", "gateway_keys",
  "team", "team_member", "member",
])

export const INVENTORY_IRRELEVANT_TABLES: ReadonlySet<string> = new Set([
  "session", "verification", "rate_limit", "jwks", "deviceCode",
  "oauthAccessToken", "oauthRefreshToken", "oauthConsent", "oauthClientAssertion",
  "desktop_handoff_grant", "desktop_connect_grant", "desktop_free_proof_nonces",
  "workspace_claim_code", "lifecycle_email", "temp_file",
  "audit_event", "audit_event_resource", "audit_operation", "audit_operation_step", "audit_state",
  "audit_usage_fact", "platform_audit_event", "telemetry_event", "telemetry_session_dimension",
  "models_analytics_event", "capability_usage_event", "capability_usage_rollup_lock", "capability_usage_rollups",
  "gateway_request_logs", "gateway_usage_audit", "gateway_usage_bucket", "gateway_usage_bucket_charge",
  "gateway_usage_consumption_event", "gateway_usage_rollups", "gateway_usage_tracking", "gateway_usage_subject",
  "gateway_rollup_lock", "workbot_usage_day", "inference_org_usage_buckets", "inference_usage_ledger_bucket_charges",
  "inference_usage_ledger_entries", "inference_free_usage", "inference_free_usage_buckets",
  "anonymous_inference_identities", "anonymous_inference_rate_buckets", "anonymous_inference_usage",
  "anonymous_inference_usage_buckets",
  "free_auto_limit_events", "free_auto_purchases",
  "automation_runner", "automation_runner_notification", "automation_run", "automation_run_event", "workflow_run",
  "computer_disconnection",
  "mcp_event_turn", "mcp_event_subscription", "mcp_event_receipt",
  "remote_session_command", "remote_session_request", "daytona_sandbox", "cloud_runtime_instance",
  "managed_deployment_event", "managed_deployment_health", "managed_deployment_run",
  "connector_sync_event", "scim_sync_event",
  "slack_assistant_event", "slack_assistant_run_token", "slack_assistant_thread",
])

const WRITTEN_TABLE = /^\s*(?:insert\s+(?:ignore\s+)?into|replace\s+into|update(?:\s+ignore)?|delete\s+from)\s+`?([A-Za-z0-9_]+)`?/i
const ORGANIZATION_ID = /^org_[0-9a-z]{26}$/

export function trackInventoryWrites<T>(writes: InventoryWrites, run: () => Promise<T>): Promise<T> {
  return inventoryWrites.run(writes, run)
}

export function emptyInventoryWrites(): InventoryWrites {
  return { wrote: false, providerInventory: false, organizationIds: new Set() }
}

export function noteInventoryWrite(query: string, params: unknown[]) {
  const writes = inventoryWrites.getStore()
  if (!writes) return
  const table = WRITTEN_TABLE.exec(query)?.[1]
  if (!table || INVENTORY_IRRELEVANT_TABLES.has(table)) return
  writes.wrote = true
  if (PROVIDER_INVENTORY_TABLES.has(table)) writes.providerInventory = true
  for (const param of params) {
    if (typeof param === "string" && ORGANIZATION_ID.test(param)) writes.organizationIds.add(param)
  }
}

export function inventoryRevisionsToBump(writes: InventoryWrites, requestOrganizationId: string | null | undefined): string[] {
  if (!writes.wrote) return []
  const organizationIds = new Set(writes.organizationIds)
  if (requestOrganizationId && ORGANIZATION_ID.test(requestOrganizationId)) organizationIds.add(requestOrganizationId)
  return [...organizationIds]
}

type InventoryChangeListener = (organizationIds: readonly string[]) => void

const inventoryChangeListeners = new Set<InventoryChangeListener>()

export function onInventoryChanged(listener: InventoryChangeListener): () => void {
  inventoryChangeListeners.add(listener)
  return () => inventoryChangeListeners.delete(listener)
}

export function notifyInventoryChanged(organizationIds: readonly string[]) {
  if (organizationIds.length === 0) return
  for (const listener of inventoryChangeListeners) {
    try {
      listener(organizationIds)
    } catch (error) {
      console.error("inventory_change_listener_failed", { error })
    }
  }
}
