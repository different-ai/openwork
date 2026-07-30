import {
  UI_ARTIFACT_RENDER_CAPABILITY,
  UI_ARTIFACT_USE_CAPABILITY,
  UI_ARTIFACT_MAX_JSON_BYTES,
  uiArtifactRenderResultSchema,
  type UiArtifactRenderResult,
  type UiArtifactAction,
} from "@openwork/types/ui-artifact"
import type { UIMessage } from "ai"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJsonText(value: string): unknown {
  if (new TextEncoder().encode(value).byteLength > UI_ARTIFACT_MAX_JSON_BYTES) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch {
    return null
  }
}

function isWithinJsonLimit(value: unknown) {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value)
    return typeof serialized === "string"
      && new TextEncoder().encode(serialized).byteLength <= UI_ARTIFACT_MAX_JSON_BYTES
  } catch {
    return false
  }
}

function textContentPayload(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.content)) return null

  for (const item of value.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue
    const parsed = parseJsonText(item.text)
    if (parsed !== null) return parsed
  }

  return null
}

export function isUiArtifactRenderToolName(toolName: string) {
  const normalized = toolName.trim().toLocaleLowerCase("en-US")
  return new Set([
    "render_artifact",
    "use_artifact",
    "ui-artifacts-demo_render_artifact",
    "ui-artifacts-demo_use_artifact",
    "openwork-ui-artifacts-demo_render_artifact",
    "openwork-ui-artifacts-demo_use_artifact",
  ]).has(normalized)
}

export function isUiArtifactRenderInvocation(toolName: string, input: unknown) {
  if (isUiArtifactRenderToolName(toolName)) return true
  const normalized = toolName.trim().toLocaleLowerCase("en-US")
  if (!new Set([
    "execute_capability",
    "openwork-cloud_execute_capability",
  ]).has(normalized)) {
    return false
  }
  return isRecord(input)
    && (input.name === UI_ARTIFACT_USE_CAPABILITY || input.name === UI_ARTIFACT_RENDER_CAPABILITY)
}

export function buildUiArtifactDecisionPrompt(
  action: Extract<UiArtifactAction, { type: "request_decision" }>,
) {
  const body = {
    operation: "decide",
    artifactId: "work.approvals",
    instanceId: action.instanceId,
    itemId: action.itemId,
    decision: action.decision,
    expectedRevision: action.expectedRevision,
  }
  const verb = action.decision === "approve" ? "Approve" : "Reject"
  return [
    `${verb} the selected UI Artifacts mock approval.`,
    `Search for and execute "${UI_ARTIFACT_USE_CAPABILITY}" with this minimal body: ${JSON.stringify(body)}.`,
    "Mock only: Do not call a provider approval tool or infer any other decision.",
  ].join(" ")
}

export function parseUiArtifactRenderResult(value: unknown): UiArtifactRenderResult | null {
  const candidates: unknown[] = [value]

  if (typeof value === "string") {
    candidates.push(parseJsonText(value))
  }

  if (isRecord(value)) {
    candidates.push(value.structuredContent, value.result, textContentPayload(value))
    if (typeof value.output === "string") {
      candidates.push(parseJsonText(value.output))
    }
  }

  for (const candidate of candidates) {
    if (!isWithinJsonLimit(candidate)) continue
    const parsed = uiArtifactRenderResultSchema.safeParse(candidate)
    if (parsed.success) return parsed.data
  }

  return null
}

export function reconcileUiArtifactMessages(messages: UIMessage[]) {
  const latest = new Map<string, { messageIndex: number; partIndex: number; revision: number }>()

  messages.forEach((message, messageIndex) => {
    message.parts.forEach((part, partIndex) => {
      if (
        part.type !== "dynamic-tool"
        || part.state !== "output-available"
        || !isUiArtifactRenderInvocation(part.toolName, part.input)
      ) {
        return
      }
      const result = parseUiArtifactRenderResult(part.output)
      if (!result) return
      const key = result.artifact.instanceId
      const current = latest.get(key)
      if (!current || result.artifact.revision >= current.revision) {
        latest.set(key, { messageIndex, partIndex, revision: result.artifact.revision })
      }
    })
  })

  let changed = false
  const reconciled = messages.map((message, messageIndex) => {
    const parts = message.parts.filter((part, partIndex) => {
      if (
        part.type !== "dynamic-tool"
        || part.state !== "output-available"
        || !isUiArtifactRenderInvocation(part.toolName, part.input)
      ) {
        return true
      }
      const result = parseUiArtifactRenderResult(part.output)
      if (!result) return true
      const current = latest.get(result.artifact.instanceId)
      const keep = current?.messageIndex === messageIndex && current.partIndex === partIndex
      if (!keep) changed = true
      return keep
    })
    return parts.length === message.parts.length ? message : { ...message, parts }
  })

  return changed ? reconciled : messages
}
