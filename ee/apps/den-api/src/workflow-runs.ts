import { createHash } from "node:crypto"
import type { createDenDb } from "@openwork-ee/den-db"
import { and, desc, eq } from "@openwork-ee/den-db/drizzle"
import { WorkflowRunTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { CodemodeRunResult } from "./mcp/codemode-run.js"

type CodemodeDb = ReturnType<typeof createDenDb>["db"]

export type RecordWorkflowRunInput = {
  organizationId: DenTypeId<"organization">
  orgMembershipId?: DenTypeId<"member"> | null
  automationRunId?: DenTypeId<"automationRun"> | null
  pluginId?: DenTypeId<"plugin"> | null
  configObjectId?: DenTypeId<"configObject"> | null
  configObjectVersionId?: DenTypeId<"configObjectVersion"> | null
  scriptInputDigest?: string | null
  inputSchemaDigest?: string | null
  validatedResult?: unknown
  resultMarkdown?: string | null
  resultDigest?: string | null
  outputSchemaDigest?: string | null
  rendererVersion?: string | null
  source: string
  code: string
  status: "succeeded" | "failed"
  errorKind?: string | null
  errorMessage?: string | null
  toolCalls: Array<{ name: string }>
  durationMs: number
  startedAt: Date
  finishedAt: Date
}

export function codemodeCodeDigest(code: string): string {
  return `sha256:${createHash("sha256").update(code).digest("hex")}`
}

export function parseCodemodeToolCalls(value: unknown): Array<{ name: string }> {
  let decoded = value
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded)
    } catch {
      throw new Error("workflow_run_tool_calls_invalid")
    }
  }
  if (decoded === null || decoded === undefined) return []
  if (!Array.isArray(decoded)) throw new Error("workflow_run_tool_calls_invalid")
  return decoded.map((call) => {
    if (typeof call !== "object" || call === null || Array.isArray(call)) {
      throw new Error("workflow_run_tool_calls_invalid")
    }
    const name = Reflect.get(call, "name")
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("workflow_run_tool_calls_invalid")
    }
    return { name }
  })
}

export async function recordWorkflowRun(database: CodemodeDb, input: RecordWorkflowRunInput): Promise<DenTypeId<"workflowRun"> | null> {
  const id = createDenTypeId("workflowRun")
  try {
    await database.insert(WorkflowRunTable).values({
      id,
      organization_id: input.organizationId,
      org_membership_id: input.orgMembershipId ?? null,
      automation_run_id: input.automationRunId ?? null,
      plugin_id: input.pluginId ?? null,
      config_object_id: input.configObjectId ?? null,
      config_object_version_id: input.configObjectVersionId ?? null,
      source: input.source,
      code_digest: codemodeCodeDigest(input.code),
      status: input.status,
      error_kind: input.errorKind ?? null,
      error_message: input.errorMessage ?? null,
      tool_calls: input.toolCalls,
      tool_call_count: input.toolCalls.length,
      duration_ms: input.durationMs,
      started_at: input.startedAt,
      finished_at: input.finishedAt,
      // Durable receipts retain only the digest. Raw caller inputs may contain
      // secrets or PII and must not become readable artifact history.
      script_input: null,
      script_input_digest: input.scriptInputDigest ?? null,
      input_schema_digest: input.inputSchemaDigest ?? null,
      validated_result: input.validatedResult,
      result_markdown: input.resultMarkdown ?? null,
      result_digest: input.resultDigest ?? null,
      output_schema_digest: input.outputSchemaDigest ?? null,
      renderer_version: input.rendererVersion ?? null,
    })
    return id
  } catch (error) {
    console.error("workflow_run_receipt_failed", {
      organization_id: input.organizationId,
      org_membership_id: input.orgMembershipId ?? null,
      source: input.source,
      error,
    })
    return null
  }
}

export function recordWorkflowResult(
  database: CodemodeDb,
  input: Omit<RecordWorkflowRunInput, "status" | "errorKind" | "errorMessage" | "toolCalls" | "durationMs">,
  result: CodemodeRunResult,
): Promise<DenTypeId<"workflowRun"> | null> {
  return recordWorkflowRun(database, {
    ...input,
    status: result.ok ? "succeeded" : "failed",
    errorKind: result.ok ? null : result.error.kind,
    errorMessage: result.ok ? null : result.error.message,
    toolCalls: result.toolCalls,
    durationMs: result.durationMs,
  })
}

export async function listWorkflowRuns(database: CodemodeDb, input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId?: DenTypeId<"member">
  limit?: number
}) {
  const limit = Math.min(200, Math.max(1, input.limit ?? 50))
  const rows = await database
    .select()
    .from(WorkflowRunTable)
    .where(input.orgMembershipId
      ? and(
        eq(WorkflowRunTable.organization_id, input.organizationId),
        eq(WorkflowRunTable.org_membership_id, input.orgMembershipId),
      )
      : eq(WorkflowRunTable.organization_id, input.organizationId))
    .orderBy(desc(WorkflowRunTable.created_at))
    .limit(limit)
  return rows.map((row) => ({ ...row, tool_calls: parseCodemodeToolCalls(row.tool_calls) }))
}
