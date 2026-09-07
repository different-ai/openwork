import type {
  AutomationAction,
} from "@openwork/types/automations"
import type {
  WorkflowArtifactSnapshot,
  WorkflowDetail,
  WorkflowRunPreview,
  WorkflowVersion,
} from "@openwork/types/workflows"
import { WorkflowGraph } from "@openwork/codemode"
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AutomationRevisionTable,
  AutomationRunTable,
  AutomationTable,
  WorkflowRunTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MemberTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
  TeamMemberTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { codemodeCodeDigest, parseCodemodeToolCalls } from "./workflow-runs.js"
import { db } from "./db.js"
import { parseCodemodeScriptPayload, validateCodemodeScriptInput } from "./mcp/codemode-script-object.js"
import type { BuiltCodemodeTools } from "./mcp/codemode-tools.js"
import { executeWorkflow } from "./mcp/workflow-service.js"
import {
  artifactDigest,
  artifactFreshness,
  optionalArtifactDigest,
  workflowArtifactSource,
  WORKFLOW_MARKDOWN_RENDERER_VERSION,
} from "./workflow-artifacts.js"
import { redactWorkflowGraphAuthoringDetails, redactWorkflowVersionAuthoringDetails } from "./workflow-projections.js"
import {
  PluginArchAuthorizationError,
  requirePluginArchResourceRole,
  resolvePluginArchGrantRole,
  resolvePluginArchResourceRole,
  type PluginArchActorContext,
} from "./routes/org/plugin-system/access.js"
import { memberHasRole } from "./routes/org/shared.js"

const DEFAULT_WORKFLOWS_PLUGIN_NAME = "My Workflows"
const LEGACY_WORKFLOW_PLUGIN_NAMES = ["My Programs", "Saved scripts"]
const RECENT_RUN_WINDOW_MS = 15 * 60_000

export type SaveWorkflowInput = {
  pluginId?: string
  name: string
  description?: string
  code: string
  currentInput?: unknown
  inputSchema?: unknown
  outputSchema?: unknown
}

export type WorkflowDraft = SaveWorkflowInput & {
  exampleInput?: unknown
  requiredCapabilities: Array<{ capabilityName: string; scriptPath: string }>
}

type WorkflowRunRow = typeof WorkflowRunTable.$inferSelect
type AutomationRunTrigger = typeof AutomationRunTable.$inferSelect.trigger
type ConfigObjectId = DenTypeId<"configObject">

function parseConfigObjectId(value: string): ConfigObjectId {
  return normalizeDenTypeId("configObject", value)
}

function parseReceiptId(value: string): DenTypeId<"workflowRun"> {
  return normalizeDenTypeId("workflowRun", value)
}

