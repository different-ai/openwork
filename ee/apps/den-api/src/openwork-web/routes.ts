import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { orgRoleRoute } from "../middleware/index.js"
import { jsonResponse, openWorkWebUnavailableSchema, orgStripeBillingResponseSchema, unauthorizedSchema } from "../openapi.js"
import { isOpenWorkWebAvailableForOrganization, openWorkWebUnavailableResponse } from "../openwork-web-availability.js"
import type { OrgRouteVariables } from "../routes/org/shared.js"
import { getOpenWorkWebSummary } from "./offer.js"

export function registerOpenWorkWebAccessRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  // The path predates OpenWork Web owning it; published desktops and den-web pin it.
  app.get(
    "/v1/billing/web",
    describeRoute({
      tags: ["Organizations"],
      hide: true,
      summary: "Get OpenWork Web billing eligibility",
      responses: {
        200: jsonResponse("OpenWork Web billing eligibility returned successfully.", orgStripeBillingResponseSchema),
        401: jsonResponse("The caller must be an organization member.", unauthorizedSchema),
        404: jsonResponse("OpenWork Web is not available for this organization.", openWorkWebUnavailableSchema),
      },
    }),
    orgRoleRoute(["member"]),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!isOpenWorkWebAvailableForOrganization(payload.organization.metadata)) {
        return c.json(openWorkWebUnavailableResponse(), 404)
      }
      const web = await getOpenWorkWebSummary(payload.organization.id)
      return c.json({ billing: { stripe: { web } } })
    },
  )
}
