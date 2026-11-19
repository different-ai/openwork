import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { readFeatureRollouts, readLatestFeatureChanges, readMemberFeatureOverrides, readOrganizationFeatureOverrides, type FeatureOverrideChanges } from "@openwork-ee/den-db/organization-features"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { FEATURE_KEYS, featureAvailableOn, mapFeatures, resolveFeature } from "@openwork/features"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { updateMemberFeatureOverrides } from "../../features.js"
import { adminFeatureChangeSchema, serializeFeatureChange } from "./feature-changes.js"
import { adminRoute, jsonValidator } from "../../middleware/index.js"
import { jsonResponse, invalidRequestSchema, notFoundSchema, unauthorizedSchema, forbiddenSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const path = "/v1/admin/organizations/:organizationId/members/:memberId/capabilities"
const inputSchema = z.object({ capabilities: z.object(mapFeatures(() => z.boolean().nullable().optional())).strict() }).strict()
const stateSchema = z.object({
  enabled: z.boolean(), source: z.enum(["unavailable", "killed", "lock", "override", "member", "everyone"]),
  everyone: z.boolean(), killed: z.boolean(), lock: z.boolean().nullable(), override: z.boolean().nullable(), overrideApplies: z.boolean(),
  lastChange: adminFeatureChangeSchema.nullable().meta({ description: "Latest change that could affect this member: their override, the organization's, or the deployment-wide state." }),
})
const responseSchema = z.object({ featureStates: z.object(mapFeatures(() => stateSchema)) })
const errors = {
  400: jsonResponse("Invalid organization, member or feature settings.", invalidRequestSchema),
  401: jsonResponse("Sign in required.", unauthorizedSchema),
  403: jsonResponse("Platform administrator required.", forbiddenSchema),
  404: jsonResponse("Active organization member not found.", notFoundSchema),
}

async function memberStates(organizationId: string, memberId: string, userId: string) {
  const [rollouts, overrides, memberOverrides, changes] = await Promise.all([
    readFeatureRollouts(db), readOrganizationFeatureOverrides(db, organizationId), readMemberFeatureOverrides(db, organizationId, userId),
    readLatestFeatureChanges(db, { organizationId, memberId }),
  ])
  return mapFeatures((key) => {
    const context = { ...env.features, rollouts, overrides }
    const inherited = resolveFeature(key, context)
    const state = resolveFeature(key, { ...context, memberOverrides })
    // The reusable editor's reset target is the organization setting; its
    // override is the selected member's, not the organization's stored row.
    return { ...state, everyone: inherited.enabled, override: memberOverrides[key] ?? null, lastChange: serializeFeatureChange(changes[key]) }
  })
}

export function registerAdminMemberFeatureRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(path, describeRoute({
    tags: ["Admin"], summary: "Get an organization member's feature overrides",
    description: "Returns effective features for one active organization member. override is the member's setting (null inherits); everyone is the inherited organization value. Deployment restrictions, kill switches and operator locks still win.",
    responses: { 200: jsonResponse("Member feature settings returned.", responseSchema), ...errors },
  }), adminRoute(), async (c) => {
    const { organizationId, memberId } = c.req.param()
    if (!isDenTypeId("organization", organizationId) || !isDenTypeId("member", memberId)) return c.json({ error: "invalid_request", message: "Invalid organization or member id." }, 400)
    const [member] = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
      eq(MemberTable.id, memberId), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false),
    )).limit(1)
    if (!member?.userId) return c.json({ error: "not_found", message: "Active organization member not found." }, 404)
    return c.json({ featureStates: await memberStates(organizationId, memberId, member.userId) })
  })

  app.put(path, describeRoute({
    tags: ["Admin"], summary: "Set an organization member's feature overrides",
    description: "Sets true/false for one member or clears an override with null to inherit the organization setting. Only platform administrators can write. Membership and organization are revalidated under a transaction lock; pending and removed members cannot receive overrides.",
    responses: { 200: jsonResponse("Member feature settings saved.", responseSchema), ...errors },
  }), adminRoute(), jsonValidator(inputSchema), async (c) => {
    const { organizationId, memberId } = c.req.param()
    if (!isDenTypeId("organization", organizationId) || !isDenTypeId("member", memberId)) return c.json({ error: "invalid_request", message: "Invalid organization or member id." }, 400)
    const body = c.req.valid("json")
    const changes: FeatureOverrideChanges = {}
    for (const key of FEATURE_KEYS) {
      const value = body.capabilities[key]
      if (value === undefined) continue
      if (value !== null && !featureAvailableOn(key, env.features.deployment)) return c.json({ error: "invalid_request", message: `${key} is not part of this deployment.` }, 400)
      changes[key] = value
    }
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized" }, 401)
    const saved = await updateMemberFeatureOverrides({ organizationId, memberId, changes, setByUserId: user.id })
    if (!saved) return c.json({ error: "not_found", message: "Active organization member not found." }, 404)
    const [member] = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
      eq(MemberTable.id, memberId), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt),
    )).limit(1)
    if (!member?.userId) return c.json({ error: "not_found", message: "Active organization member not found." }, 404)
    return c.json({ featureStates: await memberStates(organizationId, memberId, member.userId) })
  })
}
