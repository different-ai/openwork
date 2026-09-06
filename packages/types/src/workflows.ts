import { z } from "zod"

const idSchema = z.string().trim().min(1).max(160)
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const artifactFreshnessSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("never_run") }),
  z.object({ state: z.literal("fresh"), ageMs: z.number().int().nonnegative() }),
  z.object({
    state: z.literal("stale"),
    ageMs: z.number().int().nonnegative(),
    maxAgeMs: z.number().int().positive(),
  }),
  z.object({
    state: z.literal("needs_attention"),
    ageMs: z.number().int().nonnegative().nullable(),
    lastSuccessfulReceiptId: idSchema.nullable(),
    reason: z.string().trim().min(1).max(2_000),
  }),
])
export type ArtifactFreshness = z.infer<typeof artifactFreshnessSchema>

export const workflowCapabilitySchema = z.object({
  capabilityName: z.string().trim().min(1).max(255),
  scriptPath: z.string().trim().min(1).max(255),
})
export type WorkflowCapability = z.infer<typeof workflowCapabilitySchema>

export const workflowAutomationReferenceSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  state: z.enum(["active", "inactive", "needs_attention", "archived"]),
  configObjectVersionId: idSchema,
  input: z.unknown().optional(),
})
export type WorkflowAutomationReference = z.infer<typeof workflowAutomationReferenceSchema>

export const workflowGraphNodeSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("input"),
    label: z.string(),
    fields: z.array(z.string()),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("tool"),
    label: z.string(),
    namespace: z.string(),
    tool: z.string(),
    scriptPath: z.string(),
    assignsTo: z.string().nullable(),
    parallelGroup: z.string().nullable(),
  }),
  z.object({ id: z.string(), kind: z.literal("search"), label: z.string() }),
  z.object({ id: z.string(), kind: z.literal("branch"), label: z.string() }),
  z.object({ id: z.string(), kind: z.literal("loop"), label: z.string() }),
  z.object({ id: z.string(), kind: z.literal("return"), label: z.string() }),
])
export type WorkflowGraphNode = z.infer<typeof workflowGraphNodeSchema>

export const workflowGraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().nullable(),
  kind: z.enum(["flow", "data"]),
})
export type WorkflowGraphEdge = z.infer<typeof workflowGraphEdgeSchema>

export const workflowGraphSchema = z.object({
  nodes: z.array(workflowGraphNodeSchema),
  edges: z.array(workflowGraphEdgeSchema),
  parseError: z.string().nullable(),
})
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>

export const workflowVersionSchema = z.object({
  id: idSchema,
  // Authoring source and example input are OpenWork management data, not MCP
  // runtime data. Non-manager detail responses intentionally return null.
  code: z.string().nullable(),
  graph: workflowGraphSchema.nullable(),
  inputSchema: z.unknown().nullable(),
  outputSchema: z.unknown().nullable(),
  exampleInput: z.unknown().nullable().optional(),
  requiredCapabilities: z.array(workflowCapabilitySchema),
  codeDigest: digestSchema,
  inputSchemaDigest: digestSchema.nullable(),
  outputSchemaDigest: digestSchema.nullable(),
  createdAt: z.string().datetime(),
  automationReferences: z.array(workflowAutomationReferenceSchema),
})
export type WorkflowVersion = z.infer<typeof workflowVersionSchema>

