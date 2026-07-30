import { z } from "zod"
import {
  UI_ARTIFACT_RENDER_CAPABILITY,
  UI_ARTIFACT_SCHEMA_VERSION,
  UI_ARTIFACT_SEARCH_CAPABILITY,
  UI_ARTIFACT_USE_CAPABILITY,
  uiArtifactErrorSchema,
  uiArtifactRenderInputSchema,
  uiArtifactRenderResultSchema,
  uiArtifactSearchInputSchema,
  uiArtifactSuggestionEnvelopeSchema,
  uiArtifactUseInputSchema,
  type UiArtifactErrorCode,
  type UiArtifactPreferences,
} from "@openwork/types/ui-artifact"
import {
  searchArtifacts,
  UiArtifactMockStore,
} from "@openwork/ui-artifact-mcp"
import type { CapabilityMatch } from "./search.js"

type CapabilityToolResult = {
  isError?: boolean
  content: { text: string; type: "text" }[]
  structuredContent?: Record<string, unknown>
}

const managedSearchInputSchema = uiArtifactSearchInputSchema.omit({
  enabledArtifactIds: true,
})

const virtualCapabilityDefinitions = [
  {
    name: UI_ARTIFACT_SEARCH_CAPABILITY,
    summary: "Search the enabled OpenWork UI artifact catalog and return a strict use capability definition.",
    bodySchema: z.toJSONSchema(managedSearchInputSchema),
    keywords: ["artifact", "widget", "card", "render", "visual"],
  },
  {
    name: UI_ARTIFACT_USE_CAPABILITY,
    summary: "Render an exact searched UI artifact or apply an explicit revision-safe decision to a mock approval.",
    bodySchema: z.toJSONSchema(uiArtifactUseInputSchema),
    keywords: ["artifact", "widget", "card", "render", "visual", "preview", "approval", "approve", "reject"],
  },
] as const

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("en-US")
}

function textContent(value: unknown) {
  return [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }]
}

function virtualCapabilityMatch(
  definition: typeof virtualCapabilityDefinitions[number],
  query: string,
): CapabilityMatch {
  const normalizedQuery = normalize(query)
  const matchedKeywords = definition.keywords.filter((keyword) => normalizedQuery.includes(keyword))
  return {
    name: definition.name,
    method: "VIRTUAL",
    path: "openwork://ui-artifacts",
    score: Math.max(1, 80 + matchedKeywords.length * 10),
    summary: definition.summary,
    pathParams: [],
    queryParams: [],
    hasBody: true,
    bodySchema: definition.bodySchema,
  }
}

export function searchUiArtifactCapabilities(
  query: string,
  limit: number,
  preferences: UiArtifactPreferences,
): CapabilityMatch[] {
  if (!preferences.enabled || preferences.enabledArtifactIds.length === 0) return []
  const normalizedQuery = normalize(query)
  return virtualCapabilityDefinitions
    .filter((definition) => (
      normalizedQuery.includes(normalize(definition.name))
      || definition.keywords.some((keyword) => normalizedQuery.includes(keyword))
    ))
    .map((definition) => virtualCapabilityMatch(definition, query))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, Math.max(0, limit))
}

function artifactError(code: UiArtifactErrorCode, message: string): CapabilityToolResult {
  const retry = (() => {
    switch (code) {
      case "schema_digest_mismatch":
      case "manifest_changed":
      case "unknown_artifact":
      case "artifact_disabled":
        return { action: "search_artifacts" as const, changedArgumentsRequired: true }
      case "invalid_artifact_payload":
      case "unsafe_action":
      case "source_receipt_required":
      case "source_receipt_invalid":
      case "operation_unsupported":
      case "revision_conflict":
      case "state_not_found":
      case "action_not_allowed":
        return { action: "use_artifact" as const, changedArgumentsRequired: true }
      default:
        return { action: "none" as const, changedArgumentsRequired: false }
    }
  })()
  const payload = uiArtifactErrorSchema.parse({
    protocol: "openwork.ui-artifact-error",
    schemaVersion: UI_ARTIFACT_SCHEMA_VERSION,
    code,
    message,
    retry,
  })
  return { isError: true, content: textContent(payload), structuredContent: payload }
}

export function isUiArtifactCapability(name: string) {
  return name === UI_ARTIFACT_SEARCH_CAPABILITY
    || name === UI_ARTIFACT_USE_CAPABILITY
    || name === UI_ARTIFACT_RENDER_CAPABILITY
}

const MAX_SCOPED_MOCK_STORES = 250
const scopedMockStores = new Map<string, UiArtifactMockStore>()

function mockStoreFor(scope: string) {
  const current = scopedMockStores.get(scope)
  if (current) return current
  if (scopedMockStores.size >= MAX_SCOPED_MOCK_STORES) {
    const oldest = scopedMockStores.keys().next().value
    if (typeof oldest === "string") scopedMockStores.delete(oldest)
  }
  const created = new UiArtifactMockStore()
  scopedMockStores.set(scope, created)
  return created
}

