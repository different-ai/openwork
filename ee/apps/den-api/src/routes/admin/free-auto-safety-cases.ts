import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { deploymentFeatureEnabled } from "../../features.js"
import { adminRoute, jsonValidator, paramValidator, queryValidator } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { caseCursor, caseIdSchema, caseStateSchema, decideCase, decisionSchema, importCase, listCases, noticeSchema, openRequestCase, providerCaseId, reviewCase } from "../../openai-safety/cases.js"
import type { AuthContextVariables } from "../../session.js"

const params = z.object({ caseId: caseIdSchema })
const summary = z.object({ caseId: caseIdSchema, notice: noticeSchema, state: caseStateSchema, reason: z.string().nullable(), issuedAt: z.iso.datetime(),
  identifier: z.string().nullable(), reviewerId: z.string().nullable(), decision: z.string().nullable(), updatedAt: z.iso.datetime() })
const coverage = z.object({ enforcementEnabled: z.boolean(), scope: z.literal("free_auto") })
const errors = { 400: { description: "Invalid request." }, 401: { description: "Sign in required." }, 403: { description: "Platform administrator required." } }
const tags = ["Admin"]
async function enforcement() { return { enforcementEnabled: await deploymentFeatureEnabled("freeAutoSafetyCases"), scope: "free_auto" as const } }

export function registerAdminSafetyCases<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/free-auto/safety-cases", describeRoute({ tags, summary: "List free model safety cases by review state",
    description: "Returns a page of safety cases ordered by issue time, newest first. Pass the returned cursor to continue in the same review state.",
    responses: { ...errors, 200: jsonResponse("Cases and current enforcement scope.", coverage.extend({ items: z.array(summary), nextCursor: z.string().nullable() })) } }),
    adminRoute(), queryValidator(z.object({ state: caseStateSchema.default("review"), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: caseCursor.optional() })), async c => {
      const { state, limit, cursor } = c.req.valid("query")
      return c.json({ ...await listCases(state, limit, cursor), ...await enforcement() }, 200, { "cache-control": "no-store" })
    })
  app.post("/v1/admin/free-auto/safety-cases/import", describeRoute({ tags, summary: "Verify and import an OpenAI safety case by ID",
    description: "Retrieves a case directly from the configured OpenAI organization. Duplicate imports preserve previous review decisions.",
    responses: { ...errors, 200: jsonResponse("Case imported from the provider.", coverage), 503: { description: "Case lookup or storage unavailable." } } }),
    adminRoute(), jsonValidator(z.object({ caseId: providerCaseId }).strict()), async c => {
      try { await importCase(c.req.valid("json").caseId) } catch { return c.json({ error: "safety_case_import_unavailable" }, 503) }
      return c.json(await enforcement(), 200, { "cache-control": "no-store" })
    })
  app.post("/v1/admin/free-auto/safety-cases/from-request", describeRoute({ tags, summary: "Open an internal safety review from an attributed request",
    description: "Uses the identity on the stored free model request. An operator can investigate an organization-level notice after locating a relevant request.",
    responses: { ...errors, 200: jsonResponse("Review opened or previously recorded.", params), 404: { description: "No unique request matched." } } }),
    adminRoute(), jsonValidator(z.object({ requestId: z.string().regex(/^[a-f0-9]{32}$/) }).strict()), async c => {
      const caseId = await openRequestCase(c.req.valid("json").requestId, normalizeDenTypeId("user", c.get("user").id))
      if (!caseId) return c.json({ error: "request_not_found" }, 404)
      return c.json({ caseId }, 200, { "cache-control": "no-store" })
    })
  app.get("/v1/admin/free-auto/safety-cases/:caseId", describeRoute({ tags, summary: "Inspect a safety case and recent matching requests",
    description: "Returns attribution, recent request metadata and the decisions taken by platform reviewers.",
    responses: { ...errors, 200: jsonResponse("Case, local identity evidence and current enforcement scope.", summary.extend(coverage.shape).extend({
      history: z.array(z.object({ decision: decisionSchema, reviewerId: z.string(), at: z.iso.datetime() })),
      subject: z.enum(["member", "guest", "unknown"]), userId: z.string().nullable(),
      otherAccountsOnRecentDesktops: z.number().nullable().describe("Other signed-in accounts seen in seven days on verified desktops in the sampled requests. Shared workstations can belong to different people. Null when device evidence is unavailable."),
      requests: z.array(z.object({ requestId: z.string(), organizationId: z.string().nullable(), at: z.iso.datetime() })),
    })), 404: { description: "Case not found." } } }), adminRoute(), paramValidator(params), async c => {
      const value = await reviewCase(c.req.valid("param").caseId)
      if (!value) return c.json({ error: "case_not_found" }, 404)
      return c.json({ ...value, ...await enforcement() }, 200, { "cache-control": "no-store" })
    })
  app.post("/v1/admin/free-auto/safety-cases/:caseId/decision", describeRoute({ tags, summary: "Record a reviewed warning decision",
    description: "Block confirmed misuse, close a warning after review, or uphold an appeal on a local block. Provider deactivations remain effective.",
    responses: { ...errors, 200: jsonResponse("Decision recorded.", coverage), 404: { description: "Case not found." },
      409: { description: "The case cannot accept this decision." } } }), adminRoute(), paramValidator(params),
    jsonValidator(z.object({ decision: decisionSchema }).strict()), async c => {
      const result = await decideCase(c.req.valid("param").caseId, c.req.valid("json").decision, normalizeDenTypeId("user", c.get("user").id))
      if (result === "missing") return c.json({ error: "case_not_found" }, 404)
      if (result === "conflict") return c.json({ error: "case_decision_conflict" }, 409)
      return c.json(await enforcement(), 200, { "cache-control": "no-store" })
    })
}
