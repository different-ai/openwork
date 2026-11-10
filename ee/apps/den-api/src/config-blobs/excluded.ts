/**
 * Every org-scoped SQL table that no config-blob area owns, and why.
 * `pnpm --filter @openwork-ee/den-api config-blobs:coverage` fails when an
 * org-scoped table is neither owned by an area (`ConfigArea.tables`) nor
 * listed here, or is in both. A new table needs a decision: add it to an
 * area, or list it here with a reason.
 *
 * Source: docs/features/config-blobs/inventory.md and delete-organization.ts.
 * Tables owned by the v1 areas (CONFIG_AREA_KEYS) are deliberately absent.
 */

export type ConfigExclusionReason =
  /** Runs, events, queues, leases, usage, logs, caches: produced by use, not configured. */
  | "runtime"
  /** Holds credentials or tokens only; secrets never travel in a blob. */
  | "secret"
  /** Belongs to one member (sign-ins, personal keys, their agent). */
  | "personal"
  /** Commercial state. */
  | "billing"
  /** Owned by the platform operator or OpenWork staff, not the tenant. */
  | "platform"
  /** Configuration we intend to export in a later phase (inventory.md 🔜). */
  | "not_yet"
  /** The config blob feature's own bookkeeping. */
  | "config_blobs_internal"

export type ConfigExclusion = { reason: ConfigExclusionReason; note?: string }

