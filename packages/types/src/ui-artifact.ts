import { z } from "zod"

export const UI_ARTIFACT_PROTOCOL = "openwork.ui-artifact"
export const UI_ARTIFACT_SCHEMA_VERSION = "1"
export const UI_ARTIFACT_MAX_JSON_BYTES = 40_000
export const UI_ARTIFACT_SEARCH_CAPABILITY = "openwork.ui_artifacts.search"
export const UI_ARTIFACT_RENDER_CAPABILITY = "openwork.ui_artifacts.render"
export const UI_ARTIFACT_USE_CAPABILITY = "openwork.ui_artifacts.use"

export const UI_ARTIFACT_KINDS = [
  "workspace.brief",
  "calendar.view",
  "widgets.collection",
  "communication.thread",
  "mail.inbox",
  "work.attention",
  "work.approvals",
] as const

export const uiArtifactKindSchema = z.enum(UI_ARTIFACT_KINDS)
export type UiArtifactKind = z.infer<typeof uiArtifactKindSchema>

export const uiArtifactPreferencesSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-preferences"),
  schemaVersion: z.literal(UI_ARTIFACT_SCHEMA_VERSION),
  enabled: z.boolean(),
  enabledArtifactIds: z.array(uiArtifactKindSchema).max(UI_ARTIFACT_KINDS.length),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
}).strict()
export type UiArtifactPreferences = z.infer<typeof uiArtifactPreferencesSchema>

export const uiArtifactPreferencesUpdateSchema = z.object({
  enabled: z.boolean(),
  enabledArtifactIds: z.array(uiArtifactKindSchema).max(UI_ARTIFACT_KINDS.length),
}).strict()
export type UiArtifactPreferencesUpdate = z.infer<typeof uiArtifactPreferencesUpdateSchema>

const compactTextSchema = z.string().trim().min(1).max(160)
const detailTextSchema = z.string().trim().min(1).max(2_000)
const isoDateTimeSchema = z.string().datetime({ offset: true })
const webUrlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password
  } catch {
    return false
  }
}, "Only credential-free https URLs are supported")

export const uiArtifactOpenUrlActionSchema = z.object({
  id: compactTextSchema,
  label: compactTextSchema,
  type: z.literal("open_url"),
  url: webUrlSchema,
  description: compactTextSchema.optional(),
}).strict()
export const uiArtifactDecisionActionSchema = z.object({
  id: compactTextSchema,
  label: compactTextSchema,
  type: z.literal("request_decision"),
  instanceId: z.string().trim().min(1).max(128),
  itemId: compactTextSchema,
  decision: z.enum(["approve", "reject"]),
  expectedRevision: z.number().int().positive(),
  description: compactTextSchema.optional(),
}).strict()
export const uiArtifactActionSchema = z.discriminatedUnion("type", [
  uiArtifactOpenUrlActionSchema,
  uiArtifactDecisionActionSchema,
])
export type UiArtifactAction = z.infer<typeof uiArtifactActionSchema>

export const uiArtifactSourceSchema = z.object({
  type: z.enum(["mock", "provider", "derived"]),
  label: compactTextSchema,
  provider: compactTextSchema.optional(),
  account: compactTextSchema.optional(),
  observedAt: isoDateTimeSchema.optional(),
}).strict()
export type UiArtifactSource = z.infer<typeof uiArtifactSourceSchema>

export const uiArtifactPresentationSchema = z.object({
  placement: z.enum(["inline", "panel", "both"]),
  size: z.enum(["compact", "standard", "expanded"]),
}).strict()
export type UiArtifactPresentation = z.infer<typeof uiArtifactPresentationSchema>

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const uiArtifactCalendarEventSchema = z.object({
  id: compactTextSchema,
  title: compactTextSchema,
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  allDay: z.boolean().optional(),
  location: compactTextSchema.optional(),
  calendar: compactTextSchema.optional(),
  status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
  action: uiArtifactOpenUrlActionSchema.optional(),
}).strict()
const uiArtifactFocusWindowSchema = z.object({
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  label: compactTextSchema,
}).strict()

export const uiArtifactCalendarVariantSchema = z.enum(["day", "agenda", "week"])
export type UiArtifactCalendarVariant = z.infer<typeof uiArtifactCalendarVariantSchema>