async function workflowResource(
  context: PluginArchActorContext,
  value: string,
  role: "viewer" | "manager",
) {
  const configObjectId = parseConfigObjectId(value)
  const rows = await db.select({ configObject: ConfigObjectTable, plugin: PluginTable })
    .from(ConfigObjectTable)
    .innerJoin(PluginConfigObjectTable, and(
      eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
      isNull(PluginConfigObjectTable.removedAt),
    ))
    .innerJoin(PluginTable, and(
      eq(PluginTable.id, PluginConfigObjectTable.pluginId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
    ))
    .where(and(
      eq(ConfigObjectTable.id, configObjectId),
      eq(ConfigObjectTable.organizationId, context.organizationContext.organization.id),
      eq(ConfigObjectTable.objectType, "workflow"),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
    ))
    // A Workflow may be assigned to more than one Plugin. Keep memberships in
    // a stable order so the first one visible to this member becomes the
    // execution/provenance context.
    .orderBy(asc(PluginConfigObjectTable.createdAt), asc(PluginConfigObjectTable.id))
  if (!rows[0]) throw new Error("workflow_not_found")
  await requirePluginArchResourceRole({
    context,
    requireFreshSession: false,
    resourceId: configObjectId,
    resourceKind: "config_object",
    role,
  })
  for (const row of rows) {
    const pluginRole = await resolvePluginArchResourceRole({
      context,
      resourceId: row.plugin.id,
      resourceKind: "plugin",
    })
    if (pluginRole) return row
  }
  // Direct Workflow grants are intentionally independent from Plugin access.
  // In that case retain the deterministic oldest membership as its execution
  // context; capability execution separately enforces the Workflow grant.
  return rows[0]
}

function normalizedPayload(draft: WorkflowDraft) {
  const value = {
    language: "codemode-js",
    ...(draft.inputSchema === undefined ? {} : { inputSchema: draft.inputSchema }),
    ...(draft.outputSchema === undefined ? {} : { outputSchema: draft.outputSchema }),
    ...(draft.exampleInput === undefined ? {} : { exampleInput: draft.exampleInput }),
    requiredCapabilities: draft.requiredCapabilities,
  }
  const parsed = parseCodemodeScriptPayload(value)
  if (!parsed.ok) throw new Error(`workflow_invalid_schema:${parsed.message}`)
  return { parsed: parsed.payload, value }
}

function draftReceiptSource(configObjectId: ConfigObjectId, draft: WorkflowDraft) {
  return `workflow-test:${configObjectId}:${artifactDigest({
    name: draft.name.trim(),
    description: draft.description?.trim() || null,
    requiredCapabilities: draft.requiredCapabilities,
  })}`
}

function serializeSnapshot(row: WorkflowRunRow, automationTrigger: AutomationRunTrigger | null): WorkflowArtifactSnapshot | null {
  if (!row.plugin_id || !row.config_object_id || !row.config_object_version_id) return null
  const deleted = row.artifact_content_deleted_at !== null
  return {
    receiptId: row.id,
    pluginId: row.plugin_id,
    configObjectId: row.config_object_id,
    configObjectVersionId: row.config_object_version_id,
    automationRunId: row.automation_run_id,
    value: deleted ? null : row.validated_result ?? null,
    markdown: deleted ? null : row.result_markdown,
    codeDigest: row.code_digest,
    resultDigest: row.result_digest,
    inputSchemaDigest: row.input_schema_digest,
    outputSchemaDigest: row.output_schema_digest,
    rendererVersion: row.renderer_version === WORKFLOW_MARKDOWN_RENDERER_VERSION
      ? WORKFLOW_MARKDOWN_RENDERER_VERSION
      : null,
    toolCalls: parseCodemodeToolCalls(row.tool_calls),
    status: row.status,
    errorKind: row.error_kind,
    errorMessage: row.error_message,
    source: workflowArtifactSource(automationTrigger),
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at.toISOString(),
    contentDeletedAt: row.artifact_content_deleted_at?.toISOString() ?? null,
  }
}

async function currentAutomationReferences(context: PluginArchActorContext, configObjectId: ConfigObjectId) {
  const rows = await db.select({ automation: AutomationTable, revision: AutomationRevisionTable })
    .from(AutomationTable)
    .innerJoin(AutomationRevisionTable, eq(AutomationRevisionTable.id, AutomationTable.current_revision_id))
    .where(and(
      eq(AutomationTable.organization_id, context.organizationContext.organization.id),
      eq(AutomationTable.owner_member_id, context.organizationContext.currentMember.id),
    ))
  return rows.flatMap(({ automation, revision }) => {
    const action = revision.action
    if (action?.kind !== "saved_script" || action.script.configObjectId !== configObjectId) return []
    return [{
      id: automation.id,
      name: automation.name,
      state: automation.state,
      configObjectVersionId: action.script.configObjectVersionId,
      input: action.input,
    }]
  })
}

async function workflowVersions(
  context: PluginArchActorContext,
  configObjectId: ConfigObjectId,
  includeAuthoringDetails: boolean,
): Promise<WorkflowVersion[]> {
  const [rows, automationReferences] = await Promise.all([
    db.select().from(ConfigObjectVersionTable).where(and(
      eq(ConfigObjectVersionTable.organizationId, context.organizationContext.organization.id),
      eq(ConfigObjectVersionTable.configObjectId, configObjectId),
      eq(ConfigObjectVersionTable.isDeletedVersion, false),
    )).orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id)),
    currentAutomationReferences(context, configObjectId),
  ])
  return rows.flatMap((row) => {
    const parsed = parseCodemodeScriptPayload(row.normalizedPayloadJson)
    if (!parsed.ok) return []
    const code = row.rawSourceText ?? ""
    const version: WorkflowVersion = {
      id: row.id,
      code,
      graph: WorkflowGraph.analyze(code),
      inputSchema: parsed.payload.inputSchema ?? null,
      outputSchema: parsed.payload.outputSchema ?? null,
      exampleInput: parsed.payload.exampleInput ?? null,
      requiredCapabilities: parsed.payload.requiredCapabilities,
      codeDigest: codemodeCodeDigest(code),
      inputSchemaDigest: optionalArtifactDigest(parsed.payload.inputSchema),
      outputSchemaDigest: optionalArtifactDigest(parsed.payload.outputSchema),
      createdAt: row.createdAt.toISOString(),
      automationReferences: automationReferences.filter((reference) => reference.configObjectVersionId === row.id),
    }
    return [includeAuthoringDetails ? version : redactWorkflowVersionAuthoringDetails(version)]
  })
}

async function snapshotRows(organizationId: DenTypeId<"organization">, configObjectId: ConfigObjectId, limit = 100) {
  return db.select({ receipt: WorkflowRunTable, automationTrigger: AutomationRunTable.trigger })
    .from(WorkflowRunTable)
    .leftJoin(AutomationRunTable, eq(AutomationRunTable.id, WorkflowRunTable.automation_run_id))
    .where(and(
    eq(WorkflowRunTable.organization_id, organizationId),
    eq(WorkflowRunTable.config_object_id, configObjectId),
    isNotNull(WorkflowRunTable.config_object_version_id),
  )).orderBy(desc(WorkflowRunTable.finished_at), desc(WorkflowRunTable.id)).limit(limit)
}

