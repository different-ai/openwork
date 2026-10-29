import { z } from "zod"
import type { BackgroundJob } from "../background.js"
import type { BlobStore } from "../blobs.js"
import type { ErrorReporter } from "../error-reporting.js"
import { parseMessageRow, sqlRow, toTurn, TURN_COLUMNS, type ConversationRows, type Store, type StoredMessage, type Turn } from "../store.js"
import { ACTIVE, messageSchema, type Message } from "../types.js"
import { bodyPrefix, LargeBodies, type LargeBodyRef, type PreparedMessage } from "./large-bodies.js"
import { insertManifest, manifestOf, removeManifest, replaceManifest, SegmentReader, type ManifestEntry } from "./manifest.js"
import { readMeta, writeMeta } from "./migrations.js"
import { encodeSegment, SEGMENT_FORMAT, SEGMENT_VERSION, SegmentError, segmentKey, segmentPrefix, sha256Hex, type SegmentData, type SegmentHeader } from "./segments.js"

type SqlRow = z.infer<typeof sqlRow>

/** Runner settings for sealing and large bodies (config.ts). Off by default; reading what exists always works. */
export type StorageSettings = {
  /** HEADLESS_SEGMENTS: seal old turns and move large tool outputs to the files bucket. */
  segments: boolean
  /** HEADLESS_HOT_LIMIT_BYTES: the hot database is kept under this. */
  hotLimitBytes: number
  /** HEADLESS_SEGMENT_TARGET_BYTES: about this much per segment; a session with this much sealable is sealed. */
  segmentTargetBytes: number
  /** HEADLESS_LARGE_BODY_BYTES: tool outputs over this go to the files bucket. */
  largeBodyBytes: number
  /** The model's context budget: what a budget-bounded context read still reaches is never sealed. */
  contextCharBudget: number
}

export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  segments: false,
  hotLimitBytes: 32 * 1024 * 1024,
  segmentTargetBytes: 8 * 1024 * 1024,
  largeBodyBytes: 8 * 1024,
  contextCharBudget: 400_000,
}

/** The newest turns of a session always stay hot (Workbot's first page, and well beyond the model's context). */
export const MIN_HOT_TURNS = 30
const TERMINAL = new Set(["completed", "failed", "aborted"])
/** How long after a turn ends the sealer looks for work (turns often come in bursts). */
const SEAL_DEBOUNCE_MS = 2_000
/** Sessions whose hot bytes are counted per sealer run (databases from before they were kept). */
const COUNT_PER_RUN = 5
const ORPHAN_SCAN_MS = 24 * 3_600_000
const ORPHAN_MIN_AGE_MS = 24 * 3_600_000
const NEAR_LIMIT_SHARE = 0.9
const NEAR_LIMIT_REPORT_MS = 3_600_000
/** Durable Object SQL binds at most 100 parameters per statement. */
const ID_CHUNK = 90
const ORPHANS_AT = "segment_orphans_at"
const ORPHANS_COUNT = "segment_orphans_count"

/** 1B's retry shape: immediately three times, then 30 s, 2 min, then hourly. */
export function sealRetryDelayMs(attempt: number) {
  if (attempt <= 3) return 0
  if (attempt === 4) return 30_000
  if (attempt === 5) return 120_000
  return 3_600_000
}
const SEAL_REPORT_AFTER = 5

/** Same grouping as Store.deleteTurns: a task and its report belong to the message that started them. */
const rootOf = (id: string) => id.split(".")[0] ?? id
const str = (row: SqlRow, column: string) => {
  const value = row[column]
  return typeof value === "string" ? value : ""
}
const num = (row: SqlRow, column: string) => {
  const value = row[column]
  return typeof value === "number" ? value : 0
}
const RESUME_GRANT = "resume_grant"
const withoutGrant = (row: SqlRow): SqlRow => Object.fromEntries(Object.entries(row).filter(([name]) => name !== RESUME_GRANT))

/** A sealed turn and where it is: segment `n`, position `index` in it. */
type SealedTurn = { n: number; index: number; row: SqlRow; turn: Turn }
type Cursor = { kind: "end" } | { kind: "hot"; messageId: string } | { kind: "sealed"; n: number; index: number } | { kind: "none" }

export type WindowRead = {
  turns: Turn[]
  messages: StoredMessage[]
  finalAssistantText: string
  hasEarlier: boolean | undefined
  /** What sealed turns with no transcript were sent with (hot ones come from Store.waitingPrompts). */
  sealedPrompts: Map<string, string>
}

const lightTurn = z.object({ message_id: z.string(), status: z.string() })
const keyRow = z.object({ storage_key: z.string() })
const numberRow = z.object({ n: z.number().nullable() })

/**
 * The runner's one storage module: the hot SQLite (Store), sealed segments and large bodies in the files bucket, the
 * segment manifest, the sealer and orphan cleanup. Nothing else in the runner touches segment or body keys or the
 * bucket for them.
 */
export class SessionStorage {
  readonly bodies: LargeBodies
  readonly segments: SegmentReader
  private readonly now: () => number
  private sealDueAt: number | null
  private sealSeen = 0
  private sealMore = false
  private sealRetryAt: number | null = null
  private uncounted: boolean | null = null
  private orphansDueAt: number | null = null
  private deletionsDueAt: number | null | undefined = undefined
  private nearLimitReportedAt = 0

  constructor(
    readonly store: Store,
    readonly blobs: BlobStore | null,
    readonly settings: StorageSettings = DEFAULT_STORAGE_SETTINGS,
    private readonly errors?: ErrorReporter,
    now: () => number = Date.now,
  ) {
    this.now = now
    this.bodies = new LargeBodies(store, blobs, this.sealing ? settings.largeBodyBytes : null, (error) => {
      console.error("[headless-runner] large body upload failed; kept in the row", { error: error instanceof Error ? error.message : "unknown" })
      void errors?.report({ code: "large_body_upload_failed", level: "warning", error })
    })
    this.segments = new SegmentReader(blobs)
    // One look after the process (or cell) starts, then after turns end.
    this.sealDueAt = this.sealing ? now() : null
  }

  /** Sealing and new large bodies are on (HEADLESS_SEGMENTS=on with a files bucket). */
  get sealing() {
    return this.settings.segments && this.blobs !== null
  }

  // ------------------------------------------------------------------ writes (large bodies)

  /** A message as its row keeps it (see LargeBodies.prepare). Never throws. */
  prepare(sessionId: string, message: Message): Promise<PreparedMessage> {
    return this.bodies.prepare(sessionId, message)
  }

