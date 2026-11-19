import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { cache } from "../../cache.js"
import { orgMemberRoute } from "../../middleware/index.js"
import { jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"

export const inventoryRevisionResponseSchema = z.object({
  revision: z.string().nullable(),
}).meta({ ref: "InventoryRevision" })

export function registerOrgInventoryRevisionRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/inventory-revision",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get the member inventory revision",
      description: [
        "Returns an opaque revision that changes whenever what organization members can use may have changed: after any write to providers, plugins, marketplaces, connections, teams, members or their access, after a feature flag change, and on every deploy.",
        "Clients compare it with the revision they last loaded and skip reloading their inventory when it is unchanged. A null revision means it cannot be determined, so the client reloads. It describes the organization, not the caller, and reveals nothing else.",
      ].join(" "),
      responses: {
        200: jsonResponse("The current inventory revision.", inventoryRevisionResponseSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const revision = await cache.inventory.revision(c.get("organizationContext").organization.id)
      c.header("Cache-Control", "no-store")
      return c.json({ revision })
    },
  )
}