export async function getWorkflowDetail(input: {
  context: PluginArchActorContext
  configObjectId: string
  maxAgeMs?: number
}): Promise<WorkflowDetail> {
  const resource = await workflowResource(input.context, input.configObjectId, "viewer")
  const role = await resolvePluginArchResourceRole({
    context: input.context,
    resourceId: resource.configObject.id,
    resourceKind: "config_object",
  })
  const [versions, rows] = await Promise.all([
    workflowVersions(input.context, resource.configObject.id, role === "manager"),
    snapshotRows(resource.configObject.organizationId, resource.configObject.id),
  ])
  const currentVersion = versions[0]
  if (!currentVersion) throw new Error("workflow_version_not_found")
  const snapshots = rows.flatMap((row) => {
    const snapshot = serializeSnapshot(row.receipt, row.automationTrigger)
    return snapshot ? [snapshot] : []
  })
  // Deleted content remains in history, but must not stay selected as the
  // current readable artifact after an explicit deletion.
  const latestSnapshot = snapshots.find((snapshot) => snapshot.contentDeletedAt === null)
    ?? snapshots[0]
    ?? null
  const latestSuccessfulSnapshot = snapshots.find((snapshot) => snapshot.status === "succeeded" && snapshot.markdown !== null) ?? null
  return {
    pluginId: resource.plugin.id,
    configObjectId: resource.configObject.id,
    title: resource.configObject.title,
    description: resource.configObject.description,
    canRun: role === "editor" || role === "manager",
    canManage: role === "manager",
    currentVersion,
    versions,
    latestSnapshot,
    latestSuccessfulSnapshot,
    freshness: artifactFreshness({
      latestFinishedAt: latestSnapshot?.contentDeletedAt === null ? new Date(latestSnapshot.finishedAt) : null,
      latestStatus: latestSnapshot?.contentDeletedAt === null ? latestSnapshot.status : null,
      latestSuccessfulFinishedAt: latestSuccessfulSnapshot ? new Date(latestSuccessfulSnapshot.finishedAt) : null,
      latestSuccessfulReceiptId: latestSuccessfulSnapshot?.receiptId ?? null,
      failureReason: latestSnapshot?.errorMessage,
      maxAgeMs: Math.min(30 * 24 * 60 * 60_000, Math.max(60_000, input.maxAgeMs ?? 24 * 60 * 60_000)),
    }),
  }
}

export async function listWorkflowVersions(input: { context: PluginArchActorContext; configObjectId: string }) {
  const resource = await workflowResource(input.context, input.configObjectId, "viewer")
  const role = await resolvePluginArchResourceRole({
    context: input.context,
    resourceId: resource.configObject.id,
    resourceKind: "config_object",
  })
  return workflowVersions(input.context, resource.configObject.id, role === "manager")
}

export async function workflowRunPreviews(input: {
  context: PluginArchActorContext
  runs: Pick<WorkflowRunRow, "id" | "config_object_id" | "config_object_version_id">[]
}): Promise<Map<string, WorkflowRunPreview>> {
  const previews = new Map<string, WorkflowRunPreview>()
  const workflowIds = [...new Set(input.runs.flatMap((run) => run.config_object_id ? [run.config_object_id] : []))]
  const resources = await Promise.all(workflowIds.map(async (configObjectId) => {
    try {
      const resource = await workflowResource(input.context, configObjectId, "viewer")
      const role = await resolvePluginArchResourceRole({
        context: input.context, resourceId: configObjectId, resourceKind: "config_object",
      })
      return { resource, role }
    } catch (error) {
      if (error instanceof PluginArchAuthorizationError || (error instanceof Error && error.message === "workflow_not_found")) return null
      throw error
    }
  }))
  const visible = new Map(resources.flatMap((entry) => entry ? [[entry.resource.configObject.id, entry] as const] : []))
  if (visible.size === 0) return previews
  const versionIds = [...new Set(input.runs.flatMap((run) =>
    run.config_object_id && visible.has(run.config_object_id) && run.config_object_version_id ? [run.config_object_version_id] : []))]
  const versions = versionIds.length === 0 ? [] : await db.select({
    id: ConfigObjectVersionTable.id,
    configObjectId: ConfigObjectVersionTable.configObjectId,
    code: ConfigObjectVersionTable.rawSourceText,
  }).from(ConfigObjectVersionTable).where(and(
    eq(ConfigObjectVersionTable.organizationId, input.context.organizationContext.organization.id),
    inArray(ConfigObjectVersionTable.id, versionIds),
    inArray(ConfigObjectVersionTable.configObjectId, [...visible.keys()]),
    eq(ConfigObjectVersionTable.isDeletedVersion, false),
  ))
  const graphs = new Map(versions.map((version) => {
    const graph = version.code === null ? null : WorkflowGraph.analyze(version.code)
    return [version.id, {
      configObjectId: version.configObjectId,
      graph: graph && visible.get(version.configObjectId)?.role !== "manager" ? redactWorkflowGraphAuthoringDetails(graph) : graph,
    }] as const
  }))
  for (const run of input.runs) {
    const entry = run.config_object_id ? visible.get(run.config_object_id) : undefined
    if (!entry) continue
    const version = run.config_object_version_id ? graphs.get(run.config_object_version_id) : undefined
    previews.set(run.id, {
      configObjectId: entry.resource.configObject.id,
      title: entry.resource.configObject.title,
      graph: version?.configObjectId === run.config_object_id ? version.graph : null,
    })
  }
  return previews
}

