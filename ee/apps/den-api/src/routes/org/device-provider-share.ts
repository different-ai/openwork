import { and, asc, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, GatewayProviderTable, MemberTable } from "@openwork-ee/den-db/schema"
import { deviceShareOptionsSchema, parseDeviceShareProviderIds, type DeviceShareOptions } from "@openwork/types/den/device-provider-share"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { gatewayManagementUnavailable } from "../../gateway-deployment.js"
import { deviceShareProviders } from "../../llm/device-provider-share.js"
import { getModelsDevProviders } from "../../llm/models-dev.js"
import { orgMemberRoute, queryValidator, userSessionRoute } from "../../middleware/index.js"
import { jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { roleIncludesOwner } from "../../organization-member-guards.js"
import { ensureFreshPrivilegedSession } from "../../privileged-session.js"
import { hasPermission } from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"

/** A person's own screen decides from this; an agent never shares someone's key. */
type DeviceShareRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeDeviceShareRoute = (options: DeviceShareRouteOptions) => describeRoute(options)

const querySchema = z.object({ providerIds: z.string().max(4000).default("") }).strict()

export function registerOrgDeviceProviderShareRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/inference-providers/device-share-options",
    describeDeviceShareRoute({
      tags: ["Inference Providers"],
      operationId: "getDeviceShareOptions",
      "x-mcp": false,
      summary: "Check which providers on the caller's device can be shared with the organization",
      description: "Read-only. For the provider ids in providerIds (comma-separated, at most 20), says whether the caller may add each to AI Gateway for everyone with the one API key saved on their device: shareable, already shared (an active organization provider exists for it) or unsupported (not in the catalog, or it needs more than one key or settings a person chooses). canShare needs the Manage Gateway providers permission and enabled Gateway management; otherwise blocker says which is missing, managerName names an owner who can, and providers is empty. verificationRequired is true when adding the provider would first ask for a recent sign-in. Never reads or returns a key. Requires a signed-in user session. Gateway permissions, recent sign-in and organization management settings still apply.",
      responses: {
        200: jsonResponse("What the caller can share.", deviceShareOptionsSchema.meta({ ref: "DeviceShareOptions" })),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Organization not found, or sharing from a device is off for this organization (feature_disabled).", z.union([notFoundSchema, z.object({ error: z.literal("feature_disabled"), feature: z.string() })])),
      },
    }),
    orgMemberRoute(),
    userSessionRoute(),
    queryValidator(querySchema),
    async (c) => {
      const actor = c.get("organizationContext")
      if (!actor) return c.json({ error: "organization_not_found" }, 404)
      // Not requireFeature(): Settings reads this on every visit, which is not a use
      // of the feature. The app reports the use when a person actually shares.
      c.header("Cache-Control", "no-store")
      const organizationId = actor.organization.id
      const blocker = !(await hasPermission(c, "gateway_providers.manage")) ? "no_permission" as const
        : gatewayManagementUnavailable() ? "gateway_unavailable" as const
        : null
      if (blocker) {
        const owners = blocker === "no_permission"
          ? await db.select({ role: MemberTable.role, name: AuthUserTable.name })
            .from(MemberTable)
            .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
            .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt), sql`${MemberTable.role} like ${"%owner%"}`))
            .orderBy(asc(MemberTable.createdAt))
            .limit(5)
          : []
        const options: DeviceShareOptions = {
          canShare: false,
          blocker,
          managerName: owners.find((row) => roleIncludesOwner(row.role))?.name?.trim() || null,
          verificationRequired: false,
          providers: [],
        }
        return c.json(options)
      }
      const providerIds = parseDeviceShareProviderIds(c.req.valid("query").providerIds)
      const [catalog, existing] = providerIds.length
        ? await Promise.all([
          // An unreachable catalog offers nothing rather than an action that would fail.
          getModelsDevProviders(providerIds).catch(() => []),
          db.select({ providerId: GatewayProviderTable.provider_id, name: GatewayProviderTable.name })
            .from(GatewayProviderTable)
            .where(and(eq(GatewayProviderTable.organization_id, organizationId), eq(GatewayProviderTable.status, "active")))
            .orderBy(asc(GatewayProviderTable.created_at)),
        ])
        : [[], []]
      const options: DeviceShareOptions = {
        canShare: true,
        blocker: null,
        managerName: null,
        verificationRequired: !ensureFreshPrivilegedSession(c).ok,
        providers: deviceShareProviders({ providerIds, catalog, existing }),
      }
      return c.json(options)
    },
  )
}
