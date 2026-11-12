import { randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"
import { mkdir, open, rename, unlink } from "node:fs/promises"
import { join } from "node:path"

/** The runner honours its owner's session access choice; Den signs it into the runner token. */
export const SESSION_ACCESS_CAPABILITY = "remote_session_access_v1"
/**
 * The runner's owner can turn remote access off or leave it unchosen, the
 * runner enforces `off` itself and its session report says whether the owner
 * chose. Den signs it into the runner token.
 */
export const SESSION_CHOICE_CAPABILITY = "remote_session_choice_v1"
/** What a computer allows when nothing says otherwise: tasks started remotely, and only those sessions. */
const DEFAULT_SESSION_ACCESS_MODE = "created"
/** Narrowest first. */
const SESSION_ACCESS_ORDER = { off: 0, created: 1, all: 2 }
const SESSION_ACCESS_FILE = "access.json"
const SESSION_ACCESS_FILE_MAX_BYTES = 256 * 1024
const SESSION_ACCESS_KEY_MAX_LENGTH = 600
const ATTACHED_COMMANDS_FILE = "attached.json"
/** Ids kept; with the newest kept, an older attach is forgotten only after this many newer ones. */
const ATTACHED_COMMANDS_LIMIT = 4_000
const ATTACHED_COMMAND_ID_MAX_LENGTH = 240
const ATTACHED_COMMANDS_FILE_MAX_BYTES = 2 * 1024 * 1024

/**
 * `off`: nothing reaches this computer. `created`: tasks started remotely. `all`: also sessions started here.
 * @param {unknown} value
 * @returns {value is "off" | "created" | "all"}
 */
export function isSessionAccessMode(value) {
  return value === "off" || value === "created" || value === "all"
}

/**
 * Names the Den and the organization a choice belongs to: the choice made for
 * one organization never applies in another. Null when either is unknown.
 */
export function sessionAccessKey(baseUrl, organizationId) {
  const den = typeof baseUrl === "string" ? baseUrl.trim() : ""
  const organization = typeof organizationId === "string" ? organizationId.trim() : ""
  if (!den || !organization) return null
  const key = `${den}|${organization}`
  return isStoredKey(key) ? key : null
}

const isStoredKey = (key) => typeof key === "string" && key.length > 0 && key.length <= SESSION_ACCESS_KEY_MAX_LENGTH

/**
 * Reads the stored choices. `choices` holds one choice per organization; an
 * organization without one has not chosen. `legacy` is what a version 1 file
 * (one choice for the whole computer) still has to hand to the first
 * organization: `"all"`, or null for its narrow default, which may never have
 * been chosen. It is undefined for every other file. Anything missing, corrupt
 * or unknown is no choice at all, never a wide one.
 * @returns {{ choices: Record<string, "off" | "created" | "all">, legacy?: "all" | null }}
 */
export function parseSessionAccess(text) {
  try {
    const stored = JSON.parse(text)
    if (stored?.version === 1 && typeof stored.mode === "string") return { choices: {}, legacy: stored.mode === "all" ? "all" : null }
    if (stored?.version !== 2 || stored.choices === null || typeof stored.choices !== "object" || Array.isArray(stored.choices)) return { choices: {} }
    /** @type {Record<string, "off" | "created" | "all">} */
    const choices = {}
    for (const [key, mode] of Object.entries(stored.choices)) {
      if (isStoredKey(key) && isSessionAccessMode(mode)) choices[key] = mode
    }
    return { choices }
  } catch {
    return { choices: {} }
  }
}

/**
 * The access in force on this computer, read on every use.
 *
 * - The owner chose `off`: off, whatever Den says.
 * - Otherwise the owner's choice, or for an owner who has not chosen `off`
 *   under the organization's opt-in and `created` without it, capped by the
 *   organization's ceiling. Without a policy from Den the ceiling is `created`.
 * - `all` also needs Den to have accepted this runner for session access.
 * @param {{ choice: unknown, policy: { ceiling: unknown, optIn?: unknown } | null | undefined, capable: unknown }} input
 * @returns {"off" | "created" | "all"}
 */
export function effectiveSessionAccess({ choice, policy, capable }) {
  if (choice === "off") return "off"
  const base = isSessionAccessMode(choice) ? choice : policy?.optIn === true ? "off" : DEFAULT_SESSION_ACCESS_MODE
  // A ceiling this app does not know is treated as the narrowest.
  const cap = policy ? (isSessionAccessMode(policy.ceiling) ? policy.ceiling : "off") : DEFAULT_SESSION_ACCESS_MODE
  const narrower = SESSION_ACCESS_ORDER[base] <= SESSION_ACCESS_ORDER[cap] ? base : cap
  return narrower === "all" && capable !== true ? DEFAULT_SESSION_ACCESS_MODE : narrower
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
 * The owner's choices for this computer, one per organization, kept beside
 * the session-runner journals: `{ "version": 2, "choices": { "<key>": mode } }`
 * with keys from `sessionAccessKey`. An organization without a key has not
 * chosen. `getRoot` is read on every use so Electron's userData path is never
 * needed before the app is ready. The file is read once; after that the
 * choices live here and every change rewrites the file whole.
 */
export function createSessionAccessStore(getRoot) {
  /** `choices` are in force; `wanted` also holds what the owner asked for and is not saved yet. */
  let loaded = null
  let queue = Promise.resolve()
  const load = () => {
    if (loaded === null) {
      const text = readPrivateFile(join(getRoot(), SESSION_ACCESS_FILE), SESSION_ACCESS_FILE_MAX_BYTES)
      const stored = text === null ? { choices: {} } : parseSessionAccess(text)
      loaded = { ...stored, wanted: stored.choices }
    }
    return loaded
  }
  const read = (key) => (typeof key === "string" && Object.hasOwn(load().choices, key) ? load().choices[key] : null)
  /**
   * Saves everything asked for so far, after every earlier save, so the file
   * always holds the latest choices. A choice widens in memory only once it is
   * on disk and still what the owner wants: a narrower one asked for in the
   * meantime is never undone.
   */
  const saveChoice = (key, mode) => {
    const state = load()
    const task = queue.then(async () => {
      try {
        const text = JSON.stringify({ version: 2, choices: state.wanted })
        // A file too large to read back would read as no choices at all.
        if (Buffer.byteLength(text, "utf8") > SESSION_ACCESS_FILE_MAX_BYTES) throw new Error("Too many session access choices")
        await writePrivateFile(getRoot(), SESSION_ACCESS_FILE, text)
      } catch (error) {
        // A wider choice that could not be saved is dropped: a later save must not carry it to disk unasked.
        if (mode !== null && state.wanted[key] === mode && read(key) !== mode) {
          const { [key]: _unsaved, ...kept } = state.wanted
          const inForce = read(key)
          state.wanted = inForce === null ? kept : { ...kept, [key]: inForce }
        }
        throw error
      }
      if (mode !== null && state.wanted[key] === mode) state.choices = { ...state.choices, [key]: mode }
    })
    queue = task.catch(() => undefined)
    return task
  }
  return {
    /** The owner's choice for this organization, or null when they have not chosen. */
    read,
    /**
     * Hands a version 1 file's single choice to the organization this computer
     * is connected to first, and to no other: `all` becomes that
     * organization's choice once the version 2 file is written, the old narrow
     * default becomes "not chosen". Resolves to whether a choice was adopted.
     */
    adoptLegacy(key) {
      const state = load()
      if (state.legacy === undefined || !isStoredKey(key)) return Promise.resolve(false)
      const adopted = state.legacy === "all"
      // Taken at once, so an organization configured a moment later never receives it.
      delete state.legacy
      if (adopted) state.wanted = { ...state.wanted, [key]: "all" }
      return saveChoice(key, adopted ? "all" : null).then(() => adopted)
    },
    /** Narrowing applies before it is saved, widening only once it is. */
    write(key, mode) {
      if (!isSessionAccessMode(mode)) return Promise.reject(new Error("Invalid session access choice"))
      if (!isStoredKey(key)) return Promise.reject(new Error("Invalid session access organization"))
      const state = load()
      state.wanted = { ...state.wanted, [key]: mode }
      if (SESSION_ACCESS_ORDER[mode] <= SESSION_ACCESS_ORDER[read(key) ?? "off"]) state.choices = { ...state.choices, [key]: mode }
      return saveChoice(key, mode)
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
