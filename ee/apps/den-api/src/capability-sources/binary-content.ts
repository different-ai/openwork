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

export type TextWindow = {
  text: string
  offset: number
  totalCharacters: number
  nextOffset: number | null
  truncated: boolean
}

/** Returns one page of text so long files can be read in bounded windows. */
export function textWindow(text: string, offset: number, maxCharacters: number): TextWindow {
  const start = Math.min(Math.max(0, offset), text.length)
  const end = Math.min(text.length, start + Math.max(1, maxCharacters))
  const nextOffset = end < text.length ? end : null
  return {
    text: text.slice(start, end),
    offset: start,
    totalCharacters: text.length,
    nextOffset,
    truncated: nextOffset !== null,
  }
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
