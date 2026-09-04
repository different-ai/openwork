import type { WorkflowGraphNode, WorkflowVersion } from "@openwork/types/workflows"

function redactWorkflowGraphNodeLabel(node: WorkflowGraphNode): WorkflowGraphNode {
  switch (node.kind) {
    case "branch":
      return { ...node, label: "Condition" }
    case "loop":
      return { ...node, label: "Repeat" }
    case "return":
      return { ...node, label: "Result" }
    case "input":
    case "tool":
    case "search":
      return node
  }
}

export function redactWorkflowNormalizedPayloadAuthoringDetails(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) return null
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "exampleInput"))
}

export function redactWorkflowVersionAuthoringDetails(
  version: WorkflowVersion,
): WorkflowVersion {
  return {
    // Keep the structural graph visible to Workflow viewers, but replace source-derived labels.
    ...version,
    code: null,
    graph: version.graph
      ? { ...version.graph, nodes: version.graph.nodes.map(redactWorkflowGraphNodeLabel) }
      : null,
    exampleInput: null,
    automationReferences: version.automationReferences.map((reference) => ({
      id: reference.id,
      name: reference.name,
      state: reference.state,
      configObjectVersionId: reference.configObjectVersionId,
    })),
  }
}
