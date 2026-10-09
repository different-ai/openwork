// Content slice: plugins, config objects, marketplaces, Workflows, artifact views,
// dashboards, automations, automation runners, remote-session runner callbacks,
// Workbot, resources, brand assets and the deprecated memory / skill-hub stubs.

import { HIGH_VOLUME_EXCLUSIONS, type AuditRouteAttribution, type AuditRouteClass, type AuditRouteDeclaration, type AuditRouteMethod } from "./types.js"

type Extra = Pick<AuditRouteDeclaration, "changeEvidence" | "external" | "jobOutcome" | "notes">

function route(
  method: AuditRouteMethod, path: string, auditClass: AuditRouteClass, action: string, kind: string,
  type: string, idParam: string | null, attribution: AuditRouteAttribution, extra: Extra = {},
): AuditRouteDeclaration {
  return { method, path, class: auditClass, action, kind, resource: { type, idParam }, attribution, ...extra }
}

/** orgMemberRoute / orgRoleRoute: organizationContext supplies the member actor. */
function member(
  method: AuditRouteMethod, path: string, auditClass: AuditRouteClass, action: string, kind: string,
  type: string, idParam: string | null, extra: Extra = {},
): AuditRouteDeclaration {
  return route(method, path, auditClass, action, kind, type, idParam, "org_context", extra)
}

/** Verified desktop runner token (HMAC) carries organizationId, ownerMemberId and runnerId. */
function runner(
  method: AuditRouteMethod, path: string, auditClass: AuditRouteClass, action: string, kind: string,
  type: string, idParam: string | null, extra: Extra = {},
): AuditRouteDeclaration {
  return route(method, path, auditClass, action, kind, type, idParam, "handler", {
    ...extra,
    notes: `Runner-token route: authenticateRunner() verifies the token, then attributes actor automation-runner:<runnerId> for the owner member.${extra.notes ? ` ${extra.notes}` : ""}`,
  })
}

/** Public or session-only removed-feature stubs; no tenant and no state. */
function stub(method: AuditRouteMethod, path: string, action: string, kind: string, type: string, idParam: string | null, notes: string): AuditRouteDeclaration {
  return route(method, path, "platform", action, kind, type, idParam, "none", { notes })
}

/** Bulk fan-out read excluded from audit logs; the reason lives in HIGH_VOLUME_EXCLUSIONS. */
function highVolume(method: AuditRouteMethod, path: string, action: string, kind: string, type: string, idParam: string | null): AuditRouteDeclaration {
  const exclusion = HIGH_VOLUME_EXCLUSIONS.find((entry) => entry.method === method && entry.path === path)
  return route(method, path, "excluded_high_volume", action, kind, type, idParam, "none", { notes: exclusion?.reason ?? "High-volume read excluded from audit logs." })
}

function alias(method: AuditRouteMethod, path: string, action: string, notes: string): AuditRouteDeclaration {
  return route(method, path, "proxy", action, "workflow.alias", "workflow", null, "none", { notes })
}

const MCP_NATIVE = "Also reached by agents as a native capability through mcp/invoke.ts app.fetch (origin mcp)."
const DESKTOP_RUN_OUTCOME = "automation_run.completed (one per run, job operation jobRunId = run id) via src/automations/audit.ts:recordAutomationRunCompleted from every terminal transition: cloud executor (AutomationService.executeCloudRun/executeCloudAgentRun), desktop runner callback POST /v1/automation-runs/:id/complete (completeDesktopRunner), skips, cancel and lease/claim expiry; scheduled starts add automation_run.started (see src/audit/job-outcomes.ts)"
const REMOTE_SESSION_JOB = "Outcome callback of the remote-session job started by MCP remote-session:create|send|stop (service-layer tenant_job, no HTTP route); read back by remote-session:read."

