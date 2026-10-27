import { z } from "zod"
import type { BlobStore } from "../blobs.js"
import type { Store, StoredMessage } from "../store.js"
import type { Message } from "../types.js"
import { ByteCache } from "./cache.js"
import { sha256Hex } from "./segments.js"

/**
 * Large bodies: a tool result longer than HEADLESS_LARGE_BODY_BYTES goes to `sessions/<id>/bodies/<sha256>` in the
 * files bucket before the row that references it commits. The hot row stays a valid message: its output is the
 * start of the result plus a marker line, and `large_bodies (session_id, seq, part, …)` maps it to the object. Every
 * read and every model context restores the whole output; if it can't, it fails (LargeBodyUnavailableError) and
 * never shows the start as if it were the whole. An older runner (rollback) sees the start and the marker.
 */
export type LargeBodyRef = { part: "output"; storageKey: string; bytes: number; sha256: string }

/** How much of a large output stays in the hot row. */
export const LARGE_BODY_PREVIEW_CHARS = 2_000
const CACHE_BYTES = 32 * 1024 * 1024
const CACHE_AGE_MS = 10 * 60_000
/** Durable Object SQL binds at most 100 parameters per statement. */
const SEQ_CHUNK = 90

export const bodyKey = (sessionId: string, sha256: string) => `sessions/${sessionId}/bodies/${sha256}`
export const bodyPrefix = (sessionId: string) => `sessions/${sessionId}/bodies/`
export const largeBodyMarker = (bytes: number, sha256: string) => `\n[Full output kept separately (${bytes} bytes, sha256 ${sha256}); this is its start.]`

/** A message's large part couldn't be read back: the step fails retryably instead of using the start alone. */
export class LargeBodyUnavailableError extends Error {
  readonly code = "large_body_unavailable"
  constructor(message: string) {
    super(message)
  }
}

export type PreparedMessage = { message: Message; body?: LargeBodyRef }

const refRow = z.object({ seq: z.number(), part: z.string(), storage_key: z.string(), bytes: z.number(), sha256: z.string() })

export class LargeBodies {
  private readonly cache: ByteCache<string>

  constructor(
    private readonly store: Store,
    private readonly blobs: BlobStore | null,
    /** Null: new large bodies are off (HEADLESS_SEGMENTS=off); existing ones are still restored. */
    private readonly threshold: number | null,
    private readonly onUploadFailed: (error: unknown) => void = () => undefined,
  ) {
    this.cache = new ByteCache(CACHE_BYTES, CACHE_AGE_MS)
  }

  /**
   * The message as the hot row keeps it: a tool output over the threshold is uploaded first (content-addressed, so the
   * same output twice is one object) and replaced by its start and a marker. An upload that fails keeps the whole
   * output in the row (reported, never lost).
   */
  async prepare(sessionId: string, message: Message): Promise<PreparedMessage> {
    if (this.threshold === null || !this.blobs || message.role !== "tool") return { message }
    const bytes = new Uint8Array(new TextEncoder().encode(message.output))
    if (bytes.byteLength <= this.threshold) return { message }
    const sha256 = sha256Hex(bytes)
    const storageKey = bodyKey(sessionId, sha256)
    try {
      await this.blobs.put(storageKey, bytes, "text/plain; charset=utf-8")
    } catch (error) {
      this.onUploadFailed(error)
      return { message }
    }
    this.cache.set(storageKey, message.output, bytes.byteLength)
    return {
      message: { ...message, output: `${message.output.slice(0, LARGE_BODY_PREVIEW_CHARS)}${largeBodyMarker(bytes.byteLength, sha256)}` },
      body: { part: "output", storageKey, bytes: bytes.byteLength, sha256 },
    }
  }

  async prepareAll(sessionId: string, messages: Message[]): Promise<PreparedMessage[]> {
    return Promise.all(messages.map((message) => this.prepare(sessionId, message)))
  }

  /** The large-body references of these rows (by seq). */
  refs(sessionId: string, seqs: number[]): Map<number, LargeBodyRef> {
    const found = new Map<number, LargeBodyRef>()
    for (let index = 0; index < seqs.length; index += SEQ_CHUNK) {
      const chunk = seqs.slice(index, index + SEQ_CHUNK)
      const rows = this.store.db
        .prepare(`SELECT seq, part, storage_key, bytes, sha256 FROM large_bodies WHERE session_id = ? AND part = 'output' AND seq IN (${chunk.map(() => "?").join(", ")})`)
        .all(sessionId, ...chunk)
      for (const row of rows) {
        const value = refRow.parse(row)
        found.set(value.seq, { part: "output", storageKey: value.storage_key, bytes: value.bytes, sha256: value.sha256 })
      }
    }
    return found
  }

  /**
   * The rows with every large output restored, fetched in parallel (cached briefly). Throws LargeBodyUnavailableError
   * when one can't be read or doesn't match its checksum. A reference whose row no longer carries its marker (an
   * older runner rewrote the row) is ignored: the row is whole.
   */
  async restore(sessionId: string, rows: StoredMessage[]): Promise<StoredMessage[]> {
    if (rows.length === 0) return rows
    const refs = this.refs(sessionId, rows.map((row) => row.seq))
    if (refs.size === 0) return rows
    return Promise.all(
      rows.map(async (row) => {
        const ref = refs.get(row.seq)
        if (!ref || row.message.role !== "tool" || !row.message.output.endsWith(largeBodyMarker(ref.bytes, ref.sha256))) return row
        return { ...row, message: { ...row.message, output: await this.fetch(ref) } }
      }),
    )
  }

  /** One large output, checked against its checksum. */
  async fetch(ref: LargeBodyRef): Promise<string> {
    const cached = this.cache.get(ref.storageKey)
    if (cached !== undefined) return cached
    if (!this.blobs) throw new LargeBodyUnavailableError("no file store is configured to read a large output from")
    let bytes: Uint8Array<ArrayBuffer> | null
    try {
      bytes = await this.blobs.get(ref.storageKey)
    } catch (error) {
      throw new LargeBodyUnavailableError(`large output unreadable: ${error instanceof Error ? error.message : "unknown"}`)
    }
    if (!bytes) throw new LargeBodyUnavailableError("large output missing")
    if (sha256Hex(bytes) !== ref.sha256) throw new LargeBodyUnavailableError("large output checksum mismatch")
    const text = new TextDecoder().decode(bytes)
    this.cache.set(ref.storageKey, text, bytes.byteLength)
    return text
  }

  forget(storageKey: string) {
    this.cache.remove(storageKey)
  }
}
