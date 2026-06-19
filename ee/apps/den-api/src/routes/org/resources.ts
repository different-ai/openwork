import { and, desc, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectTable,
  LlmProviderAccessTable,
  LlmProviderTable,
  MarketplacePluginTable,
  MarketplaceTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import {
  type MemberTeamsContext,
  orgMemberRoute,
  resolveMemberTeamsMiddleware,
} from "../../middleware/index.js"
import { jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { resolvePluginArchResourceRole, type PluginArchActorContext } from "./plugin-system/access.js"
import type { OrgRouteVariables } from "./shared.js"

type OrganizationId = typeof LlmProviderTable.$inferSelect.organizationId
type MemberId = NonNullable<typeof LlmProviderAccessTable.$inferSelect.orgMembershipId>
type TeamId = NonNullable<typeof LlmProviderAccessTable.$inferSelect.teamId>
type MarketplaceId = typeof MarketplaceTable.$inferSelect.id
type PluginId = typeof PluginTable.$inferSelect.id

const timestampSchema = z.string().datetime()

const resourceSnapshotResponseSchema = z.object({
  organizationId: z.string(),
  orgMemberId: z.string(),
  teamIds: z.array(z.string()),
  resources: z.object({
    llmProviders: z.record(z.string(), timestampSchema),
    marketplaces: z.record(z.string(), z.object({
      lastUpdatedAt: timestampSchema,
      plugins: z.array(z.object({
        pluginId: z.string(),
        lastUpdatedAt: timestampSchema,
        configItems: z.array(z.object({
          configItemId: z.string(),
          lastUpdatedAt: timestampSchema,
        })),
      })),
    })),
  }),
}).meta({ ref: "ResourceSnapshotResponse" })

type ResourceSnapshot = z.infer<typeof resourceSnapshotResponseSchema>
type ResourceMarketplace = ResourceSnapshot["resources"]["marketplaces"][string]
type ResourcePlugin = ResourceMarketplace["plugins"][number]

function timestamp(value: Date) {
  return value.toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function readDate(value: unknown) {
  return value instanceof Date ? value : new Date(0)
}

function readMemberTeams(value: unknown, organizationId: OrganizationId): PluginArchActorContext["memberTeams"] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return []
    try {
      return [{
        id: normalizeDenTypeId("team", entry.id),
        name: typeof entry.name === "string" ? entry.name : "",
        organizationId,
        createdAt: readDate(entry.createdAt),
        updatedAt: readDate(entry.updatedAt),
      }]
    } catch {
      return []
    }
  })
}

async function listAccessibleLlmProviders(input: {
  currentMemberId: MemberId
  organizationId: OrganizationId
  teamIds: TeamId[]
}) {
  const accessWhere = input.teamIds.length > 0
    ? and(
        eq(LlmProviderTable.organizationId, input.organizationId),
        or(
          eq(LlmProviderAccessTable.orgMembershipId, input.currentMemberId),
          inArray(LlmProviderAccessTable.teamId, input.teamIds),
        ),
      )
    : and(
        eq(LlmProviderTable.organizationId, input.organizationId),
        eq(LlmProviderAccessTable.orgMembershipId, input.currentMemberId),
      )

  const rows = await db
    .select({
      id: LlmProviderTable.id,
      updatedAt: LlmProviderTable.updatedAt,
    })
    .from(LlmProviderAccessTable)
    .innerJoin(LlmProviderTable, eq(LlmProviderAccessTable.llmProviderId, LlmProviderTable.id))
    .where(accessWhere)
    .orderBy(desc(LlmProviderTable.updatedAt), desc(LlmProviderTable.id))

  const providers: Record<string, string> = {}
  for (const row of rows) {
    providers[row.id] = timestamp(row.updatedAt)
  }
  return providers
}

