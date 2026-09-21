import { z } from "zod"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { artifactRunInputSchema, artifactRuntime } from "../artifact-runtime.js"
import { artifactDigest, optionalArtifactDigest } from "../workflow-artifacts.js"
import {
  assertWorkflowSourceSafe,
  getWorkflowAuthoringRetentionMetadata,
  retainWorkflowAuthoringSource,
  type WorkflowAuthoringSourceInput,
  type WorkflowAuthoringRetentionMetadata,
} from "../workflow-authoring-receipts.js"
import type { RecordWorkflowRunInput } from "../workflow-runs.js"
import type { ExecuteCapabilityToolResult } from "./capability-registry.js"
import { runCodemodeScript } from "./codemode-run.js"
import { validateCodemodeScriptInput, validateCodemodeScriptOutput } from "./codemode-script-object.js"
import { restrictReadOnlyCodemodeToolTree, type BuiltCodemodeTools } from "./codemode-tools.js"
import { normalizeToolBody } from "./invoke.js"

export const workflowAuthoringTestInputSchema = z.object({
  code: z.string().min(1),
  mode: z.enum(["adhoc", "live"]).default("adhoc"),
  input: z.unknown().optional().describe("Adhoc parameters, normalized from JSON if needed. Live rejects any caller input, including runtime."),
  timeZone: artifactRunInputSchema.shape.timeZone.describe("IANA time zone for live mode only; defaults to UTC."),
  inputSchema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema object checked against script input before any tool dispatch."),
  outputSchema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema object checked against the returned value. Discover capability outputSchema to design this contract."),
}).strict().superRefine((value, context) => {
  if (value.mode === "live" && Object.hasOwn(value, "input")) {
    context.addIssue({ code: "custom", path: ["input"], message: "Live authoring tests do not accept caller input." })
  }
  if (value.mode !== "live" && value.timeZone !== undefined) {
    context.addIssue({ code: "custom", path: ["timeZone"], message: "timeZone is only supported in live mode." })
  }
})

