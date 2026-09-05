import type { SavedAppDetail, SavedAppSummary } from "@openwork/types/workflows"
import { getArtifactView, getGeneratedArtifactViewRevision, listArtifactViews, loadArtifactViewRevision } from "./artifact-views.js"
import { getWorkflowDetail, getWorkflowSnapshot } from "./workflows.js"
import type { PluginArchActorContext } from "./routes/org/plugin-system/access.js"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, DashboardAppTable, MemberTable } from "@openwork-ee/den-db/schema"
import { requirePluginArchResourceRole } from "./routes/org/plugin-system/access.js"
import { createResourceAccessGrant, listResourceAccess } from "./routes/org/plugin-system/store.js"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"

function dashboardScope(context: PluginArchActorContext) {
  return and(
    eq(DashboardAppTable.organization_id, context.organizationContext.organization.id),
    eq(DashboardAppTable.member_id, context.organizationContext.currentMember.id),
  )
}

/** Share through the workflow's existing access model; never copy result data. */
export async function shareSavedApp(context: PluginArchActorContext, appId: string, email: string) {
  const view = await getArtifactView({ context, artifactViewId: appId })
  if (view.status !== "active" || !view.activeRevisionId) throw new Error("artifact_view_not_found")
  const resource: { context: PluginArchActorContext; resourceId: DenTypeId<"configObject">; resourceKind: "config_object" } = {
    context, resourceId: normalizeDenTypeId("configObject", view.configObjectId), resourceKind: "config_object",
  }
  await requirePluginArchResourceRole({ ...resource, role: "manager" })
  const organizationId = context.organizationContext.organization.id
  const [member] = await db.select({ id: MemberTable.id }).from(MemberTable)
    .innerJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .where(and(eq(MemberTable.organizationId, organizationId), eq(AuthUserTable.email, email.trim().toLowerCase()), isNull(MemberTable.removedAt)))
    .limit(1)
  if (!member) throw new Error("teammate_not_found")
  const grants = await listResourceAccess(resource)
  // Repeated shares must not downgrade an existing editor or manager grant.
  if (!grants.items.some((grant) => grant.orgMembershipId === member.id && !grant.removedAt)) {
    await createResourceAccessGrant({ ...resource, value: { orgMembershipId: member.id, orgWide: false, role: "viewer" } })
  }
  const id = normalizeDenTypeId("artifactView", view.id)
  await db.insert(DashboardAppTable).values({ organization_id: organizationId, member_id: member.id, artifact_view_id: id })
    .onDuplicateKeyUpdate({ set: { artifact_view_id: id } })
}

export async function setAppOnDashboard(context: PluginArchActorContext, appId: string, added: boolean) {
  const id = normalizeDenTypeId("artifactView", appId)
  if (added) {
    const view = await getArtifactView({ context, artifactViewId: id })
    if (view.status !== "active" || !view.activeRevisionId) throw new Error("artifact_view_not_found")
    await db.insert(DashboardAppTable).values({
      organization_id: context.organizationContext.organization.id,
      member_id: context.organizationContext.currentMember.id,
      artifact_view_id: id,
    }).onDuplicateKeyUpdate({ set: { artifact_view_id: id } })
  } else {
    // Removal remains possible if access to the underlying app was revoked.
    await db.delete(DashboardAppTable).where(and(dashboardScope(context), eq(DashboardAppTable.artifact_view_id, id)))
  }
}

export async function listSavedApps(context: PluginArchActorContext): Promise<SavedAppSummary[]> {
  const views = await listArtifactViews({ context, activeOnly: true, savedOnly: true })
  const placements = await db.select().from(DashboardAppTable).where(dashboardScope(context))
  const onDashboard = new Set(placements.map((entry) => entry.artifact_view_id))
  return Promise.all(views.filter((view) => view.activeRevisionId !== null).map(async (view) => {
    const workflow = await getWorkflowDetail({ context, configObjectId: view.configObjectId })
    return { view, workflowTitle: workflow.title, canManage: workflow.canManage, onDashboard: onDashboard.has(normalizeDenTypeId("artifactView", view.id)) }
  }))
}

export async function getSavedApp(input: {
  context: PluginArchActorContext
  appId: string
  revisionId?: string
  receiptId?: string
}): Promise<SavedAppDetail> {
  // The exact-revision path also restores a draft from its original conversation.
  const view = input.revisionId
    ? (await getGeneratedArtifactViewRevision({ context: input.context, artifactViewId: input.appId, revisionId: input.revisionId })).view
    : await getArtifactView({ context: input.context, artifactViewId: input.appId })
  if (!view) throw new Error("artifact_view_not_found")
  const workflow = await getWorkflowDetail({ context: input.context, configObjectId: view.configObjectId })
  const revisionId = input.revisionId ?? view.activeRevisionId
  const revision = view.revisions.find((entry) => entry.id === revisionId) ?? null
  const placements = await db.select().from(DashboardAppTable).where(and(dashboardScope(input.context),
    eq(DashboardAppTable.artifact_view_id, normalizeDenTypeId("artifactView", view.id)))).limit(1)
  const base = { view, workflowTitle: workflow.title, canManage: workflow.canManage, onDashboard: placements.length > 0, revision }
  if (!revision || revision.buildStatus !== "ready") {
    return { ...base, html: null, payload: null, previewNotice: "This app is still being prepared. Ask OpenWork to finish its preview." }
  }
  const { revision: stored } = await loadArtifactViewRevision({ context: input.context, artifactViewId: view.id, revisionId: revision.id })
  const snapshot = input.receiptId
    ? await getWorkflowSnapshot({ context: input.context, configObjectId: view.configObjectId, receiptId: input.receiptId })
    : workflow.latestSuccessfulSnapshot
  if (!snapshot || snapshot.status !== "succeeded" || snapshot.contentDeletedAt || !snapshot.resultDigest || !snapshot.rendererVersion) {
    return { ...base, html: null, payload: null, previewNotice: "Run the workflow to give this app a result to display." }
  }
  if (snapshot.outputSchemaDigest !== revision.outputSchemaDigest) {
    return { ...base, html: null, payload: null, previewNotice: "The workflow’s results have changed. Ask OpenWork to update this app to match." }
  }
  return {
    ...base,
    html: stored.compiled_html,
    previewNotice: null,
    payload: {
      schemaVersion: "1",
      artifact: {
        title: workflow.title,
        description: workflow.description,
        pluginId: snapshot.pluginId,
        configObjectId: snapshot.configObjectId,
        configObjectVersionId: snapshot.configObjectVersionId,
        receiptId: snapshot.receiptId,
        automationRunId: snapshot.automationRunId,
        source: snapshot.source,
        generatedAt: snapshot.finishedAt,
        resultDigest: snapshot.resultDigest,
        rendererVersion: snapshot.rendererVersion,
        freshness: workflow.freshness,
      },
      data: snapshot.value,
    },
  }
}
