import { z } from "zod"
import type { BackgroundJob } from "./background.js"
import { cellRow, directoryEntry, handoffSchema, type CellsStore, type DirectoryEntry } from "./cells-store.js"
import { MemoryUnavailableError, type MemoryAccess, type MemoryResolver } from "./memory.js"
import type { Store } from "./store.js"

export type InternalPath =
  | "/internal/owner-directory"
  | "/internal/memory"
  | "/internal/import/begin"
  | "/internal/import/rows"
  | "/internal/import/commit"
  | "/internal/import/abort"
  | "/internal/import/handoff"
export const INTERNAL_PATHS: ReadonlySet<string> = new Set<InternalPath>([
  "/internal/owner-directory",
  "/internal/memory",
  "/internal/import/begin",
  "/internal/import/rows",
  "/internal/import/commit",
  "/internal/import/abort",
  "/internal/import/handoff",
])

export class CellCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`cell_call_failed:${status}:${code}`)
  }
}

export type CellCall = (cell: string, path: InternalPath, body: unknown) => Promise<unknown>
export type CellIdentity = { kind: "owner"; owner: string } | { kind: "session"; sessionId: string } | { kind: "service" }
export type InternalAnswer = { status: number; body: unknown }

export const ownerCellName = (owner: string) => `owner:${owner}`
export const sessionCellName = (sessionId: string) => `session:${sessionId}`
export const SESSION_CELL_ID = /^hs_c_[a-f0-9]{32}$/

const IMPORT_BATCH_BYTES = 2 * 1024 * 1024
const BUSY_RETRY_MS = 60_000
const BLOCKED_RETRY_MS = 24 * 3_600_000
const REPORT_AFTER = 5
const TITLE_RECHECK_MS = 15_000
const TITLE_WAIT_MS = 120_000

const memoryRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list") }).strict(),
  z.object({ op: z.literal("read"), path: z.string().min(1).max(200) }).strict(),
  z.object({ op: z.literal("write"), path: z.string().min(1).max(200), content: z.string() }).strict(),
  z.object({ op: z.literal("delete"), path: z.string().min(1).max(200) }).strict(),
])
const directoryRequest = z.object({ sessionId: z.string().min(1).max(200), version: z.number().int().min(1), entry: directoryEntry }).strict()
const importStart = z.object({ owner: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const importRowsRequest = z.object({ owner: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), table: z.string().regex(/^[a-z_][a-z0-9_]*$/), rows: z.array(cellRow).max(10_000) }).strict()
const importAbort = z.object({ owner: z.string().min(1).max(200), sessionId: z.string().min(1).max(200) }).strict()
const importHandoff = z.object({ owner: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), handoff: handoffSchema }).strict()
const memoryFiles = z.object({ files: z.array(z.object({ path: z.string(), content: z.string(), updatedAt: z.number().optional() })) })
const memoryContent = z.object({ content: z.string().nullable() })
const memoryWritten = z.union([z.object({ ok: z.literal(true), size: z.number() }), z.object({ ok: z.literal(false), message: z.string() })])
const memoryDeleted = z.object({ deleted: z.boolean() })
const importState = z.object({ state: z.enum(["copying", "complete", "aborted"]) }).loose()

const error = (status: number, code: string): InternalAnswer => ({ status, body: { error: code } })

export type SplitStatus = "not_needed" | "started" | "running" | "done"

export class SessionCells {
  private recheckAt: number | null = null

  constructor(
    private readonly options: {
      store: Store
      cells: CellsStore
      self: () => CellIdentity | null
      call: CellCall
      moved?: (sessionId: string) => void
      imported?: () => void
      handedOver?: () => void
      report?: (code: string, error: unknown) => void
      pauseMs?: number
      now?: () => number
    },
  ) {}

  private now() {
    return (this.options.now ?? Date.now)()
  }

  private ownedSession(): { sessionId: string; owner: string } | null {
    const self = this.options.self()
    if (self?.kind !== "session") return null
    const owner = this.options.cells.cellOwner()
    return owner ? { sessionId: self.sessionId, owner } : null
  }

