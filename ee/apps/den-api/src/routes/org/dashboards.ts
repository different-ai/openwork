import { and, asc, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import {
  DashboardAccessGrantTable,
  DashboardTable,
  MemberTable,
  TeamTable,
  accessRoleValues,
  type DashboardElement,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import {
  jsonValidator,
  orgMemberRoute,
  orgRoleRoute,
  paramValidator,
  resolveMemberTeamsMiddleware,
} from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { MemberTeamSummary } from "../../orgs.js"
import type { OrgRouteVariables } from "./shared.js"
import { idParamSchema } from "./shared.js"

/**
 * Organization-managed Dashboards: an org-owned, ordered list of MCP App
 * elements that admins assign to members and teams through the same grants
 * mechanism connector assignment uses (`dashboard_access_grant` mirrors
 * `connector_instance_access_grant`). Granted dashboards render on the desktop
 * MCP Apps dashboard as read-only tiles. Per-user launch consent stays on the
 * desktop; admins may explicitly authorize automatic launch on an element.
 */

type DashboardId = typeof DashboardTable.$inferSelect.id
type DashboardRow = typeof DashboardTable.$inferSelect
type DashboardAccessGrantRow = typeof DashboardAccessGrantTable.$inferSelect

const dashboardParamsSchema = idParamSchema("dashboardId", "dashboard")
const dashboardGrantParamsSchema = z.object({
  dashboardId: dashboardParamsSchema.shape.dashboardId,
  grantId: denTypeIdSchema("dashboardAccessGrant"),
})

const dashboardElementSchema = z.object({
  serverName: z.string().trim().min(1).max(255),
  connectionId: z.string().trim().min(1).max(160).optional(),
  toolName: z.string().trim().min(1).max(256),
  projectedToolName: z.string().trim().min(1).max(256),
  resourceUri: z.string().trim().min(1).max(2048).refine((value) => value.startsWith("ui://"), {
    message: "MCP App resource URIs must use ui://.",
  }),
  title: z.string().trim().min(1).max(255),
  launchArguments: z.record(z.string(), z.unknown()).optional(),
  requiresApproval: z.boolean().optional(),
  organizationAutoLaunch: z.boolean().optional(),
}).meta({ ref: "DashboardElement" })

const dashboardCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  elements: z.array(dashboardElementSchema).max(50).optional().default([]),
})

const dashboardUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  elements: z.array(dashboardElementSchema).max(50).optional(),
}).superRefine((value, ctx) => {
  if (value.name === undefined && value.elements === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide at least one field to update.",
      path: ["name"],
    })
  }
})

const accessRoleSchema = z.enum(accessRoleValues)

// Same exactly-one-subject contract the connector assignment grants use.
const dashboardAccessGrantWriteSchema = z.object({
  orgMembershipId: denTypeIdSchema("member").optional(),
  teamId: denTypeIdSchema("team").optional(),
  orgWide: z.boolean().optional().default(false),
  role: accessRoleSchema,
}).superRefine((value, ctx) => {
  const count = Number(Boolean(value.orgMembershipId)) + Number(Boolean(value.teamId)) + Number(Boolean(value.orgWide))
  if (count !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one of orgMembershipId, teamId, or orgWide=true.",
      path: ["orgMembershipId"],
    })
  }
})

const dashboardSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  elements: z.array(dashboardElementSchema),
  createdByOrgMembershipId: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).meta({ ref: "Dashboard" })

const dashboardAccessGrantSchema = z.object({
  id: z.string(),
  orgMembershipId: z.string().nullable(),
  teamId: z.string().nullable(),
  orgWide: z.boolean(),
  role: accessRoleSchema,
  createdByOrgMembershipId: z.string(),
  createdAt: z.string().datetime(),
  removedAt: z.string().datetime().nullable(),
}).meta({ ref: "DashboardAccessGrant" })

const dashboardListResponseSchema = z.object({ items: z.array(dashboardSchema) }).meta({ ref: "DashboardListResponse" })
const dashboardResponseSchema = z.object({ item: dashboardSchema }).meta({ ref: "DashboardResponse" })
const dashboardAccessListResponseSchema = z.object({ items: z.array(dashboardAccessGrantSchema) }).meta({ ref: "DashboardAccessListResponse" })
const dashboardAccessResponseSchema = z.object({ ok: z.literal(true), item: dashboardAccessGrantSchema }).meta({ ref: "DashboardAccessResponse" })

const meDashboardSchema = z.object({
  id: z.string(),
  name: z.string(),
  elements: z.array(dashboardElementSchema),
  updatedAt: z.string().datetime(),
}).meta({ ref: "MeDashboard" })

