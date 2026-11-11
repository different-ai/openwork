import { randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"
import { mkdir, open, rename, unlink } from "node:fs/promises"
import { join } from "node:path"

/** The runner honours its owner's session access choice; Den signs it into the runner token. */
export const SESSION_ACCESS_CAPABILITY = "remote_session_access_v1"
/** Only sessions started remotely: what every computer allows until its owner chooses otherwise. */
const DEFAULT_SESSION_ACCESS_MODE = "created"
const SESSION_ACCESS_FILE = "access.json"
const SESSION_ACCESS_FILE_MAX_BYTES = 4 * 1024
const ATTACHED_COMMANDS_FILE = "attached.json"
/** Ids kept; with the newest kept, an older attach is forgotten only after this many newer ones. */
const ATTACHED_COMMANDS_LIMIT = 4_000
const ATTACHED_COMMAND_ID_MAX_LENGTH = 240
const ATTACHED_COMMANDS_FILE_MAX_BYTES = 2 * 1024 * 1024

export function isSessionAccessMode(value) {
  return value === "created" || value === "all"
}

/**
 * Reads the stored choice. Anything missing, corrupt or unknown is the narrow default, never the wide one.
 * @returns {"created" | "all"}
 */
export function parseSessionAccess(text) {
  try {
    const stored = JSON.parse(text)
    return stored?.version === 1 && stored.mode === "all" ? "all" : DEFAULT_SESSION_ACCESS_MODE
  } catch {
    return DEFAULT_SESSION_ACCESS_MODE
  }
}

/**
 * The access in force on this computer. Sessions started here are reachable
 * only when the owner chose it, the organization allows it and Den accepted
 * this runner for it; everything else is the narrow default.
 * @param {{ mode: unknown, ceiling: unknown, capable: unknown }} input
 * @returns {"created" | "all"}
 */
export function effectiveSessionAccess({ mode, ceiling, capable }) {
  return mode === "all" && ceiling === "all" && capable === true ? "all" : DEFAULT_SESSION_ACCESS_MODE
}

/**
 * Reads a small private file beside the session-runner journals, or null
 * when it is missing, too large or not a plain file. A substituted symlink is
 * never followed, as for the journals.
 */
function readPrivateFile(filePath, maxBytes) {
  let descriptor
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > maxBytes) return null
    return readFileSync(descriptor, "utf8")
  } catch {
    return null
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** Replaces a private file whole: a reader sees the old contents or the new, never part of either. */
async function writePrivateFile(root, name, text) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const temporaryPath = join(root, `.${name}-${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporaryPath, "wx", 0o600)
    await handle.writeFile(text, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporaryPath, join(root, name))
    // Persist the rename where directory fsync is supported; Windows cannot open directories.
    if (process.platform !== "win32") {
      const directoryHandle = await open(root, constants.O_RDONLY)
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    }
  } finally {
    await handle?.close()
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error
    })
  }
}

/**
 * The owner's choice for this computer, kept beside the session-runner
 * journals. It belongs to the computer, not to an account or workspace.
 * `getRoot` is read on every use so Electron's userData path is never needed
 * before the app is ready.
 */
export function createSessionAccessStore(getRoot) {
  return {
    read() {
      const text = readPrivateFile(join(getRoot(), SESSION_ACCESS_FILE), SESSION_ACCESS_FILE_MAX_BYTES)
      return text === null ? DEFAULT_SESSION_ACCESS_MODE : parseSessionAccess(text)
    },
    async write(mode) {
      if (!isSessionAccessMode(mode)) throw new Error("Invalid session access choice")
      await writePrivateFile(getRoot(), SESSION_ACCESS_FILE, JSON.stringify({ version: 1, mode }))
    },
  }
}

/** Reads the recorded attach commands, oldest first. Anything missing, corrupt or unknown is an empty record. */
export function parseAttachedCommands(text) {
  try {
    const stored = JSON.parse(text)
    if (stored?.version !== 1 || !Array.isArray(stored.commands)) return []
    const commands = stored.commands.filter((id) => typeof id === "string" && id && id.length <= ATTACHED_COMMAND_ID_MAX_LENGTH)
    return [...new Set(commands)].slice(-ATTACHED_COMMANDS_LIMIT)
  } catch {
    return []
  }
}

/**
 * Every attach command this computer has taken, kept beside the owner's
 * choice. The journal forgets a command once it is pruned; this record still
 * knows it reached a session that was started here, so a later request for it
 * is never served as if the session had been started remotely. The newest
 * ids are kept. A command is recorded only once it is on disk.
 */
export function createAttachedCommandStore(getRoot) {
  let commands = null
  let queue = Promise.resolve()
  const load = () => {
    if (commands === null) {
      const text = readPrivateFile(join(getRoot(), ATTACHED_COMMANDS_FILE), ATTACHED_COMMANDS_FILE_MAX_BYTES)
      commands = new Set(text === null ? [] : parseAttachedCommands(text))
    }
    return commands
  }
  return {
    has(commandId) {
      return load().has(commandId)
    },
    /** Resolves once every id is durable; rejects, recording nothing, when the record cannot be written. */
    record(commandIds) {
      const task = queue.then(async () => {
        const known = load()
        const added = commandIds.filter((id) => !known.has(id))
        if (added.some((id) => typeof id !== "string" || !id || id.length > ATTACHED_COMMAND_ID_MAX_LENGTH)) {
          throw new Error("Invalid attach command id")
        }
        if (added.length === 0) return
        const next = [...known, ...added].slice(-ATTACHED_COMMANDS_LIMIT)
        await writePrivateFile(getRoot(), ATTACHED_COMMANDS_FILE, JSON.stringify({ version: 1, commands: next }))
        commands = new Set(next)
      })
      queue = task.catch(() => undefined)
      return task
    },
  }
}