  prepareAll(sessionId: string, messages: Message[]): Promise<PreparedMessage[]> {
    return this.bodies.prepareAll(sessionId, messages)
  }

  /** Rows with their large outputs restored; throws LargeBodyUnavailableError when one can't be read. */
  restore(sessionId: string, rows: StoredMessage[]): Promise<StoredMessage[]> {
    return this.bodies.restore(sessionId, rows)
  }

  // ------------------------------------------------------------------ reads (paged across hot and sealed)

  /**
   * The newest `count` turns before `before` with their newest `limit` messages, from the hot database where they are
   * and from sealed segments before that. `before` is a turn's messageId (as callers page today) or a message seq
   * (which never changes): the turns before the turn holding it.
   */
  async readWindow(sessionId: string, count: number, limit: number, before?: string): Promise<WindowRead> {
    const { store } = this
    const manifest = manifestOf(store.db, sessionId)
    const cursor: Cursor = before === undefined ? { kind: "end" } : await this.resolveCursor(sessionId, before, manifest)
    if (cursor.kind === "none") return { turns: [], messages: [], finalAssistantText: "", hasEarlier: false, sealedPrompts: new Map() }
    let hotTurns: Turn[] = []
    let hotEarlier = false
    if (cursor.kind !== "sealed") {
      const hot = store.recentTurns(sessionId, count, cursor.kind === "hot" ? cursor.messageId : undefined)
      hotTurns = hot.turns
      hotEarlier = hot.hasEarlier
    }
    let sealed: SealedTurn[] = []
    let sealedEarlier = false
    let sealedData = new Map<number, SegmentData>()
    if (!hotEarlier && manifest.some((entry) => entry.turns > 0)) {
      const needed = count - hotTurns.length
      if (needed > 0) {
        const read = await this.sealedBefore(manifest, cursor.kind === "sealed" ? cursor : null, needed)
        sealed = read.turns
        sealedEarlier = read.hasEarlier
        sealedData = read.data
      } else {
        sealedEarlier = true
      }
    }
    // Messages: the hot window's as today, and the sealed turns' from their segments; newest `limit` overall.
    const first = hotTurns.at(0)?.messageId
    const last = hotTurns.at(-1)?.messageId
    const hotMessages = first && last ? await this.restore(sessionId, store.windowMessages(sessionId, first, last, limit)) : []
    const sealedIds = new Set(sealed.map((entry) => entry.turn.messageId))
    const sealedMessages = [...sealedData.values()].flatMap((data) => data.messages.filter((row) => sealedIds.has(str(row, "message_id"))).map(parseMessageRow))
    const messages = [...sealedMessages, ...hotMessages].sort((left, right) => left.seq - right.seq).slice(-limit)
    let finalAssistantText = ""
    if (last) {
      finalAssistantText = assistantText(hotMessages.length < limit ? hotMessages : await this.restore(sessionId, store.turnMessages(sessionId, last)), last)
    } else if (sealed.length) {
      const newest = sealed[sealed.length - 1]
      finalAssistantText = assistantText(sealedMessages, newest.turn.messageId)
    }
    const sealedPrompts = new Map<string, string>()
    const withTranscript = new Set(sealedMessages.map((message) => message.messageId))
    for (const entry of sealed) {
      if (entry.turn.kind === undefined && (entry.turn.status === "queued" || entry.turn.status === "aborted") && !withTranscript.has(entry.turn.messageId)) {
        sealedPrompts.set(entry.turn.messageId, str(entry.row, "prompt"))
      }
    }
    return { turns: [...sealed.map((entry) => entry.turn), ...hotTurns], messages, finalAssistantText, hasEarlier: hotEarlier || sealedEarlier, sealedPrompts }
  }

  /** One turn's transcript (its newest `limit` messages) and its family, from wherever they are. */
  async readTurn(sessionId: string, messageId: string, limit: number): Promise<{ turns: Turn[]; messages: StoredMessage[]; finalAssistantText: string; sealedPrompts?: Map<string, string> }> {
    const { store } = this
    if (store.getTurn(sessionId, messageId)) {
      const transcript = await this.restore(sessionId, store.turnMessages(sessionId, messageId))
      return { turns: store.turnFamily(sessionId, messageId), messages: transcript.slice(-limit), finalAssistantText: assistantText(transcript, messageId) }
    }
    const manifest = manifestOf(store.db, sessionId)
    const found = await this.findSealed(manifest, messageId)
    if (!found) return { turns: [], messages: [], finalAssistantText: "" }
    // Its tasks and their reports come after it: in its segment, later ones, or hot.
    const family: Turn[] = []
    const tasks = new Set<string>()
    for (const entry of manifest.filter((item) => item.n >= found.n)) {
      const data = await this.segments.load(entry)
      for (const row of data.turns) {
        const turn = toTurn(row)
        if (turn.messageId === messageId || (turn.kind === "task" && turn.parent === messageId)) {
          if (turn.kind === "task" && turn.parent === messageId) tasks.add(turn.messageId)
          family.push(turn)
        } else if (turn.kind === "report" && turn.parent && tasks.has(turn.parent)) {
          family.push(turn)
        }
      }
    }
    const hotTasks = store.db
      .prepare(`SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? AND kind = 'task' AND parent = ? ORDER BY rowid`)
      .all(sessionId, messageId)
      .map(toTurn)
    for (const task of hotTasks) tasks.add(task.messageId)
    const hotFamily = [...tasks].length
      ? store.db
          .prepare(
            `SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? AND ((kind = 'task' AND parent = ?) OR (kind = 'report' AND parent IN (${[...tasks].slice(0, ID_CHUNK).map(() => "?").join(", ")}))) ORDER BY rowid`,
          )
          .all(sessionId, messageId, ...[...tasks].slice(0, ID_CHUNK))
          .map(toTurn)
      : []
    const transcript = found.data.messages.filter((row) => str(row, "message_id") === messageId).map(parseMessageRow)
    const row = found.data.turns[found.index]
    const own = row ? toTurn(row) : null
    // A message stopped before it started has only its prompt, as a hot one shows it.
    const sealedPrompts = new Map<string, string>()
    if (row && own && own.kind === undefined && (own.status === "queued" || own.status === "aborted") && transcript.length === 0) sealedPrompts.set(messageId, str(row, "prompt"))
    return { turns: [...family, ...hotFamily], messages: transcript.slice(-limit), finalAssistantText: assistantText(transcript, messageId), sealedPrompts }
  }

