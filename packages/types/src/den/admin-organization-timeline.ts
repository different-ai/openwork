import { z } from "zod";

export const adminTimelineSourceSchema = z.enum(["desktop_startup", "inference_request", "capability_use", "workflow_run", "audit_operation", "remote_device_event", "client_activity"]);
export type AdminTimelineSource = z.infer<typeof adminTimelineSourceSchema>;
export const adminTimelineSourceLabels: Record<AdminTimelineSource, string> = {
  desktop_startup: "Desktop launches",
  inference_request: "Model requests",
  capability_use: "Tool and skill use",
  workflow_run: "Workflow runs",
  audit_operation: "Audited activity",
  remote_device_event: "Computer activity",
  client_activity: "Client activity",
};
export const adminTimelineKindSchema = z.enum([
  "startup_ready", "startup_failed", "certificate", "dns", "offline", "timeout", "connection_refused", "server_error", "signed_out", "session_expired", "engine_failed", "org_unavailable", "unknown",
  "mcp_connection.configuration", "mcp_connection.oauth", "oauth_provider.connection", "connector.configuration", "connector.sync", "inference.configuration", "inference_provider.configuration", "inference_provider.member_oauth", "provider.configuration", "workflow.execution", "remote_session.execution", "automation.management", "automation.run", "session.authentication", "organization.settings",
  "session.started", "session.ended", "task.started", "task.completed", "task.failed", "workbot.greeting_started", "workbot.greeting_completed", "workbot.greeting_failed", "workbot.turn_completed", "connection.connected",
  "ok", "upstream_error", "upstream_unreachable", "client_aborted", "rejected", "skill", "connector_tool",
  "succeeded", "failed", "partial", "running", "registered", "renamed", "removed", "restored", "disconnected", "state_changed", "app_updated", "computer_changed", "viewer_opened", "paused", "resumed", "rebuilt", "continued",
]);
export const adminTimelineKindLabels: Record<z.infer<typeof adminTimelineKindSchema>, string> = {
  startup_ready: "Desktop opened", startup_failed: "Desktop could not open", certificate: "Certificate was not trusted", dns: "Service address could not be found", offline: "Computer was offline", timeout: "Startup took too long", connection_refused: "Service refused the connection", server_error: "Service returned an error", signed_out: "Member was signed out", session_expired: "Sign-in expired", engine_failed: "Agent could not start", org_unavailable: "Team could not be reached", unknown: "Reason not recorded",
  "mcp_connection.configuration": "Connection settings", "mcp_connection.oauth": "Connection sign-in", "oauth_provider.connection": "Account connection", "connector.configuration": "Connector settings", "connector.sync": "Connector sync", "inference.configuration": "Model settings", "inference_provider.configuration": "Model provider settings", "inference_provider.member_oauth": "Model provider sign-in", "provider.configuration": "Provider settings", "workflow.execution": "Workflow execution", "remote_session.execution": "Remote task", "automation.management": "Automation settings", "automation.run": "Automation execution", "session.authentication": "Account sign-in", "organization.settings": "Team settings",
  "session.started": "Conversation started", "session.ended": "Conversation ended", "task.started": "Task started", "task.completed": "Task completed", "task.failed": "Task failed", "workbot.greeting_started": "Welcome started", "workbot.greeting_completed": "Welcome completed", "workbot.greeting_failed": "Welcome failed", "workbot.turn_completed": "Agent turn completed", "connection.connected": "Service connected",
  ok: "Request completed", upstream_error: "Model service returned an error", upstream_unreachable: "Model service could not be reached", client_aborted: "Client stopped the request", rejected: "Request was refused", skill: "Skill used", connector_tool: "Connected tool called",
  succeeded: "Completed", failed: "Failed", partial: "Partly completed", running: "Still in progress", registered: "Computer registered", renamed: "Computer renamed", removed: "Computer removed", restored: "Computer restored", disconnected: "Computer disconnected", state_changed: "Computer state changed", app_updated: "Desktop updated", computer_changed: "Computer changed", viewer_opened: "Computer viewer opened", paused: "Computer paused", resumed: "Computer resumed", rebuilt: "Computer rebuilt", continued: "Work continued",
};
const outcomeSchema = z.enum(["ok", "failed", "unknown"]);
export const adminTimelineEntrySchema = z.object({
  at: z.iso.datetime(), source: adminTimelineSourceSchema, outcome: outcomeSchema,
  kind: adminTimelineKindSchema, recordId: z.string(), memberId: z.string().nullable(),
});
export type AdminTimelineEntry = z.infer<typeof adminTimelineEntrySchema>;
export const adminOrganizationTimelineSchema = z.object({
  window: z.object({ since: z.iso.datetime(), until: z.iso.datetime() }),
  entries: z.array(adminTimelineEntrySchema),
  sources: z.array(z.object({
    source: adminTimelineSourceSchema, count: z.number().int().nonnegative(), failureCount: z.number().int().nonnegative(),
    lastSeenAt: z.iso.datetime().nullable(), outcome: outcomeSchema, limited: z.boolean(), coverage: z.string(),
  })),
  excludedSources: z.array(z.object({ source: z.string(), reason: z.string() })),
  nextCursor: z.string().nullable(),
});
export type AdminOrganizationTimeline = z.infer<typeof adminOrganizationTimelineSchema>;
