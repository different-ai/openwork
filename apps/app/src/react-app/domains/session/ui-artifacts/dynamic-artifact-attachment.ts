import {
  UI_ARTIFACT_MAX_MANIFEST_BYTES,
  uiArtifactAttachmentSchema,
  type UiArtifactAttachment,
  type UiArtifactInstanceState,
} from "@openwork/types/ui-artifact-project"

const MAX_ATTACHMENT_ENVELOPE_BYTES = UI_ARTIFACT_MAX_MANIFEST_BYTES * 2
const MAX_ATTACHMENT_SEARCH_DEPTH = 5
const MAX_ATTACHMENT_SEARCH_NODES = 24
const ATTACHMENT_WRAPPER_KEYS: ReadonlyArray<"attachment" | "result" | "structuredContent"> = [
  "structuredContent",
  "result",
  "attachment",
]

function serializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function parseJsonText(value: string): unknown {
  if (new TextEncoder().encode(value).byteLength > MAX_ATTACHMENT_ENVELOPE_BYTES) {
    return null
  }

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function parseUiArtifactAttachment(value: unknown): UiArtifactAttachment | null {
  if (serializedByteLength(value) > MAX_ATTACHMENT_ENVELOPE_BYTES) {
    return null
  }

  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let visited = 0

  while (queue.length > 0 && visited < MAX_ATTACHMENT_SEARCH_NODES) {
    const candidate = queue.shift()
    if (!candidate) {
      break
    }
    visited += 1

    const parsed = uiArtifactAttachmentSchema.safeParse(candidate.value)
    if (parsed.success) {
      return parsed.data
    }
    if (candidate.depth >= MAX_ATTACHMENT_SEARCH_DEPTH) {
      continue
    }

    if (typeof candidate.value === "string") {
      const json = parseJsonText(candidate.value)
      if (json !== null) {
        queue.push({ value: json, depth: candidate.depth + 1 })
      }
      continue
    }
    if (!candidate.value || typeof candidate.value !== "object") {
      continue
    }
    const record = candidate.value as Record<string, unknown>
    if (seen.has(record)) {
      continue
    }
    seen.add(record)

    for (const key of ATTACHMENT_WRAPPER_KEYS) {
      if (Object.hasOwn(record, key)) {
        queue.push({ value: record[key], depth: candidate.depth + 1 })
      }
    }
    if (Object.hasOwn(record, "content") && Array.isArray(record.content)) {
      for (const item of record.content) {
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          queue.push({ value: item.text, depth: candidate.depth + 1 })
        }
      }
    }
  }

  return null
}

export function dynamicArtifactStateSummary(state: UiArtifactInstanceState["state"]) {
  if (
    state &&
    typeof state === "object" &&
    !Array.isArray(state) &&
    "watching" in state &&
    typeof state.watching === "string"
  ) {
    return `watching-${state.watching.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`
  }
  return "ready"
}

export function mergeDynamicArtifactPrompt(current: string, staged: string) {
  const existing = current.trim()
  return existing ? `${existing}\n\n---\n\n${staged}` : staged
}
