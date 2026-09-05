import type { createDenDb } from "@openwork-ee/den-db"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { recordWorkflowRun, recordWorkflowResult } from "../workflow-runs.js"
import {
  artifactDigest,
  canonicalArtifactJson,
  optionalArtifactDigest,
  renderWorkflowMarkdown,
  WORKFLOW_MARKDOWN_RENDERER_VERSION,
} from "../workflow-artifacts.js"
import {
  parseCodemodeScriptPayload,
  validateCodemodeScriptInput,
  validateCodemodeScriptOutput,
  type CodemodeScriptInputIssue,
} from "./codemode-script-object.js"
import { firstUnattendedUnsafeCapability, restrictCodemodeToolTree, type BuiltCodemodeTools } from "./codemode-tools.js"
import { runCodemodeScript } from "./codemode-run.js"
import { normalizeToolBody } from "./invoke.js"

type CodemodeDb = ReturnType<typeof createDenDb>["db"]

export type WorkflowExecutionResult =
  | {
      ok: true
      value: unknown
      canonicalResult: string
      markdown: string
      resultDigest: string
      inputSchemaDigest: string | null
      outputSchemaDigest: string | null
      rendererVersion: typeof WORKFLOW_MARKDOWN_RENDERER_VERSION
      receiptId: DenTypeId<"workflowRun"> | null
      logs: string[]
      toolCalls: Array<{ name: string }>
      durationMs: number
    }
  | { ok: false; error: "unsupported"; message: string }
  | { ok: false; error: "invalid_arguments" | "invalid_result"; message: string; issues: CodemodeScriptInputIssue[]; receiptId?: DenTypeId<"workflowRun"> | null }
  | {
      ok: false
      error: "capability_unavailable"
      message: string
      providerCallAttempted: false
      missing: Array<{ capabilityName: string; scriptPath: string }>
      receiptId?: DenTypeId<"workflowRun"> | null
    }
  | {
      ok: false
      error: "script_failed"
      message: string
      kind: string
      toolCalls: Array<{ name: string }>
      receiptId?: DenTypeId<"workflowRun"> | null
    }

