import { and, desc, eq } from "@openwork-ee/den-db/drizzle"
import { MemoryContextTable, MemoryTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { db } from "../../db.js"
import { authenticatedRoute, jsonValidator, orgMemberRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import type { OrganizationContextVariables } from "../../middleware/index.js"
import { emptyResponse, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import {
  getMemoryByIdForUser,
  listMemoryQuerySchema,
  listMemoryResponseSchema,
  loadContextsByMemoryId,
  logMemoryEvent,
  memoryIdParamSchema,
  memoryRelevance,
  parseMemoryIdParam,
  saveMemoryResponseSchema,
  saveMemorySchema,
  searchMemoryQuerySchema,
  searchMemoryResponseSchema,
  toMemoryContextResponse,
  toMemoryResponse,
} from "./shared.js"

function buildCitation(ctx: { conversation_id?: string; message_id?: string }): Record<string, string> | null {
  const citation: Record<string, string> = {}
  if (ctx.conversation_id) citation.conversation_id = ctx.conversation_id
  if (ctx.message_id) citation.message_id = ctx.message_id
  return Object.keys(citation).length > 0 ? citation : null
}

export function registerMemoryCoreRoutes<T extends { Variables: AuthContextVariables & Partial<OrganizationContextVariables> }>(app: Hono<T>) {
  app.post(
    "/v1/memory",
    describeRoute({
      tags: ["Memory"],
      summary:
        "Save a memory to the memory bank. Body: { content: string (required); tags?: string[]; contexts?: Array<{ snippet: string (required); conversation_id?: string; message_id?: string; origin?: \"active_conversation\" | \"searched_conversation\" }> }.",
      description:
        "Persists a human-confirmed memory for the calling user. The server sets the source and always stores it as a personal ('user') memory regardless of any scope sent by the client.",
      responses: {
        201: jsonResponse("Memory saved successfully.", saveMemoryResponseSchema),
        400: jsonResponse("The save payload was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to save a memory.", unauthorizedSchema),
        404: jsonResponse("The caller has no active organization they are a member of to save the memory to.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(saveMemorySchema),
    async (c) => {
      const user = c.get("user")
      if (!user) return c.json({ error: "unauthorized" }, 401)
      // orgMemberRoute() resolved the caller's active org (from the cookie/bearer session, or the
      // signed principal on the MCP path) AND verified they are a member of it — a non-member or
      // no-active-org caller was already rejected with 404. So a memory is only ever saved to an
      // org the user actually belongs to. org_id is recorded for the future org-shared bank (§8);
      // v0 reads stay per-user across all of the caller's orgs.
      const organizationContext = c.get("organizationContext")
      if (!organizationContext) return c.json({ error: "organization_not_found" }, 404)

      const userId = normalizeDenTypeId("user", user.id)
      const orgId = normalizeDenTypeId("org", organizationContext.organization.id)
      const input = c.req.valid("json")
      const memoryId = createDenTypeId("memory")
      // One app-clock timestamp for the whole save: the memory row, its context rows, and the
      // 201 body all carry `now`, so the response is authoritative (matches a later
      // getMemory/getMemorySearch) — MySQL has no INSERT ... RETURNING. memory.created_at is
      // the ordering authority for the list. `row` is the single source for the insert AND the
      // response, so the persisted row and the returned body cannot drift.
      const now = new Date()
      const row = {
        id: memoryId,
        user_id: userId,
        org_id: orgId,
        scope: "user",
        content: input.content,
        source: "chat",
        tags: input.tags ?? null,
        created_at: now,
        updated_at: now,
      } satisfies typeof MemoryTable.$inferInsert

      await db.transaction(async (tx) => {
        await tx.insert(MemoryTable).values(row)
        if (input.contexts && input.contexts.length > 0) {
          await tx.insert(MemoryContextTable).values(
            input.contexts.map((ctx) => ({
              id: createDenTypeId("memctx"),
              memory_id: memoryId,
              snippet: ctx.snippet,
              citation: buildCitation(ctx),
              origin: ctx.origin ?? null,
              created_at: now,
            })),
          )
        }
      })

      logMemoryEvent("save", { memoryId, userId, contexts: input.contexts?.length ?? 0 })

      return c.json({ memory: toMemoryResponse(row) }, 201)
    },
  )

  app.get(
    "/v1/memory/search",
    describeRoute({
      tags: ["Memory"],
      summary: "Search your memories with a natural-language query.",
      description: "Runs a relevance-ranked full-text search over the caller's own memories. Returns an empty result set (not an error) when nothing matches.",
      responses: {
        200: jsonResponse("Search results returned successfully.", searchMemoryResponseSchema),
        400: jsonResponse("The search query was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to search memories.", unauthorizedSchema),
      },
    }),
    authenticatedRoute(),
    queryValidator(searchMemoryQuerySchema),
    async (c) => {
      const user = c.get("user")
      if (!user) return c.json({ error: "unauthorized" }, 401)
      const userId = normalizeDenTypeId("user", user.id)
      const { q, limit } = c.req.valid("query")

      const relevance = memoryRelevance(q)
      // v0 memory is a single per-user pool: reads are scoped by user_id (+ defensive
      // scope='user'), intentionally NOT by org_id, so a user recalls their memories across
      // all of their orgs. org_id is recorded for the future org-shared bank (§8).
      const rows = await db
        .select({
          id: MemoryTable.id,
          user_id: MemoryTable.user_id,
          org_id: MemoryTable.org_id,
          scope: MemoryTable.scope,
          content: MemoryTable.content,
          source: MemoryTable.source,
          tags: MemoryTable.tags,
          created_at: MemoryTable.created_at,
          updated_at: MemoryTable.updated_at,
          score: relevance,
        })
        .from(MemoryTable)
        .where(and(eq(MemoryTable.user_id, userId), eq(MemoryTable.scope, "user"), relevance))
        .orderBy(desc(relevance))
        .limit(limit)

      logMemoryEvent("search", { userId, queryLength: q.length, resultCount: rows.length })

      return c.json({
        results: rows.map((row) => ({ ...toMemoryResponse(row), score: Number(row.score) })),
      })
    },
  )

  app.get(
    "/v1/memory",
    describeRoute({
      tags: ["Memory"],
      summary: "List your saved memories with their provenance.",
      description: "Returns the caller's own memories, newest first, each with its captured context (citations + snippets).",
      responses: {
        200: jsonResponse("Memories returned successfully.", listMemoryResponseSchema),
        400: jsonResponse("The list query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list memories.", unauthorizedSchema),
      },
    }),
    authenticatedRoute(),
    queryValidator(listMemoryQuerySchema),
    async (c) => {
      const user = c.get("user")
      if (!user) return c.json({ error: "unauthorized" }, 401)
      const userId = normalizeDenTypeId("user", user.id)
      const { limit } = c.req.valid("query")

      const rows = await db
        .select()
        .from(MemoryTable)
        .where(and(eq(MemoryTable.user_id, userId), eq(MemoryTable.scope, "user")))
        .orderBy(desc(MemoryTable.created_at))
        .limit(limit)

      const contexts = await loadContextsByMemoryId(rows.map((row) => row.id))

      return c.json({
        memories: rows.map((row) => ({
          ...toMemoryResponse(row),
          contexts: (contexts.get(row.id) ?? []).map(toMemoryContextResponse),
        })),
      })
    },
  )

  app.delete(
    "/v1/memory/:id",
    describeRoute({
      tags: ["Memory"],
      summary: "Delete one of your saved memories.",
      description: "Hard-deletes a memory and its captured context rows. Returns 404 for an id the caller does not own.",
      responses: {
        204: emptyResponse("Memory deleted successfully."),
        400: jsonResponse("The memory id path parameter was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to delete memories.", unauthorizedSchema),
        404: jsonResponse("The memory could not be found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    paramValidator(memoryIdParamSchema),
    async (c) => {
      const user = c.get("user")
      if (!user) return c.json({ error: "unauthorized" }, 401)
      const userId = normalizeDenTypeId("user", user.id)
      const { id } = c.req.valid("param")

      const memoryId = parseMemoryIdParam(id)
      if (!memoryId) return c.json({ error: "memory_not_found" }, 404)

      const existing = await getMemoryByIdForUser(memoryId, userId)
      if (!existing) return c.json({ error: "memory_not_found" }, 404)

      await db.transaction(async (tx) => {
        await tx.delete(MemoryContextTable).where(eq(MemoryContextTable.memory_id, memoryId))
        await tx.delete(MemoryTable).where(and(eq(MemoryTable.id, memoryId), eq(MemoryTable.user_id, userId)))
      })

      logMemoryEvent("delete", { memoryId, userId })
      return c.body(null, 204)
    },
  )
}
