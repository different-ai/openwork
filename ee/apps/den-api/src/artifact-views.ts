import { and, desc, eq, isNull, isNotNull } from "@openwork-ee/den-db/drizzle"
import { ArtifactViewRevisionTable, ArtifactViewTable, DashboardAppTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { GeneratedArtifactView, GeneratedArtifactViewRevision } from "@openwork/types/workflows"
import { db } from "./db.js"
import { getWorkflowDetail } from "./workflows.js"
import { buildGeneratedArtifactView } from "./generated-artifact-view-builder.js"
import type { PluginArchActorContext } from "./routes/org/plugin-system/access.js"
import { artifactViewResourceUri } from "./artifact-view-resource.js"

const ARTIFACT_VIEW_LIST_LIMIT = 50
const ARTIFACT_VIEW_REVISION_LIST_LIMIT = 50

type ArtifactViewId = DenTypeId<"artifactView">
type ArtifactViewRevisionId = DenTypeId<"artifactViewRevision">
type ArtifactViewRow = typeof ArtifactViewTable.$inferSelect
type ArtifactViewRevisionRow = typeof ArtifactViewRevisionTable.$inferSelect

function parseViewId(value: string): ArtifactViewId {
  return normalizeDenTypeId("artifactView", value)
}

function parseRevisionId(value: string): ArtifactViewRevisionId {
  return normalizeDenTypeId("artifactViewRevision", value)
}

function serializeRevision(row: ArtifactViewRevisionRow): GeneratedArtifactViewRevision {
  return {
    id: row.id,
    artifactViewId: row.artifact_view_id,
    resourceUri: artifactViewResourceUri(row.artifact_view_id, row.id),
    buildStatus: row.build_status,
    sourceDigest: row.source_digest,
    resourceDigest: row.resource_digest,
    outputSchemaDigest: row.output_schema_digest,
    csp: row.csp,
    diagnostics: row.build_diagnostics,
    compilerName: row.compiler_name,
    compilerVersion: row.compiler_version,
    reactVersion: row.react_version,
    compiledHtmlBytes: row.compiled_html_bytes,
    retiredAt: row.retired_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }
}

function serializeView(row: ArtifactViewRow, revisions: ArtifactViewRevisionRow[]): GeneratedArtifactView {
  return {
    id: row.id,
    configObjectId: row.config_object_id,
    title: row.title,
    description: row.description,
    status: row.status,
    activeRevisionId: row.active_revision_id,
    useInWorkflow: row.use_in_workflow,
    revisions: revisions.map(serializeRevision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

async function accessibleView(input: {
  context: PluginArchActorContext
  artifactViewId: string
  role: "viewer" | "manager"
}): Promise<ArtifactViewRow> {
  const viewId = parseViewId(input.artifactViewId)
  const rows = await db.select().from(ArtifactViewTable).where(and(
    eq(ArtifactViewTable.id, viewId),
    eq(ArtifactViewTable.organization_id, input.context.organizationContext.organization.id),
  )).limit(1)
  const row = rows[0]
  if (!row) throw new Error("artifact_view_not_found")
  const script = await getWorkflowDetail({ context: input.context, configObjectId: row.config_object_id })
  if (input.role === "manager" && !script.canManage) throw new Error("artifact_view_not_found")
  return row
}

async function revisionRows(artifactViewId: ArtifactViewId): Promise<ArtifactViewRevisionRow[]> {
  return db.select().from(ArtifactViewRevisionTable).where(eq(
    ArtifactViewRevisionTable.artifact_view_id,
    artifactViewId,
  )).orderBy(desc(ArtifactViewRevisionTable.created_at), desc(ArtifactViewRevisionTable.id))
    .limit(ARTIFACT_VIEW_REVISION_LIST_LIMIT)
}

export async function listArtifactViews(input: {
  context: PluginArchActorContext
  activeOnly?: boolean
  savedOnly?: boolean
}): Promise<GeneratedArtifactView[]> {
  const conditions = [eq(ArtifactViewTable.organization_id, input.context.organizationContext.organization.id)]
  if (input.activeOnly) {
    conditions.push(eq(ArtifactViewTable.status, "active"))
  }
  if (input.savedOnly) conditions.push(isNotNull(ArtifactViewTable.active_revision_id))
  const rows = await db.select().from(ArtifactViewTable)
    .where(and(...conditions))
    .orderBy(desc(ArtifactViewTable.updated_at), desc(ArtifactViewTable.id))
    .limit(ARTIFACT_VIEW_LIST_LIMIT)
  const accessible = await Promise.all(rows.map(async (row) => {
    try {
      await getWorkflowDetail({ context: input.context, configObjectId: row.config_object_id })
      return serializeView(row, await revisionRows(row.id))
    } catch {
      return null
    }
  }))
  return accessible.filter((view): view is GeneratedArtifactView => view !== null)
}

export async function listArtifactViewsForScript(input: {
  context: PluginArchActorContext
  configObjectId: string
}): Promise<GeneratedArtifactView[]> {
  const script = await getWorkflowDetail({ context: input.context, configObjectId: input.configObjectId })
  const rows = await db.select().from(ArtifactViewTable).where(and(
    eq(ArtifactViewTable.organization_id, input.context.organizationContext.organization.id),
    eq(ArtifactViewTable.config_object_id, normalizeDenTypeId("configObject", script.configObjectId)),
  )).orderBy(desc(ArtifactViewTable.updated_at), desc(ArtifactViewTable.id))
  return Promise.all(rows.map(async (row) => serializeView(row, await revisionRows(row.id))))
}

export async function loadArtifactViewRevision(input: {
  context: PluginArchActorContext
  artifactViewId: string
  revisionId: string
}): Promise<{
  view: ArtifactViewRow
  revision: ArtifactViewRevisionRow
}> {
  const view = await accessibleView({ context: input.context, artifactViewId: input.artifactViewId, role: "viewer" })
  const revisionId = parseRevisionId(input.revisionId)
  const rows = await db.select().from(ArtifactViewRevisionTable).where(and(
    eq(ArtifactViewRevisionTable.id, revisionId),
    eq(ArtifactViewRevisionTable.artifact_view_id, view.id),
    eq(ArtifactViewRevisionTable.organization_id, view.organization_id),
  )).limit(1)
  const revision = rows[0]
  if (!revision) throw new Error("artifact_view_revision_not_found")
  return { view, revision }
}

export async function getGeneratedArtifactViewRevision(input: {
  context: PluginArchActorContext
  artifactViewId: string
  revisionId: string
}) {
  const { view, revision } = await loadArtifactViewRevision(input)
  return {
    view: serializeView(view, [revision]),
    revision: serializeRevision(revision),
  }
}

export async function saveArtifactViewRevision(input: {
  context: PluginArchActorContext
  artifactViewId?: string
  configObjectId: string
  title: string
  description?: string
  reactSource: string
  cssSource?: string
}): Promise<GeneratedArtifactView> {
  const script = await getWorkflowDetail({ context: input.context, configObjectId: input.configObjectId })
  if (!script.canManage) throw new Error("artifact_view_not_found")
  if (!script.currentVersion.outputSchema || !script.currentVersion.outputSchemaDigest) {
    throw new Error("artifact_view_output_schema_required")
  }
  const outputSchemaDigest = script.currentVersion.outputSchemaDigest

  const existing = input.artifactViewId
    ? await accessibleView({ context: input.context, artifactViewId: input.artifactViewId, role: "manager" })
    : null
  if (existing && existing.config_object_id !== script.configObjectId) {
    throw new Error("artifact_view_script_binding_immutable")
  }

  const artifactViewId = existing?.id ?? createDenTypeId("artifactView")
  const revisionId = createDenTypeId("artifactViewRevision")
  const title = input.title.trim()
  const description = input.description?.trim() || null
  const reactSource = input.reactSource.trim()
  const cssSource = input.cssSource?.trim() ?? ""
  const build = await buildGeneratedArtifactView({
    reactSource,
    cssSource,
    outputSchema: script.currentVersion.outputSchema,
    title,
    description,
  })

  await db.transaction(async (tx) => {
    if (existing) {
      if (existing.active_revision_id === null) {
        await tx.update(ArtifactViewTable).set({ title, description })
          .where(eq(ArtifactViewTable.id, existing.id))
      }
    } else {
      await tx.insert(ArtifactViewTable).values({
        id: artifactViewId,
        organization_id: input.context.organizationContext.organization.id,
        config_object_id: normalizeDenTypeId("configObject", script.configObjectId),
        owner_member_id: input.context.organizationContext.currentMember.id,
        title,
        description,
        status: "active",
        active_revision_id: null,
        use_in_workflow: false,
      })
    }
    await tx.insert(ArtifactViewRevisionTable).values({
      id: revisionId,
      organization_id: input.context.organizationContext.organization.id,
      artifact_view_id: artifactViewId,
      created_by_member_id: input.context.organizationContext.currentMember.id,
      react_source: reactSource,
      css_source: cssSource,
      ...(build.ok ? { compiled_html: build.html } : {}),
      build_diagnostics: build.diagnostics,
      build_status: build.ok ? "ready" : "failed",
      source_digest: build.sourceDigest,
      ...(build.ok ? { resource_digest: build.resourceDigest } : {}),
      output_schema_digest: outputSchemaDigest,
      output_schema: script.currentVersion.outputSchema,
      csp: build.csp,
      compiler_name: build.compilerName,
      compiler_version: build.compilerVersion,
      react_version: build.reactVersion,
      ...(build.ok ? { compiled_html_bytes: build.htmlBytes } : {}),
    })
  })

  const rows = await db.select().from(ArtifactViewTable).where(eq(ArtifactViewTable.id, artifactViewId)).limit(1)
  const view = rows[0]
  if (!view) throw new Error("artifact_view_not_found")
  return serializeView(view, await revisionRows(view.id))
}

export async function activateArtifactViewRevision(input: {
  context: PluginArchActorContext
  artifactViewId: string
  revisionId: string
  save?: { title: string; useInWorkflow: boolean; expectedActiveRevisionId: string | null }
}): Promise<GeneratedArtifactView> {
  const view = await accessibleView({ context: input.context, artifactViewId: input.artifactViewId, role: "manager" })
  const revisionId = parseRevisionId(input.revisionId)
  const revisions = await db.select().from(ArtifactViewRevisionTable).where(and(
    eq(ArtifactViewRevisionTable.id, revisionId),
    eq(ArtifactViewRevisionTable.artifact_view_id, view.id),
    eq(ArtifactViewRevisionTable.build_status, "ready"),
    isNull(ArtifactViewRevisionTable.retired_at),
  )).limit(1)
  const revision = revisions[0]
  if (!revision || !revision.compiled_html || !revision.resource_digest) throw new Error("artifact_view_revision_not_ready")
  const script = await getWorkflowDetail({ context: input.context, configObjectId: view.config_object_id })
  if (script.currentVersion.outputSchemaDigest !== revision.output_schema_digest) {
    throw new Error("artifact_view_schema_incompatible")
  }
  const saved = input.save
  const updated = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(ArtifactViewTable)
      .where(eq(ArtifactViewTable.id, view.id)).limit(1).for("update")
    if (!current) throw new Error("artifact_view_not_found")
    if (saved && current.active_revision_id !== saved.expectedActiveRevisionId) {
      throw new Error("app_changed_since_preview")
    }
    const patch = {
      status: "active" as const,
      active_revision_id: revision.id,
      ...(saved ? { title: saved.title, use_in_workflow: saved.useInWorkflow } : {}),
    }
    await tx.update(ArtifactViewTable).set(patch).where(eq(ArtifactViewTable.id, view.id))
    if (saved) {
      // The existing private Workflow and exact app revision become one reusable
      // dashboard entry. A failed activation must not leave a dashboard card.
      await tx.insert(DashboardAppTable).values({
        organization_id: input.context.organizationContext.organization.id,
        member_id: input.context.organizationContext.currentMember.id,
        artifact_view_id: view.id,
      }).onDuplicateKeyUpdate({ set: { artifact_view_id: view.id } })
    }
    return { ...current, ...patch, updated_at: new Date() }
  })
  return serializeView(updated, await revisionRows(view.id))
}

export async function retireArtifactView(input: {
  context: PluginArchActorContext
  artifactViewId: string
}): Promise<GeneratedArtifactView> {
  const view = await accessibleView({ context: input.context, artifactViewId: input.artifactViewId, role: "manager" })
  await db.transaction(async (tx) => {
    await tx.update(ArtifactViewTable).set({ status: "retired", active_revision_id: null, use_in_workflow: false })
      .where(eq(ArtifactViewTable.id, view.id))
    await tx.delete(DashboardAppTable).where(and(
      eq(DashboardAppTable.organization_id, view.organization_id),
      eq(DashboardAppTable.artifact_view_id, view.id),
    ))
  })
  const updated = { ...view, status: "retired" as const, active_revision_id: null, use_in_workflow: false, updated_at: new Date() }
  return serializeView(updated, await revisionRows(view.id))
}

export async function getArtifactView(input: { context: PluginArchActorContext; artifactViewId: string }) {
  const view = await accessibleView({ ...input, role: "viewer" })
  return serializeView(view, await revisionRows(view.id))
}

export async function readArtifactViewSource(input: { context: PluginArchActorContext; artifactViewId: string }) {
  const view = await accessibleView({ ...input, role: "manager" })
  const revisions = await revisionRows(view.id)
  const latest = revisions[0]
  if (!latest) throw new Error("artifact_view_revision_not_found")
  return { view: serializeView(view, revisions), reactSource: latest.react_source, cssSource: latest.css_source }
}
