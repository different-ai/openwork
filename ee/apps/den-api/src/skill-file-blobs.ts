import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { SkillFileBlobTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { sha256Hex, skillFileText, skillFilesFromPayload, type SkillFileBody, type SkillFileEntry } from "./skill-files.js"

/**
 * Stores supporting-file contents once per organization (skill_file_blob) and
 * returns the entries a version lists. Contents already stored are not sent
 * again. Each file is its own statement, outside any transaction, so a large
 * skill never builds one oversized query or holds a transaction open; a row
 * whose version is never written is harmless, since nothing lists it.
 */
export async function storeSkillFileBodies(organizationId: string, files: readonly SkillFileBody[]): Promise<SkillFileEntry[]> {
  const entries = files.map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes), size: file.bytes.byteLength, bytes: file.bytes }))
  const wanted = [...new Set(entries.map((entry) => entry.sha256))]
  const present = new Set<string>()
  if (wanted.length > 0) {
    const rows = await db.select({ sha256: SkillFileBlobTable.sha256 }).from(SkillFileBlobTable)
      .where(and(eq(SkillFileBlobTable.organizationId, normalizeDenTypeId("organization", organizationId)), inArray(SkillFileBlobTable.sha256, wanted)))
    for (const row of rows) present.add(row.sha256)
  }
  for (const entry of entries) {
    if (present.has(entry.sha256)) continue
    await db.insert(SkillFileBlobTable)
      .values({ organizationId: normalizeDenTypeId("organization", organizationId), sha256: entry.sha256, size: entry.size, bytes: entry.bytes })
      // Another save stored the same contents first: the row is already right.
      .onDuplicateKeyUpdate({ set: { size: entry.size } })
    present.add(entry.sha256)
  }
  return entries.map(({ path, sha256, size }) => ({ path, sha256, size }))
}

/** Moves files an older version kept inline into blobs, so a new version can list them. */
export async function storeInlineSkillFiles(organizationId: string, entries: readonly SkillFileEntry[]): Promise<SkillFileEntry[]> {
  const inline = entries.flatMap((entry) => entry.inline ? [{ path: entry.path, bytes: entry.inline }] : [])
  if (inline.length === 0) return entries.map(({ path, sha256, size }) => ({ path, sha256, size }))
  const stored = new Map((await storeSkillFileBodies(organizationId, inline)).map((entry) => [entry.path, entry]))
  return entries.map((entry) => stored.get(entry.path) ?? { path: entry.path, sha256: entry.sha256, size: entry.size })
}

/**
 * One supporting file's contents, checked against the digest its version
 * lists. Call it only for a file of a skill the member was just authorized to
 * load: it checks no access itself.
 */
export async function readSkillFileBytes(organizationId: string, entry: SkillFileEntry): Promise<Uint8Array | null> {
  if (entry.inline) return entry.inline
  const [row] = await db.select({ bytes: SkillFileBlobTable.bytes }).from(SkillFileBlobTable)
    .where(and(eq(SkillFileBlobTable.organizationId, normalizeDenTypeId("organization", organizationId)), eq(SkillFileBlobTable.sha256, entry.sha256)))
    .limit(1)
  if (!row || sha256Hex(row.bytes) !== entry.sha256) return null
  return row.bytes
}

/**
 * A skill version's payload with each listed file's contents in place of its
 * digest ({ path, text } or { path, base64 }), the form imports accept, so a
 * configuration export carries the files to another organization or instance.
 * A file whose contents cannot be read is left out.
 */
export async function skillPayloadWithContents(organizationId: string, payload: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  const entries = skillFilesFromPayload(payload)
  if (!payload || entries.length === 0) return payload
  const files: Array<{ path: string; text: string } | { path: string; base64: string }> = []
  for (const entry of entries) {
    const bytes = await readSkillFileBytes(organizationId, entry)
    if (!bytes) continue
    const text = skillFileText(bytes)
    files.push(text !== null ? { path: entry.path, text } : { path: entry.path, base64: Buffer.from(bytes).toString("base64") })
  }
  return { ...payload, files }
}