  async handle(from: string, path: string, body: unknown): Promise<InternalAnswer> {
    const self = this.options.self()
    if (!self) return error(400, "invalid_cell")
    const { cells, store } = this.options
    if (path === "/internal/owner-directory") {
      if (self.kind !== "owner") return error(404, "not_found")
      const parsed = directoryRequest.safeParse(body)
      if (!parsed.success) return error(400, "invalid_request")
      if (from !== sessionCellName(parsed.data.sessionId)) return error(403, "wrong_cell")
      cells.upsertDirectory(self.owner, parsed.data.sessionId, parsed.data.version, parsed.data.entry)
      return { status: 200, body: { ok: true } }
    }
    if (path === "/internal/memory") {
      if (self.kind !== "owner" || !from.startsWith("session:")) return error(404, "not_found")
      const caller = from.slice("session:".length)
      if (!cells.directoryHas(self.owner, caller) && cells.forwardOf(caller)?.owner !== self.owner) return error(404, "not_found")
      const parsed = memoryRequest.safeParse(body)
      if (!parsed.success) return error(400, "invalid_request")
      const request = parsed.data
      if (request.op === "list") return { status: 200, body: { files: cells.ownerMemoryFiles(self.owner) } }
      if (request.op === "read") return { status: 200, body: { content: cells.readOwnerMemory(self.owner, request.path) } }
      if (request.op === "write") return { status: 200, body: cells.writeOwnerMemory(self.owner, request.path, request.content) }
      return { status: 200, body: { deleted: cells.deleteOwnerMemory(self.owner, request.path) } }
    }
    if (!path.startsWith("/internal/import/")) return error(404, "not_found")
    if (self.kind !== "session") return error(404, "not_found")
    const schema = path === "/internal/import/rows" ? importRowsRequest : path === "/internal/import/abort" ? importAbort : path === "/internal/import/handoff" ? importHandoff : importStart
    const parsed = schema.safeParse(body)
    if (!parsed.success) return error(400, "invalid_request")
    const { owner, sessionId } = parsed.data
    if (sessionId !== self.sessionId || from !== ownerCellName(owner)) return error(403, "wrong_cell")
    const claimed = cells.cellOwner()
    if (claimed !== null && claimed !== owner) return error(409, "owner_mismatch")
    const state = cells.meta("import")
    const exists = store.getSession(sessionId) !== null
    if (path === "/internal/import/begin") {
      const start = importStart.parse(body)
      if (exists && state === `complete:${start.fingerprint}`) return { status: 200, body: { state: "complete" } }
      if (exists && (state === null || state === "live")) return error(409, "session_exists")
      cells.atomic(() => {
        cells.deleteSessionRows(sessionId)
        cells.claimCellOwner(owner)
        cells.setMeta("import", "copying")
      })
      return { status: 200, body: { state: "copying" } }
    }
    if (path === "/internal/import/handoff") {
      const { handoff } = importHandoff.parse(body)
      cells.applyHandoff(sessionId, handoff, () => store.enqueueIndexUpdate(sessionId), () => store.countHotBytes(sessionId))
      this.options.handedOver?.()
      return { status: 200, body: { state: "handed_over" } }
    }
    if (path === "/internal/import/abort") {
      if (state === "live") return error(409, "session_live")
      cells.atomic(() => {
        cells.deleteSessionRows(sessionId)
        cells.setMeta("import", null)
        cells.setMeta("index_hold", null)
      })
      return { status: 200, body: { state: "aborted" } }
    }
    if (state !== "copying") return error(409, "not_importing")
    if (path === "/internal/import/rows") {
      const rows = importRowsRequest.parse(body)
      if (rows.rows.some((row) => (rows.table === "sessions" ? row.id : row.session_id) !== sessionId)) return error(400, "id_mismatch")
      try {
        cells.importRows(rows.table, rows.rows)
      } catch (failure) {
        return error(400, failure instanceof Error ? failure.message.split(":")[0] ?? "invalid_rows" : "invalid_rows")
      }
      return { status: 200, body: { ok: true } }
    }
    if (path === "/internal/import/commit") {
      const commit = importStart.parse(body)
      const fingerprint = cells.fingerprint(sessionId)
      if (fingerprint !== commit.fingerprint) {
        cells.atomic(() => {
          cells.deleteSessionRows(sessionId)
          cells.setMeta("import", null)
        })
        return error(409, "fingerprint_mismatch")
      }
      const entry = cells.currentEntry(sessionId)
      cells.atomic(() => {
        cells.setMeta("import", `complete:${fingerprint}`)
        cells.setMeta("index_hold", "1")
        if (entry) cells.seedDirectory(sessionId, owner, entry, 1)
      })
      this.options.imported?.()
      return { status: 200, body: { state: "complete", fingerprint } }
    }
    return error(404, "not_found")
  }