export const contentAuditRoutes: readonly AuditRouteDeclaration[] = [
  alias("ALL", "/v1/codemode-scripts", "workflow.alias.proxy", "One-release alias re-dispatched through app.fetch to /v1/workflows; the destination records."),
  alias("ALL", "/v1/codemode-scripts/*", "workflow.alias_subpath.proxy", "One-release alias re-dispatched through app.fetch to /v1/workflows/*; the destination records."),
  alias("ALL", "/v1/programs/*", "program.alias.proxy", "One-release alias re-dispatched through app.fetch to /v1/workflows/*; the destination records."),
  alias("ALL", "/v1/codemode-runs", "workflow_run.alias.proxy", "Legacy alias re-dispatched through app.fetch to GET /v1/workflow-runs; the destination records."),

  // Workflow run history (Organization Analytics)
  member("GET", "/v1/workflow-runs", "tenant_read", "workflow_run.list", "workflow.run", "workflow_run", null, { notes: "Owners and admins; run receipts with tool call names, status and error text. No inputs or results." }),

  // Automations
  member("GET", "/v1/automations", "tenant_access", "automation.list", "automation.management", "automation", null, { notes: `Returns automation instructions. Read may persist needs_attention_reason (reconcileModelAttention). mcp/agent.ts also lists automations directly as a read-only resource index. ${MCP_NATIVE}` }),
  member("POST", "/v1/automations", "tenant_change", "automation.create", "automation.management", "automation", null, { notes: `Same automationService.create as POST /v1/cloud-automations. ${MCP_NATIVE}` }),
  member("POST", "/v1/cloud-automations", "tenant_change", "automation.cloud.create", "automation.management", "automation", null, { notes: `Same automationService.create as POST /v1/automations; validates Workflow access. Scheduled runs are started by the scheduler tick, not an HTTP route. ${MCP_NATIVE}` }),
  member("GET", "/v1/automations/:id", "tenant_access", "automation.read", "automation.management", "automation", "id", { notes: `Returns automation instructions; read may persist needs_attention_reason. ${MCP_NATIVE}` }),
  member("PATCH", "/v1/automations/:id", "tenant_change", "automation.update", "automation.management", "automation", "id", { notes: MCP_NATIVE }),
  member("DELETE", "/v1/automations/:id", "tenant_change", "automation.archive", "automation.management", "automation", "id", { notes: `DELETE archives the automation. ${MCP_NATIVE}` }),
  member("POST", "/v1/automations/:id/activate", "tenant_change", "automation.activate", "automation.management", "automation", "id", { notes: MCP_NATIVE }),
  member("POST", "/v1/automations/:id/deactivate", "tenant_change", "automation.deactivate", "automation.management", "automation", "id", { notes: `Stops future runs; a run already in progress is not cancelled. ${MCP_NATIVE}` }),
  member("POST", "/v1/automations/:id/run", "tenant_job", "automation.run.start", "automation.run", "automation", "id", { jobOutcome: DESKTOP_RUN_OUTCOME, notes: `Returns 202; blocked runs are recorded as skipped receipts. The scheduler tick uses the same repository.claim without an HTTP route. ${MCP_NATIVE}` }),
  member("GET", "/v1/automations/:id/runs", "tenant_access", "automation.run.list", "automation.run", "automation", "id", { notes: `Returns run result summaries. ${MCP_NATIVE}` }),
  member("GET", "/v1/automation-runs", "tenant_access", "automation.run.range_list", "automation.run", "automation", null, { notes: "Returns run result summaries across the caller's own Automations for a bounded time range (calendar views). First-party clients only; not an MCP tool." }),
  member("GET", "/v1/automation-runs/:id", "tenant_access", "automation_run.read", "automation.run", "automation_run", "id", { notes: `Returns run events, thread and results. ${MCP_NATIVE}` }),
  member("POST", "/v1/automation-runs/:id/cancel", "tenant_change", "automation_run.cancel", "automation.run", "automation_run", "id", { notes: `Records cancellationRequested and notifies the runner; the final cancelled status arrives through POST /v1/automation-runs/:id/complete or the cloud executor. ${MCP_NATIVE}` }),
  runner("POST", "/v1/automation-runs/:id/claim", "tenant_change", "automation_run.claim", "automation.run", "automation_run", "id", { notes: "Job outcome callback for automation.run.start; response carries automation instructions." }),
  runner("POST", "/v1/automation-runs/:id/heartbeat", "tenant_signal", "automation_run.heartbeat", "automation.run", "automation_run", "id", { notes: "Job outcome callback for automation.run.start (lease extension)." }),
  runner("POST", "/v1/automation-runs/:id/events", "tenant_change", "automation_run.event.append", "automation.run", "automation_run", "id", { notes: "Job outcome callback for automation.run.start." }),
  runner("POST", "/v1/automation-runs/:id/complete", "tenant_change", "automation_run.complete", "automation.run", "automation_run", "id", { notes: "Terminal job outcome for desktop automation runs (completeDesktopRunner)." }),

  // Automation runners
  member("GET", "/v1/automation-runners", "tenant_read", "automation_runner.list", "automation.runner", "automation_runner", null, { notes: "Read may prune stale runner and notification rows." }),
  member("GET", "/v1/automation-runners/presence", "tenant_read", "automation_runner.presence.read", "automation.runner", "automation_runner", null),
  member("POST", "/v1/automation-runners/token", "tenant_access", "automation_runner.token.issue", "automation.runner", "automation_runner", null, { notes: "Registers the desktop runner and returns a stateless HMAC runner bearer token (credential issuance; never snapshot the token). Blocked from MCP." }),
  runner("GET", "/v1/automation-runners/events", "tenant_signal", "automation_runner.events.stream", "automation.runner", "automation_runner", null, { notes: "Long-lived text/event-stream; observed is recorded when the stream response is returned." }),
  runner("GET", "/v1/automation-runner/work", "tenant_signal", "automation_runner.work.poll", "automation.runner", "automation_runner", null, { notes: "Frequent poll; writes last_seen_at presence. Lists pending automation runs and remote-session commands/requests." }),
  runner("PUT", "/v1/automation-runner/inventory", "tenant_signal", "automation_runner.inventory.update", "automation.runner", "automation_runner", null, { notes: "High-frequency device inventory; read by MCP remote-session:targets." }),

  // Remote-session runner callbacks
  runner("GET", "/v1/remote-session-requests/pending", "tenant_signal", "remote_session.request.pending.list", "remote_session.execution", "remote_session_request", null),
  runner("POST", "/v1/remote-session-commands/:id/claim", "tenant_change", "remote_session.command.claim", "remote_session.execution", "remote_session_command", "id", { notes: `${REMOTE_SESSION_JOB} Response carries the user prompt.` }),
  runner("POST", "/v1/remote-session-commands/:id/complete", "tenant_change", "remote_session.command.complete", "remote_session.execution", "remote_session_command", "id", { notes: REMOTE_SESSION_JOB }),
  runner("POST", "/v1/remote-session-commands/:id/session", "tenant_change", "remote_session.command.session.report", "remote_session.execution", "remote_session_command", "id", { notes: `${REMOTE_SESSION_JOB} Repeated progress reports store final text / last error (user content).` }),
  runner("POST", "/v1/remote-session-requests/:id/claim", "tenant_change", "remote_session.request.claim", "remote_session.execution", "remote_session_request", "id", { notes: `${REMOTE_SESSION_JOB} Response carries follow-up prompt input.` }),
  runner("POST", "/v1/remote-session-requests/:id/complete", "tenant_change", "remote_session.request.complete", "remote_session.execution", "remote_session_request", "id", { notes: `${REMOTE_SESSION_JOB} A send also marks the command turn started (two UPDATEs, no transaction).` }),

  // Workflows and artifact views
  member("GET", "/v1/workflows", "tenant_read", "workflow.list", "workflow.management", "workflow", null, { notes: `Metadata, schemas and capability names only. ${MCP_NATIVE}` }),
  member("POST", "/v1/workflows", "tenant_change", "workflow.create", "workflow.management", "workflow", null, { notes: `saveWorkflow (may create the default My Workflows Plugin). ${MCP_NATIVE}` }),
  member("POST", "/v1/workflows/test", "tenant_external", "workflow.test", "workflow.execution", "workflow", null, { external: "connected services (Code Mode capability tool calls: Google Workspace, Microsoft 365, external MCP servers)", notes: `configObjectId is in the body. MCP execute_capability_script runs executeWorkflow directly (service layer). ${MCP_NATIVE}` }),
  member("GET", "/v1/workflows/:configObjectId", "tenant_access", "workflow.read", "workflow.management", "workflow", "configObjectId", { notes: `Returns Workflow code and example input to managers. ${MCP_NATIVE}` }),
  member("GET", "/v1/workflows/:configObjectId/versions", "tenant_access", "workflow.version.list", "workflow.management", "workflow", "configObjectId", { notes: `Returns Workflow source and example inputs. ${MCP_NATIVE}` }),
  member("POST", "/v1/workflows/:configObjectId/versions", "tenant_change", "workflow.version.create", "workflow.management", "workflow", "configObjectId", { notes: MCP_NATIVE }),
  member("POST", "/v1/workflows/:configObjectId/run", "tenant_external", "workflow.run", "workflow.execution", "workflow", "configObjectId", { external: "connected services (capability tool calls; live mode read-only)", notes: `Response carries connected-service data. Alternate paths call executeMarketplaceCapability directly: MCP execute_capability, MCP App tools and the cloud Automation saved_script executor. ${MCP_NATIVE}` }),
  member("GET", "/v1/workflows/:configObjectId/snapshots", "tenant_access", "workflow.snapshot.list", "workflow.management", "workflow", "configObjectId", { notes: `Returns result values and markdown. ${MCP_NATIVE}` }),
  member("GET", "/v1/workflows/:configObjectId/snapshots/:receiptId", "tenant_access", "workflow.snapshot.read", "workflow.management", "workflow_snapshot", "receiptId", { notes: `Returns result value and markdown. ${MCP_NATIVE}` }),
  member("DELETE", "/v1/workflows/:configObjectId/snapshots/:receiptId/content", "tenant_change", "workflow.snapshot.content.delete", "workflow.management", "workflow_snapshot", "receiptId", { notes: `Data erasure; idempotent. ${MCP_NATIVE}` }),
  member("GET", "/v1/workflows/:configObjectId/views", "tenant_read", "artifact_view.list", "workflow.management", "workflow", "configObjectId", { notes: "Revision metadata and build status only (digests, no source or data)." }),
  member("POST", "/v1/artifact-views/:artifactViewId/revisions/:revisionId/activate", "tenant_change", "artifact_view.revision.activate", "workflow.management", "artifact_view", "artifactViewId", { notes: "MCP activate_artifact_view_revision mutates directly (service layer)." }),
  member("POST", "/v1/artifact-views/:artifactViewId/retire", "tenant_change", "artifact_view.retire", "workflow.management", "artifact_view", "artifactViewId", { notes: "MCP retire_artifact_view mutates directly (service layer)." }),

  // Config objects
  member("GET", "/v1/config-objects", "tenant_access", "config_object.list", "config_object.configuration", "config_object", null, { notes: `Each item embeds latestVersion including rawSourceText (Workflow/App source redacted). ${MCP_NATIVE}` }),
  member("POST", "/v1/config-objects", "tenant_change", "config_object.create", "config_object.configuration", "config_object", null, { notes: MCP_NATIVE }),
  member("GET", "/v1/config-objects/:configObjectId", "tenant_access", "config_object.read", "config_object.configuration", "config_object", "configObjectId", { notes: `Returns the latest version source. ${MCP_NATIVE}` }),
  member("GET", "/v1/config-objects/:configObjectId/versions", "tenant_access", "config_object.version.list", "config_object.configuration", "config_object", "configObjectId", { notes: `Returns version source text. ${MCP_NATIVE}` }),
  member("POST", "/v1/config-objects/:configObjectId/versions", "tenant_change", "config_object.version.create", "config_object.configuration", "config_object", "configObjectId", { notes: `MCP update_skill calls createConfigObjectVersion directly (service layer); GitHub re-import also creates versions. ${MCP_NATIVE}` }),
  member("GET", "/v1/config-objects/:configObjectId/versions/latest", "tenant_access", "config_object.version.latest.read", "config_object.configuration", "config_object", "configObjectId", { notes: `Returns version source text. ${MCP_NATIVE}` }),
  member("GET", "/v1/config-objects/:configObjectId/versions/:versionId", "tenant_access", "config_object.version.read", "config_object.configuration", "config_object_version", "versionId", { notes: `Returns version source text. ${MCP_NATIVE}` }),
  member("POST", "/v1/config-objects/:configObjectId/archive", "tenant_change", "config_object.archive", "config_object.configuration", "config_object", "configObjectId", { notes: `Resyncs derived MCP connection access outside the lifecycle write. ${MCP_NATIVE}` }),
  member("POST", "/v1/config-objects/:configObjectId/delete", "tenant_change", "config_object.delete", "config_object.configuration", "config_object", "configObjectId", { notes: `Soft delete; resyncs derived MCP connection access. ${MCP_NATIVE}` }),
  member("POST", "/v1/config-objects/:configObjectId/restore", "tenant_change", "config_object.restore", "config_object.configuration", "config_object", "configObjectId", { notes: `Resyncs derived MCP connection access. ${MCP_NATIVE}` }),
  member("GET", "/v1/config-objects/:configObjectId/access", "tenant_read", "config_object.access_grant.list", "config_object.configuration", "config_object", "configObjectId", { notes: MCP_NATIVE }),
  member("POST", "/v1/config-objects/:configObjectId/access", "tenant_change", "config_object.access_grant.create", "config_object.configuration", "config_object", "configObjectId", { notes: MCP_NATIVE }),
  member("DELETE", "/v1/config-objects/:configObjectId/access/:grantId", "tenant_change", "config_object.access_grant.revoke", "config_object.configuration", "config_object_access_grant", "grantId", { notes: MCP_NATIVE }),
  member("GET", "/v1/config-objects/:configObjectId/plugins", "tenant_read", "config_object.plugin.list", "config_object.configuration", "config_object", "configObjectId", { notes: MCP_NATIVE }),
  member("POST", "/v1/config-objects/:configObjectId/plugins", "tenant_change", "config_object.plugin.attach", "plugin.configuration", "config_object", "configObjectId", { notes: `Duplicate route for the mutation behind POST /v1/plugins/:pluginId/config-objects (attachConfigObjectToPlugin); MCP create_app/update_app attach directly. ${MCP_NATIVE}` }),
  member("DELETE", "/v1/config-objects/:configObjectId/plugins/:pluginId", "tenant_change", "config_object.plugin.detach", "plugin.configuration", "config_object", "configObjectId", { notes: `Duplicate route for the mutation behind DELETE /v1/plugins/:pluginId/config-objects/:configObjectId. ${MCP_NATIVE}` }),

  // Plugins
  member("GET", "/v1/plugins", "tenant_read", "plugin.list", "plugin.configuration", "plugin", null, { notes: MCP_NATIVE }),
  member("POST", "/v1/plugins", "tenant_external", "plugin.create", "plugin.configuration", "plugin", null, { external: "remote MCP server (connection validation for apikey/none auth)", notes: `Composite createPluginBundle (plugin, components, grants, marketplace publish, MCP connection setup with compensating rollback); request may carry credentials, snapshot secret markers only. MCP create_skill calls createPluginBundle directly (service layer). ${MCP_NATIVE}` }),
  member("GET", "/v1/plugins/:pluginId", "tenant_read", "plugin.read", "plugin.configuration", "plugin", "pluginId", { notes: MCP_NATIVE }),
  member("PATCH", "/v1/plugins/:pluginId", "tenant_change", "plugin.update", "plugin.configuration", "plugin", "pluginId", { notes: MCP_NATIVE }),
  member("POST", "/v1/plugins/:pluginId/archive", "tenant_change", "plugin.archive", "plugin.configuration", "plugin", "pluginId", { notes: `setPluginLifecycle is also called by mcp-apps cleanup and GitHub import rollback. ${MCP_NATIVE}` }),
  member("POST", "/v1/plugins/:pluginId/restore", "tenant_change", "plugin.restore", "plugin.configuration", "plugin", "pluginId", { notes: MCP_NATIVE }),
  member("GET", "/v1/plugins/:pluginId/config-objects", "tenant_access", "plugin.config_object.list", "plugin.configuration", "plugin", "pluginId", { notes: `Memberships embed config objects with latest version source. ${MCP_NATIVE}` }),
  member("POST", "/v1/plugins/:pluginId/config-objects", "tenant_change", "plugin.config_object.add", "plugin.configuration", "plugin", "pluginId", { notes: `Duplicate route for the mutation behind POST /v1/config-objects/:configObjectId/plugins; MCP create_app/update_app attach directly. ${MCP_NATIVE}` }),
  member("DELETE", "/v1/plugins/:pluginId/config-objects/:configObjectId", "tenant_change", "plugin.config_object.remove", "plugin.configuration", "plugin", "pluginId", { notes: `Duplicate route for the mutation behind DELETE /v1/config-objects/:configObjectId/plugins/:pluginId. ${MCP_NATIVE}` }),
  // Not audited: see HIGH_VOLUME_EXCLUSIONS in ./types.ts (ENG-683).
  highVolume("GET", "/v1/plugins/:pluginId/resolved", "plugin.resolved.read", "plugin.configuration", "plugin", "pluginId"),
  member("GET", "/v1/plugins/:pluginId/access", "tenant_read", "plugin.access_grant.list", "plugin.configuration", "plugin", "pluginId", { notes: MCP_NATIVE }),
  member("POST", "/v1/plugins/:pluginId/access", "tenant_change", "plugin.access_grant.create", "plugin.configuration", "plugin", "pluginId", { notes: MCP_NATIVE }),
  member("DELETE", "/v1/plugins/:pluginId/access/:grantId", "tenant_change", "plugin.access_grant.revoke", "plugin.configuration", "plugin_access_grant", "grantId", { notes: MCP_NATIVE }),
  member("POST", "/v1/plugins/:pluginId/mcp-connections", "tenant_external", "plugin.mcp_requirement.configure", "plugin.configuration", "plugin", "pluginId", { external: "remote MCP server (initialize validation unless oauth)", notes: `Org admin only; request carries API key / OAuth client secret (snapshot secret markers only); agent secret setup refused; 502 connection_validation_failed. ${MCP_NATIVE}` }),
  member("POST", "/v1/plugins/import-mcps-from-github-url/preview", "tenant_external", "plugin.github.import_preview", "plugin.configuration", "plugin", null, { external: "github (public repository tree and file fetch)", notes: `No DB writes; read-only outbound fetch but POST, so not tenant_read. ${MCP_NATIVE}` }),
  member("POST", "/v1/plugins/import-mcps-from-github-url", "tenant_external", "plugin.github.import", "plugin.configuration", "plugin", null, { external: "github (public repository fetch)", notes: `Synchronous composite importGithubPluginMcps (plugin, config objects/versions, MCP connections, grants, marketplace attach) with compensating cleanup; re-import updates in place. ${MCP_NATIVE}` }),

  // Marketplaces
  member("GET", "/v1/marketplaces", "tenant_read", "marketplace.list", "marketplace.configuration", "marketplace", null, { notes: `Read that writes: first call per org provisions the default OpenWork marketplace (ensureDefaultOpenWorkMarketplace transaction). ${MCP_NATIVE}` }),
  member("POST", "/v1/marketplaces", "tenant_change", "marketplace.create", "marketplace.configuration", "marketplace", null, { notes: `createMarketplace is shared with PUT /v1/marketplaces/by-key/:externalKey. ${MCP_NATIVE}` }),
  member("GET", "/v1/marketplaces/by-key/:externalKey", "tenant_read", "marketplace.by_key.read", "marketplace.configuration", "marketplace", "externalKey", { notes: MCP_NATIVE }),
  member("PUT", "/v1/marketplaces/by-key/:externalKey", "tenant_change", "marketplace.by_key.apply", "marketplace.configuration", "marketplace", "externalKey", { notes: `Upsert (201 create / 200 replace) via createMarketplace / updateMarketplace, the same mutations as POST and PATCH /v1/marketplaces. ${MCP_NATIVE}` }),
  member("DELETE", "/v1/marketplaces/by-key/:externalKey", "tenant_change", "marketplace.by_key.delete", "marketplace.configuration", "marketplace", "externalKey", { notes: `Same setMarketplaceLifecycle delete as POST /v1/marketplaces/:marketplaceId/delete. ${MCP_NATIVE}` }),
  member("GET", "/v1/marketplaces/:marketplaceId", "tenant_read", "marketplace.read", "marketplace.configuration", "marketplace", "marketplaceId", { notes: MCP_NATIVE }),
  member("PATCH", "/v1/marketplaces/:marketplaceId", "tenant_change", "marketplace.update", "marketplace.configuration", "marketplace", "marketplaceId", { notes: MCP_NATIVE }),
  member("POST", "/v1/marketplaces/:marketplaceId/archive", "tenant_change", "marketplace.archive", "marketplace.configuration", "marketplace", "marketplaceId", { notes: `Access resync runs outside the lifecycle transaction. ${MCP_NATIVE}` }),
  member("POST", "/v1/marketplaces/:marketplaceId/delete", "tenant_change", "marketplace.delete", "marketplace.configuration", "marketplace", "marketplaceId", { notes: `Hard delete of a custom marketplace with memberships and grants (409 for built-in/connector-managed); capture the before-snapshot pre-delete. ${MCP_NATIVE}` }),
  member("POST", "/v1/marketplaces/:marketplaceId/restore", "tenant_change", "marketplace.restore", "marketplace.configuration", "marketplace", "marketplaceId", { notes: MCP_NATIVE }),
  member("GET", "/v1/marketplaces/:marketplaceId/resolved", "tenant_read", "marketplace.resolved.read", "marketplace.configuration", "marketplace", "marketplaceId", { notes: MCP_NATIVE }),
  member("GET", "/v1/marketplaces/:marketplaceId/plugins", "tenant_read", "marketplace.plugin.list", "marketplace.configuration", "marketplace", "marketplaceId", { notes: MCP_NATIVE }),
  member("POST", "/v1/marketplaces/:marketplaceId/plugins", "tenant_change", "marketplace.plugin.add", "marketplace.configuration", "marketplace", "marketplaceId", { notes: `attachPluginToMarketplace is also called by createPluginBundle and GitHub import; expands plugin audience via marketplace grants. ${MCP_NATIVE}` }),
  member("DELETE", "/v1/marketplaces/:marketplaceId/plugins/:pluginId", "tenant_change", "marketplace.plugin.remove", "marketplace.configuration", "marketplace", "marketplaceId", { notes: MCP_NATIVE }),
  member("GET", "/v1/marketplaces/:marketplaceId/access", "tenant_read", "marketplace.access_grant.list", "marketplace.configuration", "marketplace", "marketplaceId", { notes: MCP_NATIVE }),
  member("POST", "/v1/marketplaces/:marketplaceId/access", "tenant_change", "marketplace.access_grant.create", "marketplace.configuration", "marketplace", "marketplaceId", { notes: MCP_NATIVE }),
  member("DELETE", "/v1/marketplaces/:marketplaceId/access/:grantId", "tenant_change", "marketplace.access_grant.revoke", "marketplace.configuration", "marketplace_access_grant", "grantId", { notes: MCP_NATIVE }),

  // Dashboards (org admin, managed-dashboards capability)
  member("GET", "/v1/dashboards", "tenant_read", "dashboard.list", "dashboard.configuration", "dashboard", null),
  member("POST", "/v1/dashboards", "tenant_change", "dashboard.create", "dashboard.configuration", "dashboard", null),
  member("GET", "/v1/dashboards/:dashboardId", "tenant_read", "dashboard.read", "dashboard.configuration", "dashboard", "dashboardId"),
  member("PATCH", "/v1/dashboards/:dashboardId", "tenant_change", "dashboard.update", "dashboard.configuration", "dashboard", "dashboardId"),
  member("DELETE", "/v1/dashboards/:dashboardId", "tenant_change", "dashboard.delete", "dashboard.configuration", "dashboard", "dashboardId"),
  member("GET", "/v1/dashboards/:dashboardId/access", "tenant_read", "dashboard.access_grant.list", "dashboard.configuration", "dashboard", "dashboardId"),
  member("POST", "/v1/dashboards/:dashboardId/access", "tenant_change", "dashboard.access_grant.create", "dashboard.configuration", "dashboard", "dashboardId"),
  member("DELETE", "/v1/dashboards/:dashboardId/access/:grantId", "tenant_change", "dashboard.access_grant.revoke", "dashboard.configuration", "dashboard_access_grant", "grantId"),

  // Resources, Workbot, brand assets
  member("GET", "/v1/resources", "tenant_read", "resource_snapshot.read", "resource.discovery", "resource_snapshot", null, { notes: "Desktop polling endpoint; ids and timestamps only." }),
  member("GET", "/v1/resources/marketplace-capabilities", "tenant_read", "marketplace_capability.list", "resource.discovery", "marketplace_capability", null),
  route("GET", "/v1/workbot/session", "tenant_read", "workbot.session.read", "workbot.execution", "workbot_session", null, "handler", { notes: "Handler verifies the MCP OAuth token (verifyMcpRequest) and active membership, then attributes the token's org and user." }),
  route("GET", "/v1/workbot/connections", "tenant_read", "workbot.connection.list", "workbot.execution", "mcp_connection", null, "handler", { notes: "Handler verifies the MCP OAuth token and active membership, returns 403 while the workbot feature is off, then lists the Gmail/Google Workspace, Slack and Microsoft 365 connections this member may use (id, name, readiness, Den connect URL; no secrets)." }),
  route("GET", "/v1/workbot/calendar/*", "proxy", "workbot.calendar.read", "workbot.execution", "automation", null, "handler", { notes: "Handler verifies the MCP OAuth token, membership and the workbot + workbotCalendar features, then re-dispatches an allowlisted read (the member's Automations, runs, run receipts, native calendar events, and usable LLM providers trimmed to names and model IDs) through app.fetch with a signed internal principal; the destination route records." }),
  route("POST", "/v1/workbot/calendar/*", "proxy", "workbot.calendar.action", "workbot.execution", "automation", null, "handler", { notes: "Handler verifies the MCP OAuth token (write scope), membership and the workbot + workbotCalendar features, then re-dispatches POST /v1/automations/:id/{activate|deactivate|run} or POST /v1/cloud-automations (create, body forwarded) through app.fetch as the member; the destination route records." }),
  route("PATCH", "/v1/workbot/calendar/*", "proxy", "workbot.calendar.schedule", "workbot.execution", "automation", null, "handler", { notes: "Handler verifies the MCP OAuth token (write scope), membership and the workbot + workbotCalendar features, accepts a body limited to `name`, `schedule`, `instructions` and `model` (never where it runs), then re-dispatches PATCH /v1/automations/:id through app.fetch as the member; the destination route records." }),
  route("POST", "/v1/workbot/run-token", "tenant_access", "workbot.run_token.issue", "workbot.execution", "oauth_access_token", null, "handler", { notes: "Handler verifies the MCP OAuth token, membership and workbot capability, then mints a ≤1h headless-run MCP token (credential issuance; plaintext returned once, never snapshot). mintHeadlessRunMcpToken is also called by the headless automation executor without an HTTP route." }),
  route("GET", "/v1/brand-assets/:organizationId/:kind/:version", "tenant_read", "brand_asset.download", "organization.branding", "brand_asset", "version", "handler", { notes: "Public capability URL: the HMAC signature binds organizationId, kind, version and extension, so the handler attributes the path organization only after verifyBrandAssetSignature; actor is the anonymous signed-URL holder. Public, immutable, CDN-cached logo (login pages, emails): read category, not access. Invalid signatures 404 before attribution (platform)." }),

  // Deprecated stubs (no tenant, no state)
  { ...stub("GET", "/v1/memory", "memory.list", "deprecated.memory", "memory", null, "Removed feature stub (authenticatedRoute); no data access."), readOnly: true },
  stub("POST", "/v1/memory", "memory.create", "deprecated.memory", "memory", null, "Public 410 Gone stub."),
  { ...stub("GET", "/v1/memory/search", "memory.search", "deprecated.memory", "memory", null, "Removed feature stub (authenticatedRoute); no data access."), readOnly: true },
  stub("DELETE", "/v1/memory/:id", "memory.delete", "deprecated.memory", "memory", "id", "Removed feature stub (authenticatedRoute); no state change."),
  stub("GET", "/v1/skill-hubs", "skill_hub.list", "deprecated.skill_hub", "skill_hub", null, "Public 410 stub; use plugins."),
  stub("POST", "/v1/skill-hubs", "skill_hub.create", "deprecated.skill_hub", "skill_hub", null, "Public 410 stub; use plugins."),
  stub("PATCH", "/v1/skill-hubs/:skillHubId", "skill_hub.update", "deprecated.skill_hub", "skill_hub", "skillHubId", "Public 410 stub; use plugins."),
  stub("DELETE", "/v1/skill-hubs/:skillHubId", "skill_hub.delete", "deprecated.skill_hub", "skill_hub", "skillHubId", "Public 410 stub; use plugins."),
  stub("POST", "/v1/skill-hubs/:skillHubId/access", "skill_hub.access_grant.create", "deprecated.skill_hub", "skill_hub", "skillHubId", "Public 410 stub; use plugins."),
  stub("DELETE", "/v1/skill-hubs/:skillHubId/access/:accessId", "skill_hub.access_grant.revoke", "deprecated.skill_hub", "skill_hub", "skillHubId", "Public 410 stub; use plugins."),
  stub("POST", "/v1/skill-hubs/:skillHubId/skills", "skill_hub.skill.add", "deprecated.skill_hub", "skill_hub", "skillHubId", "Public 410 stub; use plugins."),
  stub("DELETE", "/v1/skill-hubs/:skillHubId/skills/:skillId", "skill_hub.skill.remove", "deprecated.skill_hub", "skill_hub", "skillHubId", "Public 410 stub; use plugins."),
]