export const uiArtifactCalendarDataSchema = z.object({
  variant: uiArtifactCalendarVariantSchema
    .describe("Use day for a single-day timeline, agenda for a chronological range, or week for date-grouped events."),
  startDate: calendarDateSchema,
  endDate: calendarDateSchema,
  timezone: compactTextSchema,
  events: z.array(uiArtifactCalendarEventSchema).max(50),
  focusWindow: uiArtifactFocusWindowSchema.optional(),
  action: uiArtifactOpenUrlActionSchema.optional(),
}).strict()
export type UiArtifactCalendarData = z.infer<typeof uiArtifactCalendarDataSchema>

export const uiArtifactCommunicationThreadDataSchema = z.object({
  workspace: compactTextSchema,
  channel: compactTextSchema,
  topic: compactTextSchema.optional(),
  unreadCount: z.number().int().nonnegative().optional(),
  messages: z.array(z.object({
    id: compactTextSchema,
    author: compactTextSchema,
    timestamp: isoDateTimeSchema,
    body: detailTextSchema,
    reactions: z.array(z.object({
      emoji: compactTextSchema,
      count: z.number().int().positive(),
    }).strict()).max(12).optional(),
  }).strict()).max(30),
  action: uiArtifactOpenUrlActionSchema.optional(),
}).strict()
export type UiArtifactCommunicationThreadData = z.infer<typeof uiArtifactCommunicationThreadDataSchema>

export const uiArtifactMailInboxDataSchema = z.object({
  account: compactTextSchema,
  folder: compactTextSchema,
  unreadCount: z.number().int().nonnegative(),
  messages: z.array(z.object({
    id: compactTextSchema,
    sender: compactTextSchema,
    senderEmail: z.string().email().optional(),
    subject: compactTextSchema,
    snippet: detailTextSchema,
    receivedAt: isoDateTimeSchema,
    unread: z.boolean(),
    labels: z.array(compactTextSchema).max(8).optional(),
    action: uiArtifactOpenUrlActionSchema.optional(),
  }).strict()).max(50),
  action: uiArtifactOpenUrlActionSchema.optional(),
}).strict()
export type UiArtifactMailInboxData = z.infer<typeof uiArtifactMailInboxDataSchema>

export const uiArtifactAttentionDataSchema = z.object({
  items: z.array(z.object({
    id: compactTextSchema,
    kind: z.enum(["incident", "approval", "task", "goal", "learning"]),
    title: compactTextSchema,
    description: detailTextSchema.optional(),
    priority: z.enum(["low", "normal", "high", "critical"]),
    source: compactTextSchema.optional(),
    dueAt: isoDateTimeSchema.optional(),
    action: uiArtifactOpenUrlActionSchema.optional(),
  }).strict()).max(50),
}).strict()
export type UiArtifactAttentionData = z.infer<typeof uiArtifactAttentionDataSchema>

export const uiArtifactWidgetToneSchema = z.enum(["neutral", "info", "success", "warning", "critical"])
const uiArtifactWidgetBaseShape = {
  id: compactTextSchema,
  label: compactTextSchema,
  detail: compactTextSchema.optional(),
  tone: uiArtifactWidgetToneSchema,
  action: uiArtifactOpenUrlActionSchema.optional(),
}

export const uiArtifactMetricWidgetSchema = z.object({
  ...uiArtifactWidgetBaseShape,
  kind: z.literal("metric"),
  value: compactTextSchema,
  trend: z.object({
    direction: z.enum(["up", "down", "flat"]),
    label: compactTextSchema,
  }).strict().optional(),
}).strict()

export const uiArtifactProgressWidgetSchema = z.object({
  ...uiArtifactWidgetBaseShape,
  kind: z.literal("progress"),
  value: compactTextSchema,
  progress: z.number().min(0).max(100),
}).strict()

export const uiArtifactStatusWidgetSchema = z.object({
  ...uiArtifactWidgetBaseShape,
  kind: z.literal("status"),
  value: compactTextSchema,
  status: z.enum(["healthy", "attention", "blocked", "offline"]),
}).strict()

