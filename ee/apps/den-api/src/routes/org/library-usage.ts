import { capabilityUsageSourceValues } from "@openwork-ee/den-db/schema"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  LIBRARY_USAGE_MAX_ROWS,
  LibraryUsageTooManyRowsError,
  libraryUsageTeamMemberIds,
  libraryUsageTrackingSince,
  readLibraryUsage,
  readLibraryUsageBreakdown,
} from "../../capability-usage.js"
import { libraryUsageDimensions, libraryUsageKinds, libraryUsageWindow } from "../../capability-usage-rows.js"
import { orgPermissionRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"

const libraryUsageParamsSchema = z.object({ kind: z.enum(libraryUsageKinds) })
const daysSchema = z.enum(["7", "30", "90"]).default("30").transform(Number)

export const libraryUsageQuerySchema = z.object({
  days: daysSchema,
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

export const libraryUsageBreakdownQuerySchema = z.object({
  kind: z.enum(libraryUsageKinds),
  days: daysSchema,
  groupBy: z.string().max(32).default("item")
    .transform((value) => [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))])
    .pipe(z.array(z.enum(libraryUsageDimensions)).min(1).max(libraryUsageDimensions.length)),
  memberId: z.string().min(1).max(64).optional(),
  teamId: z.string().min(1).max(64).optional(),
  itemId: z.string().min(1).max(64).optional(),
}).strict().superRefine((query, ctx) => {
  if (query.memberId !== undefined && !isDenTypeId("member", query.memberId)) {
    ctx.addIssue({ code: "custom", path: ["memberId"], message: "memberId must be an organization member ID." })
  }
  if (query.teamId !== undefined && !isDenTypeId("team", query.teamId)) {
    ctx.addIssue({ code: "custom", path: ["teamId"], message: "teamId must be a team ID." })
  }
  if (query.memberId !== undefined && query.teamId !== undefined) {
    ctx.addIssue({ code: "custom", path: ["teamId"], message: "Filter by memberId or teamId, not both." })
  }
})

const countSchema = z.number().int().nonnegative()
const sourceCountsSchema = z.object(Object.fromEntries(capabilityUsageSourceValues.map((source) => [source, countSchema.optional()])))
  .meta({ ref: "LibraryUsageSourceCounts" })

const libraryUsageBreakdownRowSchema = z.object({
  itemId: z.string().nullable(),
  memberId: z.string().nullable(),
  date: z.iso.date().nullable(),
  uses: countSchema,
  people: countSchema,
  failures: countSchema.nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  sources: sourceCountsSchema,
}).meta({ ref: "LibraryUsageBreakdownRow" })

export const libraryUsageBreakdownSchema = z.object({
  kind: z.enum(libraryUsageKinds),
  days: z.number().int().positive(),
  from: z.iso.date(),
  to: z.iso.date(),
  timezone: z.literal("UTC"),
  groupBy: z.array(z.enum(libraryUsageDimensions)),
  trackingSince: z.string().datetime().nullable(),
  rows: z.array(libraryUsageBreakdownRowSchema),
}).meta({ ref: "LibraryUsageBreakdown" })

const tooManyRowsSchema = z.object({ error: z.literal("library_usage_too_many_rows"), message: z.string() })

export function registerLibraryUsageRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/library-usage", describeRoute({
    tags: ["Plugins"], summary: "Break down how the organization's skills, plugins or connectors are used",
    description: [
      "Uses of one kind of item (`kind`: skills, plugins or connectors) over the last `days` UTC calendar days including today (7, 30 or 90; default 30), grouped by any of `item`, `member` and `day` (comma separated in `groupBy`; default `item`). `item` is the skill, plugin or connector id, `member` the organization member id and `day` the UTC date; dimensions not grouped by come back null.",
      "Filter to one member (`memberId`), the current members of one team (`teamId`), or one item (`itemId`). A team view counts its members' past uses by their current team.",
      "Every skill load and connector call counts once. Plugins count their skills' loads plus their Workflows' runs. `failures` counts failed connector calls and failed Workflow runs; it is null for skills. `people` counts distinct members in the row. `sources` splits uses by what started them (agent, workflow, automation, app, artifact); a missing key is zero.",
      `Only used items appear; ids are resolved to names by the caller. At most ${LIBRARY_USAGE_MAX_ROWS} rows: a larger result answers 422 library_usage_too_many_rows without truncation. Members with the usage_analytics.view permission only (owners and admins by default).`,
    ].join(" "),
    responses: {
      200: jsonResponse("Library usage breakdown", libraryUsageBreakdownSchema),
      400: jsonResponse("Invalid query", invalidRequestSchema),
      401: jsonResponse("Sign-in required", unauthorizedSchema),
      403: jsonResponse("View usage analytics permission required", forbiddenSchema),
      404: jsonResponse("The team is not in this organization", notFoundSchema),
      422: jsonResponse("Too many rows; narrow the window, grouping or filters", tooManyRowsSchema),
    },
  }), orgPermissionRoute("usage_analytics.view"), queryValidator(libraryUsageBreakdownQuerySchema), async (c) => {
    const organizationId = c.get("organizationContext").organization.id
    const query = c.req.valid("query")
    let memberIds: string[] | undefined = query.memberId ? [query.memberId] : undefined
    if (query.teamId) {
      const teamMembers = await libraryUsageTeamMemberIds(organizationId, query.teamId)
      if (!teamMembers) return c.json({ error: "not_found", message: "No such team in this organization." }, 404)
      memberIds = teamMembers
    }
    const now = new Date()
    const window = libraryUsageWindow(query.days, now)
    try {
      const [rows, trackingSince] = await Promise.all([
        readLibraryUsageBreakdown({ organizationId, kind: query.kind, days: query.days, groupBy: query.groupBy, memberIds, itemId: query.itemId, now }),
        libraryUsageTrackingSince(organizationId),
      ])
      return c.json({
        kind: query.kind,
        days: query.days,
        from: window.fromDate,
        to: window.toDate,
        timezone: "UTC" as const,
        groupBy: query.groupBy,
        trackingSince: trackingSince ? trackingSince.toISOString() : null,
        rows: rows.map((row) => ({
          itemId: row.itemId,
          memberId: row.memberId,
          date: row.date,
          uses: row.uses,
          people: row.people,
          failures: query.kind === "skills" ? null : row.failures,
          lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
          sources: row.sources,
        })),
      })
    } catch (error) {
      if (error instanceof LibraryUsageTooManyRowsError) {
        return c.json({ error: "library_usage_too_many_rows" as const, message: `More than ${LIBRARY_USAGE_MAX_ROWS} rows. Narrow the window, grouping or filters; nothing was truncated.` }, 422)
      }
      throw error
    }
  })

  app.get("/v1/library-usage/:kind", describeRoute({
    tags: ["Plugins"], summary: "Read how the organization's skills, plugins or connectors are used",
    description: [
      "Lists every active skill (`kind=skills`), plugin (`plugins`) or connector (`connectors`) in the organization with how often it was used over the last `days` UTC calendar days including today (7, 30 or 90; default 30), by how many members, and when it was last used. Items nobody used come back with zeros.",
      "Skills count every load of their SKILL.md through the OpenWork MCP gateway. Plugins count their skills' loads plus their Workflows' runs, and `failures` counts failed runs. Connectors count tool calls made through OpenWork, and `failures` counts calls that failed. `failures` is null for skills. Uses started by the member's agent, saved Workflows, Automations, Apps and live artifacts all count; GET /v1/library-usage splits them by source, member and day.",
      "Counts cover use since usage recording started; `trackingSince` is the first recorded use (skill loads before daily rollups were introduced were counted at most once per member per 15 minutes). Aggregates only. Members with the usage_analytics.view permission only (owners and admins by default).",
    ].join(" "),
    responses: { 200: jsonResponse("Library usage", libraryUsageReportSchema) },
  }), orgPermissionRoute("usage_analytics.view"), paramValidator(libraryUsageParamsSchema), queryValidator(libraryUsageQuerySchema), async (c) => {
    const context = c.get("organizationContext")
    const { kind } = c.req.valid("param")
    const { days } = c.req.valid("query")
    return c.json(await readLibraryUsage(context.organization.id, kind, days))
  })
}