export async function listWorkflowSnapshots(input: {
  context: PluginArchActorContext
  configObjectId: string
  limit?: number
}) {
  const resource = await workflowResource(input.context, input.configObjectId, "viewer")
  const rows = await snapshotRows(resource.configObject.organizationId, resource.configObject.id, input.limit)
  return rows.flatMap((row) => {
    const snapshot = serializeSnapshot(row.receipt, row.automationTrigger)
    return snapshot ? [snapshot] : []
  })
}

export async function getWorkflowSnapshot(input: {
  context: PluginArchActorContext
  configObjectId: string
  receiptId: string
}) {
  const resource = await workflowResource(input.context, input.configObjectId, "viewer")
  const rows = await db.select({ receipt: WorkflowRunTable, automationTrigger: AutomationRunTable.trigger })
    .from(WorkflowRunTable)
    .leftJoin(AutomationRunTable, eq(AutomationRunTable.id, WorkflowRunTable.automation_run_id))
    .where(and(
    eq(WorkflowRunTable.id, parseReceiptId(input.receiptId)),
    eq(WorkflowRunTable.organization_id, resource.configObject.organizationId),
    eq(WorkflowRunTable.config_object_id, resource.configObject.id),
    isNotNull(WorkflowRunTable.config_object_version_id),
  )).limit(1)
  return rows[0] ? serializeSnapshot(rows[0].receipt, rows[0].automationTrigger) : null
}

export async function testWorkflowDraft(input: {
  context: PluginArchActorContext
  configObjectId: string
  draft: WorkflowDraft
  buildTools: () => Promise<BuiltCodemodeTools>
}) {
  const resource = await workflowResource(input.context, input.configObjectId, "manager")
  const payload = normalizedPayload(input.draft)
  const execution = await executeWorkflow({
    database: db,
    organizationId: resource.configObject.organizationId,
    orgMembershipId: input.context.organizationContext.currentMember.id,
    pluginId: resource.plugin.id,
    configObjectId: resource.configObject.id,
    normalizedPayloadJson: payload.value,
    code: input.draft.code,
    receiptSource: draftReceiptSource(resource.configObject.id, input.draft),
    scriptInput: input.draft.exampleInput,
    validateOutput: true,
    buildTools: input.buildTools,
  })
  if (!execution.ok) return execution
  if (!execution.receiptId) throw new Error("workflow_test_receipt_not_durable")
  return {
    ...execution,
    finishedAt: new Date().toISOString(),
    requiredCapabilities: payload.parsed.requiredCapabilities,
  }
}