export const uiArtifactBalanceWidgetSchema = z.object({
  ...uiArtifactWidgetBaseShape,
  kind: z.literal("balance"),
  value: compactTextSchema,
  unit: compactTextSchema.optional(),
}).strict()

export const uiArtifactDateWidgetSchema = z.object({
  ...uiArtifactWidgetBaseShape,
  kind: z.literal("date"),
  value: compactTextSchema,
  timestamp: isoDateTimeSchema.optional(),
}).strict()

export const uiArtifactWidgetSchema = z.discriminatedUnion("kind", [
  uiArtifactMetricWidgetSchema,
  uiArtifactProgressWidgetSchema,
  uiArtifactStatusWidgetSchema,
  uiArtifactBalanceWidgetSchema,
  uiArtifactDateWidgetSchema,
])
export type UiArtifactWidget = z.infer<typeof uiArtifactWidgetSchema>

export const uiArtifactWidgetsDataSchema = z.object({
  layout: z.enum(["grid", "strip", "stack"]),
  widgets: z.array(uiArtifactWidgetSchema).min(1).max(12)
    .describe("A composable list of independently typed widgets rendered together in one artifact."),
}).strict()
export type UiArtifactWidgetsData = z.infer<typeof uiArtifactWidgetsDataSchema>

const uiArtifactSummaryMetricSchema = z.object({
  id: compactTextSchema,
  label: compactTextSchema,
  value: compactTextSchema,
  detail: compactTextSchema.optional(),
  tone: uiArtifactWidgetToneSchema,
}).strict()
const uiArtifactProgressSummarySchema = z.object({
  id: compactTextSchema,
  label: compactTextSchema,
  value: compactTextSchema,
  detail: compactTextSchema.optional(),
  progress: z.number().min(0).max(100).optional(),
  tone: uiArtifactWidgetToneSchema,
  action: uiArtifactOpenUrlActionSchema.optional(),
}).strict()

export const uiArtifactApprovalsDataSchema = z.object({
  items: z.array(z.object({
    id: compactTextSchema,
    title: compactTextSchema,
    description: detailTextSchema.optional(),
    requestor: compactTextSchema,
    submittedAt: isoDateTimeSchema,
    dueAt: isoDateTimeSchema.optional(),
    amount: compactTextSchema.optional(),
    source: compactTextSchema,
    status: z.enum(["pending", "approved", "rejected"]),
    decidedAt: isoDateTimeSchema.optional(),
    decisionNote: compactTextSchema.optional(),
    actions: z.array(uiArtifactDecisionActionSchema).max(2).optional(),
  }).strict()).max(30),
}).strict()
export type UiArtifactApprovalsData = z.infer<typeof uiArtifactApprovalsDataSchema>

export const uiArtifactWorkspaceBriefDataSchema = z.object({
  summary: detailTextSchema,
  metrics: z.array(uiArtifactSummaryMetricSchema).min(1).max(8),
  schedule: z.array(uiArtifactCalendarEventSchema).max(8),
  attention: uiArtifactAttentionDataSchema.shape.items.max(8),
  progress: z.array(uiArtifactProgressSummarySchema).max(8),
  quickActions: z.array(uiArtifactOpenUrlActionSchema).max(6),
}).strict()
export type UiArtifactWorkspaceBriefData = z.infer<typeof uiArtifactWorkspaceBriefDataSchema>

const uiArtifactBaseShape = {
  instanceId: z.string().trim().min(1).max(128),
  revision: z.number().int().positive(),
  operation: z.enum(["create", "replace"]),
  title: compactTextSchema,
  subtitle: compactTextSchema.optional(),
  presentation: uiArtifactPresentationSchema,
  source: uiArtifactSourceSchema,
}

export const uiArtifactCalendarSchema = z.object({
  ...uiArtifactBaseShape,
  artifactId: z.literal("calendar.view"),
  data: uiArtifactCalendarDataSchema,
}).strict()

export const uiArtifactWidgetsSchema = z.object({
  ...uiArtifactBaseShape,
  artifactId: z.literal("widgets.collection"),
  data: uiArtifactWidgetsDataSchema,
}).strict()

export const uiArtifactCommunicationThreadSchema = z.object({
  ...uiArtifactBaseShape,
  artifactId: z.literal("communication.thread"),
  data: uiArtifactCommunicationThreadDataSchema,
}).strict()