export function executeUiArtifactCapability(input: {
  name: string
  body: unknown
  preferences: UiArtifactPreferences
  stateScope: string
}): CapabilityToolResult | null {
  if (!isUiArtifactCapability(input.name)) return null
  if (!input.preferences.enabled) {
    return artifactError("artifact_disabled", "UI artifacts are disabled for this OpenWork member.")
  }

  if (input.name === UI_ARTIFACT_SEARCH_CAPABILITY) {
    const parsed = managedSearchInputSchema.safeParse(input.body)
    if (!parsed.success) {
      return artifactError("invalid_search_input", "The UI artifact search input is invalid.")
    }
    const result = searchArtifacts({
      ...parsed.data,
      enabledArtifactIds: input.preferences.enabledArtifactIds,
    }, { transport: "execute_capability" })
    return { content: textContent(result), structuredContent: result }
  }

  const parsed = input.name === UI_ARTIFACT_RENDER_CAPABILITY
    ? uiArtifactRenderInputSchema.safeParse(input.body)
    : uiArtifactUseInputSchema.safeParse(input.body)
  if (!parsed.success) {
    return artifactError("invalid_artifact_payload", "The UI artifact use input is invalid.")
  }
  const artifactId = "artifactId" in parsed.data ? parsed.data.artifactId : "work.approvals"
  if (!input.preferences.enabledArtifactIds.includes(artifactId)) {
    return artifactError("artifact_disabled", `${artifactId} is disabled for this OpenWork member.`)
  }
  const resolved = mockStoreFor(input.stateScope).use(parsed.data)
  if (!resolved.ok) return artifactError(resolved.code, resolved.message)
  const result = uiArtifactRenderResultSchema.parse(resolved.result)
  return { content: textContent(result), structuredContent: result }
}

function presentArgumentKeys(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const keys = Object.keys(value).slice(0, 40)
  return Object.fromEntries(keys.map((key) => [key, "<present>"]))
}

export function suggestUiArtifactForCapability(input: {
  capability: string
  title?: string
  description?: string
  path?: unknown
  query?: unknown
  body?: unknown
  preferences: UiArtifactPreferences
}) {
  if (!input.preferences.enabled || isUiArtifactCapability(input.capability)) return null
  const argumentsShape = {
    ...(presentArgumentKeys(input.path) ? { path: presentArgumentKeys(input.path) } : {}),
    ...(presentArgumentKeys(input.query) ? { query: presentArgumentKeys(input.query) } : {}),
    ...(presentArgumentKeys(input.body) ? { body: presentArgumentKeys(input.body) } : {}),
  }
  const result = searchArtifacts({
    query: `Native UI for ${input.capability}`,
    signal: {
      toolName: input.capability,
      ...(input.title ? { toolTitle: input.title } : {}),
      ...(input.description ? { toolDescription: input.description } : {}),
      ...(Object.keys(argumentsShape).length ? { arguments: argumentsShape } : {}),
    },
    enabledArtifactIds: input.preferences.enabledArtifactIds,
    limit: 1,
  }, { transport: "execute_capability" })
  const match = result.matches[0]
  if (!match) return null

  return uiArtifactSuggestionEnvelopeSchema.parse({
    protocol: "openwork.ui-artifact-suggestions",
    schemaVersion: UI_ARTIFACT_SCHEMA_VERSION,
    agentInstruction: [
      "This optional UI enhancement expires at the end of the current turn.",
      "Render at most one suggestion and skip duplicate dedupeKey values.",
      "If it materially improves the answer, follow the returned invocation once, then use the exact searched schema digest and example body.",
      "The alpha example is mock data: never replace its payload with provider values or imply it is live.",
      "After rendering, use narration.summary and only decision-relevant visibleFacts; never infer or execute an approval decision without the user's explicit choice.",
    ].join(" "),
    trigger: { capability: input.capability },
    contextPolicy: {
      selection: "optional",
      maxRendersThisTurn: 1,
      expires: "end_of_turn",
      dedupeKey: `${input.capability}:${match.artifactId}`.slice(0, 160),
      includesSourceValues: false,
    },
    suggestions: [{
      artifactId: match.artifactId,
      title: match.title,
      reason: match.reasons.join("; ").slice(0, 300) || `Matched ${input.capability}`,
      invocation: {
        toolName: "execute_capability",
        arguments: {
          name: UI_ARTIFACT_SEARCH_CAPABILITY,
          body: {
            query: `Render the best native artifact for ${input.capability}`,
            signal: {
              toolName: input.capability,
              ...(input.title ? { toolTitle: input.title } : {}),
              ...(input.description ? { toolDescription: input.description } : {}),
              ...(Object.keys(argumentsShape).length ? { arguments: argumentsShape } : {}),
            },
            limit: 1,
          },
        },
      },
    }],
  })
}

export function appendUiArtifactSuggestion(
  result: CapabilityToolResult,
  suggestion: ReturnType<typeof suggestUiArtifactForCapability>,
): CapabilityToolResult {
  if (result.isError || !suggestion) return result
  return {
    ...result,
    content: [
      ...result.content,
      ...textContent({ uiArtifactSuggestions: suggestion }),
    ],
  }
}