export const CONFIG_BLOB_EXCLUDED_TABLES: Record<string, ConfigExclusion> = {
  // Config blobs' own tables.
  config_change_request: { reason: "config_blobs_internal" },
  config_apply_run: { reason: "config_blobs_internal" },
  config_blob_alias: { reason: "config_blobs_internal" },
  config_blob_export: { reason: "config_blobs_internal" },

  // Members: later phases.
  scim_group: { reason: "runtime", note: "owned by the IdP through SCIM" },
  scim_group_member: { reason: "runtime", note: "owned by the IdP through SCIM" },
  scim_group_role: { reason: "runtime", note: "pushed by the identity provider over SCIM; exported read-only by settings.auth-security" },
  scim_group_role_grant: { reason: "runtime", note: "pushed by the identity provider over SCIM" },
  scim_user_tombstone: { reason: "runtime" },
  scim_sync_event: { reason: "runtime" },
  external_identity: { reason: "runtime", note: "SSO / SCIM identity links, per instance" },

  // AI Gateway.
  gateway_provider_credentials: { reason: "secret", note: "written through ai-gateway.providers $secret placeholders" },
  gateway_provider_oauth_states: { reason: "runtime" },
  gateway_litellm_issued_keys: { reason: "secret", note: "keys issued in an organization's LiteLLM proxy" },
  gateway_keys: { reason: "personal", note: "member gateway keys" },
  gateway_request_logs: { reason: "runtime" },
  gateway_usage_rollups: { reason: "runtime" },
  gateway_usage_audit: { reason: "runtime" },
  gateway_usage_bucket: { reason: "runtime" },
  gateway_usage_bucket_charge: { reason: "runtime" },
  gateway_usage_consumption_event: { reason: "runtime" },
  gateway_usage_quarantine: { reason: "runtime" },
  gateway_usage_reset_request: { reason: "runtime" },
  gateway_usage_subject: { reason: "runtime" },
  gateway_usage_tracking: { reason: "runtime" },
  auto_router_reasoning: { reason: "runtime", note: "per-turn routing state" },
  inference_org_limit_policies: { reason: "runtime", note: "derived from the subscription tier and seat count; no admin setting" },
  inference_org_upstream_provider_keys: { reason: "secret" },
  inference_org_usage_buckets: { reason: "runtime" },
  inference_keys: { reason: "personal", note: "member inference keys" },
  inference_free_usage: { reason: "runtime" },
  inference_usage_ledger_entries: { reason: "runtime" },
  inference_usage_ledger_bucket_charges: { reason: "runtime" },
  llm_provider_member_credential: { reason: "personal", note: "per-member BYOK credentials" },
  free_auto_limit_events: { reason: "runtime" },
  free_auto_purchases: { reason: "billing" },
  models_analytics_event: { reason: "runtime" },
  models_analytics_settings: { reason: "secret", note: "langfuse credentials" },

  // Connectors.
  connected_account: { reason: "personal", note: "per-member sign-ins and tokens" },
  mcp_registration_event: { reason: "runtime" },
  mcp_registration_status: { reason: "runtime" },

  // Plugins, skills, sources.
  connector_source_binding: { reason: "runtime", note: "sync bookkeeping" },
  connector_source_tombstone: { reason: "runtime", note: "sync bookkeeping" },
  connector_sync_event: { reason: "runtime" },
  connector_target_reconcile: { reason: "runtime" },

  // Workbot and "Your agent".
  slack_assistant_installation: { reason: "secret", note: "signing secret, bot token and a workspace binding" },
  slack_assistant_desktop_handoff: { reason: "runtime" },
  agent_instance: { reason: "personal", note: "one per member" },
  agent_member_check: { reason: "runtime" },
  agent_check: { reason: "runtime" },
  agent_delivery: { reason: "runtime" },

  // Settings.
  session_sso_authentication: { reason: "runtime" },
  session_sso_proof: { reason: "runtime" },
  audit_state: { reason: "runtime" },
  audit_event: { reason: "runtime" },
  audit_event_resource: { reason: "runtime" },
  audit_operation: { reason: "runtime" },
  audit_operation_step: { reason: "runtime" },
  audit_usage_fact: { reason: "runtime" },
  organization_diagnostic_credential: { reason: "secret" },
  org_subscriptions: { reason: "billing" },
  organization_benefit_setting: { reason: "billing" },
  organization_grant: { reason: "billing", note: "platform-granted benefits" },
  organization_feature: { reason: "platform", note: "feature flags are owned by platform admins" },
  feature_change: { reason: "platform", note: "flag change history" },

  // Personal work and runtime.
  automation: { reason: "personal", note: "My Automations" },
  automation_runner: { reason: "runtime" },
  automation_runner_notification: { reason: "runtime" },
  artifact_view: { reason: "personal", note: "Apps; a later personal blob" },
  artifact_view_revision: { reason: "personal" },
  dashboard_app: { reason: "personal" },
  workflow_run: { reason: "runtime" },
  remote_session_command: { reason: "runtime" },
  remote_session_request: { reason: "runtime" },
  headless_session_index: { reason: "runtime" },
  headless_resume_grant: { reason: "runtime" },
  headless_resume_revocation: { reason: "runtime" },
  temp_file: { reason: "runtime" },
  worker: { reason: "runtime" },
  desktop_startup_report: { reason: "runtime" },
  telemetry_event: { reason: "runtime" },
  telemetry_session_dimension: { reason: "runtime" },
  capability_usage_event: { reason: "runtime" },
  capability_usage_rollups: { reason: "runtime" },
  feature_usage: { reason: "runtime" },
  feature_intro_state: { reason: "personal" },
  install_link: { reason: "runtime", note: "retired install links" },
  workspace_bootstrap: { reason: "runtime" },
  workspace_claim: { reason: "runtime" },
  workspace_claim_code: { reason: "runtime" },
  deviceCode: { reason: "runtime" },
  sandbox_organization: { reason: "platform" },
  managed_deployment: { reason: "platform", note: "operator state" },
  account_follow_up: { reason: "platform", note: "platform-admin sales follow-up" },
  account_follow_up_action: { reason: "platform" },
}

/**
 * Org-scoped tables with no `organization_id` / `org_id` column of their own
 * (scoped through a parent row). The coverage check adds them to the tables it
 * enumerates from the schema, so child tables of exported resources must be
 * owned by the same area or excluded too.
 */
export const CONFIG_BLOB_ORG_SCOPED_CHILD_TABLES: readonly string[] = [
  "organization",
  "team_member",
  "gateway_provider_models",
  "gateway_model_groups",
  "gateway_model_group_models",
  "gateway_credential_sets",
  "gateway_provider_access",
  "llm_provider_model",
  "llm_provider_access",
]
