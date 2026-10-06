import type { AuditOrigin } from "@openwork-ee/den-db/audit-log"
import { AUDIT_ROUTE_EVENT_SUFFIXES, type AuditRouteClass } from "./routes/types.js"

// Non-HTTP mutation paths (design §6): MCP tools that mutate organization state
// without re-entering a den-api route. Each entry is recorded through
// src/audit/mcp-service-audit.ts → runAuditedServiceAction with the MCP
// principal (or the platform admin for admin tools). Tool calls that re-enter
// den-api through invokeMcpOperation are recorded at the destination route and
// never appear here. scripts/check-audit-route-coverage.ts validates the list
// and renders it into COVERAGE.md.

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
    notes: MCP_PRINCIPAL,
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
    action: "organization.plan.set", kind: "platform.admin.organization", class: "tenant_change", resource: { type: "organization", idFrom: "organizationId argument (verified to exist)" }, origin: "platform_admin",
    tools: ["den_update_org_plan", "admin:den_update_org_plan"], callSites: ["src/mcp/admin-tools.ts:den_update_org_plan → updateOrganizationMetadata"],
    notes: "Platform-admin MCP tool (/mcp/admin or /mcp/agent admin capability). Tenant is the verified argument organization; actor is the platform admin user without a member id. REST equivalent organization.plan.update.",
  },
  {
    action: "organization.capability.set", kind: "platform.admin.organization", class: "tenant_change", resource: { type: "organization", idFrom: "organizationId argument (verified to exist)" }, origin: "platform_admin",
    tools: ["den_set_org_capability", "admin:den_set_org_capability"], callSites: ["src/mcp/admin-tools.ts:den_set_org_capability → setOrganizationFeatureOverrides"],
    notes: "Platform-admin MCP tool: sets or clears one organization feature override (organization_feature). Can flip auditLogs itself (the feature read before the write decides capture). Tenant is the verified argument organization; actor is the platform admin user. REST equivalent organization.capabilities.update. The deployment-wide den_set_feature_rollout tool changes no organization's data and is not a tenant service action (see the notes on PUT /v1/admin/features/:key).",
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