export async function executeWorkflow(input: {
  database: CodemodeDb
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  pluginId: DenTypeId<"plugin">
  configObjectId: DenTypeId<"configObject">
  configObjectVersionId?: DenTypeId<"configObjectVersion">
  automationRunId?: DenTypeId<"automationRun">
  normalizedPayloadJson: unknown
  code: string
  receiptSource?: string
  scriptInput?: unknown
  validateOutput?: boolean
  buildTools: () => Promise<BuiltCodemodeTools>
}): Promise<WorkflowExecutionResult> {
  const parsed = parseCodemodeScriptPayload(input.normalizedPayloadJson)
  if (!parsed.ok) return { ok: false, error: "unsupported", message: parsed.message }
  const scriptInput = normalizeToolBody(input.scriptInput)
  const normalizedScriptInput = scriptInput ?? null
  const scriptInputDigest = artifactDigest(normalizedScriptInput)
  const inputSchemaDigest = optionalArtifactDigest(parsed.payload.inputSchema)
  const outputSchemaDigest = optionalArtifactDigest(parsed.payload.outputSchema)
  const receiptSource = input.receiptSource ?? `plugin:${input.pluginId}:${input.configObjectId}`
  const recordPreflightFailure = (errorKind: string, errorMessage: string) => {
    const now = new Date()
    return recordWorkflowRun(input.database, {
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      automationRunId: input.automationRunId,
      pluginId: input.pluginId,
      configObjectId: input.configObjectId,
      configObjectVersionId: input.configObjectVersionId,
      scriptInputDigest,
      inputSchemaDigest,
      outputSchemaDigest,
      source: receiptSource,
      code: input.code,
      status: "failed",
      errorKind,
      errorMessage,
      toolCalls: [],
      durationMs: 0,
      startedAt: now,
      finishedAt: now,
    })
  }

  if (parsed.payload.inputSchema) {
    const validation = validateCodemodeScriptInput(parsed.payload.inputSchema, scriptInput)
    if (!validation.ok) {
      if (validation.error === "invalid_schema") return { ok: false, error: "unsupported", message: validation.message }
      const message = "The arguments do not match the Workflow's inputSchema."
      const receiptId = await recordPreflightFailure("InvalidArguments", message)
      return { ok: false, error: "invalid_arguments", message, issues: validation.issues, receiptId }
    }
  }

  const built = await input.buildTools().catch(() => ({ tools: {}, manifest: [] }))
  const unsafe = input.automationRunId
    ? firstUnattendedUnsafeCapability(built, parsed.payload.requiredCapabilities)
    : null
  if (unsafe) {
    const message = `Required capability ${unsafe.scriptPath} (${unsafe.capabilityName}) must be read-only and explicitly approved by an organization admin before it can run unattended in OpenWork Cloud.`
    const receiptId = await recordPreflightFailure("CapabilityUnavailable", message)
    return {
      ok: false,
      error: "capability_unavailable",
      message,
      providerCallAttempted: false,
      missing: [unsafe],
      receiptId,
    }
  }
  const restricted = restrictCodemodeToolTree({ built, requiredCapabilities: parsed.payload.requiredCapabilities })
  const firstMissing = restricted.missing[0]
  if (firstMissing) {
    const message = `Required capability ${firstMissing.scriptPath} (${firstMissing.capabilityName}) is unavailable or disabled for this organization.`
    const receiptId = await recordPreflightFailure("CapabilityUnavailable", message)
    return {
      ok: false,
      error: "capability_unavailable",
      message,
      providerCallAttempted: false,
      missing: restricted.missing,
      receiptId,
    }
  }

  const startedAt = new Date()
  const result = await runCodemodeScript({
    code: input.code,
    scriptInput,
    tools: restricted.tools,
    timeoutMs: Math.min(parsed.payload.limits?.timeoutMs ?? 120_000, 170_000),
    maxToolCalls: parsed.payload.limits?.maxToolCalls,
    maxOutputBytes: parsed.payload.limits?.maxOutputBytes,
  })
  const finishedAt = new Date()
  if (!result.ok) {
    const receiptId = await recordWorkflowResult(input.database, {
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      automationRunId: input.automationRunId,
      pluginId: input.pluginId,
      configObjectId: input.configObjectId,
      configObjectVersionId: input.configObjectVersionId,
      scriptInputDigest,
      inputSchemaDigest,
      outputSchemaDigest,
      source: receiptSource,
      code: input.code,
      startedAt,
      finishedAt,
    }, result)
    return {
      ok: false,
      error: "script_failed",
      message: result.error.message,
      kind: result.error.kind,
      toolCalls: result.toolCalls,
      receiptId,
    }
  }

  if (input.validateOutput === true && parsed.payload.outputSchema) {
    const validation = validateCodemodeScriptOutput(parsed.payload.outputSchema, result.value)
    if (!validation.ok) {
      if (validation.error === "invalid_schema") return { ok: false, error: "unsupported", message: validation.message }
      const receiptId = await recordWorkflowRun(input.database, {
        organizationId: input.organizationId,
        orgMembershipId: input.orgMembershipId,
        automationRunId: input.automationRunId,
        pluginId: input.pluginId,
        configObjectId: input.configObjectId,
        configObjectVersionId: input.configObjectVersionId,
        scriptInputDigest,
        inputSchemaDigest,
        resultDigest: artifactDigest(result.value),
        outputSchemaDigest,
        source: receiptSource,
        code: input.code,
        status: "failed",
        errorKind: "InvalidResult",
        errorMessage: "The Workflow result did not match its outputSchema.",
        toolCalls: result.toolCalls,
        durationMs: result.durationMs,
        startedAt,
        finishedAt,
      })
      return {
        ok: false,
        error: "invalid_result",
        message: "The Workflow result does not match its outputSchema.",
        issues: validation.issues,
        receiptId,
      }
    }
  }

  const canonicalResult = canonicalArtifactJson(result.value)
  const canonicalValue: unknown = JSON.parse(canonicalResult)
  const markdown = renderWorkflowMarkdown(canonicalValue)
  const resultDigest = artifactDigest(canonicalValue)
  const receiptId = await recordWorkflowResult(input.database, {
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    automationRunId: input.automationRunId,
    pluginId: input.pluginId,
    configObjectId: input.configObjectId,
    configObjectVersionId: input.configObjectVersionId,
    scriptInputDigest,
    inputSchemaDigest,
    ...(input.validateOutput === true
      ? {
          validatedResult: canonicalValue,
          resultMarkdown: markdown,
          resultDigest,
          outputSchemaDigest,
          rendererVersion: WORKFLOW_MARKDOWN_RENDERER_VERSION,
        }
      : {}),
    source: receiptSource,
    code: input.code,
    startedAt,
    finishedAt,
  }, result)
  return {
    ok: true,
    value: canonicalValue,
    canonicalResult,
    markdown,
    resultDigest,
    inputSchemaDigest,
    outputSchemaDigest,
    rendererVersion: WORKFLOW_MARKDOWN_RENDERER_VERSION,
    receiptId,
    logs: result.logs.map((log) => log.trim()).filter(Boolean),
    toolCalls: result.toolCalls,
    durationMs: result.durationMs,
  }
}
