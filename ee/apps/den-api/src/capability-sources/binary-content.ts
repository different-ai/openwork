export type DecodedFileContent =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "binary"; contentBase64: string; byteSize: number }
  | { kind: "too_large"; byteSize: number }

export function truncateText(text: string, maxCharacters: number): { text: string; truncated: boolean } {
  if (text.length <= maxCharacters) {
    return { text, truncated: false }
  }
  return { text: text.slice(0, maxCharacters), truncated: true }
}

export function decodeFileContent(
  bytes: Uint8Array,
  options: { maxTextCharacters: number; maxBinaryBytes: number },
): DecodedFileContent {
  try {
    const decoded = truncateText(new TextDecoder("utf-8", { fatal: true }).decode(bytes), options.maxTextCharacters)
    return { kind: "text", content: decoded.text, truncated: decoded.truncated }
  } catch {
    if (bytes.length > options.maxBinaryBytes) {
      return { kind: "too_large", byteSize: bytes.length }
    }
    return { kind: "binary", contentBase64: Buffer.from(bytes).toString("base64"), byteSize: bytes.length }
  }
}

export async function readBoundedBytes(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const room = maxBytes - length
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room))
        length += room
        truncated = true
        break
      }
      chunks.push(value)
      length += value.byteLength
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}

export async function readBytesWithin(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0)
  const declared = Number(response.headers.get("content-length"))
  const encoding = response.headers.get("content-encoding")
  const hasDeclared = response.headers.has("content-length") && Number.isSafeInteger(declared) && declared >= 0
    && (!encoding || encoding === "identity")
  if (hasDeclared && declared > maxBytes) {
    await response.body.cancel().catch(() => {})
    return null
  }
  if (!hasDeclared) {
    const { bytes, truncated } = await readBoundedBytes(response, maxBytes)
    if (!truncated) return bytes
    return null
  }

  const bytes = new Uint8Array(declared)
  const reader = response.body.getReader()
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (length + value.byteLength > declared) {
        await reader.cancel().catch(() => {})
        return null
      }
      bytes.set(value, length)
      length += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  return length === declared ? bytes : bytes.subarray(0, length)
}

export function decodeTruncatedText(bytes: Uint8Array, fatal: boolean): string {
  return new TextDecoder("utf-8", { fatal }).decode(bytes, { stream: true })
}
