import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { readSkillUsage } from "../../capability-usage.js"
import { requireFeature } from "../../features.js"
import { orgRoleRoute, queryValidator } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"

export const skillUsageQuerySchema = z.object({
  days: z.enum(["7", "30", "90"]).default("30").transform(Number),
})

const skillUsageRowSchema = z.object({
  skillId: z.string(),
  skillName: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  uses: z.number().int().nonnegative(),
  people: z.number().int().nonnegative(),
  lastUsedAt: z.string().datetime().nullable(),
}).meta({ ref: "SkillUsageRow" })

export const skillUsageReportSchema = z.object({
  days: z.number().int().positive(),
  trackingSince: z.string().datetime().nullable(),
  skills: z.array(skillUsageRowSchema),
}).meta({ ref: "SkillUsageReport" })

export function registerSkillUsageRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/skill-usage", describeRoute({
    tags: ["Plugins"], summary: "Read how often the organization's skills are used",
    description: "Lists every active skill in the organization's plugins with how many times agents loaded it over the last `days` days (7, 30 or 90; default 30), how many members it was loaded for, and when it was last loaded. Skills nobody used come back with zeros. Repeated loads of the same skill by the same member within 15 minutes count once. Counts cover skills served through the OpenWork MCP gateway since the skillUsage feature was turned on; `trackingSince` is the first recorded use. Aggregates only. Workspace owners and admins only.",
    responses: { 200: jsonResponse("Skill usage", skillUsageReportSchema) },
  }), orgRoleRoute(["admin"]), requireFeature("skillUsage"), queryValidator(skillUsageQuerySchema), async (c) => {
    const context = c.get("organizationContext")
    const { days } = c.req.valid("query")
    return c.json(await readSkillUsage(context.organization.id, days))
  })
}
