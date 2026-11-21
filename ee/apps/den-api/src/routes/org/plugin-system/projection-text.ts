export const PROJECTION_TITLE_MAX_CHARS = 255
export const PROJECTION_TEXT_MAX_BYTES = 60_000

export function clampUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let bytes = 0
  let end = 0
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8")
    if (bytes + codePointBytes > maxBytes) break
    bytes += codePointBytes
    end += codePoint.length
  }
  return value.slice(0, end)
}

export function clampCodePoints(value: string, maxCodePoints: number): string {
  if (value.length <= maxCodePoints) return value
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maxCodePoints) break
    count += 1
    end += codePoint.length
  }
  return value.slice(0, end)
}
