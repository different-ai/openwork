import sharp from "sharp"

export type AgentToolContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

const MAX_INLINE_IMAGE_BYTES = 1024 * 1024
const MAX_IMAGE_DIMENSION = 1568
const MAX_MODEL_VISIBLE_BINARY_BYTES = 64 * 1024
const MAX_MODEL_VISIBLE_TEXT_CHARACTERS = 20_000
const PRETTY_JSON_MAX_BYTES = 2 * 1024
const BASE64_FIELD_PATTERN = /^(?:content|data)Base64$/i
const TRUNCATION_MARKER = "\n[truncated]"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isImagePayload(value: unknown): value is Record<string, unknown> & {
  contentBase64: string
  mimeType: string
} {
  return isRecord(value)
    && typeof value.contentBase64 === "string"
    && typeof value.mimeType === "string"
    && value.mimeType.startsWith("image/")
}

function base64ByteSize(value: string): number {
  return Buffer.byteLength(value, "base64")
}

function truncateModelString(value: string): string {
  if (value.length <= MAX_MODEL_VISIBLE_TEXT_CHARACTERS) return value
  return `${value.slice(0, MAX_MODEL_VISIBLE_TEXT_CHARACTERS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
}

function sanitizeModelPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeModelPayload)
  if (typeof value === "string") return truncateModelString(value)
  if (!isRecord(value)) return value

  const imagePayload = isImagePayload(value)
  const omittedBase64 = new Map<string, number>()
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && BASE64_FIELD_PATTERN.test(key)) {
      const byteSize = base64ByteSize(entry)
      if (imagePayload || byteSize > MAX_MODEL_VISIBLE_BINARY_BYTES) omittedBase64.set(key, byteSize)
    }
  }

  const reservedMetadata = new Set(
    [...omittedBase64.keys()].flatMap((key) => [`${key}Omitted`, `${key}Bytes`]),
  )
  const sanitizedEntries: [string, unknown][] = []
  for (const [key, entry] of Object.entries(value)) {
    if (reservedMetadata.has(key)) continue
    const byteSize = omittedBase64.get(key)
    if (byteSize !== undefined) {
      sanitizedEntries.push(
        [key, `<${byteSize} binary bytes omitted from model-visible content>`],
        [`${key}Omitted`, true],
        [`${key}Bytes`, byteSize],
      )
      continue
    }
    if (typeof entry === "string" && BASE64_FIELD_PATTERN.test(key)) {
      sanitizedEntries.push([key, entry])
      continue
    }
    sanitizedEntries.push([key, sanitizeModelPayload(entry)])
  }
  return Object.fromEntries(sanitizedEntries)
}

function stringifyModelPayload(value: unknown): string {
  const compact = JSON.stringify(value)
  if (compact === undefined) return "null"
  if (Buffer.byteLength(compact, "utf8") > PRETTY_JSON_MAX_BYTES) return compact
  return JSON.stringify(value, null, 2)!
}

function findImagePayload(value: unknown, seen = new WeakSet<object>()): (Record<string, unknown> & {
  contentBase64: string
  mimeType: string
}) | undefined {
  if (isImagePayload(value)) return value
  if (typeof value !== "object" || value === null || seen.has(value)) return undefined
  seen.add(value)
  const children = Array.isArray(value) ? value : Object.values(value)
  for (const child of children) {
    const image = findImagePayload(child, seen)
    if (image) return image
  }
  return undefined
}

export function isKnownToolContentPart(value: unknown): value is AgentToolContentPart {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (value.type === "text") return typeof value.text === "string"
  if (value.type === "image") {
    return typeof value.data === "string" && typeof value.mimeType === "string"
  }
  return false
}

export function externalToolContent(result: unknown): AgentToolContentPart[] {
  if (isRecord(result) && Array.isArray(result.content) && result.content.every(isKnownToolContentPart)) {
    return result.content
  }
  return [{ type: "text", text: JSON.stringify(result) }]
}

export async function buildRestToolContent(payload: unknown): Promise<AgentToolContentPart[]> {
  if (typeof payload === "string") return [{ type: "text", text: truncateModelString(payload) }]

  const imagePayload = findImagePayload(payload)

  const textPart: AgentToolContentPart = {
    type: "text",
    text: stringifyModelPayload(sanitizeModelPayload(payload)),
  }
  if (!imagePayload) return [textPart]

  const byteSize = Buffer.byteLength(imagePayload.contentBase64, "base64")

  if (byteSize <= MAX_INLINE_IMAGE_BYTES) {
    return [textPart, {
      type: "image",
      data: imagePayload.contentBase64,
      mimeType: imagePayload.mimeType,
    }]
  }

  try {
    const image = await sharp(Buffer.from(imagePayload.contentBase64, "base64"))
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer()
    return [textPart, { type: "image", data: image.toString("base64"), mimeType: "image/jpeg" }]
  } catch {
    return [textPart]
  }
}
