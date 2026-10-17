import { and, asc, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import type { GeneratedArtifactView } from "@openwork/types/workflows"
import { db } from "./db.js"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { getWorkflowDetail, listWorkflowCardFacts } from "./workflows.js"
import { listArtifactViewsForScript, listArtifactViewsForScripts } from "./artifact-views.js"
import {
  resolvePluginArchConfigObjectRoles,
  resolvePluginArchResourceRole,
  type PluginArchActorContext,
  type PluginArchRole,
} from "./routes/org/plugin-system/access.js"
import {
  listMeEffectivePluginAccess,
  type MePluginAccessEdge,
} from "./routes/org/plugin-system/store.js"
import {
  listMemberUsableConnectionFacts,
  type MemberUsableConnectionFacts,
} from "./routes/org/mcp-connections.js"

export type WorkflowLibraryItem = {
  type: "workflow"
  id: string
  plugin: { id: string; name: string } | null
  name: string
  description: string | null
  role: PluginArchRole
  edges: MePluginAccessEdge[]
  state: "ready" | "needs_signin" | "needs_admin_setup"
  resultState: "never_run" | "fresh" | "stale" | "needs_attention"
  latestSuccessfulAt: string | null
  viewState: "default" | "custom_active" | "build_failed" | "retired"
  activeViewTitle: string | null
  automationCount: number
  source: { kind: "created" | "installed_template"; templateName?: string; templateVersion?: string }
}

export type WorkflowLibraryDetail = {
  workflow: WorkflowLibraryItem
  script: Awaited<ReturnType<typeof getWorkflowDetail>>
  views: GeneratedArtifactView[]
}

function accessEdges(input: {
  context: PluginArchActorContext
  createdByOrgMembershipId: string
  grants: Array<typeof ConfigObjectAccessGrantTable.$inferSelect>
  inheritedEdges: MePluginAccessEdge[]
}): MePluginAccessEdge[] {
  const memberId = input.context.organizationContext.currentMember.id
  const teamsById = new Map(input.context.memberTeams.map((team) => [team.id, team]))
  const edges = new Map<string, MePluginAccessEdge>()
  for (const edge of input.inheritedEdges) {
    const key = edge.kind === "team"
      ? `team:${edge.team.id}`
      : edge.kind === "catalog"
        ? `catalog:${edge.marketplace.id}`
        : edge.kind
    edges.set(key, edge)
  }
  if (input.createdByOrgMembershipId === memberId) edges.set("mine", { kind: "mine" })
  for (const grant of input.grants) {
    if (grant.removedAt) continue
    if (grant.orgMembershipId === memberId) {
      edges.set("person", {
        kind: "person",
        sharedBy: null,
        grantedAt: grant.createdAt.toISOString(),
      })
    }
    if (grant.orgWide) edges.set("org_wide", { kind: "org_wide" })
    if (grant.teamId) {
      const team = teamsById.get(grant.teamId)
      if (team) edges.set(`team:${team.id}`, { kind: "team", team: { id: team.id, name: team.name } })
    }
  }
  return [...edges.values()]
}

function viewLifecycle(views: GeneratedArtifactView[]) {
  const active = views.find((view) => view.status === "active" && view.activeRevisionId !== null)
  if (active) return { viewState: "custom_active" as const, activeViewTitle: active.title }
  if (views.some((view) => view.status === "active" && view.revisions.some((revision) => revision.buildStatus === "failed"))) {
    return { viewState: "build_failed" as const, activeViewTitle: null }
  }
  if (views.length > 0 && views.every((view) => view.status === "retired")) {
    return { viewState: "retired" as const, activeViewTitle: null }
  }
  return { viewState: "default" as const, activeViewTitle: null }
}

function connectionReadiness(connection: MemberUsableConnectionFacts) {
  if (
    connection.setupRequired
    || connection.issuerReviewRequired
    || connection.reconnectActionOwner === "organization_admin"
    || connection.authPolicyConfirmed === false
    || connection.authTypeMismatch
    || (connection.oauthClientRequired && !connection.oauthClientConfigured)
    || (connection.credentialMode === "shared" && !connection.connectedForMe)
  ) return "needs_admin_setup" as const
  if (connection.credentialMode === "per_member" && (!connection.connectedForMe || connection.needsReconnect)) {
    return "needs_signin" as const
  }
  return "ready" as const
}

function workflowReadiness(input: {
  connections: MemberUsableConnectionFacts[]
  requiredCapabilities: Array<{ capabilityName: string }>
}) {
  const connections = new Map(input.connections.map((connection) => [connection.id, connection]))
  let state: WorkflowLibraryItem["state"] = "ready"
  for (const capability of input.requiredCapabilities) {
    const match = /^mcp:([^:]+):/.exec(capability.capabilityName)
    if (!match) continue
    const connection = connections.get(match[1] ?? "")
    const requirementState = connection ? connectionReadiness(connection) : "needs_admin_setup"
    if (requirementState === "needs_admin_setup") return requirementState
    if (requirementState === "needs_signin") state = requirementState
  }
  return state
}

type WorkflowCard = {
  row: typeof ConfigObjectTable.$inferSelect
  plugin: { id: string; name: string } | null
  inheritedEdges: MePluginAccessEdge[]
}

type ConfigObjectGrant = typeof ConfigObjectAccessGrantTable.$inferSelect

function workflowLibraryItem(input: WorkflowCard & {
  context: PluginArchActorContext
  connections: MemberUsableConnectionFacts[]
  role: PluginArchRole
  grants: ConfigObjectGrant[]
  requiredCapabilities: Array<{ capabilityName: string }>
  resultState: WorkflowLibraryItem["resultState"]
  latestSuccessfulAt: string | null
  views: GeneratedArtifactView[]
  automationCount: number
}): WorkflowLibraryItem {
  return {
    type: "workflow",
    id: input.row.id,
    plugin: input.plugin,
    name: input.row.title,
    description: input.row.description,
    role: input.role,
    edges: accessEdges({
      context: input.context,
      createdByOrgMembershipId: input.row.createdByOrgMembershipId,
      grants: input.grants,
      inheritedEdges: input.inheritedEdges,
    }),
    state: workflowReadiness({
      connections: input.connections,
      requiredCapabilities: input.requiredCapabilities,
    }),
    resultState: input.resultState,
    latestSuccessfulAt: input.latestSuccessfulAt,
    ...viewLifecycle(input.views),
    automationCount: input.automationCount,
    source: { kind: "created" },
  }
}

async function workflowGrants(context: PluginArchActorContext, configObjectIds: ConfigObjectGrant["configObjectId"][]) {
  const grants = new Map<string, ConfigObjectGrant[]>()
  if (configObjectIds.length === 0) return grants
  const rows = await db.select().from(ConfigObjectAccessGrantTable).where(and(
    eq(ConfigObjectAccessGrantTable.organizationId, context.organizationContext.organization.id),
    inArray(ConfigObjectAccessGrantTable.configObjectId, configObjectIds),
  ))
  for (const row of rows) {
    const forWorkflow = grants.get(row.configObjectId) ?? []
    forWorkflow.push(row)
    grants.set(row.configObjectId, forWorkflow)
  }
  return grants
}

async function workflowItem(input: WorkflowCard & {
  context: PluginArchActorContext
  connections: MemberUsableConnectionFacts[]
}): Promise<WorkflowLibraryItem | null> {
  const role = await resolvePluginArchResourceRole({
    context: input.context,
    resourceId: input.row.id,
    resourceKind: "config_object",
  })
  if (!role) return null
  try {
    const [script, views, grants] = await Promise.all([
      getWorkflowDetail({ context: input.context, configObjectId: input.row.id }),
      listArtifactViewsForScript({ context: input.context, configObjectId: input.row.id }),
      workflowGrants(input.context, [input.row.id]),
    ])
    return workflowLibraryItem({
      ...input,
      role,
      grants: grants.get(input.row.id) ?? [],
      requiredCapabilities: script.currentVersion.requiredCapabilities,
      resultState: script.freshness.state,
      latestSuccessfulAt: script.latestSuccessfulSnapshot?.finishedAt ?? null,
      views,
      automationCount: new Set(script.versions.flatMap((version) => version.automationReferences.map((reference) => reference.id))).size,
    })
  } catch {
    return null
  }
}

/** Library cards for many Workflows, read in batches instead of one detail load per Workflow. */
async function workflowLibraryItems(input: {
  context: PluginArchActorContext
  connections: MemberUsableConnectionFacts[]
  workflows: WorkflowCard[]
}): Promise<WorkflowLibraryItem[]> {
  const roles = await resolvePluginArchConfigObjectRoles(input.context, input.workflows.map((workflow) => workflow.row.id))
  const readable = input.workflows.filter((workflow) => roles.has(workflow.row.id))
  const readableIds = readable.map((workflow) => workflow.row.id)
  const [facts, views, grants] = await Promise.all([
    listWorkflowCardFacts(input.context, readableIds),
    listArtifactViewsForScripts({ context: input.context, configObjectIds: readableIds }),
    workflowGrants(input.context, readableIds),
  ])
  return readable.flatMap((workflow) => {
    const role = roles.get(workflow.row.id)
    const card = facts.get(workflow.row.id)
    if (!role || !card) return []
    return [workflowLibraryItem({
      ...workflow,
      context: input.context,
      connections: input.connections,
      role,
      grants: grants.get(workflow.row.id) ?? [],
      requiredCapabilities: card.requiredCapabilities,
      resultState: card.freshness.state,
      latestSuccessfulAt: card.latestSuccessfulAt,
      views: views.get(workflow.row.id) ?? [],
      automationCount: card.automationCount,
    })]
  })
}

export async function listWorkflowLibraryItems(input: { context: PluginArchActorContext }) {
  const [rows, effectiveAccess, connections] = await Promise.all([
    db.select({
      configObject: ConfigObjectTable,
      pluginId: PluginConfigObjectTable.pluginId,
      pluginName: PluginTable.name,
    })
      .from(ConfigObjectTable)
      .innerJoin(PluginConfigObjectTable, and(
        eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
        isNull(PluginConfigObjectTable.removedAt),
      ))
      .innerJoin(PluginTable, and(
        eq(PluginTable.id, PluginConfigObjectTable.pluginId),
        eq(PluginTable.organizationId, ConfigObjectTable.organizationId),
        eq(PluginTable.status, "active"),
        isNull(PluginTable.deletedAt),
      ))
      .where(and(
        eq(ConfigObjectTable.organizationId, input.context.organizationContext.organization.id),
        eq(ConfigObjectTable.objectType, "workflow"),
        eq(ConfigObjectTable.status, "active"),
        isNull(ConfigObjectTable.deletedAt),
      ))
      .orderBy(
        desc(ConfigObjectTable.updatedAt),
        desc(ConfigObjectTable.id),
        asc(PluginConfigObjectTable.createdAt),
        asc(PluginConfigObjectTable.id),
      ),
    listMeEffectivePluginAccess({ context: input.context }),
    listMemberUsableConnectionFacts({ context: input.context }),
  ])
  const pluginEdges = new Map(effectiveAccess.items.map((item) => [item.plugin.id, item.edges]))
  const workflows = new Map<string, WorkflowCard>()
  for (const { configObject, pluginId, pluginName } of rows) {
    const pluginIsVisible = pluginEdges.has(pluginId)
    const workflow = workflows.get(configObject.id) ?? {
      row: configObject,
      plugin: null,
      inheritedEdges: [],
    }
    if (!workflow.plugin && pluginIsVisible) {
      workflow.plugin = { id: pluginId, name: pluginName }
    }
    workflow.inheritedEdges.push(...(pluginEdges.get(pluginId) ?? []))
    workflows.set(configObject.id, workflow)
  }
  return workflowLibraryItems({ context: input.context, connections, workflows: [...workflows.values()] })
}

export async function getWorkflowLibraryDetail(input: {
  context: PluginArchActorContext
  configObjectId: string
  maxAgeMs?: number
}): Promise<WorkflowLibraryDetail> {
  const [script, views, effectiveAccess, connections] = await Promise.all([
    getWorkflowDetail({ context: input.context, configObjectId: input.configObjectId, maxAgeMs: input.maxAgeMs }),
    listArtifactViewsForScript({ context: input.context, configObjectId: input.configObjectId }),
    listMeEffectivePluginAccess({ context: input.context }),
    listMemberUsableConnectionFacts({ context: input.context }),
  ])
  const rows = await db.select().from(ConfigObjectTable).where(eq(
    ConfigObjectTable.id,
    normalizeDenTypeId("configObject", script.configObjectId),
  )).limit(1)
  const row = rows[0]
  if (!row) throw new Error("workflow_not_found")
  const memberships = await db.select({ pluginId: PluginConfigObjectTable.pluginId, pluginName: PluginTable.name })
    .from(PluginConfigObjectTable)
    .innerJoin(PluginTable, eq(PluginTable.id, PluginConfigObjectTable.pluginId))
    .where(and(
      eq(PluginConfigObjectTable.organizationId, input.context.organizationContext.organization.id),
      eq(PluginConfigObjectTable.configObjectId, row.id),
      isNull(PluginConfigObjectTable.removedAt),
    ))
    .orderBy(asc(PluginConfigObjectTable.createdAt), asc(PluginConfigObjectTable.id))
  const pluginEdges = new Map(effectiveAccess.items.map((item) => [item.plugin.id, item.edges]))
  const inheritedEdges = memberships.flatMap(({ pluginId }) => pluginEdges.get(pluginId) ?? [])
  if (!memberships[0]) throw new Error("workflow_not_found")
  const visibleParent = memberships.find(({ pluginId }) => pluginEdges.has(pluginId))
  const workflow = await workflowItem({
    context: input.context,
    row,
    plugin: visibleParent ? { id: visibleParent.pluginId, name: visibleParent.pluginName } : null,
    inheritedEdges,
    connections,
  })
  if (!workflow) throw new Error("workflow_not_found")
  // A readable Workflow already permits manual REST/MCP execution using the
  // caller's live tools. Do not project the stricter scheduling permission onto
  // this library action; scheduling and manager-only editing keep their checks.
  return { workflow, script: { ...script, canRun: true }, views }
}
