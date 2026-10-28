import { and, eq, isNull, isNotNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { readFeatureRollouts, readOrganizationFeatureOverrides, readOrganizationFeatureUsage, readOrganizationMemberFeatureOverrides } from "@openwork-ee/den-db/organization-features"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { availableFeatureKeys, featureKeySchema, resolveFeature, type FeatureKey } from "@openwork/features"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { adminRoute } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const DAY_MS = 24 * 60 * 60 * 1000

const featureUsageMemberSchema = z.object({
  memberId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  /** Whether the feature is on for this member now; a member can have used it before it was turned off. */
  enabled: z.boolean(),
  firstUsedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  daysUsed: z.number().int(),
})

const featureUsageSchema = z.object({
  key: featureKeySchema,
  /** Active members the feature is on for now. */
  enabledMembers: z.number().int(),
  /** Members who used it in the last 7 and 30 days. */
  usedLast7Days: z.number().int(),
  usedLast30Days: z.number().int(),
  /** Everyone who ever used it, most recent first. */
  members: z.array(featureUsageMemberSchema),
})

const responseSchema = z.object({
  activeMembers: z.number().int(),
  features: z.array(featureUsageSchema),
  generatedAt: z.iso.datetime(),
}).meta({ ref: "AdminOrganizationFeatureUsage" })

export function registerAdminFeatureUsageRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(
    "/v1/admin/organizations/:organizationId/feature-usage",
    describeRoute({
      tags: ["Admin"],
      summary: "Who has and uses each feature in an organization",
      description: "For every feature on this deployment: how many active members have it on now, how many used it in the last 7 and 30 days, and each member who used it with first and last use and days used. A use is a request through a feature-gated route or a client report (POST /v1/org/feature-usage). Platform administrators only.",
      responses: {
        200: jsonResponse("Feature usage returned.", responseSchema),
        400: jsonResponse("Invalid organization id.", invalidRequestSchema),
        401: jsonResponse("Sign in required.", unauthorizedSchema),
        403: jsonResponse("Platform administrator required.", forbiddenSchema),
        404: jsonResponse("The organization does not exist.", notFoundSchema),
      },
    }),
    adminRoute(),
    async (c) => {
      const organizationId = c.req.param("organizationId")
      if (!isDenTypeId("organization", organizationId)) return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
      const [organization] = await db.select({ id: OrganizationTable.id }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
      if (!organization) return c.json({ error: "not_found", message: "Organization not found." }, 404)

      const [members, rollouts, overrides, memberOverrides, usage] = await Promise.all([
        db.select({ id: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email })
          .from(MemberTable).leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
          .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false), isNotNull(MemberTable.userId))),
        readFeatureRollouts(db),
        readOrganizationFeatureOverrides(db, organizationId),
        readOrganizationMemberFeatureOverrides(db, organizationId),
        readOrganizationFeatureUsage(db, organizationId),
      ])

      const context = { ...env.features, rollouts, overrides }
      const enabledFor = (key: FeatureKey, memberId: DenTypeId<"member">) => resolveFeature(key, { ...context, memberOverrides: memberOverrides.get(memberId) ?? {} }).enabled
      const people = new Map(members.map((member) => [member.id, member]))
      const now = Date.now()

      const features = availableFeatureKeys(env.features.deployment).map((key) => {
        const used = usage
          .filter((row) => row.featureKey === key && people.has(row.memberId))
          .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime())
        const usedWithin = (days: number) => used.filter((row) => now - row.lastUsedAt.getTime() <= days * DAY_MS).length
        return {
          key,
          enabledMembers: members.filter((member) => enabledFor(key, member.id)).length,
          usedLast7Days: usedWithin(7),
          usedLast30Days: usedWithin(30),
          members: used.map((row) => {
            const person = people.get(row.memberId)
            return {
              memberId: row.memberId,
              name: person?.name ?? null,
              email: person?.email ?? null,
              enabled: enabledFor(key, row.memberId),
              firstUsedAt: row.firstUsedAt.toISOString(),
              lastUsedAt: row.lastUsedAt.toISOString(),
              daysUsed: row.daysUsed,
            }
          }),
        }
      })

      return c.json({ activeMembers: members.length, features, generatedAt: new Date().toISOString() })
    },
  )
}
