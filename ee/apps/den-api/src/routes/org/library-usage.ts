import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { readLibraryUsage } from "../../capability-usage.js"
import { libraryUsageKinds } from "../../capability-usage-rows.js"
import { requireFeature } from "../../features.js"
import { orgPermissionRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"

const libraryUsageParamsSchema = z.object({ kind: z.enum(libraryUsageKinds) })

export const libraryUsageQuerySchema = z.object({
  days: z.enum(["7", "30", "90"]).default("30").transform(Number),
})

const libraryUsageRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  detail: z.string().nullable(),
  pluginId: z.string().nullable(),
  uses: z.number().int().nonnegative(),
  people: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
}).meta({ ref: "LibraryUsageRow" })

export const libraryUsageReportSchema = z.object({
  kind: z.enum(libraryUsageKinds),
  days: z.number().int().positive(),
  trackingSince: z.string().datetime().nullable(),
  items: z.array(libraryUsageRowSchema),
}).meta({ ref: "LibraryUsageReport" })

export function registerLibraryUsageRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/library-usage/:kind", describeRoute({
    tags: ["Plugins"], summary: "Read how the organization's skills, plugins or connectors are used",
    description: [
      "Lists every active skill (`kind=skills`), plugin (`plugins`) or connector (`connectors`) in the organization with how often it was used over the last `days` days (7, 30 or 90; default 30), by how many members, and when it was last used. Items nobody used come back with zeros.",
      "Skills count loads of their SKILL.md through the OpenWork MCP gateway; repeated loads by the same member within 15 minutes count once. Plugins count their skills' loads plus their Workflows' runs, and `failures` counts failed runs. Connectors count tool calls made through OpenWork, and `failures` counts calls that failed. `failures` is null for skills.",
      "Counts cover use since the libraryUsage feature was turned on; `trackingSince` is the first recorded use. Aggregates only. Members with the usage_analytics.view permission only (owners and admins by default).",
    ].join(" "),
    responses: { 200: jsonResponse("Library usage", libraryUsageReportSchema) },
  }), orgPermissionRoute("usage_analytics.view"), requireFeature("libraryUsage"), paramValidator(libraryUsageParamsSchema), queryValidator(libraryUsageQuerySchema), async (c) => {
    const context = c.get("organizationContext")
    const { kind } = c.req.valid("param")
    const { days } = c.req.valid("query")
    return c.json(await readLibraryUsage(context.organization.id, kind, days))
  })
}