export async function createWorkflowVersion(input: {
  context: PluginArchActorContext
  configObjectId: string
  receiptId: string
  draft: WorkflowDraft
  buildTools: () => Promise<BuiltCodemodeTools>
}) {
  const resource = await workflowResource(input.context, input.configObjectId, "manager")
  const payload = normalizedPayload(input.draft)
  if (payload.parsed.inputSchema) {
    const validation = validateCodemodeScriptInput(payload.parsed.inputSchema, input.draft.exampleInput)
    if (!validation.ok) throw new Error("workflow_current_input_invalid")
  }
  const codeDigest = codemodeCodeDigest(input.draft.code)
  const scriptInputDigest = artifactDigest(input.draft.exampleInput ?? null)
  const inputSchemaDigest = optionalArtifactDigest(payload.parsed.inputSchema)
  const outputSchemaDigest = optionalArtifactDigest(payload.parsed.outputSchema)
  const receipts = await db.select().from(WorkflowRunTable).where(and(
    eq(WorkflowRunTable.id, parseReceiptId(input.receiptId)),
    eq(WorkflowRunTable.organization_id, resource.configObject.organizationId),
    eq(WorkflowRunTable.org_membership_id, input.context.organizationContext.currentMember.id),
    eq(WorkflowRunTable.plugin_id, resource.plugin.id),
    eq(WorkflowRunTable.config_object_id, resource.configObject.id),
    isNull(WorkflowRunTable.config_object_version_id),
    eq(WorkflowRunTable.source, draftReceiptSource(resource.configObject.id, input.draft)),
    eq(WorkflowRunTable.code_digest, codeDigest),
    eq(WorkflowRunTable.script_input_digest, scriptInputDigest),
    inputSchemaDigest === null
      ? isNull(WorkflowRunTable.input_schema_digest)
      : eq(WorkflowRunTable.input_schema_digest, inputSchemaDigest),
    outputSchemaDigest === null
      ? isNull(WorkflowRunTable.output_schema_digest)
      : eq(WorkflowRunTable.output_schema_digest, outputSchemaDigest),
    eq(WorkflowRunTable.status, "succeeded"),
    isNull(WorkflowRunTable.artifact_content_deleted_at),
    gt(WorkflowRunTable.finished_at, new Date(Date.now() - RECENT_RUN_WINDOW_MS)),
  )).limit(1)
  const receipt = receipts[0]
  if (!receipt || receipt.renderer_version !== WORKFLOW_MARKDOWN_RENDERER_VERSION
    || receipt.result_markdown === null || receipt.result_digest === null) {
    throw new Error("workflow_matching_test_receipt_required")
  }

  const consumed = await db.select({ id: ConfigObjectVersionTable.id }).from(ConfigObjectVersionTable).where(and(
    eq(ConfigObjectVersionTable.organizationId, resource.configObject.organizationId),
    eq(ConfigObjectVersionTable.configObjectId, resource.configObject.id),
    eq(ConfigObjectVersionTable.sourceRevisionRef, receipt.id),
  )).limit(1)
  if (consumed[0]) throw new Error("workflow_test_receipt_already_used")

  // Saving does not authorize unattended execution; executeWorkflow checks that at run time.
  const built = await input.buildTools()
  const manifestByPath = new Map(built.manifest.flatMap((entry) => [
    [entry.scriptPath, entry] as const,
    [entry.scriptPath.replace(/^tools\./, ""), entry] as const,
  ]))
  for (const required of payload.parsed.requiredCapabilities) {
    const current = manifestByPath.get(required.scriptPath)
    if (!current || current.capabilityName !== required.capabilityName) {
      throw new Error(`workflow_capability_unavailable:${required.scriptPath}`)
    }
  }
  for (const call of parseCodemodeToolCalls(receipt.tool_calls)) {
    if (!payload.parsed.requiredCapabilities.some((required) => {
      const normalized = call.name.replace(/^tools\./, "")
      return required.scriptPath === call.name || required.scriptPath.replace(/^tools\./, "") === normalized
    })) throw new Error(`workflow_test_capability_mismatch:${call.name}`)
  }

  const now = new Date()
  const configObjectVersionId = createDenTypeId("configObjectVersion")
  await db.transaction(async (tx) => {
    await tx.insert(ConfigObjectVersionTable).values({
      id: configObjectVersionId,
      organizationId: resource.configObject.organizationId,
      configObjectId: resource.configObject.id,
      normalizedPayloadJson: payload.value,
      rawSourceText: input.draft.code,
      schemaVersion: "codemode-script-v1",
      createdVia: "cloud",
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      sourceRevisionRef: receipt.id,
      isDeletedVersion: false,
      createdAt: now,
    })
    await tx.update(ConfigObjectTable).set({
      title: input.draft.name,
      description: input.draft.description?.trim() || null,
      searchText: `${input.draft.name} ${input.draft.description ?? ""}`.trim(),
      currentFileName: `${input.draft.name}.js`,
      updatedAt: now,
    }).where(eq(ConfigObjectTable.id, resource.configObject.id))
  })
  return getWorkflowDetail({ context: input.context, configObjectId: resource.configObject.id })
}