const meDashboardListResponseSchema = z.object({ items: z.array(meDashboardSchema) }).meta({ ref: "MeDashboardListResponse" })

type DashboardElementInput = z.infer<typeof dashboardElementSchema>

function toStoredElement(value: DashboardElementInput): DashboardElement {
  return {
    serverName: value.serverName,
    ...(value.connectionId ? { connectionId: value.connectionId } : {}),
    toolName: value.toolName,
    projectedToolName: value.projectedToolName,
    resourceUri: value.resourceUri,
    title: value.title,
    ...(value.launchArguments ? { launchArguments: value.launchArguments } : {}),
    ...(value.requiresApproval === true ? { requiresApproval: true } : {}),
    ...(value.organizationAutoLaunch === true ? { organizationAutoLaunch: true } : {}),
  }
}

function serializeDashboard(row: DashboardRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    elements: row.elementsJson,
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeDashboardAccessGrant(row: Omit<DashboardAccessGrantRow, "organizationId" | "dashboardId">) {
  return {
    id: row.id,
    orgMembershipId: row.orgMembershipId,
    teamId: row.teamId,
    orgWide: row.orgWide,
    role: row.role,
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    createdAt: row.createdAt.toISOString(),
    removedAt: row.removedAt ? row.removedAt.toISOString() : null,
  }
}

async function getDashboardRow(organizationId: DashboardRow["organizationId"], dashboardId: DashboardId) {
  const rows = await db
    .select()
    .from(DashboardTable)
    .where(and(
      eq(DashboardTable.id, dashboardId),
      eq(DashboardTable.organizationId, organizationId),
      isNull(DashboardTable.deletedAt),
    ))
    .limit(1)
  return rows[0] ?? null
}

// Validates that a grant's target member/team belong to the caller's active
// organization, so an admin cannot grant a dashboard to a foreign org's member
// or team id by smuggling it through the request body.
async function grantTargetsInOrganization(
  organizationId: DashboardRow["organizationId"],
  value: z.infer<typeof dashboardAccessGrantWriteSchema>,
): Promise<"member_not_found" | "team_not_found" | null> {
  if (value.orgMembershipId) {
    const member = await db
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.id, value.orgMembershipId)))
      .limit(1)
    if (!member[0]) return "member_not_found"
  }
  if (value.teamId) {
    const team = await db
      .select({ id: TeamTable.id })
      .from(TeamTable)
      .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamTable.id, value.teamId)))
      .limit(1)
    if (!team[0]) return "team_not_found"
  }
  return null
}

