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
