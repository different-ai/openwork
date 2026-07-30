import { createHash } from "node:crypto"
import { z } from "zod"
import {
  UI_ARTIFACT_KINDS,
  UI_ARTIFACT_SCHEMA_VERSION,
  uiArtifactApprovalsSchema,
  uiArtifactAttentionSchema,
  uiArtifactCalendarSchema,
  uiArtifactCommunicationThreadSchema,
  uiArtifactMailInboxSchema,
  uiArtifactPayloadSchema,
  uiArtifactSearchInputSchema,
  uiArtifactSearchResultSchema,
  uiArtifactWidgetsSchema,
  uiArtifactWorkspaceBriefSchema,
  type UiArtifactErrorCode,
  type UiArtifactKind,
  type UiArtifactPayload,
  type UiArtifactRenderInput,
  type UiArtifactSearchInput,
  type UiArtifactSearchResult,
} from "@openwork/types/ui-artifact"
import {
  APPROVALS_EXAMPLE,
  ATTENTION_EXAMPLE,
  CALENDAR_EXAMPLE,
  COMMUNICATION_THREAD_EXAMPLE,
  MAIL_INBOX_EXAMPLE,
  WIDGETS_EXAMPLE,
  WORKSPACE_BRIEF_EXAMPLE,
} from "./fixtures.js"

export const searchArtifactsInputSchema = uiArtifactSearchInputSchema
export const searchArtifactsResultSchema = uiArtifactSearchResultSchema
export type SearchArtifactsInput = UiArtifactSearchInput
export type SearchArtifactsResult = UiArtifactSearchResult

type ArtifactDefinition = {
  artifactId: UiArtifactKind
  title: string
  description: string
  keywords: readonly string[]
  example: UiArtifactPayload
  payloadSchema: z.ZodType
}

