import { createHash } from "node:crypto"
import { z } from "zod"

export const SKILL_SYNC_META_KEY = "io.openwork/skills"
const SKILL_KNOWN_MAX = 5_000
export const SKILL_BATCH_MAX = 20

const syncSchema = z.object({
  revision: z.string().min(1).max(256).optional(),
  known: z.record(z.string().startsWith("skill://").max(2_048), z.string().max(128))
    .refine((known) => Object.keys(known).length <= SKILL_KNOWN_MAX).optional(),
  uris: z.array(z.string().startsWith("skill://").max(2_048)).min(1).max(SKILL_BATCH_MAX).optional(),
  use: z.boolean().optional(),
})

export type SkillSyncRequest = z.infer<typeof syncSchema>

export function parseSkillSyncRequest(params: unknown): SkillSyncRequest | null {
  if (typeof params !== "object" || params === null || !("_meta" in params)) return null
  const meta = params._meta
  if (typeof meta !== "object" || meta === null || !(SKILL_SYNC_META_KEY in meta)) return null
  const parsed = syncSchema.safeParse((meta as Record<string, unknown>)[SKILL_SYNC_META_KEY])
  return parsed.success ? parsed.data : null
}

type IndexEntry = { url: string } & Record<string, unknown>
type SkillIndex = { $schema: string; delivery?: "native"; skills: IndexEntry[] }

export function skillEntryEtag(entry: IndexEntry): string {
  return createHash("sha256").update(JSON.stringify(entry), "utf8").digest("hex").slice(0, 32)
}

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

export function unchangedSkillIndexResponse(id: string | number, uri: string, schema: string, revision: string): Response {
  const text = JSON.stringify({ $schema: schema, revision, sync: "unchanged" })
  return Response.json({ jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "application/json", text }] } })
}

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
