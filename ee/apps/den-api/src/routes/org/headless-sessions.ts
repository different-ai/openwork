import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import {
  HeadlessSessionIndexQueryError,
  headlessSessionIndexPageSchema,
  headlessSessionIndexQuerySchema,
  listHeadlessSessionIndex,
} from "../../headless-runner/session-index.js"
import { orgMemberRoute, queryValidator, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"

/**
 * The organization's Workbot, Slack and Automation conversations as Den's session index knows them (session-index.ts),
 * for admins. Content-free: sizes, activity and state, never titles or messages.
 */
export function registerOrgHeadlessSessionRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/headless/sessions",
    describeRoute({
      tags: ["Organizations"],
      summary: "List the organization's Workbot, Slack and Automation conversations (content-free)",
      description: [
        "The organization's conversations on the headless runner as Den's session index knows them, most recently updated first: the member (null when the conversation belongs to none), the kind (`workbot`, `slack` or `automation`), when it was created and last updated, its hot and total stored bytes and sealed segment count, when its running turn started (`activeTurnSince`, null when idle; a long-running value can mean a stuck turn), when it was deleted, and Den's retention class and legal hold. Never a title, a message or anything else a conversation contains.",
        "Filter by `memberId`, `kind`, `active` (`true`: a turn is running) and `deleted` (`exclude` by default, `include` or `only`). Paged: up to `limit` rows (default 50, at most 200), then pass `nextCursor` as `cursor`.",
        "Members with the View usage analytics permission only (owners and admins by default).",
      ].join(" "),
      responses: {
        200: jsonResponse("One page of conversations.", headlessSessionIndexPageSchema),
        400: jsonResponse("Invalid filter or cursor.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        403: jsonResponse("View usage analytics permission required.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("usage_analytics.view"),
    queryValidator(headlessSessionIndexQuerySchema),
    async (c) => {
      const organizationId = c.get("organizationContext").organization.id
      try {
        return c.json(await listHeadlessSessionIndex(organizationId, c.req.valid("query")), 200)
      } catch (error) {
        if (error instanceof HeadlessSessionIndexQueryError) return c.json({ error: "invalid_request" as const, message: error.code, details: [] }, 400)
        throw error
      }
    },
  )
}
