import type { CellsStore, MemoryFile, MemoryWrite } from "./cells-store.js"
import { FILE_LIMITS } from "./files.js"
import type { Session, Store } from "./store.js"

export type MemoryAccess = {
  list(): Promise<MemoryFile[]>
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<MemoryWrite>
  delete(path: string): Promise<boolean>
}

export type MemoryResolver = (session: Session) => MemoryAccess | null

export class MemoryUnavailableError extends Error {
  constructor(readonly code = "memory_unavailable") {
    super(code)
  }
}

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

export function localOwnerMemory(cells: CellsStore, owner: string): MemoryAccess {
  return {
    list: async () => cells.ownerMemoryFiles(owner),
    read: async (path) => cells.readOwnerMemory(owner, path),
    write: async (path, content) => cells.writeOwnerMemory(owner, path, content),
    delete: async (path) => cells.deleteOwnerMemory(owner, path),
  }
}

export function localMemory(store: Store, cells: CellsStore): MemoryResolver {
  const pick = (session: Session): MemoryAccess | null => {
    if (session.memoryScope === "owner") return session.owner ? localOwnerMemory(cells, session.owner) : null
    if (session.memoryOf && session.memoryOf !== session.id && store.getSession(session.memoryOf)) return sessionMemory(store, session.memoryOf)
    return null
  }
  return (session) => {
    if (!pick(session)) return null
    const now = () => pick(store.getSession(session.id) ?? session) ?? sessionMemory(store, session.id)
    return {
      list: () => now().list(),
      read: (path) => now().read(path),
      write: (path, content) => now().write(path, content),
      delete: (path) => now().delete(path),
    }
  }
}