export const uiArtifactMailInboxSchema = z.object({
  ...uiArtifactBaseShape,
  artifactId: z.literal("mail.inbox"),
  data: uiArtifactMailInboxDataSchema,
}).strict()

export const uiArtifactAttentionSchema = z.object({
  ...uiArtifactBaseShape,
  artifactId: z.literal("work.attention"),
  data: uiArtifactAttentionDataSchema,
}).strict()

export const uiArtifactApprovalsSchema = z.object({
  ...uiArtifactBaseShape,
  artifactId: z.literal("work.approvals"),
  data: uiArtifactApprovalsDataSchema,
}).strict()

export const uiArtifactWorkspaceBriefSchema = z.object({
  ...uiArtifactBaseShape,
  artifactId: z.literal("workspace.brief"),
  data: uiArtifactWorkspaceBriefDataSchema,
}).strict()

export const uiArtifactPayloadSchema = z.discriminatedUnion("artifactId", [
  uiArtifactWorkspaceBriefSchema,
  uiArtifactCalendarSchema,
  uiArtifactWidgetsSchema,
  uiArtifactCommunicationThreadSchema,
  uiArtifactMailInboxSchema,
  uiArtifactAttentionSchema,
  uiArtifactApprovalsSchema,
])
export type UiArtifactPayload = z.infer<typeof uiArtifactPayloadSchema>

export const uiArtifactSchemaDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export type UiArtifactSchemaDigest = z.infer<typeof uiArtifactSchemaDigestSchema>

/**
 * The always-registered render tool deliberately keeps `artifact` unknown.
 * `search_artifacts` returns the selected strict schema and digest; the render
 * runtime resolves that definition and validates the payload before rendering.
 */
export const uiArtifactRenderInputSchema = z.object({
  artifactId: uiArtifactKindSchema,
  artifactVersion: z.literal(UI_ARTIFACT_SCHEMA_VERSION),
  schemaDigest: uiArtifactSchemaDigestSchema,
  artifact: z.unknown(),
}).strict()
export type UiArtifactRenderInput = z.infer<typeof uiArtifactRenderInputSchema>

export const uiArtifactDecisionInputSchema = z.object({
  operation: z.literal("decide"),
  artifactId: z.literal("work.approvals"),
  instanceId: z.string().trim().min(1).max(128),
  itemId: compactTextSchema,
  decision: z.enum(["approve", "reject"]),
  expectedRevision: z.number().int().positive(),
  note: compactTextSchema.optional(),
}).strict()
export type UiArtifactDecisionInput = z.infer<typeof uiArtifactDecisionInputSchema>

export const uiArtifactUseInputSchema = z.union([
  uiArtifactRenderInputSchema,
  uiArtifactDecisionInputSchema,
])
export type UiArtifactUseInput = z.infer<typeof uiArtifactUseInputSchema>

export const uiArtifactSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500)
    .describe("What the user wants to see, such as 'today's calendar' or 'Slack launch thread'."),
  signal: z.object({
    toolName: z.string().trim().min(1).max(200),
    toolTitle: z.string().trim().min(1).max(300).optional(),
    toolDescription: z.string().trim().min(1).max(1_000).optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }).strict().optional().describe("Optional metadata from the data tool that triggered artifact discovery."),
  enabledArtifactIds: z.array(uiArtifactKindSchema).max(UI_ARTIFACT_KINDS.length).optional()
    .describe("Limit results to the UI artifact kinds enabled by the user."),
  limit: z.number().int().min(1).max(5).default(3),
}).strict()
export type UiArtifactSearchInput = z.infer<typeof uiArtifactSearchInputSchema>

export const uiArtifactToolDefinitionSchema = z.object({
  name: z.enum(["use_artifact", "render_artifact", "execute_capability"]),
  title: z.string(),
  description: z.string(),
  artifactVersion: z.literal(UI_ARTIFACT_SCHEMA_VERSION),
  schemaDigest: uiArtifactSchemaDigestSchema,
  inputSchema: z.record(z.string(), z.unknown()),
  invocation: z.discriminatedUnion("toolName", [
    z.object({
      toolName: z.enum(["use_artifact", "render_artifact"]),
      argumentsField: z.literal("artifact"),
    }).strict(),
    z.object({
      toolName: z.literal("execute_capability"),
      capability: z.enum([UI_ARTIFACT_USE_CAPABILITY, UI_ARTIFACT_RENDER_CAPABILITY]),
      argumentsField: z.literal("body"),
    }).strict(),
  ]),
  exampleArguments: uiArtifactRenderInputSchema,
}).strict()
export type UiArtifactToolDefinition = z.infer<typeof uiArtifactToolDefinitionSchema>

