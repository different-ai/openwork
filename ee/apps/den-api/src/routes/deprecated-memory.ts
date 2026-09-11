import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { authenticatedRoute, publicRoute } from "../middleware/index.js"
import { jsonResponse, unauthorizedSchema } from "../openapi.js"
import type { AuthContextVariables } from "../session.js"

/**
 * Deprecation stubs for the removed Memory Bank feature.
 *
 * Published desktop builds still call GET /v1/memory and DELETE /v1/memory/:id
 * from the Memory settings screen, so the den deployment must keep answering
 * both in the shapes those clients already tolerate:
 *
 * - the list screen renders the `memories` array, so an empty list is a clean
 *   empty state, while a 404/410 would surface as a load error;
 * - the desktop delete caller explicitly treats 404 as "already gone", which
 *   is now always the truth.
 *
 * Reads therefore return exactly what the old routes returned for a caller
 * with no memories, the write returns 410 so nothing can pretend to persist,
 * and everything is tagged Deprecated, which keeps these operations out of
 * the MCP capability catalog (see mcp/policy.ts SAFE_INCLUDED_TAGS).
 *
 * Remove this module once desktop builds that ship the Memory settings
 * screen have aged out.
 */

const MEMORY_REMOVED_MESSAGE = "The Memory Bank feature has been removed. Saved memories no longer exist and new memories cannot be created."

const removedMemoryListSchema = z.object({
  memories: z.array(z.never()),
}).meta({ ref: "RemovedMemoryList" })

const removedMemorySearchSchema = z.object({
  results: z.array(z.never()),
}).meta({ ref: "RemovedMemorySearch" })

const removedMemoryNotFoundSchema = z.object({
  error: z.literal("memory_not_found"),
}).meta({ ref: "RemovedMemoryNotFound" })

const removedMemoryGoneSchema = z.object({
  error: z.literal("deprecated"),
  message: z.literal(MEMORY_REMOVED_MESSAGE),
}).meta({ ref: "RemovedMemoryGone" })

export function registerDeprecatedMemoryRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(
    "/v1/memory",
    describeRoute({
      tags: ["Deprecated"],
      deprecated: true,
      summary: "List saved memories (removed feature)",
      description: "The Memory Bank feature has been removed. Always returns an empty list so published desktop builds render their normal empty state.",
      responses: {
        200: jsonResponse("No memories exist; the feature has been removed.", removedMemoryListSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    authenticatedRoute(),
    (c) => c.json({ memories: [] }),
  )

  app.get(
    "/v1/memory/search",
    describeRoute({
      tags: ["Deprecated"],
      deprecated: true,
      summary: "Search saved memories (removed feature)",
      description: "The Memory Bank feature has been removed. Always returns an empty result set, matching the old route's behavior when nothing matched.",
      responses: {
        200: jsonResponse("No memories exist; the feature has been removed.", removedMemorySearchSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    authenticatedRoute(),
    (c) => c.json({ results: [] }),
  )

  app.delete(
    "/v1/memory/:id",
    describeRoute({
      tags: ["Deprecated"],
      deprecated: true,
      summary: "Delete a saved memory (removed feature)",
      description: "The Memory Bank feature has been removed, so every memory id is already gone. Desktop callers treat this 404 as a successful, idempotent delete.",
      responses: {
        404: jsonResponse("The memory does not exist; the feature has been removed.", removedMemoryNotFoundSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    authenticatedRoute(),
    (c) => c.json({ error: "memory_not_found" }, 404),
  )

  app.post(
    "/v1/memory",
    describeRoute({
      tags: ["Deprecated"],
      security: [],
      deprecated: true,
      summary: "Save a memory (removed feature)",
      description: "The Memory Bank feature has been removed. Saving is refused outright so no caller can believe a memory was persisted.",
      responses: {
        410: jsonResponse(MEMORY_REMOVED_MESSAGE, removedMemoryGoneSchema),
      },
    }),
    publicRoute,
    (c) => c.json({ error: "deprecated", message: MEMORY_REMOVED_MESSAGE }, 410),
  )
}