  /** Where a `before` cursor points. */
  private async resolveCursor(sessionId: string, before: string, manifest: ManifestEntry[]): Promise<Cursor> {
    const { store } = this
    if (store.getTurn(sessionId, before)) return { kind: "hot", messageId: before }
    if (/^\d{1,15}$/.test(before)) return this.seqCursor(sessionId, Number(before), manifest)
    const found = await this.findSealed(manifest, before)
    return found ? { kind: "sealed", n: found.n, index: found.index } : { kind: "none" }
  }

  /** The turns before seq `seq`: before the turn holding it, or else before the first turn starting at or after it. */
  private async seqCursor(sessionId: string, seq: number, manifest: ManifestEntry[]): Promise<Cursor> {
    const db = this.store.db
    const owner = z.object({ message_id: z.string() }).safeParse(db.prepare("SELECT message_id FROM messages WHERE session_id = ? AND seq = ?").get(sessionId, seq))
    if (owner.success && this.store.getTurn(sessionId, owner.data.message_id)) return { kind: "hot", messageId: owner.data.message_id }
    for (const entry of manifest) {
      if (entry.seqTo < seq) continue
      const data = await this.segments.load(entry)
      const starts = firstSeqs(data)
      const exact = data.messages.find((row) => num(row, "seq") === seq)
      const index = exact
        ? data.turns.findIndex((row) => str(row, "message_id") === str(exact, "message_id"))
        : data.turns.findIndex((row) => (starts.get(str(row, "message_id")) ?? -1) >= seq)
      if (index !== -1) return { kind: "sealed", n: entry.n, index }
    }
    const next = z
      .object({ message_id: z.string() })
      .safeParse(
        db
          .prepare("SELECT message_id FROM turns WHERE session_id = ? AND message_id IN (SELECT message_id FROM messages WHERE session_id = ? GROUP BY message_id HAVING MIN(seq) >= ?) ORDER BY rowid LIMIT 1")
          .get(sessionId, sessionId, seq),
      )
    return next.success ? { kind: "hot", messageId: next.data.message_id } : { kind: "end" }
  }

  /** A sealed turn by messageId, newest segment first. */
  private async findSealed(manifest: ManifestEntry[], messageId: string): Promise<{ n: number; index: number; data: SegmentData } | null> {
    for (const entry of [...manifest].reverse()) {
      if (entry.turns === 0) continue
      const data = await this.segments.load(entry)
      const index = data.turns.findIndex((row) => str(row, "message_id") === messageId)
      if (index !== -1) return { n: entry.n, index, data }
    }
    return null
  }

  /** Up to `needed` sealed turns before `position` (or the newest), oldest first. */
  private async sealedBefore(manifest: ManifestEntry[], position: { n: number; index: number } | null, needed: number) {
    const taken: SealedTurn[] = []
    const data = new Map<number, SegmentData>()
    const entries = manifest.filter((entry) => entry.turns > 0 && (!position || entry.n <= position.n)).reverse()
    let hasEarlier = false
    for (const [order, entry] of entries.entries()) {
      if (taken.length >= needed) {
        hasEarlier = true
        break
      }
      const segment = await this.segments.load(entry)
      data.set(entry.n, segment)
      const end = position && entry.n === position.n ? position.index : segment.turns.length
      const from = Math.max(0, end - (needed - taken.length))
      const rows = segment.turns.slice(from, end).map((row, offset) => ({ n: entry.n, index: from + offset, row, turn: toTurn(row) }))
      taken.unshift(...rows)
      if (from > 0 || (taken.length >= needed && order < entries.length - 1)) hasEarlier = true
    }
    return { turns: taken, hasEarlier, data }
  }

  // ------------------------------------------------------------------ export

  /**
   * Every row of the conversation, sealed turns included and large bodies inline: an export stays lossless whatever
   * was sealed. Never segment files or step checkpoints.
   */
  async exportConversation(id: string): Promise<ConversationRows | null> {
    const hot = this.store.exportConversation(id)
    if (!hot) return null
    const sealedTurns: SqlRow[] = []
    const sealedMessages: SqlRow[] = []
    for (const entry of manifestOf(this.store.db, id)) {
      const data = await this.segments.load(entry)
      sealedTurns.push(...data.turns)
      sealedMessages.push(...data.messages)
    }
    return { ...hot, turns: [...sealedTurns, ...hot.turns], messages: [...sealedMessages, ...(await this.inlineBodies(id, hot.messages))] }
  }

  /** Message rows with any large body put back in, rewritten only where one was. */
  private async inlineBodies(sessionId: string, rows: SqlRow[]): Promise<SqlRow[]> {
    const refs = this.bodies.refs(sessionId, rows.map((row) => num(row, "seq")))
    if (refs.size === 0) return rows
    return Promise.all(
      rows.map(async (row) => {
        if (!refs.has(num(row, "seq"))) return row
        const [restored] = await this.restore(sessionId, [parseMessageRow(row)])
        return restored ? { ...row, body: JSON.stringify(messageSchema.parse(restored.message)) } : row
      }),
    )
  }

  // ------------------------------------------------------------------ deletes

  /**
   * Deletes the session: its hot rows (overwritten in place first, so the bytes leave the database file and the
   * replicated pages that follow), and after they commit its segments, large bodies and kept files. Objects that
   * can't be deleted now stay queued (storage_deletions) for the `segment-orphans` job. False when it doesn't exist.
   */
  async deleteSession(id: string): Promise<boolean> {
    const { store } = this
    if (!store.getSession(id)) return false
    const db = store.db
    const keys = [
      ...manifestOf(db, id).map((entry) => entry.storageKey),
      ...db.prepare("SELECT DISTINCT storage_key FROM large_bodies WHERE session_id = ?").all(id).map((row) => keyRow.parse(row).storage_key),
      ...store.savedFileKeys(id),
    ]
    const now = this.now()
    const removed = store.deleteSession(id, {
      inTransaction: () => {
        scrubSession(store, id)
        for (const key of keys) this.queueDeletion(key, "object", now)
        // Everything else under the session's prefix (previews, objects uploaded but never recorded).
        this.queueDeletion(`sessions/${id}/`, "prefix", now)
      },
    })
    if (!removed) return false
    this.purgeHostCopies()
    await this.processDeletions([...keys, `sessions/${id}/`])
    return true
  }