export async function executeWorkflowAuthoringTest(request: unknown, context: {
  organizationId: DenTypeId<"organization">
  orgMembershipId?: DenTypeId<"member">
  buildTools: () => Promise<BuiltCodemodeTools>
  recordRun: (input: RecordWorkflowRunInput) => Promise<DenTypeId<"workflowRun"> | null>
  retainSource?: (input: WorkflowAuthoringSourceInput) => Promise<boolean>
  retentionMetadata?: () => Promise<WorkflowAuthoringRetentionMetadata>
}): Promise<ExecuteCapabilityToolResult> {
  const failure = (error: string, message: string, extra: Record<string, unknown> = {}): ExecuteCapabilityToolResult => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error, message, ...extra }) }],
  })
  const parsed = workflowAuthoringTestInputSchema.safeParse(request)
  if (!parsed.success) return failure("invalid_arguments", "Invalid authoring test arguments.", { issues: parsed.error.issues })
  const { code, mode, inputSchema, outputSchema, timeZone } = parsed.data
  const runtime = mode === "live" ? artifactRuntime(timeZone) : undefined
  const scriptInput = runtime ? { runtime } : normalizeToolBody(parsed.data.input) ?? null
  const scriptInputDigest = artifactDigest(scriptInput)
  const inputSchemaDigest = optionalArtifactDigest(inputSchema)
  const outputSchemaDigest = optionalArtifactDigest(outputSchema)
  const source = mode === "live" ? "authoring:live" : "adhoc"
  const receipt = {
    organizationId: context.organizationId,
    orgMembershipId: context.orgMembershipId,
    code, source, scriptInputDigest, inputSchemaDigest, outputSchemaDigest,
  }
  let retained = false
  let retentionError = context.orgMembershipId ? "workflow_authoring_receipt_unavailable" : "workflow_authoring_member_required"
  // A receipt is the canonical submission/version identifier. Its private source
  // record is separate from the durable execution record, including failed runs.
  const record = async (input: RecordWorkflowRunInput) => {
    const receiptId = await context.recordRun(input).catch(() => null)
    if (context.orgMembershipId && receiptId) {
      retentionError = "workflow_authoring_source_not_retained"
      try {
        assertWorkflowSourceSafe(code)
        retained = await (context.retainSource ?? retainWorkflowAuthoringSource)({
          receiptId, organizationId: context.organizationId, orgMembershipId: context.orgMembershipId,
          code, mode, inputDigest: scriptInputDigest, inputSchemaDigest, outputSchemaDigest,
          contract: { input: scriptInput, inputSchema, outputSchema },
          ...(runtime ? { runtime } : {}),
        })
      } catch (error) {
        retentionError = error instanceof Error && error.message === "workflow_source_contains_secret"
          ? "workflow_source_contains_secret" : "workflow_authoring_retention_unavailable"
      }
    }
    return receiptId
  }
  const failed = (error: string, message: string, receiptId: string | null, extra: Record<string, unknown> = {}) =>
    failure(error, message, { ...extra, receiptId, runId: receiptId, status: "failed", verification: "failed",
      retention: { available: retained, canSaveByReceipt: false, ...(!retained ? { error: retentionError } : {}) } })
  for (const [name, schema] of [["inputSchema", inputSchema], ["outputSchema", outputSchema]] satisfies Array<[string, typeof inputSchema]>) {
    if (!schema) continue
    const validation = validateCodemodeScriptInput(schema, null)
    if (!validation.ok && validation.error === "invalid_schema") {
      const now = new Date()
      const receiptId = await record({ ...receipt, status: "failed", errorKind: "InvalidArguments",
        errorMessage: `The ${name} could not be compiled.`, toolCalls: [], durationMs: 0, startedAt: now, finishedAt: now })
      return failed("invalid_schema", `The ${name} could not be compiled.`, receiptId)
    }
  }
  if (inputSchema) {
    const validation = validateCodemodeScriptInput(inputSchema, scriptInput)
    if (!validation.ok) {
      const now = new Date()
      const receiptId = await record({ ...receipt, status: "failed", errorKind: "InvalidArguments",
        errorMessage: "The input does not match inputSchema.", toolCalls: [], durationMs: 0, startedAt: now, finishedAt: now })
      return failed("invalid_arguments", "The input does not match inputSchema.", receiptId)
    }
  }
  const built = await context.buildTools()
  const tools = mode === "live"
    ? restrictReadOnlyCodemodeToolTree({ built, requiredCapabilities: built.manifest.filter((entry) => entry.readOnly === true) }).tools
    : built.tools
  const startedAt = new Date()
  const result = await runCodemodeScript({ code, scriptInput, readOnlyInput: mode === "live", tools, timeoutMs: 170_000 })
  const finishedAt = new Date()
  if (!result.ok) {
    const receiptId = await record({ ...receipt, status: "failed", errorKind: result.error.kind,
      errorMessage: "The authoring test script failed.", toolCalls: result.toolCalls, durationMs: result.durationMs, startedAt, finishedAt })
    return failed("script_failed", result.error.message, receiptId, { kind: result.error.kind,
      ...(result.error.suggestions ? { suggestions: result.error.suggestions } : {}), toolCalls: result.toolCalls })
  }
  const resultDigest = artifactDigest(result.value)
  if (outputSchema) {
    const validation = validateCodemodeScriptOutput(outputSchema, result.value)
    if (!validation.ok) {
      const receiptId = await record({ ...receipt, resultDigest, status: "failed", errorKind: "InvalidResult",
        errorMessage: "The result does not match outputSchema.", toolCalls: result.toolCalls, durationMs: result.durationMs, startedAt, finishedAt })
      return failed("invalid_result", "The result does not match outputSchema.", receiptId)
    }
  }
  const receiptId = await record({ ...receipt, resultDigest, status: "succeeded",
    toolCalls: result.toolCalls, durationMs: result.durationMs, startedAt, finishedAt })
  const retention = await (context.retentionMetadata ?? getWorkflowAuthoringRetentionMetadata)()
    .catch((): WorkflowAuthoringRetentionMetadata => ({ scope: "unavailable", ttlMs: 0 }))
  const available = retained && retention.scope !== "unavailable"
  const metadata = {
    receiptId, runId: receiptId, status: "succeeded", mode, executionType: "authoring-test", verification: outputSchema ? "schema" : "not-requested",
    keepAsWorkflow: available ? { receiptId, name: "<choose a name>" } : null,
    executedAt: startedAt.toISOString(), fetchedAt: finishedAt.toISOString(),
    ...(runtime ? { timeZone: runtime.timeZone } : {}),
    retention: { ...retention, available, canSaveByReceipt: available,
      ...(!available ? {
        error: retention.scope === "unavailable" ? "workflow_authoring_retention_unavailable" : retentionError,
        message: retentionError === "workflow_source_contains_secret"
          ? "Test execution succeeded, but source is not available to save by receipt because it contains a possible secret. Remove hardcoded secrets and retest."
          : "Test execution succeeded, but source is not available to save by receipt. Retest with a signed-in member and available retention before saving.",
      } : {}) },
  }
  const value = typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2)
  const logs = result.logs.length > 0 ? `\n\nLogs:\n${result.logs.join("\n")}` : ""
  return {
    content: [{ type: "text", text: `${value}${logs}` }, { type: "text", text: JSON.stringify({ metadata }) }],
    structuredContent: { value: result.value, metadata },
  }
}
