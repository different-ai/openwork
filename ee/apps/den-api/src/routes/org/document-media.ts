/**
 * Video and audio in Documents: which stored files a browser's own player may be given, and how their bytes are
 * served. A player asks for byte ranges (to start before the whole file arrives, and to seek), so each answer is one
 * bounded range read from the provider; no file is held or sent whole.
 */

/** Stored types browsers play natively. Only these are ever served as media; nothing here can carry script. */
const MEDIA_TYPES: Readonly<Record<string, "video" | "audio">> = {
  "video/mp4": "video", "video/webm": "video", "video/quicktime": "video", "video/ogg": "video",
  "audio/mpeg": "audio", "audio/mp3": "audio", "audio/mp4": "audio", "audio/x-m4a": "audio", "audio/aac": "audio",
  "audio/wav": "audio", "audio/x-wav": "audio", "audio/ogg": "audio", "audio/webm": "audio", "audio/flac": "audio",
}

/** The most one answer carries. A player asks again for what follows. */
export const DOCUMENT_MEDIA_CHUNK_BYTES = 8 * 1024 * 1024

export type DocumentMediaRange = { start: number; end: number; partial: boolean }

/** "video" or "audio" for a stored type a browser can play, otherwise null. */
export function documentMediaKind(mimeType: string): "video" | "audio" | null {
  return MEDIA_TYPES[mimeType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? null
}

/**
 * The bytes to answer a request with: the asked-for range, shortened to one chunk and to the file. A missing or
 * unreadable Range header starts at the beginning. Null when the range starts past the end of the file.
 */
export function documentMediaRange(header: string | undefined, size: number): DocumentMediaRange | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null
  const match = header === undefined ? null : /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim())
  const [from, to] = [match?.[1] ?? "", match?.[2] ?? ""]
  let start = 0
  let last = size - 1
  if (from !== "") {
    start = Number(from)
    if (to !== "") last = Math.min(last, Number(to))
  } else if (to !== "") {
    // "bytes=-N": the last N bytes.
    if (Number(to) === 0) return null
    start = Math.max(0, size - Number(to))
  }
  if (start > last) return null
  const end = Math.min(last, start + DOCUMENT_MEDIA_CHUNK_BYTES - 1)
  return { start, end, partial: match !== null || end < size - 1 }
}

/** The Range header that asks a provider for exactly these bytes. */
export function documentMediaRangeHeader(range: DocumentMediaRange) {
  return `bytes=${range.start}-${range.end}`
}

/**
 * Reads exactly the requested bytes from the provider's answer. A provider that ignored the range and sent the file
 * from its start is accepted only for a range that starts there; anything else is refused rather than mislabelled.
 */
export async function readDocumentMediaRange(upstream: Response, range: DocumentMediaRange): Promise<Uint8Array<ArrayBuffer>> {
  const length = range.end - range.start + 1
  if (upstream.status !== 206 && range.start !== 0) { await upstream.body?.cancel().catch(() => {}); throw new Error("The provider did not return the requested range.") }
  const bytes = new Uint8Array(length)
  let filled = 0
  const reader = upstream.body?.getReader()
  try {
    while (reader && filled < length) {
      const next = await reader.read()
      if (next.done) break
      const part = next.value.subarray(0, length - filled)
      bytes.set(part, filled)
      filled += part.byteLength
    }
  } finally {
    await reader?.cancel().catch(() => {})
  }
  if (filled !== length) throw new Error("The provider returned fewer bytes than requested.")
  return bytes
}

const SAFE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" }

/** One range of a media file, typed as the stored media type and never as a document a browser would run. */
export function documentMediaResponse(bytes: Uint8Array<ArrayBuffer>, input: { mimeType: string; range: DocumentMediaRange; size: number }) {
  return new Response(bytes.buffer, {
    status: input.range.partial ? 206 : 200,
    headers: {
      ...SAFE_HEADERS,
      "content-type": input.mimeType.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "accept-ranges": "bytes",
      ...(input.range.partial ? { "content-range": `bytes ${input.range.start}-${input.range.end}/${input.size}` } : {}),
    },
  })
}

/** The answer to a range that starts past the end of the file. */
export function documentMediaUnsatisfiable(size: number) {
  return new Response(null, { status: 416, headers: { ...SAFE_HEADERS, "content-range": `bytes */${Number.isSafeInteger(size) && size > 0 ? size : 0}` } })
}
