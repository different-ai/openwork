import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { adminRoute, jsonValidator, paramValidator } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { readWorkspaceCreateLimitStatus, setWorkspaceCreateLimitOverride, workspaceCreateLimitStatusSchema } from "../../workspace-create-limit.js"

const params = z.object({ userId: denTypeIdSchema("user") })
const body = z.object({
  limit: z.union([z.number().int().min(1).max(10_000), z.null(), z.literal("default")])
    .describe("A number sets this person's limit, null removes the limit, \"default\" restores the deployment limit."),
}).strict()
const errors = {
  400: jsonResponse("Invalid request.", invalidRequestSchema),
  401: jsonResponse("Sign in required.", unauthorizedSchema),
  403: jsonResponse("Platform administrator required.", forbiddenSchema),
  404: jsonResponse("User not found.", notFoundSchema),
}
const tags = ["Admin"]
const path = "/v1/admin/users/:userId/workspace-limit"

export function registerAdminWorkspaceCreateLimit<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(path, describeRoute({ tags, summary: "Read one person's workspace creation limit",
    description: "Returns the effective limit, whether it is a per-account override, and how many workspaces the person founded inside the window.",
    responses: { ...errors, 200: jsonResponse("Limit status.", workspaceCreateLimitStatusSchema) } }),
  adminRoute(), paramValidator(params), async c => {
    const status = await readWorkspaceCreateLimitStatus(normalizeDenTypeId("user", c.req.valid("param").userId))
    if (!status) return c.json({ error: "not_found" }, 404)
    return c.json(status, 200, { "cache-control": "no-store" })
  })
  app.put(path, describeRoute({ tags, summary: "Raise, remove, or restore one person's workspace creation limit",
    description: "Stores a per-account override. Workspaces the person already founded keep counting.",
    responses: { ...errors, 200: jsonResponse("Updated limit status.", workspaceCreateLimitStatusSchema) } }),
  adminRoute(), paramValidator(params), jsonValidator(body), async c => {
    const userId = normalizeDenTypeId("user", c.req.valid("param").userId)
    if (!await readWorkspaceCreateLimitStatus(userId)) return c.json({ error: "not_found" }, 404)
    await setWorkspaceCreateLimitOverride({ userId, limit: c.req.valid("json").limit, setByUserId: normalizeDenTypeId("user", c.get("user").id) })
    return c.json(await readWorkspaceCreateLimitStatus(userId), 200, { "cache-control": "no-store" })
  })
}
