const MAX_ENTRIES = 4_000
const MAX_BYTES = 32 * 1024 * 1024
const TTL_MS = 15 * 60_000

type Entry = { revision: string; text: string; bytes: number; expiresAt: number }

const entries = new Map<string, Entry>()
let totalBytes = 0

export type SkillReadKey = { organizationId: string; userId: string; uri: string; revision: string }

export function isSkillDocumentUri(uri: string | null): uri is string {
  return typeof uri === "string" && /^skill:\/\/[^/]+\/SKILL\.md$/.test(uri)
}

export function isSkillFileUri(uri: string | null): uri is string {
  return typeof uri === "string" && /^skill:\/\/[^/]+\/.+$/.test(uri) && !isSkillDocumentUri(uri)
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

export function skillReadResponse(id: string | number, uri: string, text: string): Response {
  return Response.json({ jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "text/markdown", text }] } })
}

export function resetSkillReadCacheForTests() {
  entries.clear()
  totalBytes = 0
}