export const workflowArtifactSnapshotSchema = z.object({
  receiptId: idSchema,
  pluginId: idSchema,
  configObjectId: idSchema,
  configObjectVersionId: idSchema,
  automationRunId: idSchema.nullable(),
  value: z.unknown().nullable(),
  markdown: z.string().nullable(),
  codeDigest: digestSchema,
  resultDigest: digestSchema.nullable(),
  inputSchemaDigest: digestSchema.nullable(),
  outputSchemaDigest: digestSchema.nullable(),
  rendererVersion: z.literal("codemode-markdown-v1").nullable(),
  toolCalls: z.array(z.object({ name: z.string() })),
  status: z.enum(["succeeded", "failed"]),
  errorKind: z.string().nullable(),
  errorMessage: z.string().nullable(),
  source: z.enum(["manual", "scheduled"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  contentDeletedAt: z.string().datetime().nullable(),
})
export type WorkflowArtifactSnapshot = z.infer<typeof workflowArtifactSnapshotSchema>

export const workflowDetailSchema = z.object({
  pluginId: idSchema,
  configObjectId: idSchema,
  title: z.string().trim().min(1).max(255),
  description: z.string().nullable(),
  canRun: z.boolean(),
  canManage: z.boolean(),
  currentVersion: workflowVersionSchema,
  versions: z.array(workflowVersionSchema),
  latestSnapshot: workflowArtifactSnapshotSchema.nullable(),
  latestSuccessfulSnapshot: workflowArtifactSnapshotSchema.nullable(),
  freshness: artifactFreshnessSchema,
})
export type WorkflowDetail = z.infer<typeof workflowDetailSchema>

export const workflowTestResultSchema = z.object({
  receiptId: idSchema,
  value: z.unknown(),
  markdown: z.string(),
  codeDigest: digestSchema,
  resultDigest: digestSchema,
  inputSchemaDigest: digestSchema.nullable(),
  outputSchemaDigest: digestSchema.nullable(),
  rendererVersion: z.literal("codemode-markdown-v1"),
  requiredCapabilities: z.array(workflowCapabilitySchema),
  finishedAt: z.string().datetime(),
})
export type WorkflowTestResult = z.infer<typeof workflowTestResultSchema>

/**
 * Stable data contract injected into the Workflow Artifact MCP App view.
 *
 * Keep this independent from the presentation resource so MCP hosts and other
 * OpenWork surfaces can validate the same result without understanding the UI.
 */
export const workflowArtifactSchemaVersion = "1" as const
export const workflowArtifactPayloadSchema = z.object({
  schemaVersion: z.literal(workflowArtifactSchemaVersion),
  artifact: z.object({
    title: z.string().trim().min(1).max(255),
    description: z.string().nullable(),
    pluginId: idSchema,
    configObjectId: idSchema,
    configObjectVersionId: idSchema,
    receiptId: idSchema,
    automationRunId: idSchema.nullable(),
    source: z.enum(["manual", "scheduled"]),
    generatedAt: z.string().datetime(),
    resultDigest: digestSchema,
    rendererVersion: z.literal("codemode-markdown-v1"),
    freshness: artifactFreshnessSchema,
  }),
  data: z.unknown(),
})
export type WorkflowArtifactPayload = z.infer<typeof workflowArtifactPayloadSchema>

export const generatedArtifactViewCspSchema = z.object({
  connectDomains: z.array(z.string()).length(0),
  resourceDomains: z.array(z.string()).length(0),
  frameDomains: z.array(z.string()).length(0),
  baseUriDomains: z.array(z.string()).length(0),
})
export type GeneratedArtifactViewCsp = z.infer<typeof generatedArtifactViewCspSchema>

export const generatedArtifactViewBuildDiagnosticSchema = z.object({
  level: z.enum(["error", "warning"]),
  message: z.string().trim().min(1).max(4_000),
  line: z.number().int().positive().nullable(),
  column: z.number().int().nonnegative().nullable(),
})
export type GeneratedArtifactViewBuildDiagnostic = z.infer<typeof generatedArtifactViewBuildDiagnosticSchema>

export const generatedArtifactViewRevisionSchema = z.object({
  id: idSchema,
  artifactViewId: idSchema,
  resourceUri: z.string().startsWith("ui://openwork/artifacts/"),
  buildStatus: z.enum(["ready", "failed"]),
  sourceDigest: digestSchema,
  resourceDigest: digestSchema.nullable(),
  outputSchemaDigest: digestSchema,
  csp: generatedArtifactViewCspSchema,
  diagnostics: z.array(generatedArtifactViewBuildDiagnosticSchema),
  compilerName: z.string().trim().min(1),
  compilerVersion: z.string().trim().min(1),
  reactVersion: z.string().trim().min(1),
  compiledHtmlBytes: z.number().int().nonnegative().nullable(),
  retiredAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
})
export type GeneratedArtifactViewRevision = z.infer<typeof generatedArtifactViewRevisionSchema>

export const generatedArtifactViewSchema = z.object({
  id: idSchema,
  configObjectId: idSchema,
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2_000).nullable(),
  status: z.enum(["active", "retired"]),
  activeRevisionId: idSchema.nullable(),
  useInWorkflow: z.boolean().optional(),
  revisions: z.array(generatedArtifactViewRevisionSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type GeneratedArtifactView = z.infer<typeof generatedArtifactViewSchema>

export const savedAppSummarySchema = z.object({
  view: generatedArtifactViewSchema,
  workflowTitle: z.string(),
  canManage: z.boolean(),
  onDashboard: z.boolean(),
})
export type SavedAppSummary = z.infer<typeof savedAppSummarySchema>

export const savedAppDetailSchema = savedAppSummarySchema.extend({
  revision: generatedArtifactViewRevisionSchema.nullable(),
  html: z.string().nullable(),
  payload: workflowArtifactPayloadSchema.nullable(),
  previewNotice: z.string().nullable(),
})
export type SavedAppDetail = z.infer<typeof savedAppDetailSchema>

export const saveAppSchema = z.object({
  revisionId: idSchema,
  title: z.string().trim().min(1).max(255),
  useInWorkflow: z.boolean(),
  expectedActiveRevisionId: idSchema.nullable(),
})
export type SaveApp = z.infer<typeof saveAppSchema>