  /**
   * What the host lets the runner do to drop deleted bytes from the database file. On Node: checkpoint the WAL so the
   * old page images go. Durable Object hosts (celld, Cloudflare) deny every pragma but a short list and VACUUM (an
   * internal ATTACH): nothing more is possible there; see README "Deleting a conversation".
   */
  private purgeHostCopies() {
    try {
      this.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    } catch {
      // Not permitted on this host.
    }
  }

  /**
   * Removes a message and what it led to (as Store.deleteTurns), also when that reaches sealed turns: each segment
   * holding one is rewritten without them (a new object, the manifest swapped in one transaction with the hot rows'
   * deletion, the old object deleted after). Null while any of them is queued or running.
   */
  async deleteTurns(sessionId: string, messageId: string, options: { andAfter?: boolean } = {}): Promise<string[] | null> {
    const { store } = this
    const manifest = manifestOf(store.db, sessionId)
    const hotRoot = store.getTurn(sessionId, rootOf(messageId)) !== null || rootOf(messageId) === messageId
    if (manifest.length === 0 || (store.getTurn(sessionId, messageId) && hotRoot)) return store.deleteTurns(sessionId, messageId, options)
    // The whole ordered turn list, sealed first.
    const loaded = new Map<number, SegmentData>()
    const all: Array<{ turn: Turn; n: number | null }> = []
    for (const entry of manifest) {
      const data = await this.segments.load(entry)
      loaded.set(entry.n, data)
      for (const row of data.turns) all.push({ turn: toTurn(row), n: entry.n })
    }
    for (const turn of store.listTurns(sessionId)) all.push({ turn, n: null })
    const index = all.findIndex((entry) => entry.turn.messageId === messageId)
    if (index === -1) return []
    const roots = new Set(
      options.andAfter ? all.slice(index).filter((entry) => entry.turn.kind === undefined).map((entry) => entry.turn.messageId) : [rootOf(messageId)],
    )
    const removed = all.filter((entry) => roots.has(rootOf(entry.turn.messageId)))
    if (removed.some((entry) => ACTIVE.has(entry.turn.status))) return null
    const removedIds = new Set(removed.map((entry) => entry.turn.messageId))
    const hotIds = removed.filter((entry) => entry.n === null).map((entry) => entry.turn.messageId)
    // Rewrite each segment that loses turns (or drop it when none stay).
    const rewrites: Array<{ old: ManifestEntry; next: ManifestEntry | null; data: SegmentData | null; size: number }> = []
    for (const entry of manifest) {
      const data = loaded.get(entry.n)
      if (!data || !data.turns.some((row) => removedIds.has(str(row, "message_id")))) continue
      const turns = data.turns.filter((row) => !removedIds.has(str(row, "message_id")))
      if (turns.length === 0) {
        rewrites.push({ old: entry, next: null, data: null, size: 0 })
        continue
      }
      const kept = new Set(turns.map((row) => str(row, "message_id")))
      const messages = data.messages.filter((row) => kept.has(str(row, "message_id")))
      const written = await this.writeSegment(sessionId, entry.n, turns, messages, sha256Hex(`${entry.sha256}:${this.now()}`).slice(0, 8))
      rewrites.push({ old: entry, next: written.entry, data: written.data, size: written.size })
    }
    const now = this.now()
    let freed: string[] = []
    try {
      store.transaction(() => {
        for (const rewrite of rewrites) {
          const swapped = rewrite.next ? replaceManifest(store.db, rewrite.old.sha256, rewrite.next) : removeManifest(store.db, sessionId, rewrite.old.n, rewrite.old.sha256)
          if (!swapped) throw new SegmentError("segment_corrupt", "segment changed while it was rewritten")
          this.queueDeletion(rewrite.old.storageKey, "object", now)
        }
        if (hotIds.some((id) => !store.getTurn(sessionId, id) || ACTIVE.has(store.getTurn(sessionId, id)?.status ?? "queued"))) throw new SegmentError("segment_corrupt", "turns changed while they were removed")
        freed = store.deleteHotTurns(sessionId, hotIds)
        for (const key of freed) this.queueDeletion(key, "object", now)
        if (rewrites.length && hotIds.length === 0) store.enqueueIndexUpdate(sessionId)
      })
    } catch (error) {
      for (const rewrite of rewrites) if (rewrite.next) await this.blobs?.delete(rewrite.next.storageKey).catch(() => undefined)
      throw error
    }
    for (const rewrite of rewrites) if (rewrite.next && rewrite.data) this.segments.remember(rewrite.next, rewrite.data, rewrite.size)
    await this.processDeletions([...rewrites.map((rewrite) => rewrite.old.storageKey), ...freed])
    const ids = removed.map((entry) => entry.turn.messageId)
    for (const id of ids) store.onChange?.(sessionId, id)
    return ids
  }

  // ------------------------------------------------------------------ sealing

  /** Encodes, uploads and verifies a segment; the caller commits its manifest entry. */
  private async writeSegment(sessionId: string, n: number, turns: SqlRow[], messages: SqlRow[], rev?: string) {
    const blobs = this.blobs
    if (!blobs) throw new SegmentError("segments_unavailable", "no file store is configured for sealed history")
    const seqs = messages.map((row) => num(row, "seq"))
    const header: SegmentHeader = {
      format: SEGMENT_FORMAT,
      version: SEGMENT_VERSION,
      sessionId,
      n,
      seqFrom: seqs.length ? Math.min(...seqs) : 0,
      seqTo: seqs.length ? Math.max(...seqs) : 0,
      turnFrom: str(turns[0] ?? {}, "message_id"),
      turnTo: str(turns[turns.length - 1] ?? {}, "message_id"),
      createdAt: this.now(),
    }
    const data: SegmentData = { header, turns, messages }
    const bytes = await encodeSegment(data)
    const sha256 = sha256Hex(bytes)
    const storageKey = segmentKey(sessionId, n, rev)
    await blobs.put(storageKey, bytes, "application/gzip")
    // Read back and verify before anything refers to it.
    const back = await blobs.get(storageKey)
    if (!back || sha256Hex(back) !== sha256) {
      await blobs.delete(storageKey).catch(() => undefined)
      throw new SegmentError("segment_corrupt", "the uploaded segment did not read back intact")
    }
    const times = turns.flatMap((row) => [num(row, "created_at"), num(row, "updated_at")])
    const entry: ManifestEntry = {
      sessionId,
      n,
      seqFrom: header.seqFrom,
      seqTo: header.seqTo,
      timeFrom: times.length ? Math.min(...times) : 0,
      timeTo: times.length ? Math.max(...times) : 0,
      turns: turns.length,
      bytes: bytes.byteLength,
      sha256,
      storageKey,
      formatVersion: SEGMENT_VERSION,
      createdAt: header.createdAt,
    }
    return { entry, data, size: messages.reduce((sum, row) => sum + str(row, "body").length, 0) }
  }

