import type { CellsStore, MemoryFile, MemoryWrite } from "./cells-store.js"
import { FILE_LIMITS } from "./files.js"
import type { Session, Store } from "./store.js"

/**
 * Where a conversation's memory/ lives, for the model's context (all files, read once per turn or step) and for the
 * file tools (one file at a time). Everything else in the scratch workspace stays the conversation's own.
 *
 * - No access (null): memory/ is the conversation's own files, as always.
 * - `memoryOf` (legacy): another conversation's files in the same database.
 * - `memoryScope: "owner"`: the owner's memory. Local where it is stored (Node, an owner cell); in a session cell, calls
 *   to the owner cell (see src/worker), one read per context build and each write through.
 *
 * `list` is called once per turn (once per step in step mode) and its files are shown in the system prompt.
 */
export type MemoryAccess = {
  list(): Promise<MemoryFile[]>
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<MemoryWrite>
  delete(path: string): Promise<boolean>
}

/** Picks a conversation's memory, or null when memory/ is its own. */
export type MemoryResolver = (session: Session) => MemoryAccess | null

/** The owner's memory could not be reached: the step fails (retryably) rather than run without it. */
export class MemoryUnavailableError extends Error {
  constructor(readonly code = "memory_unavailable") {
    super(code)
  }
}

/** Another conversation's memory/ files, in the same database (legacy `memoryOf`). */
export function sessionMemory(store: Store, sessionId: string): MemoryAccess {
  return {
    list: async () => store.memoryFiles(sessionId),
    read: async (path) => store.readFile(sessionId, path),
    async write(path, content) {
      const size = Buffer.byteLength(content)
      if (size > FILE_LIMITS.maxFileBytes) return { ok: false, message: `File is larger than ${FILE_LIMITS.maxFileBytes} bytes.` }
      const files = store.listFiles(sessionId)
      const existing = files.find((file) => file.path === path)
      if (!existing && files.length >= FILE_LIMITS.maxFiles) return { ok: false, message: `Workspace already has ${FILE_LIMITS.maxFiles} files.` }
      const total = files.reduce((sum, file) => sum + file.size, 0) - (existing?.size ?? 0) + size
      if (total > FILE_LIMITS.maxSessionBytes) return { ok: false, message: `Workspace would exceed ${FILE_LIMITS.maxSessionBytes} bytes.` }
      store.writeFile(sessionId, path, content)
      return { ok: true, size }
    },
    delete: async (path) => store.deleteFile(sessionId, path),
  }
}

/** The owner's memory, stored in this database (Node host, an owner cell). */
export function localOwnerMemory(cells: CellsStore, owner: string): MemoryAccess {
  return {
    list: async () => cells.ownerMemoryFiles(owner),
    read: async (path) => cells.readOwnerMemory(owner, path),
    write: async (path, content) => cells.writeOwnerMemory(owner, path, content),
    delete: async (path) => cells.deleteOwnerMemory(owner, path),
  }
}

/**
 * Memory where both live in this database: the owner's for `memoryScope: "owner"`, the other conversation's for
 * `memoryOf` (when it still exists), otherwise the conversation's own (null).
 */
export function localMemory(store: Store, cells: CellsStore): MemoryResolver {
  const pick = (session: Session): MemoryAccess | null => {
    if (session.memoryScope === "owner") return session.owner ? localOwnerMemory(cells, session.owner) : null
    if (session.memoryOf && session.memoryOf !== session.id && store.getSession(session.memoryOf)) return sessionMemory(store, session.memoryOf)
    return null
  }
  return (session) => {
    if (!pick(session)) return null
    // Decided again on every call: the owner's memory can take over a shared one while a turn runs (adoptOwnerMemory).
    const now = () => pick(store.getSession(session.id) ?? session) ?? sessionMemory(store, session.id)
    return {
      list: () => now().list(),
      read: (path) => now().read(path),
      write: (path, content) => now().write(path, content),
      delete: (path) => now().delete(path),
    }
  }
}
