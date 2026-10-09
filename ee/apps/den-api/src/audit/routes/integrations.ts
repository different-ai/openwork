// Integrations slice: capability sources (Google Workspace, Microsoft 365), connectors,
// MCP connections, OAuth providers, inference/LLM providers, gateway limits, analytics,
// Slack assistant and Apps. One declaration per live route except the 14 provider routes
// generated as domain_provider from coverage.ts providerCoveredRoutes:
//   POST /v1/inference-providers
//   PATCH|DELETE /v1/inference-providers/:inferenceProviderId
//   POST /v1/inference-providers/:inferenceProviderId/enable-models
//   POST /v1/inference-providers/:inferenceProviderId/model-groups
//   PATCH|DELETE /v1/inference-providers/:inferenceProviderId/model-groups/:groupId
//   POST /v1/inference-providers/:inferenceProviderId/credential-sets
//   PATCH|DELETE /v1/inference-providers/:inferenceProviderId/credential-sets/:credentialSetId
//   POST /v1/inference-providers/:inferenceProviderId/access-grants
//   PATCH|DELETE /v1/inference-providers/:inferenceProviderId/access-grants/:grantId
//   DELETE /v1/inference-providers/:inferenceProviderId/access/:grantId
import type { AuditRouteAttribution, AuditRouteClass, AuditRouteDeclaration, AuditRouteMethod } from "./types.js"

type Resource = AuditRouteDeclaration["resource"]
type Extra = Pick<AuditRouteDeclaration, "external" | "jobOutcome" | "notes">

const res = (type: string, idParam: string | null = null): Resource => ({ type, idParam })

function route(cls: AuditRouteClass, method: AuditRouteMethod, path: string, action: string, kind: string, resource: Resource, attribution: AuditRouteAttribution, extra: Extra = {}): AuditRouteDeclaration {
  return { method, path, class: cls, action, kind, resource, attribution, ...extra }
}
const read = (path: string, action: string, kind: string, resource: Resource, notes?: string) =>
  route("tenant_read", "GET", path, action, kind, resource, "org_context", notes ? { notes } : {})
const access = (method: AuditRouteMethod, path: string, action: string, kind: string, resource: Resource, notes?: string) =>
  route("tenant_access", method, path, action, kind, resource, "org_context", notes ? { notes } : {})
const change = (method: AuditRouteMethod, path: string, action: string, kind: string, resource: Resource, notes?: string) =>
  route("tenant_change", method, path, action, kind, resource, "org_context", notes ? { notes } : {})
const external = (method: AuditRouteMethod, path: string, action: string, kind: string, resource: Resource, system: string, notes?: string) =>
  route("tenant_external", method, path, action, kind, resource, "org_context", { external: system, ...(notes ? { notes } : {}) })
const job = (method: AuditRouteMethod, path: string, action: string, kind: string, resource: Resource, jobOutcome: string, attribution: AuditRouteAttribution = "org_context", notes?: string) =>
  route("tenant_job", method, path, action, kind, resource, attribution, { jobOutcome, ...(notes ? { notes } : {}) })
/** Token/signature/state routes: the handler calls attributeAuditRequest() after verification and before the effect. */
const handlerRoute = (cls: AuditRouteClass, method: AuditRouteMethod, path: string, action: string, kind: string, resource: Resource, extra: Extra) =>
  route(cls, method, path, action, kind, resource, "handler", extra)
const support = (path: string, scope: string, notes: string) => route("support", "ALL", path, `middleware.context_storage.${scope}`, "support.middleware", res("none"), "none", { notes })

const GW = "/v1/capabilities/google-workspace"
const MS = "/v1/capabilities/microsoft-365"
const GWK = "capability.google_workspace"
const MSK = "capability.microsoft_365"
const GOOGLE = "Google Workspace API (member's delegated account)"
const GRAPH = "Microsoft Graph (member's delegated account)"
const CAP = "Acts on the caller's own external account; conditional OAuth token refresh persists refreshed tokens; agents reach it via internal re-entry (origin mcp)."
const CAP_CONTENT = `${CAP} Response carries user content.`
const SYNC_OUTCOME = "connector_sync.completed (job operation jobRunId = connector_sync_event id, counts only) via src/workers/github-sync.ts:processDueGithubSyncEvents → recordConnectorSyncCompleted when the event is terminal (see src/audit/job-outcomes.ts)"
const CONN = "connector.configuration"
const GH = "connector.github"
const GUL = "gateway_usage_limit.management"
const INF = "inference.configuration"
const IP = "inference_provider.configuration"
const IPO = "inference_provider.member_oauth"
const LITELLM = "Organization's LiteLLM proxy (admin API: key creation/deletion in issued mode)"
const MA = "models_analytics.reporting"
const LLM = "llm_provider.configuration"
const LLMC = "llm_provider.member_credential"
const MCP = "mcp_connection.configuration"
const MCPO = "mcp_connection.oauth"
const OAP = "oauth_provider.connection"
const SLACK = "slack_assistant.configuration"
const APP = "app.management"