  /**
   * The oldest whole turns of a session that may be sealed, up to about `targetBytes`: a prefix of its turns that are
   * all completed, failed or aborted, with nothing of their task family still open, no next step scheduled, before
   * the model's context (`context_from`, or where a budget-bounded read stops) and not among the newest
   * MIN_HOT_TURNS.
   */
  sealable(sessionId: string, targetBytes: number): { ids: string[]; bytes: number } | null {
    const db = this.store.db
    const turns = db.prepare("SELECT message_id, status FROM turns WHERE session_id = ? ORDER BY rowid").all(sessionId).map((row) => lightTurn.parse(row))
    if (turns.length <= MIN_HOT_TURNS) return null
    const blocked = new Set(turns.filter((turn) => !TERMINAL.has(turn.status)).map((turn) => rootOf(turn.message_id)))
    for (const row of db.prepare("SELECT message_id FROM step_schedule WHERE session_id = ?").all(sessionId)) {
      blocked.add(rootOf(z.object({ message_id: z.string() }).parse(row).message_id))
    }
    const boundary = this.contextBoundary(sessionId)
    const perTurn = new Map<string, { maxSeq: number; bytes: number }>()
    for (const row of db.prepare("SELECT message_id, MAX(seq) AS max_seq, SUM(LENGTH(CAST(body AS BLOB))) AS bytes FROM messages WHERE session_id = ? GROUP BY message_id").all(sessionId)) {
      const value = z.object({ message_id: z.string(), max_seq: z.number(), bytes: z.number() }).parse(row)
      perTurn.set(value.message_id, { maxSeq: value.max_seq, bytes: value.bytes })
    }
    const bodyBytes = new Map<string, number>()
    for (const row of db
      .prepare("SELECT messages.message_id AS message_id, SUM(large_bodies.bytes) AS bytes FROM large_bodies JOIN messages ON messages.session_id = large_bodies.session_id AND messages.seq = large_bodies.seq WHERE large_bodies.session_id = ? GROUP BY messages.message_id")
      .all(sessionId)) {
      const value = z.object({ message_id: z.string(), bytes: z.number() }).parse(row)
      bodyBytes.set(value.message_id, value.bytes)
    }
    const ids: string[] = []
    let bytes = 0
    for (const turn of turns.slice(0, turns.length - MIN_HOT_TURNS)) {
      if (!TERMINAL.has(turn.status) || blocked.has(rootOf(turn.message_id))) break
      const info = perTurn.get(turn.message_id)
      if (boundary !== null && info && info.maxSeq >= boundary) break
      ids.push(turn.message_id)
      bytes += (info?.bytes ?? 0) + (bodyBytes.get(turn.message_id) ?? 0)
      if (bytes >= targetBytes) break
    }
    return ids.length ? { ids, bytes } : null
  }

  /**
   * Where the model's view starts: `context_from` once the conversation outgrew the context; before that, where a
   * budget-bounded context read of the newest turn stops (as Store.contextMessages reads). Null with no transcript.
   */
  private contextBoundary(sessionId: string): number | null {
    const { store } = this
    const from = store.contextFrom(sessionId)
    if (from !== null) return from
    let used = 0
    let current: string | null = null
    let previous: string | null = null
    let oldest: number | null = null
    for (const row of store.db
      .prepare("SELECT seq, message_id, body FROM messages WHERE session_id = ? AND message_id NOT IN (SELECT message_id FROM turns WHERE session_id = ? AND kind = 'task') ORDER BY seq DESC")
      .iterate(sessionId, sessionId)) {
      const value = z.object({ seq: z.number(), message_id: z.string(), body: z.string() }).parse(row)
      // The newest turn plays the current one: its own rows don't count against the budget.
      if (current === null) current = value.message_id
      else if (used > this.settings.contextCharBudget && value.message_id !== previous) break
      oldest = value.seq
      previous = value.message_id
      if (value.message_id === current) continue
      const message = messageSchema.safeParse(JSON.parse(value.body))
      used += message.success && message.data.role === "tool" ? Math.min(message.data.output.length, 1_000) + 200 : value.body.length
    }
    return oldest
  }

  /** The rows a seal of these turns writes, read the same way again inside its transaction to see nothing changed. */
  private sealRows(sessionId: string, ids: string[]) {
    const db = this.store.db
    const turns: SqlRow[] = []
    const messages: SqlRow[] = []
    const refs: SqlRow[] = []
    for (let index = 0; index < ids.length; index += ID_CHUNK) {
      const chunk = ids.slice(index, index + ID_CHUNK)
      const marks = chunk.map(() => "?").join(", ")
      turns.push(...db.prepare(`SELECT * FROM turns WHERE session_id = ? AND message_id IN (${marks})`).all(sessionId, ...chunk).map((row) => sqlRow.parse(row)))
      messages.push(...db.prepare(`SELECT * FROM messages WHERE session_id = ? AND message_id IN (${marks})`).all(sessionId, ...chunk).map((row) => sqlRow.parse(row)))
      refs.push(
        ...db
          .prepare(`SELECT * FROM large_bodies WHERE session_id = ? AND seq IN (SELECT seq FROM messages WHERE session_id = ? AND message_id IN (${marks}))`)
          .all(sessionId, sessionId, ...chunk)
          .map((row) => sqlRow.parse(row)),
      )
    }
    const order = new Map(ids.map((id, position) => [id, position]))
    turns.sort((left, right) => (order.get(str(left, "message_id")) ?? 0) - (order.get(str(right, "message_id")) ?? 0))
    messages.sort((left, right) => num(left, "seq") - num(right, "seq"))
    refs.sort((left, right) => num(left, "seq") - num(right, "seq"))
    return { turns, messages, refs }
  }

