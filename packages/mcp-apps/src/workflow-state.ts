import type { App } from "@modelcontextprotocol/ext-apps"
import {
  workflowRunnerOpenInputSchema,
  workflowRunnerOpenOutputSchema,
  workflowRunnerOpenTool,
  workflowRunnerRunInputSchema,
  workflowRunnerRunOutputSchema,
  workflowRunnerRunTool,
  type WorkflowRunnerCatalog,
  type WorkflowRunnerError,
  type WorkflowRunnerItem,
  type WorkflowRunnerResult,
} from "@openwork/types/workflow-runner-app"
import { parseToolResult } from "./shared/result"

export type WorkflowLaunch = WorkflowRunnerCatalog | WorkflowRunnerError
export type WorkflowState = {
  catalog: WorkflowRunnerCatalog | null
  selected: WorkflowRunnerItem | null
  result: WorkflowRunnerResult | null
  receivedAt: string | null
  busy: "search" | "run" | null
  error: WorkflowRunnerError | null
  recovery: string
  stale: boolean
}
type WorkflowAction =
  | { type: "select"; workflow: WorkflowRunnerItem | null }
  | { type: "start"; operation: "search" | "run" }
  | { type: "catalog"; payload: WorkflowLaunch }
  | { type: "result"; payload: WorkflowRunnerResult; receivedAt: string }
  | { type: "error"; error: WorkflowRunnerError; operation: "search" | "run" }

export function workflowKey(workflow: WorkflowRunnerItem) {
  return JSON.stringify([workflow.pluginId, workflow.configObjectId, workflow.configObjectVersionId])
}

export function initialWorkflowState(payload: WorkflowLaunch): WorkflowState {
  return workflowReducer({
    catalog: null, selected: null, result: null, receivedAt: null, busy: null,
    error: null, recovery: "", stale: false,
  }, { type: "catalog", payload })
}

export function workflowReducer(state: WorkflowState, action: WorkflowAction): WorkflowState {
  switch (action.type) {
    case "select":
      return { ...state, selected: action.workflow }
    case "start":
      return { ...state, busy: action.operation, error: null, stale: state.result !== null }
    case "catalog":
      if (action.payload.kind === "workflow_error") {
        return workflowReducer(state, { type: "error", error: action.payload, operation: "search" })
      }
      return { ...state, catalog: action.payload, busy: null, error: null }
    case "result":
      return { ...state, result: action.payload, receivedAt: action.receivedAt, busy: null, error: null, stale: false }
    case "error":
      return {
        ...state, busy: null, error: action.error, stale: state.result !== null,
        recovery: action.operation === "run"
          ? "Check run history before running again; a receipt may have been saved."
          : "Search again. If access is blocked, ask the workflow owner to review it.",
      }
  }
}

export function selectedWorkflow(state: WorkflowState) {
  return state.catalog?.workflows.find(workflow => state.selected && workflowKey(workflow) === workflowKey(state.selected))
}

export function workflowBlock(state: WorkflowState, serverTools: boolean) {
  if (!serverTools) return "This host cannot run workflows. Open Workflows in a host that supports server tools."
  if (!state.selected) return null
  const selected = selectedWorkflow(state)
  if (!selected) return "The selected version is not in these results. Change the search or choose a version from the list."
  if (selected.blockedReason !== null) return `${selected.blockedReason || "This workflow is blocked."} Ask the workflow owner to review its access and read-only setup.`
  return null
}

export function isPreviousResult(state: WorkflowState) {
  return Boolean(state.result && (state.stale || !state.selected || !selectedWorkflow(state) || workflowKey(state.result.workflow) !== workflowKey(state.selected)))
}

export async function searchWorkflows(app: Pick<App, "callServerTool">, query: string) {
  const args = workflowRunnerOpenInputSchema.parse(query.trim() ? { query } : {})
  const result = await app.callServerTool({ name: workflowRunnerOpenTool, arguments: args })
  return parseToolResult(workflowRunnerOpenOutputSchema, result, payload => payload.kind === "workflow_error")
}

export async function runWorkflow(app: Pick<App, "callServerTool">, workflow: WorkflowRunnerItem, timeZone?: string) {
  const args = workflowRunnerRunInputSchema.parse({
    pluginId: workflow.pluginId,
    configObjectId: workflow.configObjectId,
    configObjectVersionId: workflow.configObjectVersionId,
    ...(timeZone ? { timeZone } : {}),
  })
  const result = await app.callServerTool({ name: workflowRunnerRunTool, arguments: args })
  const payload = parseToolResult(workflowRunnerRunOutputSchema, result, value => value.kind === "workflow_error")
  if (payload.kind === "workflow_result" && workflowKey(payload.workflow) !== workflowKey(workflow)) {
    throw new Error("The result does not match the selected workflow version.")
  }
  return payload
}
