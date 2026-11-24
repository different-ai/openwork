import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { workspaceLimitRuleInputSchema, workspaceLimitRuleScopeSchema, workspaceLimitSettingsSchema } from "@openwork/types/den/admin-limits"
import { adminRoute, jsonValidator, paramValidator } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import {
  readWorkspaceCreateLimitStatus,
  readWorkspaceLimitSettings,
  removeWorkspaceLimitRule,
  setWorkspaceLimitRule,
  workspaceCreateLimitStatusSchema,
} from "../../workspace-create-limit.js"

const errors = {
  400: jsonResponse("Invalid request.", invalidRequestSchema),
  401: jsonResponse("Sign in required.", unauthorizedSchema),
  403: jsonResponse("Platform administrator required.", forbiddenSchema),
}
const notFound = { 404: jsonResponse("Not found.", notFoundSchema) }
const tags = ["Admin"]
const base = "/v1/admin/limits/workspace-creation"
const settings = workspaceLimitSettingsSchema.meta({ ref: "WorkspaceLimitSettings" })
const noStore = { "cache-control": "no-store" }

export function registerAdminWorkspaceCreateLimit<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(base, describeRoute({ tags, summary: "List workspace creation limits",
    description: "Returns the deployment default and the per-email and per-domain limits. The most specific match applies to each person.",
    responses: { ...errors, 200: jsonResponse("Limits.", settings) } }),
  adminRoute(), async c => c.json(await readWorkspaceLimitSettings(), 200, noStore))

  app.put(`${base}/rules`, describeRoute({ tags, summary: "Add or change a per-email or per-domain workspace limit",
    description: "Values are normalized first: lowercase, +tags removed, and Gmail dots removed, so aliases share one rule. A domain limit applies to each person at that domain.",
    responses: { ...errors, 200: jsonResponse("Updated limits.", settings) } }),
  adminRoute(), jsonValidator(workspaceLimitRuleInputSchema), async c => {
    const input = c.req.valid("json")
    const value = await setWorkspaceLimitRule({ ...input, setByUserId: normalizeDenTypeId("user", c.get("user").id) })
    if (!value) return c.json({ error: "invalid_request", message: input.scope === "email" ? "Enter a valid email address." : "Enter a valid domain." }, 400)
    return c.json(await readWorkspaceLimitSettings(), 200, noStore)
  })

  app.delete(`${base}/rules/:scope/:value`, describeRoute({ tags, summary: "Remove a per-email or per-domain workspace limit",
    description: "Matching people fall back to the next most specific limit.",
    responses: { ...errors, ...notFound, 200: jsonResponse("Updated limits.", settings) } }),
  adminRoute(), paramValidator(z.object({ scope: workspaceLimitRuleScopeSchema, value: z.string().min(3).max(320) })), async c => {
    const { scope, value } = c.req.valid("param")
    if (!await removeWorkspaceLimitRule(scope, value)) return c.json({ error: "not_found" }, 404)
    return c.json(await readWorkspaceLimitSettings(), 200, noStore)
  })

  app.get("/v1/admin/users/:userId/workspace-limit", describeRoute({ tags, summary: "Read one person's workspace creation limit",
    description: "Returns the normalized email, the limit that applies and which rule set it, and how many workspaces the person currently has across alias accounts.",
    responses: { ...errors, ...notFound, 200: jsonResponse("Limit status.", workspaceCreateLimitStatusSchema) } }),
  adminRoute(), paramValidator(z.object({ userId: denTypeIdSchema("user") })), async c => {
    const status = await readWorkspaceCreateLimitStatus(normalizeDenTypeId("user", c.req.valid("param").userId))
    if (!status) return c.json({ error: "not_found" }, 404)
    return c.json(status, 200, noStore)
  })
}
