import type { AuditOrigin } from "@openwork-ee/den-db/audit-log"
import { AUDIT_ROUTE_EVENT_SUFFIXES, type AuditRouteClass } from "./routes/types.js"

// Non-HTTP mutation paths (design §6): MCP tools that mutate organization state
// without re-entering a den-api route. Each entry is recorded through
// src/audit/mcp-service-audit.ts → runAuditedServiceAction with the MCP
// principal (or the platform admin for admin tools). Tool calls that re-enter
// den-api through invokeMcpOperation are recorded at the destination route and
// never appear here. scripts/check-audit-route-coverage.ts validates the list
// without requiring a generated report.

export type AuditServiceActionClass = Extract<AuditRouteClass, "tenant_change" | "tenant_external" | "tenant_job">

export type AuditServiceActionDeclaration = Readonly<{
  /** Semantic stem; events are `${action}.${suffix}` with the class suffixes of route declarations. */
  action: string
  kind: string
  class: AuditServiceActionClass
  /** Target resource type; `idFrom` names where the recorded id comes from (null: collection). */
  resource: Readonly<{ type: string; idFrom: string | null }>
  origin: Extract<AuditOrigin, "mcp" | "platform_admin">
  /** MCP tools (or capability names) that reach this mutation. */
  tools: readonly string[]
  /** `file:function` of each wrapped call site. */
  callSites: readonly string[]
  external?: string
  jobOutcome?: string
  notes?: string
}>

const MCP_PRINCIPAL = "Tenant is the MCP token's organization claim; actor is the token user and its active member, credential the grant/client id."

