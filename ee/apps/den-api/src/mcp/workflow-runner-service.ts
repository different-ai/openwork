import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  workflowRunnerOpenInputSchema,
  workflowRunnerRunInputSchema,
  workflowRunnerResultSchema,
  type WorkflowRunnerCatalog,
  type WorkflowRunnerError,
  type WorkflowRunnerItem,
  type WorkflowRunnerResult,
} from "@openwork/types/workflow-runner-app"
import { z } from "zod"
import { artifactRunInputSchema, artifactRuntime } from "../artifact-runtime.js"
import { validateCodemodeScriptInput } from "./codemode-script-object.js"
import { restrictReadOnlyCodemodeToolTree, type BuiltCodemodeTools } from "./codemode-tools.js"
import type { McpMemberIdentity } from "./external-capabilities.js"
import {
  executeMarketplaceCapability,
  listAccessibleWorkflows,
  type AccessibleWorkflow,
} from "./marketplace-capabilities.js"
import { DEN_MCP_READ_SCOPE } from "./scopes.js"

export function workflowRunnerError(error: string, message: string): WorkflowRunnerError {
  return { schemaVersion: "1", kind: "workflow_error", error, message }
}

function selection(value: { pluginId: string; configObjectId: string; configObjectVersionId: string }) {
  return {
    pluginId: normalizeDenTypeId("plugin", value.pluginId),
    configObjectId: normalizeDenTypeId("configObject", value.configObjectId),
    configObjectVersionId: normalizeDenTypeId("configObjectVersion", value.configObjectVersionId),
  }
}

function selectedWorkflow(workflows: AccessibleWorkflow[], selected: ReturnType<typeof selection>) {
  return workflows.find((workflow) => {
    const ids = selection(workflow)
    return ids.pluginId === selected.pluginId
      && ids.configObjectId === selected.configObjectId
      && ids.configObjectVersionId === selected.configObjectVersionId
  })
}

function workflowItem(workflow: AccessibleWorkflow, built: BuiltCodemodeTools, runtime: ReturnType<typeof artifactRuntime>): WorkflowRunnerItem {
  let blockedReason: string | null = null
  if (workflow.inputSchema !== null) {
    const schema = z.record(z.string(), z.unknown()).safeParse(workflow.inputSchema)
    if (!schema.success || !validateCodemodeScriptInput(schema.data, { runtime }).ok) {
      blockedReason = "This Workflow does not accept server-provided input.runtime without additional caller input."
    }
  }
  const restricted = restrictReadOnlyCodemodeToolTree({ built, requiredCapabilities: workflow.requiredCapabilities })
  if (restricted.unsafe.length > 0) {
    blockedReason = "This Workflow requires capabilities that are not current Den-authorized read-only operations."
  } else if (restricted.missing.length > 0) {
    blockedReason = "This Workflow requires capabilities that are unavailable or disabled for this member."
  }
  return {
    ...selection(workflow),
    title: workflow.title,
    description: workflow.description,
    blockedReason,
  }
}