export function registerOrgDashboardRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/dashboards",
    describeRoute({
      tags: ["Dashboards"],
      summary: "List dashboards",
      responses: {
        200: jsonResponse("Dashboards returned successfully.", dashboardListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can list dashboards.", forbiddenSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    async (c) => {
      const payload = c.get("organizationContext")
      const rows = await db
        .select()
        .from(DashboardTable)
        .where(and(eq(DashboardTable.organizationId, payload.organization.id), isNull(DashboardTable.deletedAt)))
        .orderBy(asc(DashboardTable.name), asc(DashboardTable.id))
      return c.json({ items: rows.map(serializeDashboard) })
    },
  )

  app.post(
    "/v1/dashboards",
    describeRoute({
      tags: ["Dashboards"],
      summary: "Create dashboard",
      responses: {
        201: jsonResponse("Dashboard created successfully.", dashboardResponseSchema),
        400: jsonResponse("The dashboard request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can create dashboards.", forbiddenSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    jsonValidator(dashboardCreateSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const input = c.req.valid("json")
      const now = new Date()
      const row: DashboardRow = {
        id: createDenTypeId("dashboard"),
        organizationId: payload.organization.id,
        name: input.name.trim(),
        elementsJson: input.elements.map(toStoredElement),
        createdByOrgMembershipId: payload.currentMember.id,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }
      await db.insert(DashboardTable).values(row)
      return c.json({ item: serializeDashboard(row) }, 201)
    },
  )

  app.get(
    "/v1/dashboards/:dashboardId",
    describeRoute({
      tags: ["Dashboards"],
      summary: "Get dashboard",
      responses: {
        200: jsonResponse("Dashboard returned successfully.", dashboardResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can view dashboards.", forbiddenSchema),
        404: jsonResponse("The dashboard was not found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(dashboardParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const row = await getDashboardRow(
        payload.organization.id,
        normalizeDenTypeId("dashboard", c.req.valid("param").dashboardId),
      )
      if (!row) return c.json({ error: "dashboard_not_found" }, 404)
      return c.json({ item: serializeDashboard(row) })
    },
  )

  app.patch(
    "/v1/dashboards/:dashboardId",
    describeRoute({
      tags: ["Dashboards"],
      summary: "Update dashboard",
      responses: {
        200: jsonResponse("Dashboard updated successfully.", dashboardResponseSchema),
        400: jsonResponse("The dashboard request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can update dashboards.", forbiddenSchema),
        404: jsonResponse("The dashboard was not found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(dashboardParamsSchema),
    jsonValidator(dashboardUpdateSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const existing = await getDashboardRow(
        payload.organization.id,
        normalizeDenTypeId("dashboard", c.req.valid("param").dashboardId),
      )
      if (!existing) return c.json({ error: "dashboard_not_found" }, 404)
      const input = c.req.valid("json")
      const updatedAt = new Date()
      const next: DashboardRow = {
        ...existing,
        name: input.name?.trim() ?? existing.name,
        elementsJson: input.elements ? input.elements.map(toStoredElement) : existing.elementsJson,
        updatedAt,
      }
      await db
        .update(DashboardTable)
        .set({ name: next.name, elementsJson: next.elementsJson, updatedAt })
        .where(eq(DashboardTable.id, existing.id))
      return c.json({ item: serializeDashboard(next) })
    },
  )

  app.delete(
    "/v1/dashboards/:dashboardId",
    describeRoute({
      tags: ["Dashboards"],
      summary: "Delete dashboard",
      responses: {
        204: emptyResponse("Dashboard deleted successfully."),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can delete dashboards.", forbiddenSchema),
        404: jsonResponse("The dashboard was not found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(dashboardParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const existing = await getDashboardRow(
        payload.organization.id,
        normalizeDenTypeId("dashboard", c.req.valid("param").dashboardId),
      )
      if (!existing) return c.json({ error: "dashboard_not_found" }, 404)
      await db
        .update(DashboardTable)
        .set({ deletedAt: new Date() })
        .where(eq(DashboardTable.id, existing.id))
      return c.body(null, 204)
    },
  )

  app.get(
    "/v1/dashboards/:dashboardId/access",
    describeRoute({
      tags: ["Dashboards"],
      summary: "List dashboard access grants",
      responses: {
        200: jsonResponse("Dashboard access grants returned successfully.", dashboardAccessListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can list dashboard access.", forbiddenSchema),
        404: jsonResponse("The dashboard was not found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(dashboardParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const existing = await getDashboardRow(
        payload.organization.id,
        normalizeDenTypeId("dashboard", c.req.valid("param").dashboardId),
      )
      if (!existing) return c.json({ error: "dashboard_not_found" }, 404)
      const grants = await db
        .select()
        .from(DashboardAccessGrantTable)
        .where(and(
          eq(DashboardAccessGrantTable.organizationId, payload.organization.id),
          eq(DashboardAccessGrantTable.dashboardId, existing.id),
        ))
        .orderBy(asc(DashboardAccessGrantTable.createdAt), asc(DashboardAccessGrantTable.id))
      return c.json({ items: grants.map(serializeDashboardAccessGrant) })
    },
  )

  app.post(
    "/v1/dashboards/:dashboardId/access",
    describeRoute({
      tags: ["Dashboards"],
      summary: "Grant dashboard access",
      description: "Assigns a dashboard to one member, one team, or the whole organization — the same subject model connector assignment grants use. Regranting a revoked subject reactivates the existing grant.",
      responses: {
        201: jsonResponse("Dashboard access granted successfully.", dashboardAccessResponseSchema),
        400: jsonResponse("The grant request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can grant dashboard access.", forbiddenSchema),
        404: jsonResponse("The dashboard, member, or team was not found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(dashboardParamsSchema),
    jsonValidator(dashboardAccessGrantWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const existing = await getDashboardRow(
        payload.organization.id,
        normalizeDenTypeId("dashboard", c.req.valid("param").dashboardId),
      )
      if (!existing) return c.json({ error: "dashboard_not_found" }, 404)
      const value = c.req.valid("json")
      const targetFailure = await grantTargetsInOrganization(payload.organization.id, value)
      if (targetFailure) return c.json({ error: targetFailure }, 404)

      const createdByOrgMembershipId = payload.currentMember.id
      const existingGrants = await db
        .select()
        .from(DashboardAccessGrantTable)
        .where(and(
          eq(DashboardAccessGrantTable.dashboardId, existing.id),
          value.orgMembershipId
            ? eq(DashboardAccessGrantTable.orgMembershipId, value.orgMembershipId)
            : value.teamId
              ? eq(DashboardAccessGrantTable.teamId, value.teamId)
              : eq(DashboardAccessGrantTable.orgWide, true),
        ))
        .limit(1)

      if (existingGrants[0]) {
        await db
          .update(DashboardAccessGrantTable)
          .set({
            createdByOrgMembershipId,
            orgMembershipId: value.orgMembershipId ?? null,
            orgWide: value.orgWide ?? false,
            removedAt: null,
            role: value.role,
            teamId: value.teamId ?? null,
          })
          .where(eq(DashboardAccessGrantTable.id, existingGrants[0].id))
        return c.json({
          ok: true,
          item: serializeDashboardAccessGrant({
            ...existingGrants[0],
            createdByOrgMembershipId,
            orgMembershipId: value.orgMembershipId ?? null,
            orgWide: value.orgWide ?? false,
            removedAt: null,
            role: value.role,
            teamId: value.teamId ?? null,
          }),
        }, 201)
      }

      const row: DashboardAccessGrantRow = {
        id: createDenTypeId("dashboardAccessGrant"),
        organizationId: payload.organization.id,
        dashboardId: existing.id,
        orgMembershipId: value.orgMembershipId ?? null,
        teamId: value.teamId ?? null,
        orgWide: value.orgWide ?? false,
        role: value.role,
        createdByOrgMembershipId,
        createdAt: new Date(),
        removedAt: null,
      }
      await db.insert(DashboardAccessGrantTable).values(row)
      return c.json({ ok: true, item: serializeDashboardAccessGrant(row) }, 201)
    },
  )

  app.delete(
    "/v1/dashboards/:dashboardId/access/:grantId",
    describeRoute({
      tags: ["Dashboards"],
      summary: "Revoke dashboard access",
      responses: {
        204: emptyResponse("Dashboard access revoked successfully."),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can revoke dashboard access.", forbiddenSchema),
        404: jsonResponse("The dashboard or grant was not found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(dashboardGrantParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")
      const existing = await getDashboardRow(
        payload.organization.id,
        normalizeDenTypeId("dashboard", params.dashboardId),
      )
      if (!existing) return c.json({ error: "dashboard_not_found" }, 404)
      const grantId = normalizeDenTypeId("dashboardAccessGrant", params.grantId)
      const grants = await db
        .select({ id: DashboardAccessGrantTable.id, removedAt: DashboardAccessGrantTable.removedAt })
        .from(DashboardAccessGrantTable)
        .where(and(
          eq(DashboardAccessGrantTable.id, grantId),
          eq(DashboardAccessGrantTable.dashboardId, existing.id),
          eq(DashboardAccessGrantTable.organizationId, payload.organization.id),
        ))
        .limit(1)
      if (!grants[0]) return c.json({ error: "access_grant_not_found" }, 404)
      if (!grants[0].removedAt) {
        await db
          .update(DashboardAccessGrantTable)
          .set({ removedAt: new Date() })
          .where(eq(DashboardAccessGrantTable.id, grants[0].id))
      }
      return c.body(null, 204)
    },
  )

  // The desktop dashboard consumes this: every dashboard granted to the
  // signed-in member directly, through one of their teams, or org-wide.
  app.get(
    "/v1/me/dashboards",
    describeRoute({
      tags: ["Dashboards"],
      summary: "List dashboards granted to the current member",
      responses: {
        200: jsonResponse("Granted dashboards returned successfully.", meDashboardListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const memberId = payload.currentMember.id
      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      const teamIds = memberTeams.map((team) => team.id)
      const applicableGrant = teamIds.length > 0
        ? or(
            eq(DashboardAccessGrantTable.orgWide, true),
            eq(DashboardAccessGrantTable.orgMembershipId, memberId),
            inArray(DashboardAccessGrantTable.teamId, teamIds),
          )
        : or(
            eq(DashboardAccessGrantTable.orgWide, true),
            eq(DashboardAccessGrantTable.orgMembershipId, memberId),
          )
      const rows = await db
        .select({
          id: DashboardTable.id,
          name: DashboardTable.name,
          elementsJson: DashboardTable.elementsJson,
          updatedAt: DashboardTable.updatedAt,
        })
        .from(DashboardTable)
        .innerJoin(DashboardAccessGrantTable, eq(DashboardAccessGrantTable.dashboardId, DashboardTable.id))
        .where(and(
          eq(DashboardTable.organizationId, payload.organization.id),
          isNull(DashboardTable.deletedAt),
          eq(DashboardAccessGrantTable.organizationId, payload.organization.id),
          isNull(DashboardAccessGrantTable.removedAt),
          applicableGrant,
        ))
        .orderBy(asc(DashboardTable.name), asc(DashboardTable.id))
      const seen = new Set<string>()
      const items = rows.flatMap((row) => {
        if (seen.has(row.id)) return []
        seen.add(row.id)
        return [{
          id: row.id,
          name: row.name,
          elements: row.elementsJson,
          updatedAt: row.updatedAt.toISOString(),
        }]
      })
      return c.json({ items })
    },
  )
}
