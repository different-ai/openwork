import type { McpUiResourceMeta } from "@modelcontextprotocol/ext-apps"
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { workflowRunnerAppHtml } from "@openwork/mcp-apps/workflow-runner"
import {
  workflowRunnerOpenInputSchema,
  workflowRunnerOpenOutputSchema,
  workflowRunnerOpenTool,
  workflowRunnerResourceUri,
  workflowRunnerRunInputSchema,
  workflowRunnerRunOutputSchema,
  workflowRunnerRunTool,
  type WorkflowRunnerCatalog,
  type WorkflowRunnerError,
  type WorkflowRunnerResult,
} from "@openwork/types/workflow-runner-app"
import { renderWorkflowMarkdown } from "../workflow-artifacts.js"
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "./mcp-app-v2.js"
import type { WorkflowRunnerService } from "./workflow-runner-service.js"

const resourceMeta: { ui: McpUiResourceMeta } = {
  ui: {
    prefersBorder: true,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
  },
}

function toolResult(result: WorkflowRunnerCatalog | WorkflowRunnerResult | WorkflowRunnerError): CallToolResult {
  let text: string
  if (result.kind === "workflow_error") {
    text = result.message
  } else if (result.kind === "workflow_result") {
    text = [
      `# ${result.workflow.title}`,
      `Workflow: ${result.workflow.configObjectId}`,
      `Version: ${result.workflow.configObjectVersionId}`,
      `Receipt: ${result.receiptId ?? "unavailable"}`,
      renderWorkflowMarkdown(result.value),
    ].join("\n\n")
  } else {
    text = result.workflows.length === 0
      ? "No accessible Workflows found. Save a Workflow in your library, or ask its owner for access."
      : [
          "# Workflows",
          ...result.workflows.map((workflow) => [
            `## ${workflow.title}`,
            workflow.description,
            workflow.blockedReason ? `Blocked: ${workflow.blockedReason}` : "Ready for a read-only run.",
            JSON.stringify({ pluginId: workflow.pluginId, configObjectId: workflow.configObjectId, configObjectVersionId: workflow.configObjectVersionId }),
          ].filter(Boolean).join("\n")),
          result.hasMore ? "More Workflows are available. Narrow the search query." : "",
          "Listing does not run anything. Call run_workflow_readonly with the exact IDs to run a selected Workflow.",
        ].filter(Boolean).join("\n\n")
  }
  return {
    ...(result.kind === "workflow_error" ? { isError: true } : {}),
    content: [{ type: "text", text }],
    structuredContent: result,
  }
}

async function safely(run: () => Promise<WorkflowRunnerCatalog | WorkflowRunnerResult | WorkflowRunnerError>) {
  try {
    return toolResult(await run())
  } catch {
    return toolResult({ schemaVersion: "1", kind: "workflow_error", error: "workflow_unavailable", message: "Workflows are temporarily unavailable. List Workflows again before retrying." })
  }
}

export function registerAgentWorkflowRunnerApp(input: { server: McpServer; service: WorkflowRunnerService }) {
  registerAppResource(input.server, "Workflow runner", workflowRunnerResourceUri, {
    description: "A portable picker for running saved Workflows with Den-authorized read-only capabilities.",
    _meta: resourceMeta,
  }, async () => ({
    contents: [{ uri: workflowRunnerResourceUri, mimeType: RESOURCE_MIME_TYPE, text: workflowRunnerAppHtml, _meta: resourceMeta }],
  }))

  registerAppTool(input.server, workflowRunnerOpenTool, {
    title: "Open Workflows",
    description: "List up to 20 accessible saved Workflows, optionally filtered by query, and open the Workflow runner. Includes blocked reasons for read-only safety and server input.runtime compatibility. Listing never executes a Workflow; text-only clients receive the same catalog and exact IDs.",
    inputSchema: workflowRunnerOpenInputSchema,
    outputSchema: workflowRunnerOpenOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: workflowRunnerResourceUri, visibility: ["model", "app"] } },
  }, (request) => safely(() => input.service.open(request)))

  input.server.registerTool(workflowRunnerRunTool, {
    title: "Run Workflow read-only",
    description: "Run the exact current version selected from open_workflows. Accepts only pluginId, configObjectId, configObjectVersionId and optional IANA timeZone (UTC by default). The server supplies input.runtime and permits only current Den-authorized read-only capabilities. Access and version are rechecked; stale selections must be listed again. Returns validated JSON and readable text without opening another App.",
    inputSchema: workflowRunnerRunInputSchema,
    outputSchema: workflowRunnerRunOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: { ui: { visibility: ["model", "app"] } },
  }, (request) => safely(() => input.service.run(request)))
}
