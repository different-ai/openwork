import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { adminRoute, jsonValidator, paramValidator } from "../../middleware/index.js"
import { applyProviderSuspension, fundedSuspensionStatus, releaseProviderSuspension } from "../../openai-safety/account-suspensions.js"
import { providerCaseId } from "../../openai-safety/cases.js"
import { denTypeIdSchema, jsonResponse } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const user = denTypeIdSchema("user")
const params = z.object({ userId: user })
const result = z.object({ userId: user, suspended: z.boolean(), recent: z.array(z.object({
  reference: z.string(), suspendedAt: z.iso.datetime(), suspendedBy: user, releasedAt: z.iso.datetime().nullable(), releasedBy: user.nullable(), releaseReference: z.string().nullable(),
})) })
const responses = { 200: jsonResponse("Account-wide status and up to 50 recent decisions.", result), 400: { description: "Invalid input." },
  401: { description: "Authentication required." }, 403: { description: "Platform administrator required." } }
const mutationResponses = { ...responses, 404: { description: "Account or suspension not found." }, 409: { description: "Reference, account or disposition conflicts with a recorded decision." } }
const tags = ["Admin"]
const path = "/v1/admin/users/:userId/funded-model-suspensions"
export function registerFundedModelSuspensions<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(path, describeRoute({ tags, summary: "Inspect funded model suspensions for an account",
    description: "Returns active suspension status across organizations and recent operator decisions.", responses }),
    adminRoute(), paramValidator(params), async c => c.json(await fundedSuspensionStatus(c.req.valid("param").userId), 200, { "cache-control": "no-store" }))
  app.post(path, describeRoute({ tags, summary: "Suspend funded model access across organizations",
    description: "Record an explicit provider request against the confirmed OpenWork user. Repeating the same reference preserves the original decision.", responses: mutationResponses }),
    adminRoute(), paramValidator(params), jsonValidator(z.strictObject({ reference: providerCaseId, verified: z.literal("provider_requested_account_suspension") })), async c => {
      const { userId } = c.req.valid("param")
      const outcome = await applyProviderSuspension(c.req.valid("json").reference, userId, c.get("user").id)
      if (outcome === "missing") return c.json({ error: "user_not_found" }, 404)
      if (outcome === "conflict") return c.json({ error: "suspension_conflict" }, 409)
      return c.json(await fundedSuspensionStatus(userId), 200, { "cache-control": "no-store" })
    })
  app.post(path + "/release", describeRoute({ tags, summary: "Release a specific provider-requested suspension",
    description: "Record the provider's separate reinstatement reference. Other active restrictions on the account continue to apply.", responses: mutationResponses }),
    adminRoute(), paramValidator(params), jsonValidator(z.strictObject({ reference: providerCaseId, releaseReference: providerCaseId, verified: z.literal("provider_authorized_reinstatement") })), async c => {
      const { userId } = c.req.valid("param")
      const body = c.req.valid("json")
      const outcome = await releaseProviderSuspension(body.reference, userId, body.releaseReference, c.get("user").id)
      if (outcome === "missing") return c.json({ error: "suspension_not_found" }, 404)
      if (outcome === "conflict") return c.json({ error: "suspension_conflict" }, 409)
      return c.json(await fundedSuspensionStatus(userId), 200, { "cache-control": "no-store" })
    })
}
