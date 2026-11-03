/**
 * Recently served skill:// SKILL.md reads, so a client that reads the same
 * skill again does not rebuild the member's whole MCP surface to get it.
 *
 * Desktops load organization skills in the background and, in some versions,
 * re-read every one of them on each refresh. Each read is otherwise a full
 * /mcp/agent request: catalog, features, member, connection readiness and the
 * skill's own authorization, for bytes that have not changed.
 *
 * An entry is reused only for the same organization, user and URI at the same
 * inventory revision (cache.inventory.revision). The revision moves after any
 * write that can change what a member may use, including skill edits, plugin,
 * marketplace and team access, membership, feature flags and every deploy, so
 * a reused body is one the member could read at that revision. Token checks
 * still run on every request. A write made outside any request does not move
 * the revision, so an entry lasts at most 15 minutes: the same limit desktops
 * already apply before they reload an inventory whose revision is unchanged.
 *
 * Kept free of database and environment imports so it can be unit tested.
 */

const MAX_ENTRIES = 4_000
const MAX_BYTES = 32 * 1024 * 1024
const TTL_MS = 15 * 60_000

type Entry = { revision: string; text: string; bytes: number; expiresAt: number }

const entries = new Map<string, Entry>()
let totalBytes = 0

export type SkillReadKey = { organizationId: string; userId: string; uri: string; revision: string }

/** A SKILL.md document, not the skill index or another resource. */
export function isSkillDocumentUri(uri: string | null): uri is string {
  return typeof uri === "string" && /^skill:\/\/[^/]+\/SKILL\.md$/.test(uri)
}

function entryKey(key: SkillReadKey) {
  return `${key.organizationId}\u0000${key.userId}\u0000${key.uri}`
}

function drop(id: string) {
  const entry = entries.get(id)
  if (!entry) return
  entries.delete(id)
  totalBytes -= entry.bytes
}

export function readCachedSkill(key: SkillReadKey, now = Date.now()): string | null {
  const id = entryKey(key)
  const entry = entries.get(id)
  if (!entry) return null
  if (entry.revision !== key.revision || entry.expiresAt <= now) {
    drop(id)
    return null
  }
  // Most recently used last, so the oldest entries go first.
  entries.delete(id)
  entries.set(id, entry)
  return entry.text
}

export function rememberSkillRead(key: SkillReadKey, text: string, now = Date.now()) {
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes > MAX_BYTES / 8) return
  const id = entryKey(key)
  drop(id)
  entries.set(id, { revision: key.revision, text, bytes, expiresAt: now + TTL_MS })
  totalBytes += bytes
  for (const oldest of entries.keys()) {
    if (entries.size <= MAX_ENTRIES && totalBytes <= MAX_BYTES) break
    drop(oldest)
  }
}

/** The JSON-RPC result a resources/read for one SKILL.md returns. */
export function skillReadResponse(id: string | number, uri: string, text: string): Response {
  return Response.json({ jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "text/markdown", text }] } })
}

export function resetSkillReadCacheForTests() {
  entries.clear()
  totalBytes = 0
}
