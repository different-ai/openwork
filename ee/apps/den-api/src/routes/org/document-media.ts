const MEDIA_TYPES: Readonly<Record<string, "video" | "audio">> = {
  "video/mp4": "video", "video/webm": "video", "video/quicktime": "video", "video/ogg": "video",
  "audio/mpeg": "audio", "audio/mp3": "audio", "audio/mp4": "audio", "audio/x-m4a": "audio", "audio/aac": "audio",
  "audio/wav": "audio", "audio/x-wav": "audio", "audio/ogg": "audio", "audio/webm": "audio", "audio/flac": "audio",
}

export const DOCUMENT_MEDIA_CHUNK_BYTES = 8 * 1024 * 1024

export type DocumentMediaRange = { start: number; end: number; partial: boolean }

export function documentMediaKind(mimeType: string): "video" | "audio" | null {
  return MEDIA_TYPES[mimeType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? null
}

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
    if (Number(to) === 0) return null
    start = Math.max(0, size - Number(to))
  }
  if (start > last) return null
  const end = Math.min(last, start + DOCUMENT_MEDIA_CHUNK_BYTES - 1)
  return { start, end, partial: match !== null || end < size - 1 }
}

export function documentMediaRangeHeader(range: DocumentMediaRange) {
  return `bytes=${range.start}-${range.end}`
}

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

export function documentMediaUnsatisfiable(size: number) {
  return new Response(null, { status: 416, headers: { ...SAFE_HEADERS, "content-range": `bytes */${Number.isSafeInteger(size) && size > 0 ? size : 0}` } })
}