const CATALOG: readonly ArtifactDefinition[] = [
  {
    artifactId: "workspace.brief",
    title: "Workspace brief",
    description: "A complete chat-native work dashboard with metrics, schedule, attention items, progress widgets, and quick actions.",
    keywords: ["dashboard", "home", "workspace", "brief", "morning", "today", "overview", "everything", "at a glance", "quick actions"],
    example: WORKSPACE_BRIEF_EXAMPLE,
    payloadSchema: uiArtifactWorkspaceBriefSchema,
  },
  {
    artifactId: "calendar.view",
    title: "Calendar",
    description: "A calendar artifact with day, chronological agenda, and date-grouped week variants.",
    keywords: ["calendar", "agenda", "day", "week", "events", "meetings", "schedule", "google calendar", "outlook calendar", "availability", "today"],
    example: CALENDAR_EXAMPLE,
    payloadSchema: uiArtifactCalendarSchema,
  },
  {
    artifactId: "widgets.collection",
    title: "Widgets",
    description: "A composable collection of metric, progress, status, balance, and date widgets in grid, strip, or stack layouts.",
    keywords: ["widget", "widgets", "metrics", "progress", "status", "goals", "learning", "payroll", "payslip", "leave", "balance", "summary", "glance"],
    example: WIDGETS_EXAMPLE,
    payloadSchema: uiArtifactWidgetsSchema,
  },
  {
    artifactId: "communication.thread",
    title: "Conversation thread",
    description: "A compact Slack, Teams, or Google Chat thread with participants, messages, reactions, and unread context.",
    keywords: ["slack", "teams", "google chat", "conversation", "thread", "channel", "messages", "replies", "chat"],
    example: COMMUNICATION_THREAD_EXAMPLE,
    payloadSchema: uiArtifactCommunicationThreadSchema,
  },
  {
    artifactId: "mail.inbox",
    title: "Priority inbox",
    description: "A Gmail or Outlook inbox preview focused on unread or reply-worthy messages.",
    keywords: ["gmail", "outlook", "mail", "email", "inbox", "messages", "replies", "unread", "sender"],
    example: MAIL_INBOX_EXAMPLE,
    payloadSchema: uiArtifactMailInboxSchema,
  },
  {
    artifactId: "work.attention",
    title: "Attention queue",
    description: "A cross-source list of incidents, approvals, tasks, goals, and learning items that need attention.",
    keywords: ["attention", "incident", "approval", "task", "goal", "learning", "critical", "overdue", "servicenow", "workday"],
    example: ATTENTION_EXAMPLE,
    payloadSchema: uiArtifactAttentionSchema,
  },
  {
    artifactId: "work.approvals",
    title: "Approval queue",
    description: "A stateful queue of mock approvals with revision-safe approve and reject decisions.",
    keywords: ["approval", "approvals", "approve", "reject", "decision", "expense", "access request", "workday", "servicenow"],
    example: APPROVALS_EXAMPLE,
    payloadSchema: uiArtifactApprovalsSchema,
  },
]

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("en-US")
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function schemaDigest(value: Record<string, unknown>) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`
}

function renderContract(definition: ArtifactDefinition) {
  const payloadJsonSchema = z.toJSONSchema(definition.payloadSchema) as Record<string, unknown>
  const digest = schemaDigest(payloadJsonSchema)
  const inputSchema = z.toJSONSchema(z.object({
    artifactId: z.literal(definition.artifactId),
    artifactVersion: z.literal(UI_ARTIFACT_SCHEMA_VERSION),
    schemaDigest: z.literal(digest),
    artifact: definition.payloadSchema,
  }).strict()) as Record<string, unknown>
  return { digest, inputSchema }
}

const MOCK_ACTION_HOSTS = new Set([
  "app.slack.com",
  "calendar.google.com",
  "mail.google.com",
])

function unsafeMockAction(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const issue = unsafeMockAction(child)
      if (issue) return issue
    }
    return null
  }
  if (!value || typeof value !== "object") return null

  const record = value as Record<string, unknown>
  if (record.type === "open_url" && typeof record.url === "string") {
    try {
      const url = new URL(record.url)
      if (
        url.protocol !== "https:"
        || Boolean(url.username)
        || Boolean(url.password)
        || !MOCK_ACTION_HOSTS.has(url.hostname)
      ) {
        return `The mock action host is not allowlisted: ${url.hostname || "unknown"}`
      }
    } catch {
      return "The mock action URL is invalid"
    }
  }

  for (const child of Object.values(record)) {
    const issue = unsafeMockAction(child)
    if (issue) return issue
  }
  return null
}

export type RenderArtifactResolution =
  | { ok: true; artifact: UiArtifactPayload }
  | { ok: false; code: UiArtifactErrorCode; message: string }

export function resolveRenderArtifactInput(input: UiArtifactRenderInput): RenderArtifactResolution {
  const definition = CATALOG.find((candidate) => candidate.artifactId === input.artifactId)
  if (!definition) {
    return { ok: false, code: "unknown_artifact", message: `Unknown UI artifact: ${input.artifactId}` }
  }

  if (input.artifactVersion !== UI_ARTIFACT_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "renderer_unsupported",
      message: `Unsupported ${input.artifactId} artifact version: ${input.artifactVersion}`,
    }
  }

  const contract = renderContract(definition)
  if (input.schemaDigest !== contract.digest) {
    return {
      ok: false,
      code: "schema_digest_mismatch",
      message: "The artifact schema changed after discovery. Search artifacts again before rendering.",
    }
  }

  const payload = definition.payloadSchema.safeParse(input.artifact)
  if (!payload.success) {
    return {
      ok: false,
      code: "invalid_artifact_payload",
      message: `The payload does not match the searched ${definition.artifactId} schema.`,
    }
  }
  const parsed = uiArtifactPayloadSchema.safeParse(payload.data)
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_artifact_payload",
      message: "The payload is not a supported UI artifact envelope.",
    }
  }
  if (parsed.data.source.type !== "mock") {
    return {
      ok: false,
      code: "source_receipt_required",
      message: "The demo MCP accepts only visibly marked mock sources. Live provider data requires a host-issued provenance receipt.",
    }
  }
  if (parsed.data.operation !== "create") {
    return {
      ok: false,
      code: "operation_unsupported",
      message: "The demo MCP supports immutable create operations only.",
    }
  }
  if (parsed.data.presentation.placement === "panel") {
    return {
      ok: false,
      code: "renderer_unsupported",
      message: "The demo MCP requires inline or both placement because expanded instance rendering is not implemented.",
    }
  }
  const actionIssue = unsafeMockAction(parsed.data)
  if (actionIssue) {
    return { ok: false, code: "unsafe_action", message: actionIssue }
  }

  return { ok: true, artifact: parsed.data }
}

function tokens(value: string) {
  return new Set(normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [])
}

function boundedArguments(value: Record<string, unknown> | undefined) {
  if (!value) return ""
  try {
    return JSON.stringify(value).slice(0, 4_000)
  } catch {
    return ""
  }
}

function rankDefinition(definition: ArtifactDefinition, input: SearchArtifactsInput) {
  const query = normalize(input.query)
  const signalText = input.signal
    ? [
        input.signal.toolName,
        input.signal.toolTitle,
        input.signal.toolDescription,
        boundedArguments(input.signal.arguments),
      ].filter((value): value is string => typeof value === "string").join(" ")
    : ""
  const haystack = normalize(`${query} ${signalText}`)
  const queryTokens = tokens(`${query} ${signalText}`)
  const definitionText = normalize([
    definition.artifactId,
    definition.title,
    definition.description,
    ...definition.keywords,
  ].join(" "))
  const definitionTokens = tokens(definitionText)
  const reasons: string[] = []
  let score = 0

  if (haystack.includes(normalize(definition.artifactId))) {
    score += 40
    reasons.push(`matched ${definition.artifactId}`)
  }

  if (haystack.includes(normalize(definition.title))) {
    score += 30
    reasons.push(`matched title "${definition.title}"`)
  }

  const matchedKeywords = definition.keywords.filter((keyword) => haystack.includes(normalize(keyword)))
  if (matchedKeywords.length > 0) {
    score += Math.min(60, matchedKeywords.length * 15)
    reasons.push(`matched ${matchedKeywords.slice(0, 3).join(", ")}`)
  }

  let tokenMatches = 0
  for (const token of queryTokens) {
    if (definitionTokens.has(token)) tokenMatches += 1
  }
  score += Math.min(30, tokenMatches * 3)

  if (input.signal && score > 0) {
    score += 5
    reasons.push(`suggested from ${input.signal.toolName}`)
  }

  return { score, reasons }
}

export function searchArtifacts(
  input: SearchArtifactsInput,
  options: { transport?: "direct" | "execute_capability" } = {},
): SearchArtifactsResult {
  const transport = options.transport ?? "direct"
  const enabled = new Set(input.enabledArtifactIds ?? UI_ARTIFACT_KINDS)
  const matches = CATALOG
    .filter((definition) => enabled.has(definition.artifactId))
    .map((definition) => {
      const ranking = rankDefinition(definition, input)
      return { definition, ...ranking }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.definition.artifactId.localeCompare(right.definition.artifactId))
    .slice(0, input.limit)
    .map(({ definition, score, reasons }) => {
      const contract = renderContract(definition)
      return {
        artifactId: definition.artifactId,
        title: definition.title,
        description: definition.description,
        score,
        reasons,
        toolDefinition: {
          name: transport === "execute_capability" ? "execute_capability" as const : "use_artifact" as const,
          title: `Render ${definition.title}`,
          description: `Render a native OpenWork ${definition.title.toLocaleLowerCase("en-US")} UI artifact in the chat transcript.`,
          artifactVersion: UI_ARTIFACT_SCHEMA_VERSION as "1",
          schemaDigest: contract.digest,
          inputSchema: contract.inputSchema,
          invocation: transport === "execute_capability"
            ? {
                toolName: "execute_capability" as const,
                capability: "openwork.ui_artifacts.use" as const,
                argumentsField: "body" as const,
              }
            : {
                toolName: "use_artifact" as const,
                argumentsField: "artifact" as const,
              },
          exampleArguments: {
            artifactId: definition.artifactId,
            artifactVersion: UI_ARTIFACT_SCHEMA_VERSION as "1",
            schemaDigest: contract.digest,
            artifact: definition.example,
          },
        },
      }
    })

  return {
    protocol: "openwork.ui-artifact-search",
    schemaVersion: "1",
    query: input.query,
    matches,
  }
}
