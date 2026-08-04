import sharp from "sharp"

export type AgentToolContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

const MAX_INLINE_IMAGE_BYTES = 1024 * 1024
const MAX_IMAGE_DIMENSION = 1568

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
  if (typeof payload === "string") return [{ type: "text", text: payload }]

  const payloadRecord = isRecord(payload) ? payload : undefined
  let imagePayload: (Record<string, unknown> & { contentBase64: string; mimeType: string }) | undefined
  let imagePayloadKey: string | undefined
  if (isImagePayload(payload)) {
    imagePayload = payload
  } else if (payloadRecord) {
    for (const [key, value] of Object.entries(payloadRecord)) {
      if (isImagePayload(value)) {
        imagePayload = value
        imagePayloadKey = key
        break
      }
    }
  }

  if (!imagePayload) {
    return [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  }

  const byteSize = Buffer.byteLength(imagePayload.contentBase64, "base64")
  const placeholder = `<${byteSize} bytes delivered as image content>`
  const redactedImagePayload = { ...imagePayload, contentBase64: placeholder }
  const redactedPayload = imagePayloadKey === undefined || payloadRecord === undefined
    ? redactedImagePayload
    : { ...payloadRecord, [imagePayloadKey]: redactedImagePayload }
  const textPart: AgentToolContentPart = {
    type: "text",
    text: JSON.stringify(redactedPayload, null, 2),
  }

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
