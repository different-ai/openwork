import { createHash } from "node:crypto"
import { z } from "zod"
import { sqlRow } from "../store.js"

/**
 * A sealed segment: whole old turns of one session, moved out of the hot database into the files bucket, immutable.
 *
 * Gzip'd JSONL (CompressionStream, on Node and in a cell alike). The first line is the header; then one line per turn
 * row (as stored, without its resume grant) and one per transcript row (as stored, with any large body inlined), so a
 * segment alone pages a session's history and exports it with nothing lost. Readers check the format version and the
 * SHA-256 of the stored bytes (kept in the manifest) before using one.
 */
export const SEGMENT_FORMAT = "openwork-headless-segment"
export const SEGMENT_VERSION = 1

export const segmentHeaderSchema = z.object({
  format: z.literal(SEGMENT_FORMAT),
  version: z.number().int(),
  sessionId: z.string(),
  n: z.number().int(),
  seqFrom: z.number(),
  seqTo: z.number(),
  /** The first and last sealed turn's message id, in turn order. */
  turnFrom: z.string(),
  turnTo: z.string(),
  createdAt: z.number(),
})
export type SegmentHeader = z.infer<typeof segmentHeaderSchema>
type SqlRow = z.infer<typeof sqlRow>

const lineSchema = z.union([z.object({ turn: sqlRow }).strict(), z.object({ message: sqlRow }).strict()])

/** Turn rows in turn order, transcript rows in seq order. */
export type SegmentData = { header: SegmentHeader; turns: SqlRow[]; messages: SqlRow[] }

/** Where segment `n` of a session lives; a rewrite of it gets a fresh name (`rev`) so the old one stays until the swap. */
export function segmentKey(sessionId: string, n: number, rev?: string) {
  return `sessions/${sessionId}/segments/${String(n).padStart(6, "0")}${rev ? `.${rev}` : ""}.jsonl.gz`
}
export const segmentPrefix = (sessionId: string) => `sessions/${sessionId}/segments/`

export function sha256Hex(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, transform: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(transform)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function encodeSegment(data: SegmentData): Promise<Uint8Array<ArrayBuffer>> {
  const lines = [
    JSON.stringify(segmentHeaderSchema.parse(data.header)),
    ...data.turns.map((turn) => JSON.stringify({ turn })),
    ...data.messages.map((message) => JSON.stringify({ message })),
  ]
  return pipe(new Uint8Array(new TextEncoder().encode(`${lines.join("\n")}\n`)), new CompressionStream("gzip"))
}

export class SegmentError extends Error {
  constructor(readonly code: "segment_missing" | "segment_corrupt" | "segment_format_unsupported" | "segments_unavailable", message?: string) {
    super(message ?? code)
  }
}

/** Decodes stored bytes, checking them against the manifest's checksum first. */
export async function decodeSegment(bytes: Uint8Array<ArrayBuffer>, expectedSha256: string): Promise<{ data: SegmentData; size: number }> {
  if (sha256Hex(bytes) !== expectedSha256) throw new SegmentError("segment_corrupt", "segment checksum mismatch")
  let text: string
  try {
    text = new TextDecoder().decode(await pipe(bytes, new DecompressionStream("gzip")))
  } catch {
    throw new SegmentError("segment_corrupt", "segment does not decompress")
  }
  const lines = text.split("\n").filter(Boolean)
  const first = lines.shift()
  const header = segmentHeaderSchema.safeParse(first ? JSON.parse(first) : null)
  if (!header.success) throw new SegmentError("segment_corrupt", "segment header unreadable")
  if (header.data.version > SEGMENT_VERSION) throw new SegmentError("segment_format_unsupported", `segment format version ${header.data.version}`)
  const turns: SqlRow[] = []
  const messages: SqlRow[] = []
  for (const line of lines) {
    const parsed = lineSchema.safeParse(JSON.parse(line))
    if (!parsed.success) throw new SegmentError("segment_corrupt", "segment row unreadable")
    if ("turn" in parsed.data) turns.push(parsed.data.turn)
    else messages.push(parsed.data.message)
  }
  return { data: { header: header.data, turns, messages }, size: text.length }
}