  /**
   * Seals one segment of the session's oldest sealable turns: written, uploaded, read back and verified; then in one
   * transaction the rows are checked unchanged (else the object is deleted and nothing happens), the manifest entry is
   * added, the hot rows go and the Den index update is queued. A crash before the commit leaves at most an orphan
   * object. `conflict`: something changed meanwhile; `none`: nothing to seal.
   */
  async sealSession(sessionId: string, targetBytes = this.settings.segmentTargetBytes): Promise<"sealed" | "conflict" | "none"> {
    const { store } = this
    if (!this.blobs) throw new SegmentError("segments_unavailable", "no file store is configured for sealed history")
    const selection = this.sealable(sessionId, targetBytes)
    if (!selection) return "none"
    const nextN = () => (numberRow.parse(store.db.prepare("SELECT MAX(n) AS n FROM segments WHERE session_id = ?").get(sessionId)).n ?? 0) + 1
    const n = nextN()
    const read = this.sealRows(sessionId, selection.ids)
    const fingerprint = sha256Hex(JSON.stringify(read))
    // Large bodies go into the segment whole: it alone pages and exports these turns.
    const inlined = await this.inlineBodies(sessionId, read.messages)
    const written = await this.writeSegment(sessionId, n, read.turns.map(withoutGrant), inlined)
    const now = this.now()
    let committed = false
    let freed: string[] = []
    try {
      committed = store.transaction(() => {
        if (sha256Hex(JSON.stringify(this.sealRows(sessionId, selection.ids))) !== fingerprint || nextN() !== n || !this.stillSealable(sessionId, selection.ids)) return false
        insertManifest(store.db, written.entry)
        freed = store.deleteHotTurns(sessionId, selection.ids)
        for (const key of freed) this.queueDeletion(key, "object", now)
        store.db.prepare("DELETE FROM seal_state WHERE session_id = ?").run(sessionId)
        return true
      })
    } catch (error) {
      await this.blobs.delete(written.entry.storageKey).catch(() => undefined)
      throw error
    }
    if (!committed) {
      await this.blobs.delete(written.entry.storageKey).catch(() => undefined)
      return "conflict"
    }
    this.segments.remember(written.entry, written.data, written.size)
    for (const key of freed) this.bodies.forget(key)
    await this.processDeletions(freed)
    return "sealed"
  }

  /** Inside the seal's transaction: still nothing open in the turns' families and no next step scheduled. */
  private stillSealable(sessionId: string, ids: string[]) {
    const db = this.store.db
    const roots = new Set(ids.map(rootOf))
    const open = db.prepare("SELECT message_id FROM turns WHERE session_id = ? AND status NOT IN ('completed', 'failed', 'aborted')").all(sessionId)
    const scheduled = db.prepare("SELECT message_id FROM step_schedule WHERE session_id = ?").all(sessionId)
    return ![...open, ...scheduled].some((row) => roots.has(rootOf(z.object({ message_id: z.string() }).parse(row).message_id)))
  }

  /** Re-encodes every segment of a session (verified on the way), swapping each in its own transaction. */
  async reseal(sessionId: string): Promise<number> {
    let count = 0
    for (const entry of manifestOf(this.store.db, sessionId)) {
      const data = await this.segments.load(entry)
      const written = await this.writeSegment(sessionId, entry.n, data.turns, data.messages, sha256Hex(`${entry.sha256}:${this.now()}`).slice(0, 8))
      const now = this.now()
      const swapped = this.store.transaction(() => {
        if (!replaceManifest(this.store.db, entry.sha256, written.entry)) return false
        this.queueDeletion(entry.storageKey, "object", now)
        return true
      })
      if (!swapped) {
        await this.blobs?.delete(written.entry.storageKey).catch(() => undefined)
        continue
      }
      await this.processDeletions([entry.storageKey])
      count += 1
    }
    return count
  }

  /** Each segment fetched and checked against its manifest checksum and header. */
  async verify(sessionId: string): Promise<Array<{ n: number; ok: boolean; error?: string }>> {
    const results: Array<{ n: number; ok: boolean; error?: string }> = []
    for (const entry of manifestOf(this.store.db, sessionId)) {
      try {
        if (!this.blobs) throw new SegmentError("segments_unavailable")
        const bytes = await this.blobs.get(entry.storageKey)
        if (!bytes) throw new SegmentError("segment_missing")
        if (sha256Hex(bytes) !== entry.sha256) throw new SegmentError("segment_corrupt", "checksum mismatch")
        const data = await this.segments.load(entry)
        if (data.header.sessionId !== sessionId || data.header.n !== entry.n || data.turns.length !== entry.turns) throw new SegmentError("segment_corrupt", "header does not match the manifest")
        results.push({ n: entry.n, ok: true })
      } catch (error) {
        results.push({ n: entry.n, ok: false, error: error instanceof Error ? error.message : "unknown" })
      }
    }
    return results
  }

  /** What a session holds where: hot rows, manifest, large bodies, pending seal failures. */
  inspect(sessionId: string) {
    const db = this.store.db
    const count = (sql: string) => numberRow.parse(db.prepare(sql).get(sessionId)).n ?? 0
    const sealState = z
      .object({ attempt: z.number(), next_attempt_at: z.number(), error: z.string().nullable() })
      .safeParse(db.prepare("SELECT attempt, next_attempt_at, error FROM seal_state WHERE session_id = ?").get(sessionId))
    return {
      sessionId,
      hot: {
        turns: count("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?"),
        messages: count("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?"),
        bytes: z.object({ hot_bytes: z.number().nullable() }).safeParse(db.prepare("SELECT hot_bytes FROM sessions WHERE id = ?").get(sessionId)).data?.hot_bytes ?? null,
        largeBodies: count("SELECT COUNT(*) AS n FROM large_bodies WHERE session_id = ?"),
      },
      segments: manifestOf(db, sessionId),
      sealable: this.sealable(sessionId, Number.POSITIVE_INFINITY),
      sealFailures: sealState.success ? { attempt: sealState.data.attempt, nextAttemptAt: sealState.data.next_attempt_at, error: sealState.data.error } : null,
      orphans: { lastScanAt: Number(readMeta(db, ORPHANS_AT) ?? "0") || null, lastCount: Number(readMeta(db, ORPHANS_COUNT) ?? "0") },
    }
  }

  /** Seals everything sealable in a session now, whatever the triggers (the CLI's force-seal). Still never breaks a rule. */
  async sealAll(sessionId: string): Promise<number> {
    let sealed = 0
    for (let round = 0; round < 10_000; round += 1) {
      const result = await this.sealSession(sessionId)
      if (result !== "sealed") break
      sealed += 1
    }
    return sealed
  }

  // ------------------------------------------------------------------ background jobs

  /** The jobs this module runs with no request (registered in createRuntime). */
  jobs(): BackgroundJob[] {
    return [
      { name: "seal", nextAt: () => this.sealNextAt(), run: () => this.sealRun() },
      { name: "segment-orphans", nextAt: () => this.orphansNextAt(), run: () => this.orphansRun() },
    ]
  }