export function createWorkflowRunnerService(context: {
  organizationId: string
  member: McpMemberIdentity | null
  scopes: ReadonlySet<string>
  enabled: boolean
  buildTools: () => Promise<BuiltCodemodeTools>
}, dependencies: {
  list: typeof listAccessibleWorkflows
  execute: typeof executeMarketplaceCapability
} = { list: listAccessibleWorkflows, execute: executeMarketplaceCapability }) {
  function gate() {
    if (!context.member) return workflowRunnerError("forbidden", "An active organization membership is required.")
    if (!context.scopes.has(DEN_MCP_READ_SCOPE)) return workflowRunnerError("insufficient_mcp_scope", "The mcp:read scope is required.")
    if (!context.enabled) return workflowRunnerError("workflow_execution_disabled", "Workflow execution is disabled for this organization.")
    return null
  }

  async function list() {
    if (!context.member) return []
    return dependencies.list({ organizationId: context.organizationId, member: context.member })
  }

  const unavailable = () => workflowRunnerError("workflow_unavailable", "The selected Workflow version is no longer available. List Workflows again and select its current version.")

  return {
    async open(request: unknown): Promise<WorkflowRunnerCatalog | WorkflowRunnerError> {
      const parsed = workflowRunnerOpenInputSchema.safeParse(request)
      if (!parsed.success) return workflowRunnerError("invalid_arguments", "Provide only an optional search query of at most 200 characters.")
      const denied = gate()
      if (denied) return denied
      try {
        const query = parsed.data.query?.toLowerCase() ?? ""
        const workflows = (await list()).filter((workflow) =>
          `${workflow.title}\n${workflow.description ?? ""}`.toLowerCase().includes(query))
        const visible = workflows.slice(0, 20)
        const built = visible.length > 0 ? await context.buildTools() : { tools: {}, manifest: [] }
        const runtime = artifactRuntime()
        return {
          schemaVersion: "1",
          kind: "workflow_catalog",
          workflows: visible.map((workflow) => workflowItem(workflow, built, runtime)),
          hasMore: workflows.length > visible.length,
        }
      } catch {
        return workflowRunnerError("workflow_catalog_unavailable", "Workflows could not be listed. Try listing again.")
      }
    },
    async run(request: unknown): Promise<WorkflowRunnerResult | WorkflowRunnerError> {
      const parsed = workflowRunnerRunInputSchema.safeParse(request)
      if (!parsed.success) return workflowRunnerError("invalid_arguments", "Provide exact plugin, Workflow, and version IDs, plus an optional IANA timeZone. Caller input and code are not accepted.")
      const runtimeInput = artifactRunInputSchema.safeParse({ timeZone: parsed.data.timeZone })
      if (!runtimeInput.success) return workflowRunnerError("invalid_arguments", "Provide a valid IANA timeZone, or omit it for UTC.")
      const denied = gate()
      if (denied) return denied
      let selected: ReturnType<typeof selection>
      try {
        selected = selection(parsed.data)
      } catch {
        return unavailable()
      }
      try {
        if (!selectedWorkflow(await list(), selected)) return unavailable()
        const built = await context.buildTools()
        const workflow = selectedWorkflow(await list(), selected)
        if (!workflow) return unavailable()
        const item = workflowItem(workflow, built, artifactRuntime(runtimeInput.data.timeZone))
        if (item.blockedReason) return workflowRunnerError("workflow_blocked", item.blockedReason)
        const execution = await dependencies.execute({
          ...selected,
          organizationId: context.organizationId,
          member: context.member,
          enabled: context.enabled,
          buildTools: async () => built,
          liveRuntime: runtimeInput.data,
          validateScriptOutput: true,
        })
        if (!execution.ok) {
          switch (execution.error) {
            case "forbidden":
            case "unknown_capability":
              return unavailable()
            case "capability_unavailable":
              return workflowRunnerError("workflow_blocked", "Required capabilities are unavailable or are not Den-authorized read-only operations. List Workflows again.")
            case "invalid_capability_arguments":
              return workflowRunnerError("workflow_validation_failed", "The Workflow input or result did not satisfy its saved schema.")
            case "script_failed":
              return workflowRunnerError("workflow_failed", "The Workflow could not complete. No successful result is available.")
          }
        }
        if (execution.result.kind !== "workflow" || execution.result.status !== "executed") return unavailable()
        const result = workflowRunnerResultSchema.safeParse({
          schemaVersion: "1",
          kind: "workflow_result",
          workflow: item,
          value: execution.result.value,
          receiptId: execution.result.receiptId ?? null,
          resultDigest: execution.result.resultDigest,
          outputSchemaDigest: execution.result.outputSchemaDigest ?? null,
        })
        return result.success ? result.data : workflowRunnerError("workflow_invalid_result", "The Workflow did not return a valid JSON result.")
      } catch {
        return workflowRunnerError("workflow_failed", "The Workflow could not complete. List Workflows again before retrying.")
      }
    },
  }
}

export type WorkflowRunnerService = ReturnType<typeof createWorkflowRunnerService>