  markLive() {
    const state = this.options.cells.meta("import")
    if (state?.startsWith("complete:")) this.options.cells.setMeta("import", "live")
  }

  memoryResolver(local: MemoryResolver): MemoryResolver {
    return (session) => {
      const owned = this.ownedSession()
      if (session.memoryScope !== "owner" || !owned || owned.sessionId !== session.id) return local(session)
      return this.remoteMemory(owned.owner)
    }
  }

  private remoteMemory(owner: string): MemoryAccess {
    const ask = async (body: z.infer<typeof memoryRequest>) => {
      let last: unknown
      let listed = false
      for (const wait of [0, 250, 1_000]) {
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
        try {
          return await this.options.call(ownerCellName(owner), "/internal/memory", body)
        } catch (failure) {
          last = failure
          if (!listed && failure instanceof CellCallError && failure.status === 404) {
            listed = true
            await this.sendDirectory(true).catch(() => undefined)
            continue
          }
          if (failure instanceof CellCallError && failure.status >= 400 && failure.status < 500) break
        }
      }
      console.error("[headless-cells] owner memory unavailable", { error: last instanceof Error ? last.message : "unknown" })
      throw new MemoryUnavailableError()
    }
    return {
      list: async () => memoryFiles.parse(await ask({ op: "list" })).files,
      read: async (path) => memoryContent.parse(await ask({ op: "read", path })).content,
      write: async (path, content) => memoryWritten.parse(await ask({ op: "write", path, content })),
      delete: async (path) => memoryDeleted.parse(await ask({ op: "delete", path })).deleted,
    }
  }

  refreshDirectory() {
    const owned = this.ownedSession()
    if (!owned) return
    try {
      this.options.cells.refreshDirectory(owned.sessionId, owned.owner)
      const session = this.options.store.getSession(owned.sessionId)
      const recent = session !== null && this.now() - session.updatedAt < TITLE_WAIT_MS
      this.recheckAt = session?.autoTitle && session.title === "" && recent && this.options.cells.currentEntry(owned.sessionId)?.hasTurns ? this.now() + TITLE_RECHECK_MS : null
    } catch (failure) {
      console.error("[headless-cells] directory refresh failed", { error: failure instanceof Error ? failure.message : "unknown" })
    }
  }

  async syncDirectory(): Promise<boolean> {
    this.refreshDirectory()
    try {
      await this.sendDirectory()
      return true
    } catch {
      return false
    }
  }

  private async sendDirectory(now = false) {
    const owned = this.ownedSession()
    if (!owned) return
    const pending = this.options.cells.pendingDirectory()
    if (!pending || (!now && pending.dueAt > this.now())) return
    try {
      await this.options.call(ownerCellName(pending.owner), "/internal/owner-directory", { sessionId: pending.sessionId, version: pending.version, entry: pending.entry })
      this.options.cells.ackDirectory(pending.sessionId, pending.version)
    } catch (failure) {
      const attempt = this.options.cells.deferDirectory(pending.sessionId, pending.version)
      if (attempt >= REPORT_AFTER) throw failure
    }
  }

  directoryJob(): BackgroundJob {
    return {
      name: "owner-directory",
      nextAt: () => {
        if (!this.ownedSession()) return null
        const due = this.options.cells.pendingDirectory()?.dueAt ?? null
        return due === null ? this.recheckAt : this.recheckAt === null ? due : Math.min(due, this.recheckAt)
      },
      run: async () => {
        this.refreshDirectory()
        await this.sendDirectory()
      },
    }
  }

  startSplit(): SplitStatus {
    const self = this.options.self()
    if (self?.kind !== "owner") return "not_needed"
    const { cells } = this.options
    const state = cells.meta("split")
    const left = cells.legacySessions(self.owner).length + (cells.pendingHandoff() ? 1 : 0)
    if (left === 0) {
      if (state === "running") cells.setMeta("split", "done")
      return state === null ? "not_needed" : "done"
    }
    if (state === "running") return "running"
    cells.setMeta("split", "running")
    return "started"
  }