  private sealNextAt(): number | null {
    if (!this.sealing) return null
    if (this.sealMore) return this.now()
    if (this.store.turnsEnded !== this.sealSeen && this.sealDueAt === null) this.sealDueAt = this.now() + SEAL_DEBOUNCE_MS
    if (this.uncounted === null) this.uncounted = this.store.db.prepare("SELECT 1 AS n FROM sessions WHERE hot_bytes IS NULL LIMIT 1").get() !== undefined
    const due = [this.sealDueAt, this.sealRetryAt, this.uncounted ? this.now() : null].filter((at): at is number => at !== null)
    return due.length ? Math.min(...due) : null
  }

  /**
   * One sealer pass: counts a few sessions' hot bytes if any were never counted, then seals at most one segment from
   * the session most in need, when the hot database is over its limit or a session's sealable part is over the
   * segment target. Failures follow 1B's guarantees: a persisted attempt count and backoff, reported as `seal_failed`
   * once they keep failing.
   */
  private async sealRun() {
    const { store } = this
    this.sealSeen = store.turnsEnded
    this.sealDueAt = null
    this.sealMore = false
    // A pass that fails before it ends (reported by BackgroundJobs) looks again in a minute, never in a tight loop.
    this.uncounted = false
    this.sealRetryAt = this.now() + 60_000
    const db = store.db
    const uncounted = db.prepare("SELECT id FROM sessions WHERE hot_bytes IS NULL LIMIT ?").all(COUNT_PER_RUN + 1).map((row) => z.object({ id: z.string() }).parse(row).id)
    for (const id of uncounted.slice(0, COUNT_PER_RUN)) store.countHotBytes(id)
    this.uncounted = uncounted.length > COUNT_PER_RUN
    const now = this.now()
    const total = numberRow.parse(db.prepare("SELECT SUM(hot_bytes) AS n FROM sessions").get()).n ?? 0
    if (total > this.settings.hotLimitBytes * NEAR_LIMIT_SHARE && now - this.nearLimitReportedAt > NEAR_LIMIT_REPORT_MS) {
      this.nearLimitReportedAt = now
      console.warn("[headless-runner] hot database near its limit", { hotBytes: total, limit: this.settings.hotLimitBytes })
      void this.errors?.report({ code: "hot_db_near_limit", level: "warning", tags: { hotBytes: total, limit: this.settings.hotLimitBytes } })
    }
    const overLimit = total > this.settings.hotLimitBytes
    const candidates = db
      .prepare(
        `SELECT id FROM sessions WHERE hot_bytes IS NOT NULL AND ${overLimit ? "1" : "hot_bytes > ?"}
         AND NOT EXISTS (SELECT 1 FROM seal_state WHERE seal_state.session_id = sessions.id AND seal_state.next_attempt_at > ?)
         ORDER BY hot_bytes DESC LIMIT 5`,
      )
      .all(...(overLimit ? [now] : [this.settings.segmentTargetBytes, now]))
      .map((row) => z.object({ id: z.string() }).parse(row).id)
    for (const sessionId of candidates) {
      const selection = this.sealable(sessionId, this.settings.segmentTargetBytes)
      if (!selection || (!overLimit && selection.bytes < this.settings.segmentTargetBytes)) continue
      const started = Date.now()
      try {
        const result = await this.sealSession(sessionId)
        if (result === "sealed") {
          console.log(`[headless-runner] sealed ${JSON.stringify({ sessionId, turns: selection.ids.length, bytes: selection.bytes, ms: Date.now() - started })}`)
        }
        // Sealed (maybe more to do) or something changed meanwhile: look again right away.
        if (result !== "none") this.sealMore = true
      } catch (error) {
        this.sealFailed(sessionId, error, Date.now() - started)
      }
      break
    }
    this.sealRetryAt = numberRow.parse(db.prepare("SELECT MIN(next_attempt_at) AS n FROM seal_state").get()).n
  }

  private sealFailed(sessionId: string, error: unknown, ms: number) {
    const db = this.store.db
    const previous = z.object({ attempt: z.number() }).safeParse(db.prepare("SELECT attempt FROM seal_state WHERE session_id = ?").get(sessionId))
    const attempt = (previous.success ? previous.data.attempt : 0) + 1
    const now = this.now()
    const code = error instanceof SegmentError ? error.code : "seal_error"
    db.prepare(
      `INSERT INTO seal_state (session_id, attempt, next_attempt_at, error, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET attempt = excluded.attempt, next_attempt_at = excluded.next_attempt_at, error = excluded.error, updated_at = excluded.updated_at`,
    ).run(sessionId, attempt, now + sealRetryDelayMs(attempt), code, now)
    console.error("[headless-runner] seal failed", { sessionId, attempt, code, ms, error: error instanceof Error ? error.message : "unknown" })
    if (attempt >= SEAL_REPORT_AFTER) void this.errors?.report({ code: "seal_failed", tags: { sessionId, attempt, reason: code }, error })
  }

  private orphansNextAt(): number | null {
    if (!this.blobs) return null
    if (this.deletionsDueAt === undefined) this.deletionsDueAt = numberRow.parse(this.store.db.prepare("SELECT MIN(due_at) AS n FROM storage_deletions").get()).n
    if (this.sealing && this.orphansDueAt === null) this.orphansDueAt = (Number(readMeta(this.store.db, ORPHANS_AT) ?? "0") || 0) + ORPHAN_SCAN_MS
    const due = [this.deletionsDueAt, this.sealing ? this.orphansDueAt : null].filter((at): at is number => at !== null)
    return due.length ? Math.min(...due) : null
  }

  /** Retries queued deletions; once a day (with sealing on) deletes this cell's unreferenced segments and bodies. */
  private async orphansRun() {
    // A pass that fails before it ends tries again later, never in a tight loop.
    const now = this.now()
    if (this.deletionsDueAt !== null && this.deletionsDueAt !== undefined && this.deletionsDueAt <= now) this.deletionsDueAt = now + 60_000
    await this.processDeletions()
    if (this.sealing && this.orphansDueAt !== null && this.orphansDueAt <= now) {
      this.orphansDueAt = now + 3_600_000
      await this.scanOrphans()
    }
  }