export async function deleteWorkflowSnapshotContent(input: {
  context: PluginArchActorContext
  configObjectId: string
  receiptId: string
}) {
  const resource = await workflowResource(input.context, input.configObjectId, "manager")
  const receiptId = parseReceiptId(input.receiptId)
  const rows = await db.select().from(WorkflowRunTable).where(and(
    eq(WorkflowRunTable.id, receiptId),
    eq(WorkflowRunTable.organization_id, resource.configObject.organizationId),
    eq(WorkflowRunTable.config_object_id, resource.configObject.id),
    isNotNull(WorkflowRunTable.config_object_version_id),
  )).limit(1)
  const receipt = rows[0]
  if (!receipt) throw new Error("workflow_snapshot_not_found")
  if (!receipt.artifact_content_deleted_at) {
    await db.update(WorkflowRunTable).set({
      script_input: null,
      validated_result: null,
      result_markdown: null,
      artifact_content_deleted_at: new Date(),
    }).where(eq(WorkflowRunTable.id, receipt.id))
  }

  if (receipt.automation_run_id) {
    const automationRuns = await db.select({ automationId: AutomationRunTable.automation_id })
      .from(AutomationRunTable)
      .where(eq(AutomationRunTable.id, receipt.automation_run_id)).limit(1)
    const automationId = automationRuns[0]?.automationId
    if (automationId) {
      const retained = await db.select({ receipt: WorkflowRunTable, run: AutomationRunTable })
        .from(WorkflowRunTable)
        .innerJoin(AutomationRunTable, eq(AutomationRunTable.id, WorkflowRunTable.automation_run_id))
        .where(and(
          eq(AutomationRunTable.automation_id, automationId),
          eq(WorkflowRunTable.config_object_id, resource.configObject.id),
          eq(WorkflowRunTable.status, "succeeded"),
          isNull(WorkflowRunTable.artifact_content_deleted_at),
          isNotNull(WorkflowRunTable.result_markdown),
        )).orderBy(desc(WorkflowRunTable.finished_at), desc(WorkflowRunTable.id)).limit(1)
      await db.update(AutomationTable).set({
        latest_successful_run_id: retained[0]?.run.id ?? null,
        latest_successful_result: retained[0]?.receipt.validated_result ?? null,
      }).where(eq(AutomationTable.id, automationId))
    }
  }
  return getWorkflowSnapshot({ ...input, receiptId })
}

export async function validateWorkflowAutomationAction(input: {
  organizationId: string
  ownerMemberId: string
  action: Extract<AutomationAction, { kind: "saved_script" }>
}) {
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const ownerMemberId = normalizeDenTypeId("member", input.ownerMemberId)
  const pluginId = normalizeDenTypeId("plugin", input.action.script.pluginId)
  const configObjectId = normalizeDenTypeId("configObject", input.action.script.configObjectId)
  const configObjectVersionId = normalizeDenTypeId("configObjectVersion", input.action.script.configObjectVersionId)
  const members = await db.select({ role: MemberTable.role }).from(MemberTable).where(and(
    eq(MemberTable.id, ownerMemberId),
    eq(MemberTable.organizationId, organizationId),
    isNull(MemberTable.removedAt),
  )).limit(1)
  const member = members[0]
  if (!member) throw new Error("automation_owner_inactive")
  if (!memberHasRole(member.role, "admin")) {
    const [teams, configObjectGrants, pluginGrants] = await Promise.all([
      db.select({ id: TeamMemberTable.teamId }).from(TeamMemberTable)
        .where(eq(TeamMemberTable.orgMembershipId, ownerMemberId)),
      db.select({
        orgMembershipId: ConfigObjectAccessGrantTable.orgMembershipId,
        orgWide: ConfigObjectAccessGrantTable.orgWide,
        removedAt: ConfigObjectAccessGrantTable.removedAt,
        role: ConfigObjectAccessGrantTable.role,
        teamId: ConfigObjectAccessGrantTable.teamId,
      }).from(ConfigObjectAccessGrantTable).where(and(
        eq(ConfigObjectAccessGrantTable.organizationId, organizationId),
        eq(ConfigObjectAccessGrantTable.configObjectId, configObjectId),
      )),
      db.select({
        orgMembershipId: PluginAccessGrantTable.orgMembershipId,
        orgWide: PluginAccessGrantTable.orgWide,
        removedAt: PluginAccessGrantTable.removedAt,
        role: PluginAccessGrantTable.role,
        teamId: PluginAccessGrantTable.teamId,
      }).from(PluginAccessGrantTable).where(and(
        eq(PluginAccessGrantTable.organizationId, organizationId),
        eq(PluginAccessGrantTable.pluginId, pluginId),
      )),
    ])
    const grantInput = { memberId: ownerMemberId, teamIds: teams.map((team) => team.id) }
    // Scheduling a Workflow executes it, so the owner needs run access — the
    // same editor-or-manager bar the detail response reports as `canRun`. A
    // viewer may read results but must not gain scheduled execution.
    const roles = [
      resolvePluginArchGrantRole({ ...grantInput, grants: configObjectGrants }),
      resolvePluginArchGrantRole({ ...grantInput, grants: pluginGrants }),
    ]
    if (!roles.some((role) => role === "editor" || role === "manager")) {
      throw new Error("automation_saved_script_forbidden")
    }
  }
  const rows = await db.select({ version: ConfigObjectVersionTable })
    .from(ConfigObjectVersionTable)
    .innerJoin(ConfigObjectTable, and(
      eq(ConfigObjectTable.id, ConfigObjectVersionTable.configObjectId),
      eq(ConfigObjectTable.organizationId, organizationId),
      eq(ConfigObjectTable.objectType, "workflow"),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
    ))
    .innerJoin(PluginConfigObjectTable, and(
      eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
      eq(PluginConfigObjectTable.pluginId, pluginId),
      isNull(PluginConfigObjectTable.removedAt),
    ))
    .where(and(
      eq(ConfigObjectVersionTable.id, configObjectVersionId),
      eq(ConfigObjectVersionTable.configObjectId, configObjectId),
      eq(ConfigObjectVersionTable.organizationId, organizationId),
      eq(ConfigObjectVersionTable.isDeletedVersion, false),
    )).limit(1)
  const version = rows[0]?.version
  if (!version) throw new Error("automation_saved_script_version_not_found")
  const parsed = parseCodemodeScriptPayload(version.normalizedPayloadJson)
  if (!parsed.ok) throw new Error("automation_saved_script_version_invalid")
  if (parsed.payload.inputSchema) {
    const validation = validateCodemodeScriptInput(parsed.payload.inputSchema, input.action.input)
    if (!validation.ok) throw new Error("automation_saved_script_input_invalid")
  }
}