  splitJob(): BackgroundJob {
    return {
      name: "owner-split",
      nextAt: () => {
        const self = this.options.self()
        if (self?.kind !== "owner" || this.options.cells.meta("split") !== "running") return null
        const row = this.options.cells.db
          .prepare("SELECT MIN(COALESCE(split_progress.next_attempt_at, 0)) AS n FROM sessions LEFT JOIN split_progress ON split_progress.session_id = sessions.id WHERE sessions.owner = ?")
          .get(self.owner)
        const moving = z.object({ n: z.number().nullable() }).parse(row).n
        const handoff = this.options.cells.pendingHandoff()?.dueAt ?? null
        const due = moving === null ? handoff : handoff === null ? moving : Math.min(moving, handoff)
        const now = this.now()
        return due === null || due <= now ? now : due
      },
      run: () => this.splitOnce(),
    }
  }

  private async splitOnce() {
    const self = this.options.self()
    if (self?.kind !== "owner") return
    const { cells } = this.options
    if (cells.meta("split") !== "running") return
    cells.adoptOwnerMemory(self.owner)
    const handoff = cells.pendingHandoff()
    if (handoff && handoff.dueAt <= this.now()) await this.sendHandoff(self.owner, handoff.sessionId, handoff.handoff)
    const legacy = cells.legacySessions(self.owner)
    if (legacy.length === 0) {
      if (!cells.pendingHandoff()) cells.setMeta("split", "done")
      return
    }
    const now = this.now()
    const next = legacy.find((id) => (cells.progress(id)?.next_attempt_at ?? 0) <= now)
    if (next) await this.move(self.owner, next)
  }

  private async move(owner: string, sessionId: string) {
    const { cells, call } = this.options
    if (cells.busy(sessionId)) {
      cells.deferProgress(sessionId, "busy", this.now() + BUSY_RETRY_MS)
      return
    }
    const attempt = cells.startProgress(sessionId, "copying")
    const cell = sessionCellName(sessionId)
    const fingerprint = cells.fingerprint(sessionId)
    try {
      const begun = importState.parse(await call(cell, "/internal/import/begin", { owner, sessionId, fingerprint }))
      if (begun.state === "copying") {
        for (const table of cells.copyTables()) {
          for (let after = 0, done = false; !done; ) {
            const page = cells.exportPage(table, sessionId, after, IMPORT_BATCH_BYTES)
            after = page.lastRowid
            done = page.done
            if (page.rows.length) await call(cell, "/internal/import/rows", { owner, sessionId, table, rows: page.rows })
            if (this.options.pauseMs) await new Promise((resolve) => setTimeout(resolve, this.options.pauseMs))
          }
        }
        await call(cell, "/internal/import/commit", { owner, sessionId, fingerprint })
      }
    } catch (failure) {
      if (failure instanceof CellCallError && failure.code === "session_exists") {
        cells.deferProgress(sessionId, "blocked", this.now() + BLOCKED_RETRY_MS)
        this.options.report?.("owner_split_blocked", failure)
        return
      }
      if (attempt >= REPORT_AFTER) throw failure
      return
    }
    if (cells.busy(sessionId) || cells.fingerprint(sessionId) !== fingerprint) {
      cells.deferProgress(sessionId, "changed", this.now())
      await call(cell, "/internal/import/abort", { owner, sessionId }).catch(() => undefined)
      return
    }
    const entry: DirectoryEntry | null = cells.currentEntry(sessionId)
    if (!entry) return
    cells.finishMove({ sessionId, owner, cell, entry, version: 1 })
    this.options.moved?.(sessionId)
    console.log(`[headless-cells] chat moved to its own cell ${JSON.stringify({ sessionId })}`)
    const handoff = cells.pendingHandoff()
    if (handoff?.sessionId === sessionId) await this.sendHandoff(owner, sessionId, handoff.handoff)
  }

  private async sendHandoff(owner: string, sessionId: string, handoff: z.infer<typeof handoffSchema>) {
    const { cells } = this.options
    try {
      await this.options.call(sessionCellName(sessionId), "/internal/import/handoff", { owner, sessionId, handoff })
      cells.handoffDone(sessionId)
    } catch (failure) {
      if (cells.deferHandoff(sessionId) >= REPORT_AFTER) throw failure
    }
  }
}
