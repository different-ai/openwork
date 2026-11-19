import { z } from "zod"
import type { BlobStore } from "../blobs.js"
import type { SqlDriver } from "../sql.js"
import { ByteCache } from "./cache.js"
import { decodeSegment, SegmentError, type SegmentData } from "./segments.js"

/** One sealed segment as the hot `segments` table (the manifest) records it. */
export type ManifestEntry = {
  sessionId: string
  n: number
  seqFrom: number
  seqTo: number
  timeFrom: number
  timeTo: number
  turns: number
  bytes: number
  sha256: string
  storageKey: string
  formatVersion: number
  createdAt: number
}

const manifestRow = z.object({
  session_id: z.string(),
  n: z.number(),
  seq_from: z.number(),
  seq_to: z.number(),
  time_from: z.number(),
  time_to: z.number(),
  turns: z.number(),
  bytes: z.number(),
  sha256: z.string(),
  storage_key: z.string(),
  format_version: z.number(),
  created_at: z.number(),
})

function toEntry(row: unknown): ManifestEntry {
  const value = manifestRow.parse(row)
  return {
    sessionId: value.session_id,
    n: value.n,
    seqFrom: value.seq_from,
    seqTo: value.seq_to,
    timeFrom: value.time_from,
    timeTo: value.time_to,
    turns: value.turns,
    bytes: value.bytes,
    sha256: value.sha256,
    storageKey: value.storage_key,
    formatVersion: value.format_version,
    createdAt: value.created_at,
  }
}

/** A session's segments, oldest first (segment order is turn order). */
export function manifestOf(db: SqlDriver, sessionId: string): ManifestEntry[] {
  return db.prepare("SELECT * FROM segments WHERE session_id = ? ORDER BY n").all(sessionId).map(toEntry)
}

export function insertManifest(db: SqlDriver, entry: ManifestEntry) {
  db.prepare(
    `INSERT INTO segments (session_id, n, seq_from, seq_to, time_from, time_to, turns, bytes, sha256, storage_key, format_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(entry.sessionId, entry.n, entry.seqFrom, entry.seqTo, entry.timeFrom, entry.timeTo, entry.turns, entry.bytes, entry.sha256, entry.storageKey, entry.formatVersion, entry.createdAt)
}

/** Swaps one entry for its rewrite, only if it is still the version read (`expectedSha256`). */
export function replaceManifest(db: SqlDriver, expectedSha256: string, entry: ManifestEntry): boolean {
  return (
    db
      .prepare(
        `UPDATE segments SET seq_from = ?, seq_to = ?, time_from = ?, time_to = ?, turns = ?, bytes = ?, sha256 = ?, storage_key = ?, format_version = ?, created_at = ?
         WHERE session_id = ? AND n = ? AND sha256 = ?`,
      )
      .run(entry.seqFrom, entry.seqTo, entry.timeFrom, entry.timeTo, entry.turns, entry.bytes, entry.sha256, entry.storageKey, entry.formatVersion, entry.createdAt, entry.sessionId, entry.n, expectedSha256).changes === 1
  )
}

export function removeManifest(db: SqlDriver, sessionId: string, n: number, expectedSha256: string): boolean {
  return db.prepare("DELETE FROM segments WHERE session_id = ? AND n = ? AND sha256 = ?").run(sessionId, n, expectedSha256).changes === 1
}

/** Decoded segments, fetched from the files bucket and kept briefly, bounded by bytes. */
export class SegmentReader {
  private readonly cache = new ByteCache<SegmentData>(64 * 1024 * 1024, 5 * 60_000)

  constructor(private readonly blobs: BlobStore | null) {}

  async load(entry: ManifestEntry): Promise<SegmentData> {
    const cacheKey = `${entry.storageKey}#${entry.sha256}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached
    if (!this.blobs) throw new SegmentError("segments_unavailable", "no file store is configured to read sealed history from")
    const bytes = await this.blobs.get(entry.storageKey)
    if (!bytes) throw new SegmentError("segment_missing", `segment ${entry.n} is missing`)
    const { data, size } = await decodeSegment(bytes, entry.sha256)
    this.cache.set(cacheKey, data, size)
    return data
  }

  /** Keeps a segment this process just wrote, so the next read needn't fetch it. */
  remember(entry: ManifestEntry, data: SegmentData, size: number) {
    this.cache.set(`${entry.storageKey}#${entry.sha256}`, data, size)
  }
}
