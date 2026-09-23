import { z } from "zod"

// App identity belongs to the UI, not to a Workflow or a generated Artifact view.
export const workflowRunnerResourceUri = "ui://openwork/workflow-runner/v1/view.html"
export const workflowRunnerOpenTool = "open_workflows"
export const workflowRunnerRunTool = "run_workflow_readonly"

const id = z.string().trim().min(1).max(160)
export const workflowRunnerOpenInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
}).strict()
export const workflowRunnerRunInputSchema = z.object({
  pluginId: id,
  configObjectId: id,
  configObjectVersionId: id,
  timeZone: z.string().trim().min(1).max(100).optional(),
}).strict()
export const workflowRunnerItemSchema = z.object({
  pluginId: id,
  configObjectId: id,
  configObjectVersionId: id,
  title: z.string(),
  description: z.string().nullable(),
  blockedReason: z.string().nullable(),
})
export const workflowRunnerErrorSchema = z.object({
  schemaVersion: z.literal("1"),
  kind: z.literal("workflow_error"),
  error: z.string(),
  message: z.string(),
})
export const workflowRunnerCatalogSchema = z.object({
  schemaVersion: z.literal("1"),
  kind: z.literal("workflow_catalog"),
  workflows: z.array(workflowRunnerItemSchema).max(20),
  hasMore: z.boolean(),
})
export const workflowRunnerResultSchema = z.object({
  schemaVersion: z.literal("1"),
  kind: z.literal("workflow_result"),
  workflow: workflowRunnerItemSchema,
  value: z.json(),
  receiptId: z.string().nullable(),
  resultDigest: z.string(),
  outputSchemaDigest: z.string().nullable(),
})
export const workflowRunnerOpenOutputSchema = z.union([workflowRunnerCatalogSchema, workflowRunnerErrorSchema])
export const workflowRunnerRunOutputSchema = z.union([workflowRunnerResultSchema, workflowRunnerErrorSchema])
export type WorkflowRunnerItem = z.infer<typeof workflowRunnerItemSchema>
export type WorkflowRunnerCatalog = z.infer<typeof workflowRunnerCatalogSchema>
export type WorkflowRunnerResult = z.infer<typeof workflowRunnerResultSchema>
export type WorkflowRunnerError = z.infer<typeof workflowRunnerErrorSchema>
