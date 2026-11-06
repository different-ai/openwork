import { and, eq } from "@openwork-ee/den-db/drizzle"
import { GatewayProviderTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { workbotReadinessSchema, readWorkbotModel } from "@openwork/types/den/workbot-settings"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { db } from "../../db.js"
import { orgMemberRoute } from "../../middleware/index.js"
import { jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { workbotIncludedDefaultModel, workbotUsesManagedDefault } from "../../workbot/managed-luna.js"
import { cloudAgentLegacyCatalog } from "../../workbot/legacy-model.js"
import type { OrgRouteVariables } from "./shared.js"

const workbotReadinessDocumentSchema = workbotReadinessSchema.meta({ ref: "WorkbotReadiness" })

async function hasActiveGatewayProvider(organizationId: string): Promise<boolean> {
  const [provider] = await db.select({ id: GatewayProviderTable.id }).from(GatewayProviderTable)
    .where(and(eq(GatewayProviderTable.organization_id, normalizeDenTypeId("organization", organizationId)), eq(GatewayProviderTable.status, "active")))
    .limit(1)
  return Boolean(provider)
}

/**
 * Members cannot list providers, so Den web reads this content-free answer before sending someone
 * to Workbot. A supported, credential-ready legacy provider also satisfies the custom-provider prerequisite.
 */
export function registerOrgWorkbotReadinessRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/workbot-readiness",
    describeRoute({
      tags: ["Organizations"],
      summary: "Check whether Workbot has an AI provider",
      description:
        "Returns whether Workbot turns need a custom provider and, only then, whether an active Gateway provider or a usable legacy provider exists. The legacy wire fields gatewayRequired and hasGatewayProvider also cover supported legacy providers with current member access and credentials. The managed default uses the member's included OpenWork models and needs no custom provider while the member is entitled to them. Content-free: no provider names, counts, ids, models or grants. Each turn rechecks the member's access. Available to any organization member. Never exposed to MCP.",
      ...{ "x-mcp": false },
      responses: {
        200: jsonResponse("Whether Workbot needs an AI Gateway provider and whether one exists.", workbotReadinessDocumentSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        404: jsonResponse("The caller is not a member of the organization.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const { organization, currentMember } = c.get("organizationContext")
      const organizationId = organization.id
      const chosen = readWorkbotModel(organization.metadata)
      const managedLuna = workbotUsesManagedDefault(chosen)
        && await workbotIncludedDefaultModel({ organizationId, userId: currentMember.userId }, chosen) !== null
      const gatewayRequired = !managedLuna
      // Keep the content-free wire field for older clients; a usable legacy route also satisfies it.
      const hasGatewayProvider = gatewayRequired && (await hasActiveGatewayProvider(organizationId)
        || (await cloudAgentLegacyCatalog({ organizationId, userId: currentMember.userId })).models.length > 0)
      return c.json({ gatewayRequired, hasGatewayProvider })
    },
  )
}
