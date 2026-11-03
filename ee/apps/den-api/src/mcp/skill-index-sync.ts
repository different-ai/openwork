import { createHash } from "node:crypto"
import { z } from "zod"

/**
 * Incremental skill sync for clients that opt in.
 *
 * A desktop keeps the member's skill index and reads SKILL.md bodies only for
 * skills it actually uses. Two optional request fields let it do that cheaply:
 *
 * - Reading `skill://index.json` with the revision it last saw and the etag of
 *   each entry it holds. When the organization's inventory revision has not
 *   moved, Den answers `unchanged` without building the index. Otherwise it
 *   answers with only the added or changed entries and the URLs removed.
 * - Reading one SKILL.md with more `uris`, so several bodies arrive in one
 *   `resources/read` result (its `contents` is already a list).
 *
 * Both ride in the request's `_meta`, MCP's place for extension fields, under
 * one reverse-DNS key. A request without them, or a server that ignores them,
 * gets and gives today's responses, so old desktops and old Dens keep working.
 * The answer is the resource's JSON text rather than result `_meta`, because
 * resource text is what every client already reads and keeps.
 *
 * Kept free of database and environment imports so it can be unit tested.
 */

export const SKILL_SYNC_META_KEY = "io.openwork/skills"
/** Entries a client may say it holds; far above any member's index. */
const SKILL_KNOWN_MAX = 5_000
/** Bodies one batched read may return. */
export const SKILL_BATCH_MAX = 20

const syncSchema = z.object({
  revision: z.string().min(1).max(256).optional(),
  known: z.record(z.string().startsWith("skill://").max(2_048), z.string().max(128))
    .refine((known) => Object.keys(known).length <= SKILL_KNOWN_MAX).optional(),
  uris: z.array(z.string().startsWith("skill://").max(2_048)).min(1).max(SKILL_BATCH_MAX).optional(),
  /** The body is for a message that uses the skill: a Library use. */
  use: z.boolean().optional(),
})

export type SkillSyncRequest = z.infer<typeof syncSchema>

/** The opt-in sync fields of a request's params, or null when it sent none (or malformed ones). */
export function parseSkillSyncRequest(params: unknown): SkillSyncRequest | null {
  if (typeof params !== "object" || params === null || !("_meta" in params)) return null
  const meta = params._meta
  if (typeof meta !== "object" || meta === null || !(SKILL_SYNC_META_KEY in meta)) return null
  const parsed = syncSchema.safeParse((meta as Record<string, unknown>)[SKILL_SYNC_META_KEY])
  return parsed.success ? parsed.data : null
}

type IndexEntry = { url: string } & Record<string, unknown>
type SkillIndex = { $schema: string; delivery?: "native"; skills: IndexEntry[] }

/** Changes whenever anything a client renders from the entry changes, not only its body digest. */
export function skillEntryEtag(entry: IndexEntry): string {
  return createHash("sha256").update(JSON.stringify(entry), "utf8").digest("hex").slice(0, 32)
}

/** The index as a change set against what the client already holds. An empty `known` lists every entry. */
export function skillIndexChanges(index: SkillIndex, revision: string | null, known: Record<string, string> = {}) {
  const current = new Set<string>()
  const skills: Array<IndexEntry & { etag: string }> = []
  for (const entry of index.skills) {
    current.add(entry.url)
    const etag = skillEntryEtag(entry)
    if (known[entry.url] !== etag) skills.push({ ...entry, etag })
  }
  return {
    $schema: index.$schema,
    ...(index.delivery ? { delivery: index.delivery } : {}),
    ...(revision ? { revision } : {}),
    sync: "changes" as const,
    skills,
    removed: Object.keys(known).filter((url) => !current.has(url)),
  }
}

/** The JSON-RPC result for an index read whose revision has not moved: no skill list at all. */
export function unchangedSkillIndexResponse(id: string | number, uri: string, schema: string, revision: string): Response {
  const text = JSON.stringify({ $schema: schema, revision, sync: "unchanged" })
  return Response.json({ jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "application/json", text }] } })
}

/**
 * The JSON-RPC result for a batched SKILL.md read. URIs the member cannot read
 * are simply absent; the `_meta` marker tells the client this server batched,
 * so an absent URI is unavailable rather than unread by an older server.
 */
export function skillBatchResponse(id: string | number, contents: Array<{ uri: string; text: string }>): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    result: {
      contents: contents.map(({ uri, text }) => ({ uri, mimeType: "text/markdown", text })),
      _meta: { [SKILL_SYNC_META_KEY]: { batch: true } },
    },
  })
}