export const uiArtifactSearchResultSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-search"),
  schemaVersion: z.literal(UI_ARTIFACT_SCHEMA_VERSION),
  query: z.string(),
  matches: z.array(z.object({
    artifactId: uiArtifactKindSchema,
    title: z.string(),
    description: z.string(),
    score: z.number().int().nonnegative(),
    reasons: z.array(z.string()),
    toolDefinition: uiArtifactToolDefinitionSchema,
  }).strict()),
}).strict()
export type UiArtifactSearchResult = z.infer<typeof uiArtifactSearchResultSchema>

export const uiArtifactSuggestionEnvelopeSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-suggestions"),
  schemaVersion: z.literal(UI_ARTIFACT_SCHEMA_VERSION),
  agentInstruction: z.string().trim().min(1).max(1_200),
  trigger: z.object({
    capability: z.string().trim().min(1).max(500),
  }).strict(),
  contextPolicy: z.object({
    selection: z.literal("optional"),
    maxRendersThisTurn: z.literal(1),
    expires: z.literal("end_of_turn"),
    dedupeKey: compactTextSchema,
    includesSourceValues: z.literal(false),
  }).strict(),
  suggestions: z.array(z.object({
    artifactId: uiArtifactKindSchema,
    title: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(1).max(300),
    invocation: z.object({
      toolName: z.literal("execute_capability"),
      arguments: z.object({
        name: z.literal(UI_ARTIFACT_SEARCH_CAPABILITY),
        body: uiArtifactSearchInputSchema.omit({ enabledArtifactIds: true }),
      }).strict(),
    }).strict(),
  }).strict()).max(3),
}).strict()
export type UiArtifactSuggestionEnvelope = z.infer<typeof uiArtifactSuggestionEnvelopeSchema>

export const uiArtifactRenderResultSchema = z.object({
  protocol: z.literal(UI_ARTIFACT_PROTOCOL),
  schemaVersion: z.literal(UI_ARTIFACT_SCHEMA_VERSION),
  status: z.literal("rendered"),
  artifact: uiArtifactPayloadSchema,
  narration: z.object({
    summary: detailTextSchema,
    visibleFacts: z.array(compactTextSchema).max(8),
  }).strict(),
  interaction: z.object({
    type: z.literal("decision"),
    itemId: compactTextSchema,
    decision: z.enum(["approve", "reject"]),
    previousRevision: z.number().int().positive(),
    revision: z.number().int().positive(),
  }).strict().optional(),
}).strict()
export type UiArtifactRenderResult = z.infer<typeof uiArtifactRenderResultSchema>

export const uiArtifactErrorCodeSchema = z.enum([
  "invalid_search_input",
  "unknown_artifact",
  "artifact_disabled",
  "renderer_unsupported",
  "schema_digest_mismatch",
  "invalid_artifact_payload",
  "payload_too_large",
  "unsafe_action",
  "source_receipt_required",
  "source_receipt_invalid",
  "manifest_changed",
  "operation_unsupported",
  "revision_conflict",
  "state_not_found",
  "action_not_allowed",
  "internal_error",
])
export type UiArtifactErrorCode = z.infer<typeof uiArtifactErrorCodeSchema>

export const uiArtifactErrorSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-error"),
  schemaVersion: z.literal(UI_ARTIFACT_SCHEMA_VERSION),
  code: uiArtifactErrorCodeSchema,
  message: z.string().trim().min(1).max(500),
  retry: z.object({
    action: z.enum(["search_artifacts", "use_artifact", "render_artifact", "refresh_source", "none"]),
    changedArgumentsRequired: z.boolean(),
  }).strict(),
}).strict()
export type UiArtifactError = z.infer<typeof uiArtifactErrorSchema>
