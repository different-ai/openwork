import { and, desc, eq, inArray, type SQL, sql } from "@openwork-ee/den-db/drizzle"
import { MemoryContextOrigin, MemoryContextTable, MemoryTable } from "@openwork-ee/den-db/schema"
import { type DenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { db } from "../../db.js"
import { denTypeIdSchema } from "../../openapi.js"

// Input bounds — a cheap abuse guard (§8); full per-user quota/rate-limiting is deferred.
export const MAX_CONTENT_LENGTH = 8_000
export const MAX_TAGS = 32
export const MAX_TAG_LENGTH = 64
export const MAX_CONTEXTS = 16
export const MAX_SNIPPET_LENGTH = 4_000
export const MAX_CITATION_ID_LENGTH = 128
export const MAX_QUERY_LENGTH = 512
export const DEFAULT_LIMIT = 20
export const MAX_SEARCH_LIMIT = 50
export const MAX_LIST_LIMIT = 100

// The save body shape is intentionally flat and mostly-optional so the agent — which only
// sees `hasBody:true`, not the schema — can construct it; the shape is also spelled out in
// the route's OpenAPI summary (memory-bank-architecture.md §4, B3).
export const saveMemorySchema = z
  .object({
    content: z.string().trim().min(1).max(MAX_CONTENT_LENGTH),
    tags: z.array(z.string().trim().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS).optional(),
    contexts: z
      .array(
        z.object({
          snippet: z.string().trim().min(1).max(MAX_SNIPPET_LENGTH),
          conversation_id: z.string().min(1).max(MAX_CITATION_ID_LENGTH).optional(),
          message_id: z.string().min(1).max(MAX_CITATION_ID_LENGTH).optional(),
          origin: z.enum(MemoryContextOrigin).optional(),
        }),
      )
      .max(MAX_CONTEXTS)
      .optional(),
  })
  .meta({ ref: "SaveMemoryRequest" })

export const searchMemoryQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
    limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_LIMIT),
  })
  .meta({ ref: "MemorySearchQuery" })

export const listMemoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIMIT),
  })
  .meta({ ref: "MemoryListQuery" })

export const memoryIdParamSchema = z.object({ id: z.string() }).meta({ ref: "MemoryIdParam" })

const memoryContextResponseSchema = z
  .object({
    id: denTypeIdSchema("memctx"),
    snippet: z.string(),
    citation: z.record(z.string(), z.unknown()).nullable(),
    origin: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .meta({ ref: "MemoryContext" })

const memoryResponseSchema = z
  .object({
    id: denTypeIdSchema("memory"),
    content: z.string(),
    tags: z.array(z.string()).nullable(),
    source: z.string(),
    scope: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .meta({ ref: "Memory" })

const memoryWithContextsSchema = memoryResponseSchema
  .extend({ contexts: z.array(memoryContextResponseSchema) })
  .meta({ ref: "MemoryWithContexts" })

export const saveMemoryResponseSchema = z
  .object({ memory: memoryResponseSchema })
  .meta({ ref: "SaveMemoryResponse" })

export const listMemoryResponseSchema = z
  .object({ memories: z.array(memoryWithContextsSchema) })
  .meta({ ref: "MemoryListResponse" })

export const searchMemoryResponseSchema = z
  .object({
    results: z.array(memoryResponseSchema.extend({ score: z.number() })),
  })
  .meta({ ref: "MemorySearchResponse" })

type MemoryRow = typeof MemoryTable.$inferSelect
type MemoryContextRow = typeof MemoryContextTable.$inferSelect

function normalizeTags(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null
}

function normalizeCitation(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...value }
    : null
}

export function toMemoryResponse(row: MemoryRow) {
  return {
    id: row.id,
    content: row.content,
    tags: normalizeTags(row.tags),
    source: row.source,
    scope: row.scope,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export function toMemoryContextResponse(row: MemoryContextRow) {
  return {
    id: row.id,
    snippet: row.snippet,
    citation: normalizeCitation(row.citation),
    origin: row.origin,
    createdAt: row.created_at.toISOString(),
  }
}

/** Owner-scoped read (B4): user_id is the PRIMARY predicate, plus defensive scope='user'. */
export async function getMemoryByIdForUser(
  memoryId: DenTypeId<"memory">,
  userId: DenTypeId<"user">,
): Promise<MemoryRow | null> {
  const rows = await db
    .select()
    .from(MemoryTable)
    .where(and(eq(MemoryTable.id, memoryId), eq(MemoryTable.user_id, userId), eq(MemoryTable.scope, "user")))
    .limit(1)
  return rows[0] ?? null
}

export async function loadContextsByMemoryId(
  memoryIds: DenTypeId<"memory">[],
): Promise<Map<string, MemoryContextRow[]>> {
  const grouped = new Map<string, MemoryContextRow[]>()
  if (memoryIds.length === 0) {
    return grouped
  }
  const rows = await db
    .select()
    .from(MemoryContextTable)
    .where(inArray(MemoryContextTable.memory_id, memoryIds))
    .orderBy(desc(MemoryContextTable.created_at))
  for (const row of rows) {
    const bucket = grouped.get(row.memory_id) ?? []
    bucket.push(row)
    grouped.set(row.memory_id, bucket)
  }
  return grouped
}

/** Bound MATCH … AGAINST in NATURAL LANGUAGE MODE — never sql.raw (B/§3). */
export function memoryRelevance(query: string): SQL<number> {
  return sql<number>`MATCH(${MemoryTable.content}) AGAINST (${query} IN NATURAL LANGUAGE MODE)`
}

export function parseMemoryIdParam(raw: string): DenTypeId<"memory"> | null {
  try {
    return normalizeDenTypeId("memory", raw)
  } catch {
    return null
  }
}

/** Structured, server-observable event (TR-10) — distinguishes "never saved" from "save failed". */
export function logMemoryEvent(event: "save" | "search" | "delete", fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: `memory.${event}`, ...fields }))
}