async function listAccessibleMarketplaces(input: {
  context: PluginArchActorContext
  organizationId: OrganizationId
}) {
  const marketplaceRows = await db
    .select({
      id: MarketplaceTable.id,
      updatedAt: MarketplaceTable.updatedAt,
    })
    .from(MarketplaceTable)
    .where(and(
      eq(MarketplaceTable.organizationId, input.organizationId),
      eq(MarketplaceTable.status, "active"),
      isNull(MarketplaceTable.deletedAt),
    ))
    .orderBy(desc(MarketplaceTable.updatedAt), desc(MarketplaceTable.id))

  const marketplaceAccess = await Promise.all(
    marketplaceRows.map(async (row) => ({
      row,
      role: await resolvePluginArchResourceRole({
        context: input.context,
        resourceId: row.id,
        resourceKind: "marketplace",
      }),
    })),
  )
  const visibleMarketplaces = marketplaceAccess.flatMap((entry) => entry.role ? [entry.row] : [])

  const marketplaceIds = visibleMarketplaces.map((marketplace) => marketplace.id)
  if (marketplaceIds.length === 0) {
    return {}
  }

  const marketplaceMemberships = await db
    .select({
      marketplaceId: MarketplacePluginTable.marketplaceId,
      pluginId: MarketplacePluginTable.pluginId,
    })
    .from(MarketplacePluginTable)
    .where(and(
      eq(MarketplacePluginTable.organizationId, input.organizationId),
      inArray(MarketplacePluginTable.marketplaceId, marketplaceIds),
      isNull(MarketplacePluginTable.removedAt),
    ))

  const pluginIds = [...new Set(marketplaceMemberships.map((membership) => membership.pluginId))]
  const pluginRows = pluginIds.length === 0
    ? []
    : await db
      .select({
        id: PluginTable.id,
        updatedAt: PluginTable.updatedAt,
      })
      .from(PluginTable)
      .where(and(
        eq(PluginTable.organizationId, input.organizationId),
        inArray(PluginTable.id, pluginIds),
        eq(PluginTable.status, "active"),
        isNull(PluginTable.deletedAt),
      ))

  const activePluginIds = pluginRows.map((plugin) => plugin.id)
  const configMemberships = activePluginIds.length === 0
    ? []
    : await db
      .select({
        configItemId: ConfigObjectTable.id,
        lastUpdatedAt: ConfigObjectTable.updatedAt,
        pluginId: PluginConfigObjectTable.pluginId,
      })
      .from(PluginConfigObjectTable)
      .innerJoin(ConfigObjectTable, eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id))
      .where(and(
        eq(PluginConfigObjectTable.organizationId, input.organizationId),
        inArray(PluginConfigObjectTable.pluginId, activePluginIds),
        isNull(PluginConfigObjectTable.removedAt),
        eq(ConfigObjectTable.status, "active"),
        isNull(ConfigObjectTable.deletedAt),
      ))

  const pluginsById = new Map(pluginRows.map((plugin) => [plugin.id, plugin]))
  const configItemsByPluginId = new Map<PluginId, ResourcePlugin["configItems"]>()
  for (const membership of configMemberships) {
    const existing = configItemsByPluginId.get(membership.pluginId) ?? []
    existing.push({
      configItemId: membership.configItemId,
      lastUpdatedAt: timestamp(membership.lastUpdatedAt),
    })
    configItemsByPluginId.set(membership.pluginId, existing)
  }

  const pluginIdsByMarketplaceId = new Map<MarketplaceId, PluginId[]>()
  for (const membership of marketplaceMemberships) {
    if (!pluginsById.has(membership.pluginId)) continue
    const existing = pluginIdsByMarketplaceId.get(membership.marketplaceId) ?? []
    existing.push(membership.pluginId)
    pluginIdsByMarketplaceId.set(membership.marketplaceId, existing)
  }

  const marketplaces: Record<string, ResourceMarketplace> = {}
  for (const marketplace of visibleMarketplaces) {
    const plugins = (pluginIdsByMarketplaceId.get(marketplace.id) ?? []).flatMap((pluginId) => {
      const plugin = pluginsById.get(pluginId)
      if (!plugin) return []
      return [{
        pluginId: plugin.id,
        lastUpdatedAt: timestamp(plugin.updatedAt),
        configItems: configItemsByPluginId.get(plugin.id) ?? [],
      }]
    })

    marketplaces[marketplace.id] = {
      lastUpdatedAt: timestamp(marketplace.updatedAt),
      plugins,
    }
  }

  return marketplaces
}

export function registerOrgResourceRoutes<T extends { Variables: OrgRouteVariables & Partial<MemberTeamsContext> }>(app: Hono<T>) {
  app.get(
    "/v1/resources",
    describeRoute({
      tags: ["Resources"],
      summary: "Get accessible resource snapshot",
      description: "Returns IDs and update timestamps for cloud resources visible to the current organization member.",
      responses: {
        200: jsonResponse("Accessible resource snapshot returned successfully.", resourceSnapshotResponseSchema),
        401: jsonResponse("The caller must be signed in to list resources.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const organizationContext = c.get("organizationContext")
      if (!organizationContext) {
        return c.json({ error: "organization_not_found" }, 404)
      }

      const organizationId = organizationContext.organization.id
      const orgMemberId = organizationContext.currentMember.id
      const memberTeams = readMemberTeams(c.get("memberTeams"), organizationId)
      const teamIds = memberTeams.map((team) => team.id)

      const [llmProviders, marketplaces] = await Promise.all([
        listAccessibleLlmProviders({
          currentMemberId: orgMemberId,
          organizationId,
          teamIds,
        }),
        listAccessibleMarketplaces({
          context: { memberTeams, organizationContext, session: c.get("session") },
          organizationId,
        }),
      ])

      return c.json({
        organizationId,
        orgMemberId,
        teamIds,
        resources: {
          llmProviders,
          marketplaces,
        },
      })
    },
  )
}