export const integrationsAuditRoutes: readonly AuditRouteDeclaration[] = [
  support(`${GW}/*`, "capabilities_google_workspace", "app.use contextStorage so token resolvers can read signed internal capability headers; concrete handlers are declared."),
  support(`${MS}/*`, "capabilities_microsoft_365", "app.use contextStorage for the Microsoft token resolver; concrete handlers are declared."),
  support("/v1/direct-uploads/google-workspace/*", "direct_uploads_google_workspace", "app.use contextStorage for direct-upload handlers; concrete handlers are declared."),

  // Google Workspace capabilities
  read(`${GW}/gmail-labels`, "capability.gmail.label.list", GWK, res("gmail_label"), CAP),
  access("GET", `${GW}/gmail-messages`, "capability.gmail.message.search", GWK, res("gmail_message"), CAP_CONTENT),
  access("GET", `${GW}/gmail-message/:messageId`, "capability.gmail.message.read", GWK, res("gmail_message", "messageId"), CAP_CONTENT),
  access("GET", `${GW}/gmail-attachment/:messageId/:attachmentId`, "capability.gmail.attachment.download", GWK, res("gmail_attachment", "attachmentId"), `${CAP} Response carries attachment bytes.`),
  access("GET", `${GW}/gmail-drafts`, "capability.gmail.draft.list", GWK, res("gmail_draft"), CAP_CONTENT),
  access("GET", `${GW}/gmail-draft/:draftId`, "capability.gmail.draft.read", GWK, res("gmail_draft", "draftId"), `${CAP} Response carries draft content incl. raw MIME.`),
  external("POST", `${GW}/gmail-drafts`, "capability.gmail.draft.create", GWK, res("gmail_draft"), GOOGLE, CAP),
  external("PUT", `${GW}/gmail-draft/:draftId`, "capability.gmail.draft.update", GWK, res("gmail_draft", "draftId"), GOOGLE, `${CAP} Response echoes the draft.`),
  external("DELETE", `${GW}/gmail-draft/:draftId`, "capability.gmail.draft.delete", GWK, res("gmail_draft", "draftId"), GOOGLE, CAP),
  external("POST", `${GW}/gmail-draft/:draftId/send`, "capability.gmail.draft.send", GWK, res("gmail_draft", "draftId"), GOOGLE, `${CAP} Sends email.`),
  external("POST", `${GW}/gmail-labels`, "capability.gmail.label.create", GWK, res("gmail_label"), GOOGLE, CAP),
  external("PATCH", `${GW}/gmail-label/:labelId`, "capability.gmail.label.update", GWK, res("gmail_label", "labelId"), GOOGLE, CAP),
  external("DELETE", `${GW}/gmail-label/:labelId`, "capability.gmail.label.delete", GWK, res("gmail_label", "labelId"), GOOGLE, CAP),
  external("POST", `${GW}/gmail-message/:messageId/modify`, "capability.gmail.message.labels.modify", GWK, res("gmail_message", "messageId"), GOOGLE, CAP),
  external("POST", `${GW}/gmail-message/:messageId/trash`, "capability.gmail.message.trash", GWK, res("gmail_message", "messageId"), GOOGLE, CAP),
  external("POST", `${GW}/gmail-message/:messageId/untrash`, "capability.gmail.message.untrash", GWK, res("gmail_message", "messageId"), GOOGLE, CAP),
  access("GET", `${GW}/calendar-events`, "capability.google_calendar.event.list", GWK, res("google_calendar_event"), CAP_CONTENT),
  access("GET", `${GW}/calendar-events/:eventId`, "capability.google_calendar.event.read", GWK, res("google_calendar_event", "eventId"), CAP_CONTENT),
  external("POST", `${GW}/calendar-events`, "capability.google_calendar.event.create", GWK, res("google_calendar_event"), GOOGLE, `${CAP} May send invitations to attendees.`),
  external("PATCH", `${GW}/calendar-events/:eventId`, "capability.google_calendar.event.update", GWK, res("google_calendar_event", "eventId"), GOOGLE, `${CAP} May notify attendees; response echoes event incl. attendees.`),
  external("PATCH", `${GW}/calendar-event/:eventId`, "capability.google_calendar.event.meet.add", GWK, res("google_calendar_event", "eventId"), GOOGLE, `${CAP} Adds a Google Meet conference.`),
  external("DELETE", `${GW}/calendar-events/:eventId`, "capability.google_calendar.event.delete", GWK, res("google_calendar_event", "eventId"), GOOGLE, `${CAP} May notify attendees.`),
  access("GET", `${GW}/drive-files`, "capability.google_drive.file.search", GWK, res("google_drive_file"), `${CAP} Response lists file names and links.`),
  read(`${GW}/drive-files/:fileId`, "capability.google_drive.file.metadata.read", GWK, res("google_drive_file", "fileId"), `${CAP} Metadata only.`),
  access("GET", `${GW}/drive-file/:fileId`, "capability.google_drive.file.read", GWK, res("google_drive_file", "fileId"), `${CAP} Response carries file content.`),
  external("PATCH", `${GW}/drive-files/:fileId`, "capability.google_drive.file.update", GWK, res("google_drive_file", "fileId"), GOOGLE, CAP),
  external("POST", `${GW}/drive-folders`, "capability.google_drive.folder.create", GWK, res("google_drive_file"), GOOGLE, CAP),
  external("POST", `${GW}/drive-file-share/:fileId`, "capability.google_drive.file.share", GWK, res("google_drive_file", "fileId"), GOOGLE, `${CAP} Grants Drive permissions to other principals.`),
  read(`${GW}/spreadsheets/:spreadsheetId`, "capability.google_sheets.spreadsheet.read", GWK, res("google_spreadsheet", "spreadsheetId"), `${CAP} Metadata only.`),
  access("GET", `${GW}/spreadsheets/:spreadsheetId/values`, "capability.google_sheets.values.read", GWK, res("google_spreadsheet", "spreadsheetId"), CAP_CONTENT),
  external("POST", `${GW}/spreadsheets`, "capability.google_sheets.spreadsheet.create", GWK, res("google_spreadsheet"), GOOGLE, CAP),
  external("PUT", `${GW}/spreadsheets/:spreadsheetId/values`, "capability.google_sheets.values.update", GWK, res("google_spreadsheet", "spreadsheetId"), GOOGLE, CAP),
  external("POST", `${GW}/spreadsheets/:spreadsheetId/values/append`, "capability.google_sheets.values.append", GWK, res("google_spreadsheet", "spreadsheetId"), GOOGLE, CAP),
  external("POST", `${GW}/drive-upload-sessions`, "capability.google_drive.upload.prepare", GWK, res("google_drive_file"), GOOGLE, `${CAP} Returns a secret resumable upload URL; no file bytes or session URL are captured in audit evidence.`),
  external("POST", "/v1/direct-uploads/google-workspace/drive-upload-sessions", "capability.google_drive.host_upload.prepare", GWK, res("google_drive_file"), GOOGLE, "cloudTransportRoute; host prepares a selected-account resumable session, bytes bypass Den. Session URL is not audit evidence."),
  external("POST", "/v1/direct-uploads/google-workspace/drive-files", "capability.google_drive.file.upload", GWK, res("google_drive_file"), GOOGLE, "cloudTransportRoute (MCP OAuth token, org from token); host file transport, bytes not echoed. Conditional token refresh write."),
  external("POST", "/v1/direct-uploads/google-workspace/gmail-drafts", "capability.gmail.draft.attachments.create", GWK, res("gmail_draft"), GOOGLE, "cloudTransportRoute (MCP OAuth token, org from token); creates a draft with attachments, never sends. Conditional token refresh write."),

  // Microsoft 365 capabilities
  access("GET", `${MS}/mail-messages`, "capability.outlook_mail.message.search", MSK, res("outlook_message"), CAP_CONTENT),
  access("GET", `${MS}/mail-message/:messageId`, "capability.outlook_mail.message.read", MSK, res("outlook_message", "messageId"), CAP_CONTENT),
  external("PATCH", `${MS}/mail-message/:messageId`, "capability.outlook_mail.message.update", MSK, res("outlook_message", "messageId"), GRAPH, CAP),
  external("POST", `${MS}/mail-message/:messageId/move`, "capability.outlook_mail.message.move", MSK, res("outlook_message", "messageId"), GRAPH, CAP),
  external("POST", `${MS}/mail-message/:messageId/reply-draft`, "capability.outlook_mail.reply_draft.create", MSK, res("outlook_message", "messageId"), GRAPH, CAP),
  external("POST", `${MS}/mail-drafts`, "capability.outlook_mail.draft.create", MSK, res("outlook_message"), GRAPH, CAP),
  external("POST", `${MS}/mail-drafts/:messageId/send`, "capability.outlook_mail.draft.send", MSK, res("outlook_message", "messageId"), GRAPH, `${CAP} Sends email.`),
  access("GET", `${MS}/calendar-events`, "capability.outlook_calendar.event.list", MSK, res("outlook_calendar_event"), CAP_CONTENT),
  external("POST", `${MS}/calendar-events`, "capability.outlook_calendar.event.create", MSK, res("outlook_calendar_event"), GRAPH, `${CAP} May send invitations to attendees.`),
  external("PATCH", `${MS}/calendar-events/:eventId`, "capability.outlook_calendar.event.update", MSK, res("outlook_calendar_event", "eventId"), GRAPH, `${CAP} May notify attendees; response echoes event.`),
  external("DELETE", `${MS}/calendar-events/:eventId`, "capability.outlook_calendar.event.delete", MSK, res("outlook_calendar_event", "eventId"), GRAPH, CAP),
  external("POST", `${MS}/calendar-events/:eventId/cancel`, "capability.outlook_calendar.event.cancel", MSK, res("outlook_calendar_event", "eventId"), GRAPH, `${CAP} Notifies attendees.`),
  access("GET", `${MS}/drive-files`, "capability.onedrive.file.search", MSK, res("onedrive_item"), `${CAP} Response lists file names and links.`),
  access("GET", `${MS}/drive-file/:itemId`, "capability.onedrive.file.read", MSK, res("onedrive_item", "itemId"), `${CAP} Response carries file content.`),
  external("PATCH", `${MS}/drive-file/:itemId`, "capability.onedrive.item.update", MSK, res("onedrive_item", "itemId"), GRAPH, CAP),
  external("PUT", `${MS}/drive-files`, "capability.onedrive.file.write", MSK, res("onedrive_item"), GRAPH, CAP),
  external("POST", `${MS}/drive-folders`, "capability.onedrive.folder.create", MSK, res("onedrive_item"), GRAPH, CAP),
  access("GET", `${MS}/teams-chats`, "capability.teams.chat.list", MSK, res("teams_chat"), `${CAP} Response lists chat names and participants.`),
  access("GET", `${MS}/teams-chats/:chatId/messages`, "capability.teams.chat_message.list", MSK, res("teams_chat", "chatId"), CAP_CONTENT),
  external("POST", `${MS}/teams-chats/:chatId/messages`, "capability.teams.chat_message.send", MSK, res("teams_chat", "chatId"), GRAPH, `${CAP} Posts a Teams message.`),

  // Apps
  read("/v1/apps", "app.list", APP, res("artifact_view")),
  access("GET", "/v1/apps/:appId", "app.open", "app.access", res("artifact_view", "appId"), "Live apps execute their workflow (tool calls, run receipt write); response carries workflow result data and compiled HTML."),
  change("POST", "/v1/apps/:appId/dashboard", "app.dashboard.update", APP, res("artifact_view", "appId")),
  change("POST", "/v1/apps/:appId/save", "app.revision.activate", APP, res("artifact_view", "appId")),
  change("POST", "/v1/apps/:appId/share", "app.share", APP, res("artifact_view", "appId"), "Grants another member access (security relevant)."),

  // Connectors (plugin system)
  read("/v1/connector-accounts", "connector_account.list", CONN, res("connector_account")),
  read("/v1/connector-accounts/:connectorAccountId", "connector_account.read", CONN, res("connector_account", "connectorAccountId")),
  change("POST", "/v1/connector-accounts", "connector_account.create", CONN, res("connector_account")),
  change("POST", "/v1/connector-accounts/:connectorAccountId/disconnect", "connector_account.disconnect", CONN, res("connector_account", "connectorAccountId"), "Cascading local delete; does not uninstall the GitHub App."),
  read("/v1/connector-instances", "connector_instance.list", CONN, res("connector_instance")),
  read("/v1/connector-instances/:connectorInstanceId", "connector_instance.read", CONN, res("connector_instance", "connectorInstanceId")),
  read("/v1/connector-instances/:connectorInstanceId/configuration", "connector_instance.configuration.read", CONN, res("connector_instance", "connectorInstanceId")),
  read("/v1/connector-instances/:connectorInstanceId/discovery", "connector_instance.discovery.read", CONN, res("connector_instance", "connectorInstanceId"), "Calls GitHub; may persist a discovery cache to the target config (read-with-write)."),
  read("/v1/connector-instances/:connectorInstanceId/discovery/tree", "connector_instance.discovery_tree.list", CONN, res("connector_instance", "connectorInstanceId"), "May call GitHub and persist a discovery cache (read-with-write)."),
  read("/v1/connector-instances/:connectorInstanceId/access", "connector_instance.access_grant.list", CONN, res("connector_instance", "connectorInstanceId")),
  read("/v1/connector-instances/:connectorInstanceId/targets", "connector_target.list", CONN, res("connector_instance", "connectorInstanceId")),
  change("POST", "/v1/connector-instances", "connector_instance.create", CONN, res("connector_instance")),
  change("PATCH", "/v1/connector-instances/:connectorInstanceId", "connector_instance.update", CONN, res("connector_instance", "connectorInstanceId")),
  change("POST", "/v1/connector-instances/:connectorInstanceId/access", "connector_instance.access_grant.create", CONN, res("connector_instance", "connectorInstanceId")),
  change("DELETE", "/v1/connector-instances/:connectorInstanceId/access/:grantId", "connector_instance.access_grant.revoke", CONN, res("connector_instance_access_grant", "grantId")),
  change("POST", "/v1/connector-instances/:connectorInstanceId/archive", "connector_instance.archive", CONN, res("connector_instance", "connectorInstanceId")),
  change("POST", "/v1/connector-instances/:connectorInstanceId/disable", "connector_instance.disable", CONN, res("connector_instance", "connectorInstanceId")),
  change("POST", "/v1/connector-instances/:connectorInstanceId/enable", "connector_instance.enable", CONN, res("connector_instance", "connectorInstanceId")),
  change("POST", "/v1/connector-instances/:connectorInstanceId/remove", "connector_instance.remove", CONN, res("connector_instance", "connectorInstanceId"), "Cascading local delete."),
  change("POST", "/v1/connector-instances/:connectorInstanceId/auto-import", "connector_instance.auto_import.update", CONN, res("connector_instance", "connectorInstanceId")),
  change("POST", "/v1/connector-instances/:connectorInstanceId/discovery/apply", "connector_instance.discovery.apply", CONN, res("connector_instance", "connectorInstanceId"), "Reads GitHub; creates plugins/config objects. Also invoked by the GitHub sync worker for auto-import (no HTTP route)."),
  change("POST", "/v1/connector-instances/:connectorInstanceId/targets", "connector_target.create", CONN, res("connector_instance", "connectorInstanceId")),
  job("POST", "/v1/connector-instances/:connectorInstanceId/sync-now", "connector_instance.sync.request", "connector.sync", res("connector_instance", "connectorInstanceId"), SYNC_OUTCOME),
  read("/v1/connector-targets/:connectorTargetId", "connector_target.read", CONN, res("connector_target", "connectorTargetId")),
  change("PATCH", "/v1/connector-targets/:connectorTargetId", "connector_target.update", CONN, res("connector_target", "connectorTargetId")),
  job("POST", "/v1/connector-targets/:connectorTargetId/resync", "connector_target.resync.request", "connector.sync", res("connector_target", "connectorTargetId"), SYNC_OUTCOME),
  read("/v1/connector-targets/:connectorTargetId/mappings", "connector_mapping.list", CONN, res("connector_target", "connectorTargetId")),
  change("POST", "/v1/connector-targets/:connectorTargetId/mappings", "connector_mapping.create", CONN, res("connector_target", "connectorTargetId")),
  change("PATCH", "/v1/connector-mappings/:connectorMappingId", "connector_mapping.update", CONN, res("connector_mapping", "connectorMappingId")),
  change("DELETE", "/v1/connector-mappings/:connectorMappingId", "connector_mapping.delete", CONN, res("connector_mapping", "connectorMappingId")),
  read("/v1/connector-sync-events", "connector_sync_event.list", "connector.sync", res("connector_sync_event")),
  read("/v1/connector-sync-events/:connectorSyncEventId", "connector_sync_event.read", "connector.sync", res("connector_sync_event", "connectorSyncEventId")),
  job("POST", "/v1/connector-sync-events/:connectorSyncEventId/retry", "connector_sync_event.retry", "connector.sync", res("connector_sync_event", "connectorSyncEventId"), SYNC_OUTCOME),
  read("/v1/connectors/github/accounts/:connectorAccountId/repositories", "connector_account.github_repository.list", GH, res("connector_account", "connectorAccountId"), "Calls GitHub and refreshes cached account repository metadata (read-with-write)."),
  change("POST", "/v1/connectors/github/accounts", "connector_account.github.create", GH, res("connector_account")),
  external("POST", "/v1/connectors/github/install/start", "connector_account.github.install.start", GH, res("connector_account"), "GitHub App installation", "Returns install redirect URL and state; reads GitHub App summary."),
  external("POST", "/v1/connectors/github/install/complete", "connector_account.github.install.complete", GH, res("connector_account"), "GitHub App installation", "Verifies the installation with GitHub and creates the local connector account."),
  external("POST", "/v1/connectors/github/setup", "connector.github.setup", GH, res("connector_instance"), "GitHub API", "Multi-resource local create without an enclosing transaction."),
  external("POST", "/v1/connectors/github/validate-target", "connector.github.target.validate", GH, res("connector_target"), "GitHub API", "Read-only GitHub probe; no local write."),

  // Gateway usage limits and usage
  read("/v1/gateway/usage-limit-policies", "gateway_usage_limit.policy.list", GUL, res("gateway_usage_limit_policy")),
  change("POST", "/v1/gateway/usage-limit-policies", "gateway_usage_limit.policy.create", GUL, res("gateway_usage_limit_policy")),
  change("PATCH", "/v1/gateway/usage-limit-policies/:policyId", "gateway_usage_limit.policy.update", GUL, res("gateway_usage_limit_policy", "policyId")),
  change("POST", "/v1/gateway/usage-limit-policies/:policyId/archive", "gateway_usage_limit.policy.archive", GUL, res("gateway_usage_limit_policy", "policyId")),
  change("POST", "/v1/gateway/usage-limit-policies/:policyId/restore", "gateway_usage_limit.policy.restore", GUL, res("gateway_usage_limit_policy", "policyId")),
  read("/v1/gateway/usage-limit-policies/:policyId/assignments", "gateway_usage_limit.assignment.list", GUL, res("gateway_usage_limit_policy", "policyId")),
  change("POST", "/v1/gateway/usage-limit-policies/:policyId/assignments", "gateway_usage_limit.assignment.create", GUL, res("gateway_usage_limit_policy", "policyId")),
  change("DELETE", "/v1/gateway/usage-limit-policies/:policyId/assignments/:assignmentId", "gateway_usage_limit.assignment.delete", GUL, res("gateway_usage_limit_assignment", "assignmentId")),
  read("/v1/gateway/usage-limit-reset-requests", "gateway_usage_limit.reset_request.list", GUL, res("gateway_usage_reset_request")),
  read("/v1/gateway/usage-limit-reset-requests/me", "gateway_usage_limit.reset_request.list_own", GUL, res("gateway_usage_reset_request")),
  change("POST", "/v1/gateway/usage-limit-reset-requests", "gateway_usage_limit.reset_request.create", GUL, res("gateway_usage_reset_request")),
  change("POST", "/v1/gateway/usage-limit-reset-requests/:id/approve", "gateway_usage_limit.reset_request.approve", GUL, res("gateway_usage_reset_request", "id")),
  change("POST", "/v1/gateway/usage-limit-reset-requests/:id/deny", "gateway_usage_limit.reset_request.deny", GUL, res("gateway_usage_reset_request", "id")),
  read("/v1/gateway/usage-limits/me", "gateway_usage_limit.status.read_own", GUL, res("member")),
  read("/v1/gateway/usage-limits/members", "gateway_usage_limit.member.search", GUL, res("member")),
  read("/v1/gateway/usage-limits/members/:memberId", "gateway_usage_limit.status.read", GUL, res("member", "memberId")),
  read("/v1/inference-providers/usage", "gateway_usage.read", "gateway_usage.reporting", res("gateway_usage"), "Aggregate usage/cost per member and team."),

  // Inference settings and free tier
  read("/v1/inference", "inference.settings.read", INF, res("organization")),
  external("PATCH", "/v1/inference", "inference.settings.update", INF, res("organization"), "OpenRouter management API", "Enable/disable creates or deletes the org OpenRouter API key; unsubscribed enable only flips offerAllowed. setInferenceEnabled is also called by Stripe billing webhooks (no tenant route)."),
  read("/v1/inference/access", "inference.free.access.read", "inference.free", res("member")),
  read("/v1/inference/free/provider", "inference.free.provider.read", "inference.free", res("organization")),
  change("PATCH", "/v1/inference/free/pins", "inference.free.pin.update", "inference.free", res("organization")),
  access("POST", "/v1/inference/free/credential", "inference.free.credential.issue", "inference.free", res("inference_key"), "Issues and returns a member inference API key (sensitive response)."),

  // Inference providers (reads, member OAuth, uncovered mutations)
  read("/v1/inference-providers", "inference_provider.list", IP, res("provider")),
  read("/v1/inference-providers/model-management", "inference_provider.model_management.list", IP, res("provider")),
  read("/v1/inference-providers/member-connections", "inference_provider.member_connection.list", IPO, res("provider_credential")),
  read("/v1/inference-providers/:inferenceProviderId", "inference_provider.read", IP, res("provider", "inferenceProviderId"), "Credential metadata incl. member emails; no secrets."),
  read("/v1/inference-providers/:inferenceProviderId/available-models", "inference_provider.available_models.list", IP, res("provider", "inferenceProviderId"), "Reads cached models.dev catalog."),
  read("/v1/inference-providers/:inferenceProviderId/models", "inference_provider.models.list", IP, res("provider", "inferenceProviderId"), "May run refreshGatewayCatalog which writes provider models (audited as provider catalog.refresh)."),
  read("/v1/inference-providers/:inferenceProviderId/model-groups", "inference_provider.model_groups.list", IP, res("provider", "inferenceProviderId")),
  read("/v1/inference-providers/:inferenceProviderId/credential-sets", "inference_provider.credential_sets.list", IP, res("provider", "inferenceProviderId"), "oauthClientId only; no secrets."),
  read("/v1/inference-providers/:inferenceProviderId/access-grants", "inference_provider.access_grants.list", IP, res("provider", "inferenceProviderId")),
  access("GET", "/v1/inference-providers/:inferenceProviderId/connect", "inference_provider.connect", IP, res("provider", "inferenceProviderId"), "Returns member Gateway API key(s); may create the member key in a transaction (read-with-write)."),
  change("GET", "/v1/inference-providers/:inferenceProviderId/oauth/start", "inference_provider.member_oauth.start", IPO, res("provider", "inferenceProviderId"), "Writes OAuth state entry; returns entry URL."),
  handlerRoute("tenant_change", "GET", "/v1/inference-providers/oauth/browser-start", "inference_provider.member_oauth.browser_start", IPO, res("provider_credential_set"), { notes: "Public route. Attributed (attributeMemberOAuthEntry) once the live signed session cookie matches the entry's initiating user and the provider/set/client binding is rechecked: org = provider.organization_id, actor = that user + entry member; before the state rotation write. 302 to Google." }),
  handlerRoute("tenant_read", "GET", "/v1/inference-providers/oauth/browser-status", "inference_provider.member_oauth.browser_status", IPO, res("provider_credential_set"), { notes: "Public poll. Attributed like browser-start once the cookie user matches the entry; sign_in_required/account_mismatch answers stay unattributed (platform store when reads are enabled). No writes." }),
  handlerRoute("tenant_external", "POST", "/v1/inference-providers/oauth/browser-aws-start", "inference_provider.member_oauth.browser_aws_start", IPO, res("provider_credential_set"), { external: "AWS IAM Identity Center OIDC (RegisterClient, StartDeviceAuthorization)", notes: "Public route. Attributed (attributeMemberOAuthEntry) like browser-start once the live signed session cookie matches the entry's initiating user and the provider/set binding and gatewayCloudSignIn feature are rechecked; before the device authorization and the state rotation write." }),
  handlerRoute("tenant_external", "POST", "/v1/inference-providers/oauth/browser-aws-poll", "inference_provider.member_oauth.browser_aws_poll", IPO, res("provider_credential"), { external: "AWS IAM Identity Center (CreateToken, GetRoleCredentials, Logout) and STS GetCallerIdentity", notes: "Public poll. Attributed like browser-aws-start once the cookie user matches the attempt; at most one AWS token request per polling interval. On approval verifies role credentials and identity, then stores the member credential and consumes the attempt." }),
  handlerRoute("tenant_external", "GET", "/v1/inference-providers/oauth/callback", "inference_provider.member_oauth.complete", IPO, res("provider_credential"), { external: "Google OAuth or Microsoft Entra ID (code exchange; Google token revocation on cleanup)", notes: "Attributed after the signed cookie, single-use state and provider/set binding are verified and before the state claim and Google code exchange: org = provider.organization_id, actor = initiating user + member. Failures render HTML 400 or a 302 with an error parameter (a 302 maps to confirmed)." }),
  external("DELETE", "/v1/inference-providers/:inferenceProviderId/oauth", "inference_provider.member_oauth.disconnect", IPO, res("provider", "inferenceProviderId"), "Google OAuth token revocation; AWS IAM Identity Center logout", "Deletes the member credential locally, then best-effort revocation after commit; status reflects the local result."),
  change("POST", "/v1/inference-providers/migrate-from-llm-provider", "inference_provider.llm_provider.migrate", IP, res("provider"), "Not covered by provider emitter (providerUncoveredRoutes)."),

  // LiteLLM providers (litellm feature; not covered by the provider emitter, see providerUncoveredRoutes)
  external("POST", "/v1/inference-providers/litellm", "inference_provider.litellm.create", IP, res("provider"), LITELLM, "Reads the proxy catalog with the write-only organization/admin key, creates the provider, groups and grants locally; issued mode then creates member keys in LiteLLM."),
  external("POST", "/v1/inference-providers/:inferenceProviderId/litellm/sync", "inference_provider.litellm.sync", IP, res("provider", "inferenceProviderId"), LITELLM, "Reads the proxy with the stored key and refreshes models, groups and member assignments locally (a failed read records the sync error); issued mode reconciles member keys in LiteLLM."),
  external("PATCH", "/v1/inference-providers/:inferenceProviderId/litellm", "inference_provider.litellm.update", IP, res("provider", "inferenceProviderId"), LITELLM, "Verifies and stores a replacement write-only key and/or key creation settings, then syncs; issued mode replaces member keys in LiteLLM."),
  change("PUT", "/v1/inference-providers/:inferenceProviderId/litellm/member-key", "inference_provider.litellm.member_key.connect", IPO, res("provider", "inferenceProviderId"), "Verifies the caller's own LiteLLM key with the proxy (read only), stores it as the member credential (write-only) and grants the matching model group."),
  handlerRoute("tenant_change", "POST", "/v1/inference-providers/oauth/browser-litellm-key", "inference_provider.member_oauth.browser_litellm_key", IPO, res("provider_credential"), { notes: "Public route. Attributed (attributeMemberOAuthEntry) like browser-start once the live signed session cookie matches the entry's initiating user and the provider/set binding and litellm feature are rechecked; before key verification and the credential write that consumes the entry." }),
  handlerRoute("tenant_external", "POST", "/v1/inference-providers/oauth/browser-litellm-check", "inference_provider.member_oauth.browser_litellm_check", IPO, res("provider_credential"), { external: LITELLM, notes: "Public route. Attributed like browser-litellm-key once the cookie user matches the entry and the provider/set binding and litellm feature are rechecked; before LiteLLM key creation for that member." }),

  // Models analytics
  access("GET", "/v1/inference/analytics/activity", "models_analytics.activity.list", MA, res("models_analytics_event"), "Per-member task analytics payloads (tool/skill/model metadata)."),
  read("/v1/inference/analytics/consumption", "models_analytics.consumption.read", MA, res("models_analytics_event"), "Aggregates only."),
  read("/v1/inference/analytics/settings", "models_analytics.settings.read", "models_analytics.configuration", res("models_analytics_settings")),
  change("PATCH", "/v1/inference/analytics/settings", "models_analytics.settings.update", "models_analytics.configuration", res("models_analytics_settings")),
  change("POST", "/v1/inference/analytics/langfuse/connect", "models_analytics.export.connect", "models_analytics.configuration", res("models_analytics_export"), "Stores Langfuse credentials (write-only) after a test send to Langfuse; enables the export loop."),
  external("POST", "/v1/inference/analytics/langfuse/test", "models_analytics.export.test", "models_analytics.configuration", res("models_analytics_export"), "Langfuse", "Sends a test event with caller-supplied credentials; no local write."),
  change("DELETE", "/v1/inference/analytics/langfuse", "models_analytics.export.disconnect", "models_analytics.configuration", res("models_analytics_export")),

  // Legacy LLM providers
  read("/v1/llm-provider-catalog", "llm_provider_catalog.list", LLM, res("llm_provider_catalog")),
  read("/v1/llm-provider-catalog/:providerId", "llm_provider_catalog.read", LLM, res("llm_provider_catalog", "providerId")),
  read("/v1/llm-providers", "llm_provider.list", LLM, res("llm_provider"), "May repair member inference access (conditional local write); apiKey stripped."),
  read("/v1/llm-providers/:llmProviderId", "llm_provider.read", LLM, res("llm_provider", "llmProviderId")),
  read("/v1/llm-providers/by-key/:externalKey", "llm_provider.by_key.read", LLM, res("llm_provider", "externalKey")),
  access("GET", "/v1/llm-providers/:llmProviderId/connect", "llm_provider.connect", LLM, res("llm_provider", "llmProviderId"), "Returns decrypted provider API key(s)."),
  read("/v1/llm-providers/:llmProviderId/member-credentials", "llm_provider.member_credential.list", LLMC, res("llm_provider", "llmProviderId")),
  change("POST", "/v1/llm-providers", "llm_provider.create", LLM, res("llm_provider")),
  change("PATCH", "/v1/llm-providers/:llmProviderId", "llm_provider.update", LLM, res("llm_provider", "llmProviderId")),
  change("DELETE", "/v1/llm-providers/:llmProviderId", "llm_provider.delete", LLM, res("llm_provider", "llmProviderId")),
  change("PUT", "/v1/llm-providers/by-key/:externalKey", "llm_provider.by_key.upsert", LLM, res("llm_provider", "externalKey")),
  change("DELETE", "/v1/llm-providers/by-key/:externalKey", "llm_provider.by_key.delete", LLM, res("llm_provider", "externalKey")),
  change("DELETE", "/v1/llm-providers/:llmProviderId/access/:accessId", "llm_provider.access_grant.delete", LLM, res("llm_provider_access", "accessId")),
  external("POST", "/v1/llm-providers/test-connection", "llm_provider.connection.test", LLM, res("llm_provider"), "Caller-supplied LLM endpoint", "Outbound probe with caller-supplied URL and key; no local write."),
  change("PUT", "/v1/llm-providers/:llmProviderId/my-credential", "llm_provider.member_credential.set_own", LLMC, res("llm_provider", "llmProviderId"), "Stores an encrypted credential; response is a summary only."),
  change("DELETE", "/v1/llm-providers/:llmProviderId/my-credential", "llm_provider.member_credential.delete_own", LLMC, res("llm_provider", "llmProviderId")),
  change("PUT", "/v1/llm-providers/:llmProviderId/member-credentials/:orgMembershipId", "llm_provider.member_credential.set", LLMC, res("llm_provider_member_credential", "orgMembershipId"), "Stores an encrypted credential for another member; response is a summary only."),
  change("POST", "/v1/llm-providers/:llmProviderId/member-credentials/:orgMembershipId/block", "llm_provider.member_credential.block", LLMC, res("llm_provider_member_credential", "orgMembershipId")),

  // MCP connections
  read("/v1/mcp-apps", "mcp_app.catalog.list", "mcp_app.catalog", res("mcp_app")),
  read("/v1/mcp-connections", "mcp_connection.list", MCP, res("mcp_connection")),
  read("/v1/mcp-connections/presets", "mcp_connection.preset.list", MCP, res("mcp_connection_preset")),
  read("/v1/mcp-connections/:connectionId", "mcp_connection.read", MCP, res("mcp_connection", "connectionId")),
  read("/v1/mcp-connections/:connectionId/tool-policy", "mcp_connection.tool_policy.read", MCP, res("mcp_connection", "connectionId")),
  read("/v1/mcp-connections/:connectionId/tools", "mcp_connection.tool.list", "mcp_connection.tools", res("mcp_connection", "connectionId"), "Upstream tools/list; conditional OAuth token refresh write."),
  read("/v1/mcp-connections/:connectionId/mcp-apps", "mcp_connection.mcp_app.list", "mcp_connection.tools", res("mcp_connection", "connectionId"), "Upstream tools/list; conditional OAuth token refresh write."),
  external("POST", "/v1/mcp-connections/:connectionId/tools/call", "mcp_connection.tool.call", "mcp_connection.tools", res("mcp_connection", "connectionId"), "Upstream MCP server (tools/call)", "Arbitrary upstream side effects; response carries upstream tool result (sensitive). Agents reach the same effect via the excluded /mcp/agent transport (service layer)."),
  change("POST", "/v1/mcp-connections", "mcp_connection.create", MCP, res("mcp_connection"), "May probe the MCP server (initialize) before storing; secrets write-only."),
  change("PUT", "/v1/mcp-connections/:connectionId", "mcp_connection.update", MCP, res("mcp_connection", "connectionId"), "May probe the MCP server when validating; secrets write-only."),
  change("DELETE", "/v1/mcp-connections/:connectionId", "mcp_connection.delete", MCP, res("mcp_connection", "connectionId")),
  change("PUT", "/v1/mcp-connections/by-key/:externalKey", "mcp_connection.by_key.upsert", MCP, res("mcp_connection", "externalKey"), "May probe the MCP server when validating."),
  change("DELETE", "/v1/mcp-connections/by-key/:externalKey", "mcp_connection.by_key.delete", MCP, res("mcp_connection", "externalKey")),
  change("PUT", "/v1/mcp-connections/:connectionId/access", "mcp_connection.access.replace", MCP, res("mcp_connection", "connectionId")),
  change("PUT", "/v1/mcp-connections/:connectionId/tool-policy", "mcp_connection.tool_policy.update", MCP, res("mcp_connection", "connectionId")),
  change("POST", "/v1/mcp-connections/:connectionId/disconnect", "mcp_connection.disconnect_all", MCPO, res("mcp_connection", "connectionId"), "Removes all stored member credentials; no upstream revocation."),
  change("POST", "/v1/mcp-connections/:connectionId/disconnect-my-account", "mcp_connection.member_account.disconnect", MCPO, res("mcp_connection", "connectionId"), "No upstream revocation."),
  change("PUT", "/v1/mcp-connections/:connectionId/my-credential", "mcp_connection.member_credential.set_own", MCPO, res("mcp_connection", "connectionId"), "Session-only (API keys and MCP internal calls get 403); stores the caller's personal API key encrypted for a member-api-key connection; response is ok only. Removal uses disconnect-my-account."),
  change("POST", "/v1/mcp-connections/:connectionId/oauth/issuer-review", "mcp_connection.oauth_issuer.confirm", MCPO, res("mcp_connection", "connectionId"), "Live discovery fetch; writes only on confirm."),
  external("POST", "/v1/mcp-connections/discover", "mcp_connection.requirements.discover", MCP, res("mcp_connection"), "Caller-supplied MCP server URL", "Guarded outbound discovery fetch; no local write."),
  external("POST", "/v1/mcp-connections/resolve", "mcp_connection.resolve", MCP, res("mcp_connection"), "Candidate MCP server URLs", "Outbound probes of candidate URLs; no local write."),
  external("GET", "/v1/mcp-connections/:connectionId/connect/start", "mcp_connection.oauth.start", MCPO, res("mcp_connection", "connectionId"), "MCP authorization server (discovery; dynamic client registration)", "Writes pending OAuth state; may update issuer config and perform dynamic client registration at the authorization server."),
  handlerRoute("tenant_external", "GET", "/v1/mcp-connections/:connectionId/connect/callback", "mcp_connection.oauth.complete", MCPO, res("mcp_connection", "connectionId"), { external: "MCP authorization server (token exchange; Slack auth.test for Slack)", notes: "Attributed (attributeOAuthCallbackMember) after the HMAC-signed state, connection and active initiating member are verified, before issuer validation and token exchange: org = state organization, actor = that member's user." }),
  handlerRoute("tenant_external", "GET", "/v1/mcp-connections/oauth/callback", "mcp_connection.oauth.shared_callback.complete", MCPO, res("mcp_connection"), { external: "MCP authorization server (token exchange)", notes: "Fixed redirect URI; attributed like the per-connection callback once the signed state, connection and member are verified." }),
  access("POST", "/v1/mcp/token", "mcp_token.mint", "mcp_token.issuance", res("oauth_access_token"), "Mints and returns MCP access tokens (token, appHostToken)."),

  // Native OAuth providers (Google Workspace, Microsoft 365)
  read("/v1/oauth-providers/:providerId/client", "oauth_provider.client.read", "oauth_provider.configuration", res("oauth_client", "providerId"), "Client id only."),
  change("POST", "/v1/oauth-providers/:providerId/client", "oauth_provider.client.update", "oauth_provider.configuration", res("oauth_client", "providerId"), "Client secret write-only."),
  read("/v1/oauth-providers/:providerId/status", "oauth_provider.connection.status", OAP, res("oauth_provider_connection", "providerId")),
  change("GET", "/v1/oauth-providers/:providerId/connect/start", "oauth_provider.connect.start", OAP, res("oauth_provider_connection", "providerId"), "Writes OAuth state; returns authorize URL."),
  change("GET", "/v1/mcp-connections/google-workspace/connect/start", "oauth_provider.google_workspace.connect.start", OAP, res("oauth_provider_connection"), "Alias of oauth-providers connect start for Google Workspace."),
  change("GET", "/v1/mcp-connections/microsoft-365/connect/start", "oauth_provider.microsoft_365.connect.start", OAP, res("oauth_provider_connection"), "Alias of oauth-providers connect start for Microsoft 365."),
  handlerRoute("tenant_external", "GET", "/v1/oauth-providers/:providerId/connect/callback", "oauth_provider.connect.complete", OAP, res("oauth_provider_connection", "providerId"), { external: "native OAuth provider (Google / Microsoft token exchange)", notes: "Attributed after the HMAC-signed state, member credential resolution and pending verifier are verified, before the token exchange: org = state organization, actor = the active initiating member's user." }),
  change("POST", "/v1/oauth-providers/:providerId/disconnect", "oauth_provider.connection.disconnect", OAP, res("oauth_provider_connection", "providerId"), "Removes stored credential; no upstream revocation."),

  // Slack assistant
  read("/v1/mcp-connections/:connectionId/slack-assistant", "slack_assistant.settings.read", SLACK, res("slack_assistant_installation", "connectionId"), "Credentials never returned."),
  change("PUT", "/v1/mcp-connections/:connectionId/slack-assistant", "slack_assistant.settings.update", SLACK, res("slack_assistant_installation", "connectionId"), "Signing secret write-only."),
  change("POST", "/v1/mcp-connections/:connectionId/slack-assistant/install", "slack_assistant.install.start", SLACK, res("slack_assistant_installation", "connectionId"), "Writes single-use install state; returns authorize URL."),
  handlerRoute("tenant_external", "GET", "/v1/integrations/slack/oauth/callback", "slack_assistant.install.complete", SLACK, res("slack_assistant_installation"), { external: "Slack (oauth.v2.access)", notes: "Attributed after the single-use DB state is consumed and the installing member's admin role is re-verified, before oauth.v2.access: org = installation organization, actor = installing member's user." }),
  job("POST", "/v1/integrations/slack/:connectionId/events", "slack_assistant.event.receive", "slack_assistant.webhook", res("slack_assistant_installation", "connectionId"), "not_recorded: src/slack-assistant/worker.ts:processSlackEvent checkpoints slack_assistant_event status (operational record); the assistant's tool calls reach /mcp/agent and are recorded at destination routes or service actions", "handler", "Attributed right after the Slack signature verifies with the installation's signing secret (before the team/app check and enqueue): org = installation organization, actor service slack_installation:<connectionId>, origin webhook."),
  handlerRoute("tenant_change", "POST", "/v1/integrations/slack/:connectionId/commands", "slack_assistant.command.receive", "slack_assistant.webhook", res("slack_assistant_installation", "connectionId"), { notes: "Attributed after the installation signature verifies (actor service slack_installation:<connectionId>, origin webhook); returns an ephemeral connect link, no state change." }),
  handlerRoute("tenant_change", "POST", "/v1/integrations/slack/:connectionId/interactions", "slack_assistant.interaction.receive", "slack_assistant.webhook", res("slack_assistant_installation", "connectionId"), { notes: "Attributed after the installation signature verifies (actor service slack_installation:<connectionId>, origin webhook). Records feedback locally." }),
]