  /**
   * Deletes `sessions/<id>/segments/*` and `sessions/<id>/bodies/*` objects of this cell's sessions that nothing
   * references and that are older than 24 hours (an upload a commit is about to reference is never that old).
   */
  async scanOrphans(): Promise<number> {
    const blobs = this.blobs
    const db = this.store.db
    const now = this.now()
    let orphans = 0
    if (blobs?.list) {
      const sessions = db.prepare("SELECT id FROM sessions ORDER BY rowid").all().map((row) => z.object({ id: z.string() }).parse(row).id)
      for (const sessionId of sessions) {
        const referenced = new Set([
          ...manifestOf(db, sessionId).map((entry) => entry.storageKey),
          ...db.prepare("SELECT DISTINCT storage_key FROM large_bodies WHERE session_id = ?").all(sessionId).map((row) => keyRow.parse(row).storage_key),
        ])
        for (const prefix of [segmentPrefix(sessionId), bodyPrefix(sessionId)]) {
          for (const object of await blobs.list(prefix)) {
            if (referenced.has(object.key) || now - object.lastModified < ORPHAN_MIN_AGE_MS) continue
            // Read the references again: a request may have committed one meanwhile.
            if (this.referenced(object.key)) continue
            await blobs.delete(object.key)
            orphans += 1
          }
        }
      }
    }
    writeMeta(db, ORPHANS_AT, String(now))
    writeMeta(db, ORPHANS_COUNT, String(orphans))
    this.orphansDueAt = now + ORPHAN_SCAN_MS
    if (orphans) console.log(`[headless-runner] orphan objects deleted ${JSON.stringify({ orphans })}`)
    return orphans
  }

  private referenced(key: string) {
    const db = this.store.db
    return (
      db.prepare("SELECT 1 AS n FROM segments WHERE storage_key = ? LIMIT 1").get(key) !== undefined ||
      db.prepare("SELECT 1 AS n FROM large_bodies WHERE storage_key = ? LIMIT 1").get(key) !== undefined ||
      db.prepare("SELECT 1 AS n FROM saved_files WHERE storage_key = ? LIMIT 1").get(key) !== undefined
    )
  }

  /** Pending deletions were added from outside (a moved chat's, handed over by its owner cell): looked at again. */
  deletionsChanged() {
    this.deletionsDueAt = undefined
  }

  /** Queues an object (or a whole prefix) for deletion after the current transaction commits. */
  private queueDeletion(key: string, kind: "object" | "prefix", dueAt: number) {
    this.store.db.prepare("INSERT INTO storage_deletions (key, kind, due_at, attempt) VALUES (?, ?, ?, 0) ON CONFLICT (key) DO UPDATE SET due_at = MIN(due_at, excluded.due_at)").run(key, kind, dueAt)
    this.deletionsDueAt = Math.min(this.deletionsDueAt ?? dueAt, dueAt)
  }

  /**
   * Deletes queued objects that are due (only `keys`, when given). One that is referenced again (a session re-created
   * under the same id, the same large body written again) is kept. A failure is retried later with backoff.
   */
  private async processDeletions(keys?: string[]) {
    const blobs = this.blobs
    if (!blobs) return
    const db = this.store.db
    const now = this.now()
    const rows = (
      keys
        ? keys.flatMap((key) => db.prepare("SELECT key, kind, attempt FROM storage_deletions WHERE key = ?").all(key))
        : db.prepare("SELECT key, kind, attempt FROM storage_deletions WHERE due_at <= ? ORDER BY due_at LIMIT 200").all(now)
    ).map((row) => z.object({ key: z.string(), kind: z.string(), attempt: z.number() }).parse(row))
    for (const row of rows) {
      try {
        if (row.kind === "prefix") {
          const sessionId = /^sessions\/([^/]+)\/$/.exec(row.key)?.[1]
          if (blobs.list && !(sessionId && this.store.getSession(sessionId))) {
            for (const object of await blobs.list(row.key)) if (!this.referenced(object.key)) await blobs.delete(object.key)
          }
        } else if (!this.referenced(row.key)) {
          await blobs.delete(row.key)
        }
        db.prepare("DELETE FROM storage_deletions WHERE key = ?").run(row.key)
      } catch (error) {
        const delay = Math.min(3_600_000, 60_000 * 2 ** Math.min(row.attempt, 6))
        db.prepare("UPDATE storage_deletions SET attempt = attempt + 1, due_at = ? WHERE key = ?").run(now + delay, row.key)
        console.warn("[headless-runner] object deletion failed; retried later", { attempt: row.attempt + 1, error: error instanceof Error ? error.message : "unknown" })
      }
    }
    this.deletionsDueAt = numberRow.parse(db.prepare("SELECT MIN(due_at) AS n FROM storage_deletions").get()).n
  }
}

/** The first transcript seq of each turn in a segment. */
function firstSeqs(data: SegmentData) {
  const starts = new Map<string, number>()
  for (const row of data.messages) {
    const id = str(row, "message_id")
    const seq = num(row, "seq")
    if (!starts.has(id) || seq < (starts.get(id) ?? seq)) starts.set(id, seq)
  }
  return starts
}

/** What the assistant wrote in one turn, its messages joined. */
export function assistantText(entries: StoredMessage[], messageId: string) {
  return entries
    .filter((entry) => entry.messageId === messageId)
    .flatMap((entry) => (entry.message.role === "assistant" && entry.message.text ? [entry.message.text] : []))
    .join("\n\n")
}

/**
 * Overwrites a session's content in place with zero bytes of the same length before its rows are deleted: SQLite then
 * rewrites the same cells (and overflow pages) instead of leaving the old bytes in freed space, and the replicated
 * page images that follow carry zeros. Inside the delete's transaction.
 */
function scrubSession(store: Store, id: string) {
  const zero = (column: string) => `CASE WHEN ${column} IS NULL THEN NULL ELSE zeroblob(LENGTH(CAST(${column} AS BLOB))) END`
  const db = store.db
  db.prepare(`UPDATE messages SET body = ${zero("body")} WHERE session_id = ?`).run(id)
  db.prepare(`UPDATE turns SET prompt = ${zero("prompt")}, attachments = ${zero("attachments")}, error_detail = ${zero("error_detail")}, title = ${zero("title")} WHERE session_id = ?`).run(id)
  db.prepare(`UPDATE files SET content = ${zero("content")} WHERE session_id = ?`).run(id)
  db.prepare(`UPDATE step_checkpoints SET text = ${zero("text")} WHERE session_id = ?`).run(id)
  db.prepare(`UPDATE step_schedule SET state = ${zero("state")} WHERE session_id = ?`).run(id)
  db.prepare(`UPDATE sessions SET title = ${zero("title")}, instructions = ${zero("instructions")}, options = ${zero("options")} WHERE id = ?`).run(id)
}

export type { LargeBodyRef }