export const auditServiceActionDeclarations = [
  {
    action: "plugin.bundle.create", kind: "plugin.configuration", class: "tenant_change", resource: { type: "plugin", idFrom: null }, origin: "mcp",
    tools: ["create_skill"], callSites: ["src/mcp/agent.ts:registerAgentSkillTools.create → createPluginBundle"],
    notes: `Creates a Plugin holding one skill. ${MCP_PRINCIPAL}`,
  },
  {
    action: "skill.version.create", kind: "config_object.configuration", class: "tenant_change", resource: { type: "config_object", idFrom: "skillId argument (validated typeid)" }, origin: "mcp",
    tools: ["update_skill"], callSites: ["src/mcp/agent.ts:registerAgentSkillTools.update → createConfigObjectVersion"],
    notes: `Same store write as POST /v1/config-objects/:configObjectId/versions (config_object.version.create), reached without the route. ${MCP_PRINCIPAL}`,
  },
  {
    action: "native_mcp_event.subscribe", kind: "mcp_event.subscription", class: "tenant_external", resource: { type: "mcp_native_subscription", idFrom: null }, origin: "mcp",
    external: "subscriber MCP webhook endpoint",
    tools: ["events/subscribe"], callSites: ["src/native-mcp-events/mcp.ts:subscribe"], notes: "Creates or refreshes a finite owner-scoped event subscription. Callback credentials are never captured.",
  },
  {
    action: "native_mcp_event.unsubscribe", kind: "mcp_event.subscription", class: "tenant_external", resource: { type: "mcp_native_subscription", idFrom: null }, origin: "mcp",
    external: "subscriber MCP webhook endpoint",
    tools: ["events/unsubscribe"], callSites: ["src/native-mcp-events/mcp.ts:unsubscribe"], notes: "Stops a native event watch belonging to the verified MCP caller.",
  },
  {
    action: "mcp_event.subscribe", kind: "mcp_event.subscription", class: "tenant_external", resource: { type: "mcp_event_subscription", idFrom: null }, origin: "mcp",
    external: "connected MCP server (events/subscribe)",
    tools: ["subscribe_mcp_event"], callSites: ["src/mcp-events/tools.ts:subscribe"],
    notes: `Thread-bound finite webhook subscription; callback secret and filters are never audit fields. ${MCP_PRINCIPAL}`,
  },
  {
    action: "mcp_event.unsubscribe", kind: "mcp_event.subscription", class: "tenant_external", resource: { type: "mcp_event_subscription", idFrom: null }, origin: "mcp",
    external: "connected MCP server (events/unsubscribe)",
    tools: ["unsubscribe_mcp_event"], callSites: ["src/mcp-events/tools.ts:unsubscribe"],
    notes: `Local cancellation precedes best-effort remote unsubscribe. ${MCP_PRINCIPAL}`,
  },
  {
    action: "mcp_app.create", kind: "app.management", class: "tenant_change", resource: { type: "mcp_app", idFrom: null }, origin: "mcp",
    tools: ["create_app"], callSites: ["src/mcp/agent.ts:registerAppBuilderTools.create → createMcpApp"],
    notes: `Plugin, App config object and Workflow memberships; archives the Plugin on failure. ${MCP_PRINCIPAL}`,
  },
  {
    action: "mcp_app.update", kind: "app.management", class: "tenant_change", resource: { type: "mcp_app", idFrom: "appId argument (validated typeid)" }, origin: "mcp",
    tools: ["update_app"], callSites: ["src/mcp/agent.ts:registerAppBuilderTools.update → updateMcpApp"],
    notes: MCP_PRINCIPAL,
  },
  {
    action: "artifact_view.save", kind: "workflow.management", class: "tenant_change", resource: { type: "artifact_view", idFrom: "artifactViewId argument (null when creating)" }, origin: "mcp",
    tools: ["save_artifact_view"], callSites: ["src/mcp/agent.ts:registerAgentGeneratedArtifactViews.save → saveArtifactViewRevision"],
    notes: `Legacy Workflow-bound views; only writable while Apps built in OpenWork are off. ${MCP_PRINCIPAL}`,
  },
  {
    action: "artifact_view.activate", kind: "workflow.management", class: "tenant_change", resource: { type: "artifact_view", idFrom: "artifactViewId argument" }, origin: "mcp",
    tools: ["activate_artifact_view_revision"], callSites: ["src/mcp/agent.ts:registerAgentGeneratedArtifactViews.activate → activateArtifactViewRevision"],
    notes: `REST equivalent artifact_view.revision.activate. ${MCP_PRINCIPAL}`,
  },
  {
    action: "artifact_view.deactivate", kind: "workflow.management", class: "tenant_change", resource: { type: "artifact_view", idFrom: "artifactViewId argument" }, origin: "mcp",
    tools: ["retire_artifact_view"], callSites: ["src/mcp/agent.ts:registerAgentGeneratedArtifactViews.retire → retireArtifactView"],
    notes: `Retires the render capability; REST equivalent artifact_view.retire. ${MCP_PRINCIPAL}`,
  },
  {
    action: "workflow_run.record", kind: "workflow.execution", class: "tenant_external", resource: { type: "workflow", idFrom: null }, origin: "mcp",
    tools: ["execute_capability_script"], callSites: ["src/mcp/agent.ts:execute_capability_script → executeWorkflowAuthoringTest + recordWorkflowRun"],
    external: "connected services (Code Mode capability tool calls: Google Workspace, Microsoft 365, external MCP servers)",
    notes: `Authoring test run and its workflow_run receipt; REST equivalent workflow.test. Nested Den/native tool calls re-enter den-api and are recorded at their destination routes. ${MCP_PRINCIPAL}`,
  },
  {
    action: "workflow.execute", kind: "workflow.execution", class: "tenant_external", resource: { type: "workflow", idFrom: "configObjectId of the Workflow" }, origin: "mcp",
    tools: ["execute_capability plugin:<pluginId>:<workflowId>", "Code Mode marketplace tools", "App server Workflow tools (/mcp/agent/connections/<appId>)", "render_workflow_artifact (dataMode live)", "live artifact view tools"],
    callSites: [
      "src/mcp/capability-registry.ts:executeMarketplaceSource → executeMarketplaceCapability(auditWorkflowExecution) → executeWorkflow",
      "src/mcp/app-tools.ts:callMcpAppTool → executeMarketplaceCapability(auditWorkflowExecution)",
      "src/mcp/agent.ts:loadWorkflowArtifact → executeLiveArtifactWorkflow",
    ],
    external: "connected services (Workflow capability tool calls; live mode read-only)",
    notes: `Saved Workflow run and its workflow_run receipt; REST equivalent workflow.run. Route and Automation callers of executeMarketplaceCapability pass no audit hook (recorded by their route or not operation-audited). ${MCP_PRINCIPAL}`,
  },
  {
    action: "remote_session.create", kind: "remote_session.execution", class: "tenant_job", resource: { type: "remote_session", idFrom: null }, origin: "mcp",
    tools: ["execute_capability remote-session:create"], callSites: ["src/mcp/capability-registry.ts:remoteSessionSource.execute → executeRemoteSessionCapability"],
    jobOutcome: "Desktop: runner callbacks POST /v1/remote-session-commands/:id/{claim,complete,session} (declared routes). Cloud: not_recorded: the session runs on the member's OpenWork Web worker.",
    notes: `A desktop or registered target that takes nothing from other devices (its owner's choice, no choice yet under remoteTasksOptIn, or the organization's ceiling) is refused with remote_access_off: nothing is queued and the refusal is recorded as a failed outcome. ${MCP_PRINCIPAL}`,
  },
  {
    action: "remote_session.send", kind: "remote_session.execution", class: "tenant_job", resource: { type: "remote_session", idFrom: "sessionId argument" }, origin: "mcp",
    tools: ["execute_capability remote-session:send"], callSites: ["src/mcp/capability-registry.ts:remoteSessionSource.execute → executeRemoteSessionCapability"],
    jobOutcome: "Desktop: runner callbacks POST /v1/remote-session-requests/:id/{claim,complete} and /v1/remote-session-commands/:id/session (declared routes). Cloud: not_recorded: the turn runs on the member's OpenWork Web worker.",
    notes: MCP_PRINCIPAL,
  },
  {
    action: "remote_session.stop", kind: "remote_session.execution", class: "tenant_job", resource: { type: "remote_session", idFrom: "sessionId argument" }, origin: "mcp",
    tools: ["execute_capability remote-session:stop"], callSites: ["src/mcp/capability-registry.ts:remoteSessionSource.execute → executeRemoteSessionCapability"],
    jobOutcome: "Desktop: runner callbacks POST /v1/remote-session-requests/:id/{claim,complete} (declared routes). Cloud: not_recorded: the abort is synchronous on the member's OpenWork Web worker.",
    notes: MCP_PRINCIPAL,
  },
  {
    action: "remote_session.answer", kind: "remote_session.execution", class: "tenant_job", resource: { type: "remote_session", idFrom: "sessionId argument" }, origin: "mcp",
    tools: ["execute_capability remote-session:answer"], callSites: ["src/mcp/capability-registry.ts:remoteSessionSource.execute → executeRemoteSessionCapability"],
    jobOutcome: "Desktop: runner callbacks POST /v1/remote-session-requests/:id/{claim,complete} (declared routes). Cloud: not_recorded: the reply is synchronous on the member's OpenWork Web worker.",
    notes: `The member's agent answers their own remote session's open question or permission after asking them, or dismisses a question they want skipped (mcp:write, agent chats only). ${MCP_PRINCIPAL}`,
  },
  {
    action: "remote_session.attach", kind: "remote_session.execution", class: "tenant_job", resource: { type: "remote_session", idFrom: "sessionId argument" }, origin: "mcp",
    tools: ["execute_capability remote-session:attach"], callSites: ["src/mcp/capability-registry.ts:remoteSessionSource.execute → executeRemoteSessionCapability"],
    jobOutcome: "Runner callbacks POST /v1/remote-session-commands/:id/{claim,complete,session} (declared routes).",
    notes: `remoteSessionAccess: the member's agent attaches to a session that was started on one of the member's own computers, where the organization's ceiling and the computer's owner both allow every session (mcp:write, agent chats only). Refusals queue nothing and are recorded as failed outcomes. REST equivalent remote_session.session.attach. ${MCP_PRINCIPAL}`,
  },
  {
    action: "slack_assistant.bot_message.send", kind: "slack_assistant.execution", class: "tenant_external", resource: { type: "slack_message", idFrom: null }, origin: "mcp",
    tools: ["execute_capability slack_send_as_bot", "openwork-bot.slack_send_as_bot (full tool view)"], callSites: ["src/mcp/capability-registry.ts:slackSendAsBotSource.execute → executeSlackSendAsBot"],
    external: "Slack Web API with the OpenWork Slack app's bot token (conversations.open and chat.postMessage; chat.getPermalink) and, for a channel post, conversations.history with the member's own Slack token to confirm they can read the channel",
    notes: `A DM to the caller or a channel post credited to them, from the OpenWork Slack app's bot (mcp:write). Refusals (limits, targets, no Slack app, unlinked member) are recorded as failed outcomes. Not callable from Code Mode scripts. ${MCP_PRINCIPAL}`,
  },
  {
    action: "agent.check_request.create", kind: "agent.member", class: "tenant_change", resource: { type: "agent_instance", idFrom: "the token's own member id" }, origin: "mcp",
    tools: ["request_check"], callSites: ["src/mcp/agent-check-request.ts:registerAgentCheckRequestTool → requestAgentCheck"],
    notes: `workbotAgentBrief: a member's background agent asks for one extra check of its own member's sources. Only the agent's read-scoped check token sees it; it changes only that member's agent schedule, capped per day and inside their hours. Refusals (limit, outside hours, unreadable time) are recorded as failed outcomes. ${MCP_PRINCIPAL}`,
  },
  {
    action: "organization.plan.set", kind: "platform.admin.organization", class: "tenant_change", resource: { type: "organization", idFrom: "organizationId argument (verified to exist)" }, origin: "platform_admin",
    tools: ["den_update_org_plan", "admin:den_update_org_plan"], callSites: ["src/mcp/admin-tools.ts:den_update_org_plan → updateOrganizationMetadata"],
    notes: "Platform-admin MCP tool (/mcp/admin or /mcp/agent admin capability). Tenant is the verified argument organization; actor is the platform admin user without a member id. REST equivalent organization.plan.update.",
  },
  {
    action: "organization.capability.set", kind: "platform.admin.organization", class: "tenant_change", resource: { type: "organization", idFrom: "organizationId argument (verified to exist)" }, origin: "platform_admin",
    tools: ["den_set_org_capability", "admin:den_set_org_capability"], callSites: ["src/mcp/admin-tools.ts:den_set_org_capability → updateOrganizationFeatureOverrides"],
    notes: "Platform-admin MCP tool: sets or clears one organization feature override (organization_feature). Tenant is the verified argument organization; actor is the platform admin user. REST equivalent organization.capabilities.update. The deployment-wide den_set_feature_rollout tool changes no organization's data and is not a tenant service action (see the notes on PUT /v1/admin/features/:key).",
  },
] as const satisfies readonly AuditServiceActionDeclaration[]

export type AuditServiceActionName = typeof auditServiceActionDeclarations[number]["action"]

export function auditServiceActionEventTypesFor(declaration: AuditServiceActionDeclaration): string[] {
  return AUDIT_ROUTE_EVENT_SUFFIXES[declaration.class].map((suffix) => `${declaration.action}.${suffix}`)
}

/** Tenant-visible event types of every service-layer action. */
export function auditServiceActionEventTypes(): string[] {
  return [...new Set(auditServiceActionDeclarations.flatMap(auditServiceActionEventTypesFor))].sort()
}

export function auditServiceActionDeclaration(action: AuditServiceActionName): AuditServiceActionDeclaration {
  const declaration = auditServiceActionDeclarations.find((entry) => entry.action === action)
  if (!declaration) throw new Error(`undeclared audit service action ${action}`)
  return declaration
}
