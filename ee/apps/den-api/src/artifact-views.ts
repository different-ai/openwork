import { and, desc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { ArtifactViewRevisionTable, ArtifactViewTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { GeneratedArtifactView, GeneratedArtifactViewRevision } from "@openwork/types/dynamic-artifacts"
import { db } from "./db.js"
import { getCodemodeScriptDetail } from "./codemode-scripts.js"
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
  const script = await getCodemodeScriptDetail({ context: input.context, configObjectId: row.config_object_id })
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
}): Promise<GeneratedArtifactView[]> {
  const conditions = [eq(ArtifactViewTable.organization_id, input.context.organizationContext.organization.id)]
  if (input.activeOnly) {
    conditions.push(eq(ArtifactViewTable.status, "active"))
  }
  const rows = await db.select().from(ArtifactViewTable)
    .where(and(...conditions))
    .orderBy(desc(ArtifactViewTable.updated_at), desc(ArtifactViewTable.id))
    .limit(ARTIFACT_VIEW_LIST_LIMIT)
  const accessible = await Promise.all(rows.map(async (row) => {
    try {
      await getCodemodeScriptDetail({ context: input.context, configObjectId: row.config_object_id })
      return serializeView(row, await revisionRows(row.id))
    } catch {
      return null
    }
  }))
  return accessible.filter((view): view is GeneratedArtifactView => view !== null)
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

export async function saveArtifactViewRevision(input: {
  context: PluginArchActorContext
  artifactViewId?: string
  configObjectId: string
  title: string
  description?: string
  reactSource: string
  cssSource?: string
}): Promise<GeneratedArtifactView> {
  const script = await getCodemodeScriptDetail({ context: input.context, configObjectId: input.configObjectId })
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
      await tx.update(ArtifactViewTable).set({
        title,
        description,
        ...(build.ok && existing.active_revision_id === null
          ? { status: "active" as const, active_revision_id: revisionId }
          : {}),
      }).where(eq(ArtifactViewTable.id, existing.id))
    } else {
      await tx.insert(ArtifactViewTable).values({
        id: artifactViewId,
        organization_id: input.context.organizationContext.organization.id,
        config_object_id: normalizeDenTypeId("configObject", script.configObjectId),
        owner_member_id: input.context.organizationContext.currentMember.id,
        title,
        description,
        status: "active",
        active_revision_id: build.ok ? revisionId : null,
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
  const script = await getCodemodeScriptDetail({ context: input.context, configObjectId: view.config_object_id })
  if (script.currentVersion.outputSchemaDigest !== revision.output_schema_digest) {
    throw new Error("artifact_view_schema_incompatible")
  }
  await db.update(ArtifactViewTable).set({ status: "active", active_revision_id: revision.id })
    .where(eq(ArtifactViewTable.id, view.id))
  const updated = { ...view, status: "active" as const, active_revision_id: revision.id, updated_at: new Date() }
  return serializeView(updated, await revisionRows(view.id))
}

export async function retireArtifactView(input: {
  context: PluginArchActorContext
  artifactViewId: string
}): Promise<GeneratedArtifactView> {
  const view = await accessibleView({ context: input.context, artifactViewId: input.artifactViewId, role: "manager" })
  await db.update(ArtifactViewTable).set({ status: "retired", active_revision_id: null })
    .where(eq(ArtifactViewTable.id, view.id))
  const updated = { ...view, status: "retired" as const, active_revision_id: null, updated_at: new Date() }
  return serializeView(updated, await revisionRows(view.id))
}