export async function saveWorkflow(input: {
  organizationId: string
  ownerMemberId: string
  workflow: SaveWorkflowInput
  buildTools: () => Promise<BuiltCodemodeTools>
  context?: PluginArchActorContext
}): Promise<{
  pluginId: string
  configObjectId: string
  configObjectVersionId: string
  graph: WorkflowGraph.WorkflowGraph
  mermaid: string
}> {
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const ownerMemberId = normalizeDenTypeId("member", input.ownerMemberId)
  const requestedPluginId = input.workflow.pluginId
    ? normalizeDenTypeId("plugin", input.workflow.pluginId)
    : null
  if (requestedPluginId) {
    if (
      !input.context
      || input.context.organizationContext.organization.id !== organizationId
      || input.context.organizationContext.currentMember.id !== ownerMemberId
    ) {
      throw new Error("saved_workflow_plugin_context_required")
    }
    await requirePluginArchResourceRole({
      context: input.context,
      resourceId: requestedPluginId,
      resourceKind: "plugin",
      role: "editor",
    })
  }
  const receipts = await db.select().from(WorkflowRunTable).where(and(
    eq(WorkflowRunTable.organization_id, organizationId),
    eq(WorkflowRunTable.org_membership_id, ownerMemberId),
    eq(WorkflowRunTable.code_digest, codemodeCodeDigest(input.workflow.code)),
    eq(WorkflowRunTable.status, "succeeded"),
    gt(WorkflowRunTable.finished_at, new Date(Date.now() - RECENT_RUN_WINDOW_MS)),
  )).orderBy(desc(WorkflowRunTable.finished_at)).limit(1)
  const receipt = receipts[0]
  if (!receipt) throw new Error("workflow_recent_receipt_required")

  // Saving does not authorize unattended execution; executeWorkflow checks that at run time.
  const built = await input.buildTools()
  const manifestByPath = new Map(built.manifest.flatMap((entry) => [
    [entry.scriptPath, entry] as const,
    [entry.scriptPath.replace(/^tools\./, ""), entry] as const,
  ]))
  const requiredCapabilities: Array<{ capabilityName: string; scriptPath: string }> = []
  for (const call of parseCodemodeToolCalls(receipt.tool_calls)) {
    const resolved = manifestByPath.get(call.name)
    if (!resolved) throw new Error(`workflow_capability_unavailable:${call.name}`)
    if (!requiredCapabilities.some((entry) => entry.scriptPath === resolved.scriptPath)) {
      requiredCapabilities.push({
        capabilityName: resolved.capabilityName,
        scriptPath: resolved.scriptPath,
      })
    }
  }
  const normalizedPayloadJson = {
    language: "codemode-js",
    ...(input.workflow.inputSchema === undefined ? {} : { inputSchema: input.workflow.inputSchema }),
    ...(input.workflow.outputSchema === undefined ? {} : { outputSchema: input.workflow.outputSchema }),
    ...(input.workflow.currentInput === undefined ? {} : { exampleInput: input.workflow.currentInput }),
    requiredCapabilities,
  }
  const parsed = parseCodemodeScriptPayload(normalizedPayloadJson)
  if (!parsed.ok) throw new Error(`workflow_invalid_schema:${parsed.message}`)
  if (parsed.payload.inputSchema) {
    const validation = validateCodemodeScriptInput(parsed.payload.inputSchema, input.workflow.currentInput)
    if (!validation.ok) throw new Error("workflow_current_input_invalid")
  }
  const graph = WorkflowGraph.analyze(input.workflow.code)

  return db.transaction(async (tx) => {
    const plugins = requestedPluginId
      ? await tx.select().from(PluginTable).where(and(
          eq(PluginTable.id, requestedPluginId),
          eq(PluginTable.organizationId, organizationId),
          eq(PluginTable.status, "active"),
          isNull(PluginTable.deletedAt),
        )).limit(1).for("update")
      : await tx.select().from(PluginTable).where(and(
          eq(PluginTable.organizationId, organizationId),
          eq(PluginTable.createdByOrgMembershipId, ownerMemberId),
          eq(PluginTable.name, DEFAULT_WORKFLOWS_PLUGIN_NAME),
          eq(PluginTable.status, "active"),
          isNull(PluginTable.deletedAt),
        )).limit(1).for("update")
    const legacyPlugins = requestedPluginId || plugins[0]
      ? []
      : await tx.select().from(PluginTable).where(and(
          eq(PluginTable.organizationId, organizationId),
          eq(PluginTable.createdByOrgMembershipId, ownerMemberId),
          inArray(PluginTable.name, LEGACY_WORKFLOW_PLUGIN_NAMES),
          eq(PluginTable.status, "active"),
          isNull(PluginTable.deletedAt),
        )).limit(1).for("update")
    const plugin = plugins[0] ?? legacyPlugins[0]
    if (requestedPluginId && !plugin) throw new Error("saved_workflow_plugin_not_found")
    const pluginId = plugin?.id ?? createDenTypeId("plugin")
    if (!plugin) {
      await tx.insert(PluginTable).values({
        id: pluginId,
        organizationId,
        name: DEFAULT_WORKFLOWS_PLUGIN_NAME,
        description: "Private reusable Workflows.",
        status: "active",
        createdByOrgMembershipId: ownerMemberId,
      })
      await tx.insert(PluginAccessGrantTable).values({
        id: createDenTypeId("pluginAccessGrant"),
        organizationId,
        pluginId,
        orgMembershipId: ownerMemberId,
        teamId: null,
        orgWide: false,
        role: "manager",
        createdByOrgMembershipId: ownerMemberId,
      })
    } else if (!requestedPluginId && LEGACY_WORKFLOW_PLUGIN_NAMES.includes(plugin.name)) {
      await tx.update(PluginTable).set({
        name: DEFAULT_WORKFLOWS_PLUGIN_NAME,
        description: "Private reusable Workflows.",
      }).where(eq(PluginTable.id, plugin.id))
    }

    const linked = await tx.select({ object: ConfigObjectTable }).from(PluginConfigObjectTable)
      .innerJoin(ConfigObjectTable, eq(ConfigObjectTable.id, PluginConfigObjectTable.configObjectId))
      .where(and(
        eq(PluginConfigObjectTable.pluginId, pluginId),
        isNull(PluginConfigObjectTable.removedAt),
        eq(ConfigObjectTable.title, input.workflow.name),
        inArray(ConfigObjectTable.objectType, ["script", "workflow"]),
        eq(ConfigObjectTable.status, "active"),
        isNull(ConfigObjectTable.deletedAt),
      )).limit(1).for("update")
    const configObjectId = linked[0]?.object.id ?? createDenTypeId("configObject")
    if (linked[0]) {
      // Saving the same name creates a new immutable version of the existing
      // Workflow. Plugin edit access can widen the audience, but it must never
      // grant authority to replace another Workflow manager's executable code.
      if (!input.context) throw new Error("saved_workflow_manager_context_required")
      await requirePluginArchResourceRole({
        context: input.context,
        resourceId: configObjectId,
        resourceKind: "config_object",
        role: "manager",
      })
    } else {
      await tx.insert(ConfigObjectTable).values({
        id: configObjectId,
        organizationId,
        objectType: "workflow",
        sourceMode: "cloud",
        title: input.workflow.name,
        description: input.workflow.description?.trim() || null,
        searchText: `${input.workflow.name} ${input.workflow.description ?? ""}`.trim(),
        currentFileName: `${input.workflow.name}.js`,
        currentFileExtension: "js",
        status: "active",
        createdByOrgMembershipId: ownerMemberId,
      })
      await tx.insert(PluginConfigObjectTable).values({
        id: createDenTypeId("pluginConfigObject"),
        organizationId,
        pluginId,
        configObjectId,
        membershipSource: "manual",
        createdByOrgMembershipId: ownerMemberId,
      })
      await tx.insert(ConfigObjectAccessGrantTable).values({
        id: createDenTypeId("configObjectAccessGrant"),
        organizationId,
        configObjectId,
        orgMembershipId: ownerMemberId,
        teamId: null,
        orgWide: false,
        role: "manager",
        createdByOrgMembershipId: ownerMemberId,
      })
    }
    const configObjectVersionId: DenTypeId<"configObjectVersion"> = createDenTypeId("configObjectVersion")
    await tx.insert(ConfigObjectVersionTable).values({
      id: configObjectVersionId,
      organizationId,
      configObjectId,
      normalizedPayloadJson,
      rawSourceText: input.workflow.code,
      schemaVersion: "codemode-script-v1",
      createdVia: "cloud",
      createdByOrgMembershipId: ownerMemberId,
      sourceRevisionRef: receipt.code_digest,
      isDeletedVersion: false,
    })
    return {
      pluginId,
      configObjectId,
      configObjectVersionId,
      graph,
      mermaid: WorkflowGraph.toMermaid(graph),
    }
  })
}
