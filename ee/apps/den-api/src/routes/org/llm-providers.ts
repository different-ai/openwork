import { and, desc, eq, inArray, isNotNull, or } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  LlmProviderAccessTable,
  LlmProviderModelTable,
  LlmProviderTable,
  MemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import {
  jsonValidator,
  paramValidator,
  requireUserMiddleware,
  resolveMemberTeamsMiddleware,
  resolveOrganizationContextMiddleware,
} from "../../middleware/index.js"
import { getModelsDevProvider, listModelsDevProviders } from "../../llm/models-dev.js"
import type { MemberTeamsContext } from "../../middleware/member-teams.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { idParamSchema, memberHasRole, orgIdParamSchema } from "./shared.js"

type JsonRecord = Record<string, unknown>
type LlmProviderId = typeof LlmProviderTable.$inferSelect.id
type LlmProviderAccessId = typeof LlmProviderAccessTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type TeamId = typeof TeamTable.$inferSelect.id
type LlmProviderRow = typeof LlmProviderTable.$inferSelect

type RouteFailure = {
  status: number
  error: string
  message?: string
}

const providerCatalogParamsSchema = orgIdParamSchema.extend({
  providerId: z.string().trim().min(1).max(255),
})

const orgLlmProviderParamsSchema = orgIdParamSchema.extend(idParamSchema("llmProviderId", "llmProvider").shape)

const customModelSchema = z.object({
  id: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(255),
}).passthrough()

const customProviderSchema = z.object({
  id: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(255),
  npm: z.string().trim().min(1).max(255),
  env: z.array(z.string().trim().min(1).max(255)).min(1),
  doc: z.string().trim().min(1).max(2048),
  api: z.string().trim().min(1).max(2048).optional(),
  models: z.array(customModelSchema).min(1),
}).passthrough()

const llmProviderWriteSchema = z.object({
  source: z.enum(["models_dev", "custom"]),
  providerId: z.string().trim().min(1).max(255).optional(),
  modelIds: z.array(z.string().trim().min(1).max(255)).min(1).optional(),
  customConfigText: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().max(65535).optional(),
  memberIds: z.array(denTypeIdSchema("member")).max(500).optional().default([]),
  teamIds: z.array(denTypeIdSchema("team")).max(500).optional().default([]),
}).superRefine((value, ctx) => {
  if (value.source === "models_dev") {
    if (!value.providerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerId"],
        message: "Select a provider.",
      })
    }

    if (!value.modelIds?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelIds"],
        message: "Select at least one model.",
      })
    }
  }

  if (value.source === "custom" && !value.customConfigText) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["customConfigText"],
      message: "Paste a custom provider config.",
    })
  }
})

const providerCatalogListResponseSchema = z.object({
  providers: z.array(z.object({}).passthrough()),
}).meta({ ref: "LlmProviderCatalogListResponse" })

const providerCatalogResponseSchema = z.object({
  provider: z.object({}).passthrough(),
}).meta({ ref: "LlmProviderCatalogResponse" })

const llmProviderListResponseSchema = z.object({
  llmProviders: z.array(z.object({}).passthrough()),
}).meta({ ref: "LlmProviderListResponse" })

const llmProviderResponseSchema = z.object({
  llmProvider: z.object({}).passthrough(),
}).meta({ ref: "LlmProviderResponse" })

const providerCatalogUnavailableSchema = z.object({
  error: z.literal("provider_catalog_unavailable"),
  message: z.string(),
}).meta({ ref: "ProviderCatalogUnavailableError" })

const conflictSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
}).meta({ ref: "ConflictError" })

function createFailure(status: number, error: string, message?: string): RouteFailure {
  return { status, error, message }
}

function isRouteFailure(value: unknown): value is RouteFailure {
  return typeof value === "object" && value !== null && "status" in value && "error" in value
}

function isOrganizationAdmin(payload: { currentMember: { isOwner: boolean; role: string } }) {
  return payload.currentMember.isOwner || memberHasRole(payload.currentMember.role, "admin")
}

function canManageLlmProvider(
  payload: { currentMember: { id: MemberId; isOwner: boolean; role: string } },
  provider: LlmProviderRow,
) {
  return isOrganizationAdmin(payload) || provider.createdByOrgMembershipId === payload.currentMember.id
}

async function canAccessLlmProvider(input: {
  organizationId: typeof LlmProviderTable.$inferSelect.organizationId
  llmProviderId: LlmProviderId
  currentMemberId: MemberId
  memberTeams: Array<{ id: TeamId }>
  isAdmin: boolean
}) {
  if (input.isAdmin) {
    return true
  }

  const access = await listAccessibleProviderAccess({
    organizationId: input.organizationId,
    currentMemberId: input.currentMemberId,
    memberTeams: input.memberTeams,
  })

  return access.some((entry) => entry.llmProviderId === input.llmProviderId)
}

function parseLlmProviderId(value: string) {
  return normalizeDenTypeId("llmProvider", value)
}

function parseLlmProviderAccessId(value: string) {
  return normalizeDenTypeId("llmProviderAccess", value)
}

function parseMemberId(value: string) {
  return normalizeDenTypeId("member", value)
}

function parseTeamId(value: string) {
  return normalizeDenTypeId("team", value)
}

async function listAccessibleProviderAccess(input: {
  organizationId: typeof LlmProviderTable.$inferSelect.organizationId
  currentMemberId: MemberId
  memberTeams: Array<{ id: TeamId }>
}) {
  const teamIds = input.memberTeams.map((team) => team.id)
  const accessWhere = teamIds.length > 0
    ? and(
        eq(LlmProviderTable.organizationId, input.organizationId),
        or(
          eq(LlmProviderAccessTable.orgMembershipId, input.currentMemberId),
          inArray(LlmProviderAccessTable.teamId, teamIds),
        ),
      )
    : and(
        eq(LlmProviderTable.organizationId, input.organizationId),
        eq(LlmProviderAccessTable.orgMembershipId, input.currentMemberId),
      )

  return db
    .select({
      id: LlmProviderAccessTable.id,
      llmProviderId: LlmProviderAccessTable.llmProviderId,
      orgMembershipId: LlmProviderAccessTable.orgMembershipId,
      teamId: LlmProviderAccessTable.teamId,
      createdAt: LlmProviderAccessTable.createdAt,
    })
    .from(LlmProviderAccessTable)
    .innerJoin(LlmProviderTable, eq(LlmProviderAccessTable.llmProviderId, LlmProviderTable.id))
    .where(accessWhere)
}

async function resolveMemberIds(input: {
  organizationId: typeof LlmProviderTable.$inferSelect.organizationId
  values: string[]
}) {
  const uniqueValues = [...new Set(input.values)]
  if (uniqueValues.length === 0) {
    return [] as MemberId[]
  }

  const memberIds = uniqueValues.map((value) => {
    try {
      return parseMemberId(value)
    } catch {
      throw createFailure(404, "member_not_found")
    }
  })

  const rows = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), inArray(MemberTable.id, memberIds)))

  if (rows.length !== memberIds.length) {
    throw createFailure(404, "member_not_found")
  }

  return memberIds
}

async function resolveTeamIds(input: {
  organizationId: typeof LlmProviderTable.$inferSelect.organizationId
  values: string[]
}) {
  const uniqueValues = [...new Set(input.values)]
  if (uniqueValues.length === 0) {
    return [] as TeamId[]
  }

  const teamIds = uniqueValues.map((value) => {
    try {
      return parseTeamId(value)
    } catch {
      throw createFailure(404, "team_not_found")
    }
  })

  const rows = await db
    .select({ id: TeamTable.id })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, input.organizationId), inArray(TeamTable.id, teamIds)))

  if (rows.length !== teamIds.length) {
    throw createFailure(404, "team_not_found")
  }

  return teamIds
}

async function normalizeLlmProviderInput(input: z.infer<typeof llmProviderWriteSchema>) {
  if (input.source === "models_dev") {
    const provider = await getModelsDevProvider(input.providerId ?? "")
    if (!provider) {
      throw createFailure(404, "provider_not_found", "The selected provider was not found in models.dev.")
    }

    const requestedModelIds = [...new Set(input.modelIds ?? [])]
    const modelsById = new Map(provider.models.map((model) => [model.id, model]))
    const models = requestedModelIds.map((modelId) => {
      const model = modelsById.get(modelId)
      if (!model) {
        throw createFailure(404, "model_not_found", `Model ${modelId} is not available for ${provider.name}.`)
      }
      return model
    })

    const apiKey = input.apiKey?.trim() || null

    return {
      source: input.source,
      providerId: provider.id,
      name: provider.name,
      providerConfig: provider.config,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        config: model.config,
      })),
      apiKey,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(input.customConfigText ?? "")
  } catch {
    throw createFailure(400, "invalid_custom_provider_config", "Custom provider config must be valid JSON.")
  }

  const customProvider = customProviderSchema.safeParse(parsed)
  if (!customProvider.success) {
    throw createFailure(
      400,
      "invalid_custom_provider_config",
      customProvider.error.issues[0]?.message ?? "Custom provider config is invalid.",
    )
  }

  const { models, ...providerConfig } = customProvider.data

  return {
    source: input.source,
    providerId: customProvider.data.id,
    name: customProvider.data.name,
    providerConfig: providerConfig as JsonRecord,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      config: model as JsonRecord,
    })),
    apiKey: input.apiKey?.trim() || null,
  }
}

async function loadLlmProviders(input: {
  organizationId: typeof LlmProviderTable.$inferSelect.organizationId
  currentMemberId: MemberId
  memberTeams: Array<{ id: TeamId }>
  isAdmin: boolean
}) {
  const accessibleAccess = input.isAdmin
    ? []
    : await listAccessibleProviderAccess({
        organizationId: input.organizationId,
        currentMemberId: input.currentMemberId,
        memberTeams: input.memberTeams,
      })

  const accessibleProviderIds = [...new Set(accessibleAccess.map((entry) => entry.llmProviderId))]
  if (!input.isAdmin && accessibleProviderIds.length === 0) {
    return []
  }

  const providers = await db
    .select()
    .from(LlmProviderTable)
    .where(
      input.isAdmin
        ? eq(LlmProviderTable.organizationId, input.organizationId)
        : and(
            eq(LlmProviderTable.organizationId, input.organizationId),
            inArray(LlmProviderTable.id, accessibleProviderIds),
          ),
    )
    .orderBy(desc(LlmProviderTable.updatedAt))

  if (providers.length === 0) {
    return []
  }

  const providerIds = providers.map((provider) => provider.id)
  const models = await db
    .select()
    .from(LlmProviderModelTable)
    .where(inArray(LlmProviderModelTable.llmProviderId, providerIds))

  const memberAccessRows = await db
    .select({
      access: {
        id: LlmProviderAccessTable.id,
        llmProviderId: LlmProviderAccessTable.llmProviderId,
        createdAt: LlmProviderAccessTable.createdAt,
      },
      member: {
        id: MemberTable.id,
        role: MemberTable.role,
      },
      user: {
        id: AuthUserTable.id,
        name: AuthUserTable.name,
        email: AuthUserTable.email,
        image: AuthUserTable.image,
      },
    })
    .from(LlmProviderAccessTable)
    .innerJoin(MemberTable, eq(LlmProviderAccessTable.orgMembershipId, MemberTable.id))
    .innerJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .where(and(inArray(LlmProviderAccessTable.llmProviderId, providerIds), isNotNull(LlmProviderAccessTable.orgMembershipId)))

  const teamAccessRows = await db
    .select({
      access: {
        id: LlmProviderAccessTable.id,
        llmProviderId: LlmProviderAccessTable.llmProviderId,
        createdAt: LlmProviderAccessTable.createdAt,
      },
      team: {
        id: TeamTable.id,
        name: TeamTable.name,
        createdAt: TeamTable.createdAt,
        updatedAt: TeamTable.updatedAt,
      },
    })
    .from(LlmProviderAccessTable)
    .innerJoin(TeamTable, eq(LlmProviderAccessTable.teamId, TeamTable.id))
    .where(and(inArray(LlmProviderAccessTable.llmProviderId, providerIds), isNotNull(LlmProviderAccessTable.teamId)))

  const modelsByProviderId = new Map<LlmProviderId, typeof models>()
  for (const model of models) {
    const existing = modelsByProviderId.get(model.llmProviderId) ?? []
    existing.push(model)
    modelsByProviderId.set(model.llmProviderId, existing)
  }

  const memberAccessByProviderId = new Map<LlmProviderId, typeof memberAccessRows>()
  for (const row of memberAccessRows) {
    const existing = memberAccessByProviderId.get(row.access.llmProviderId) ?? []
    existing.push(row)
    memberAccessByProviderId.set(row.access.llmProviderId, existing)
  }

  const teamAccessByProviderId = new Map<LlmProviderId, typeof teamAccessRows>()
  for (const row of teamAccessRows) {
    const existing = teamAccessByProviderId.get(row.access.llmProviderId) ?? []
    existing.push(row)
    teamAccessByProviderId.set(row.access.llmProviderId, existing)
  }

  const accessibleViaByProviderId = new Map<LlmProviderId, { orgMembershipIds: MemberId[]; teamIds: TeamId[] }>()
  for (const row of accessibleAccess) {
    const existing = accessibleViaByProviderId.get(row.llmProviderId) ?? { orgMembershipIds: [], teamIds: [] }
    if (row.orgMembershipId && !existing.orgMembershipIds.includes(row.orgMembershipId)) {
      existing.orgMembershipIds.push(row.orgMembershipId)
    }
    if (row.teamId && !existing.teamIds.includes(row.teamId)) {
      existing.teamIds.push(row.teamId)
    }
    accessibleViaByProviderId.set(row.llmProviderId, existing)
  }

  return providers.map((provider) => ({
    ...provider,
    hasApiKey: Boolean(provider.apiKey && provider.apiKey.trim().length > 0),
    models: (modelsByProviderId.get(provider.id) ?? [])
      .map((model) => ({
        id: model.modelId,
        name: model.name,
        config: model.modelConfig,
        createdAt: model.createdAt,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    access: {
      members: (memberAccessByProviderId.get(provider.id) ?? []).map((row) => ({
        id: row.access.id,
        orgMembershipId: row.member.id,
        role: row.member.role,
        user: row.user,
        createdAt: row.access.createdAt,
      })),
      teams: (teamAccessByProviderId.get(provider.id) ?? []).map((row) => ({
        id: row.access.id,
        teamId: row.team.id,
        name: row.team.name,
        createdAt: row.team.createdAt,
        updatedAt: row.team.updatedAt,
      })),
    },
    accessibleVia: accessibleViaByProviderId.get(provider.id) ?? { orgMembershipIds: [], teamIds: [] },
  }))
}

export function registerOrgLlmProviderRoutes<T extends { Variables: OrgRouteVariables & Partial<MemberTeamsContext> }>(app: Hono<T>) {
  app.get(
    "/v1/orgs/:orgId/llm-provider-catalog",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "List LLM provider catalog",
      description: "Lists the provider catalog from models.dev so an organization can choose which LLM providers to configure.",
      responses: {
        200: jsonResponse("Provider catalog returned successfully.", providerCatalogListResponseSchema),
        400: jsonResponse("The provider catalog path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to browse the provider catalog.", unauthorizedSchema),
        502: jsonResponse("The external provider catalog was unavailable.", providerCatalogUnavailableSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
      try {
        const providers = await listModelsDevProviders()
        return c.json({ providers })
      } catch (error) {
        return c.json({
          error: "provider_catalog_unavailable",
          message: error instanceof Error ? error.message : "Could not load the models.dev catalog.",
        }, 502)
      }
    },
  )

  app.get(
    "/v1/orgs/:orgId/llm-provider-catalog/:providerId",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Get LLM provider catalog entry",
      description: "Returns the full models.dev catalog record for one provider, including its config template and model list.",
      responses: {
        200: jsonResponse("Provider catalog entry returned successfully.", providerCatalogResponseSchema),
        400: jsonResponse("The provider catalog path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to inspect provider catalog entries.", unauthorizedSchema),
        404: jsonResponse("The requested provider catalog entry could not be found.", notFoundSchema),
        502: jsonResponse("The external provider catalog was unavailable.", providerCatalogUnavailableSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(providerCatalogParamsSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
      const params = c.req.valid("param")

      try {
        const provider = await getModelsDevProvider(params.providerId)
        if (!provider) {
          return c.json({ error: "provider_not_found" }, 404)
        }

        return c.json({
          provider: {
            id: provider.id,
            name: provider.name,
            npm: provider.npm,
            env: provider.env,
            doc: provider.doc,
            api: provider.api,
            config: provider.config,
            models: provider.models,
          },
        })
      } catch (error) {
        return c.json({
          error: "provider_catalog_unavailable",
          message: error instanceof Error ? error.message : "Could not load the provider details.",
        }, 502)
      }
    },
  )

  app.get(
    "/v1/orgs/:orgId/llm-providers",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "List organization LLM providers",
      description: "Lists the LLM providers that the current organization member is allowed to see and potentially manage.",
      responses: {
        200: jsonResponse("Accessible organization LLM providers returned successfully.", llmProviderListResponseSchema),
        400: jsonResponse("The provider list path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list organization LLM providers.", unauthorizedSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const memberTeams = c.get("memberTeams") ?? []
      const providers = await loadLlmProviders({
        organizationId: payload.organization.id,
        currentMemberId: payload.currentMember.id,
        memberTeams,
        isAdmin: isOrganizationAdmin(payload),
      })

      return c.json({
        llmProviders: providers.map((provider) => ({
          ...provider,
          apiKey: undefined,
          canManage: canManageLlmProvider(payload, provider),
        })),
      })
    },
  )

  app.get(
    "/v1/orgs/:orgId/llm-providers/:llmProviderId/connect",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Get LLM provider connect payload",
      description: "Returns one accessible organization LLM provider with the concrete model configuration needed to connect to it.",
      responses: {
        200: jsonResponse("Provider connection payload returned successfully.", llmProviderResponseSchema),
        400: jsonResponse("The provider connect path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to connect to an organization LLM provider.", unauthorizedSchema),
        403: jsonResponse("Only members with access grants, the provider creator, or workspace admins can connect to this provider.", forbiddenSchema),
        404: jsonResponse("The provider could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgLlmProviderParamsSchema),
    resolveOrganizationContextMiddleware,
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const memberTeams = c.get("memberTeams") ?? []
      const params = c.req.valid("param")

      let llmProviderId: LlmProviderId
      try {
        llmProviderId = parseLlmProviderId(params.llmProviderId)
      } catch {
        return c.json({ error: "llm_provider_not_found" }, 404)
      }

      const providerRows = await db
        .select()
        .from(LlmProviderTable)
        .where(and(eq(LlmProviderTable.id, llmProviderId), eq(LlmProviderTable.organizationId, payload.organization.id)))
        .limit(1)

      const provider = providerRows[0]
      if (!provider) {
        return c.json({ error: "llm_provider_not_found" }, 404)
      }

      const accessible = await canAccessLlmProvider({
        organizationId: payload.organization.id,
        llmProviderId,
        currentMemberId: payload.currentMember.id,
        memberTeams,
        isAdmin: isOrganizationAdmin(payload),
      })

      if (!accessible) {
        return c.json({
          error: "forbidden",
          message: "You do not have access to this provider.",
        }, 403)
      }

      const models = await db
        .select()
        .from(LlmProviderModelTable)
        .where(eq(LlmProviderModelTable.llmProviderId, llmProviderId))

      return c.json({
        llmProvider: {
          ...provider,
          models: models
            .map((model) => ({
              id: model.modelId,
              name: model.name,
              config: model.modelConfig,
              createdAt: model.createdAt,
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        },
      })
    },
  )

  app.post(
    "/v1/orgs/:orgId/llm-providers",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Create organization LLM provider",
      description: "Creates a new organization-scoped LLM provider from either a models.dev provider template or a pasted custom configuration.",
      responses: {
        201: jsonResponse("Organization LLM provider created successfully.", llmProviderResponseSchema),
        400: jsonResponse("The provider creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create organization LLM providers.", unauthorizedSchema),
        404: jsonResponse("A referenced provider, model, member, or team could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(llmProviderWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const input = c.req.valid("json")

      try {
        const normalized = await normalizeLlmProviderInput(input)
        const memberIds = await resolveMemberIds({
          organizationId: payload.organization.id,
          values: input.memberIds,
        })
        const teamIds = await resolveTeamIds({
          organizationId: payload.organization.id,
          values: input.teamIds,
        })

        const llmProviderId = createDenTypeId("llmProvider")
        const protectedMemberIds = [...new Set([payload.currentMember.id, ...memberIds])]
        const now = new Date()

        await db.transaction(async (tx) => {
          await tx.insert(LlmProviderTable).values({
            id: llmProviderId,
            organizationId: payload.organization.id,
            createdByOrgMembershipId: payload.currentMember.id,
            source: normalized.source,
            providerId: normalized.providerId,
            name: normalized.name,
            providerConfig: normalized.providerConfig,
            apiKey: normalized.apiKey,
            createdAt: now,
            updatedAt: now,
          })

          if (normalized.models.length > 0) {
            await tx.insert(LlmProviderModelTable).values(
              normalized.models.map((model) => ({
                id: createDenTypeId("llmProviderModel"),
                llmProviderId,
                modelId: model.id,
                name: model.name,
                modelConfig: model.config,
                createdAt: now,
              })),
            )
          }

          const accessRows = [
            ...protectedMemberIds.map((orgMembershipId) => ({
              id: createDenTypeId("llmProviderAccess"),
              llmProviderId,
              orgMembershipId,
              teamId: null,
              createdAt: now,
            })),
            ...teamIds.map((teamId) => ({
              id: createDenTypeId("llmProviderAccess"),
              llmProviderId,
              orgMembershipId: null,
              teamId,
              createdAt: now,
            })),
          ]

          if (accessRows.length > 0) {
            await tx.insert(LlmProviderAccessTable).values(accessRows)
          }
        })

        return c.json({
          llmProvider: {
            id: llmProviderId,
            organizationId: payload.organization.id,
            createdByOrgMembershipId: payload.currentMember.id,
            source: normalized.source,
            providerId: normalized.providerId,
            name: normalized.name,
            providerConfig: normalized.providerConfig,
            hasApiKey: Boolean(normalized.apiKey),
            createdAt: now,
            updatedAt: now,
          },
        }, 201)
      } catch (error) {
        if (isRouteFailure(error)) {
          return c.json(
            { error: error.error, message: error.message },
            { status: error.status as 400 | 404 },
          )
        }

        throw error
      }
    },
  )

  app.patch(
    "/v1/orgs/:orgId/llm-providers/:llmProviderId",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Update organization LLM provider",
      description: "Updates an existing organization LLM provider, including its provider config, selected models, secret, and access grants.",
      responses: {
        200: jsonResponse("Organization LLM provider updated successfully.", llmProviderResponseSchema),
        400: jsonResponse("The provider update request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update organization LLM providers.", unauthorizedSchema),
        403: jsonResponse("Only the provider creator or a workspace admin can update providers.", forbiddenSchema),
        404: jsonResponse("The provider or a referenced resource could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgLlmProviderParamsSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(llmProviderWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")
      const input = c.req.valid("json")

      let llmProviderId: LlmProviderId
      try {
        llmProviderId = parseLlmProviderId(params.llmProviderId)
      } catch {
        return c.json({ error: "llm_provider_not_found" }, 404)
      }

      const providerRows = await db
        .select()
        .from(LlmProviderTable)
        .where(and(eq(LlmProviderTable.id, llmProviderId), eq(LlmProviderTable.organizationId, payload.organization.id)))
        .limit(1)

      const provider = providerRows[0]
      if (!provider) {
        return c.json({ error: "llm_provider_not_found" }, 404)
      }

      if (!canManageLlmProvider(payload, provider)) {
        return c.json({
          error: "forbidden",
          message: "Only the provider creator or a workspace admin can update providers.",
        }, 403)
      }

      try {
        const normalized = await normalizeLlmProviderInput(input)
        const memberIds = await resolveMemberIds({
          organizationId: payload.organization.id,
          values: input.memberIds,
        })
        const teamIds = await resolveTeamIds({
          organizationId: payload.organization.id,
          values: input.teamIds,
        })
        const protectedMemberIds = [...new Set([provider.createdByOrgMembershipId, ...memberIds])]
        const updatedAt = new Date()

        await db.transaction(async (tx) => {
          await tx
            .update(LlmProviderTable)
            .set({
              source: normalized.source,
              providerId: normalized.providerId,
              name: normalized.name,
              providerConfig: normalized.providerConfig,
              apiKey: input.apiKey === undefined ? provider.apiKey : normalized.apiKey,
              updatedAt,
            })
            .where(eq(LlmProviderTable.id, provider.id))

          await tx.delete(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId, provider.id))
          await tx.delete(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.llmProviderId, provider.id))

          if (normalized.models.length > 0) {
            await tx.insert(LlmProviderModelTable).values(
              normalized.models.map((model) => ({
                id: createDenTypeId("llmProviderModel"),
                llmProviderId: provider.id,
                modelId: model.id,
                name: model.name,
                modelConfig: model.config,
                createdAt: updatedAt,
              })),
            )
          }

          const accessRows = [
            ...protectedMemberIds.map((orgMembershipId) => ({
              id: createDenTypeId("llmProviderAccess"),
              llmProviderId: provider.id,
              orgMembershipId,
              teamId: null,
              createdAt: updatedAt,
            })),
            ...teamIds.map((teamId) => ({
              id: createDenTypeId("llmProviderAccess"),
              llmProviderId: provider.id,
              orgMembershipId: null,
              teamId,
              createdAt: updatedAt,
            })),
          ]

          if (accessRows.length > 0) {
            await tx.insert(LlmProviderAccessTable).values(accessRows)
          }
        })

        return c.json({
          llmProvider: {
            ...provider,
            source: normalized.source,
            providerId: normalized.providerId,
            name: normalized.name,
            providerConfig: normalized.providerConfig,
            hasApiKey: input.apiKey === undefined ? Boolean(provider.apiKey) : Boolean(normalized.apiKey),
            updatedAt,
          },
        })
      } catch (error) {
        if (isRouteFailure(error)) {
          return c.json(
            { error: error.error, message: error.message },
            { status: error.status as 400 | 404 },
          )
        }

        throw error
      }
    },
  )

  app.delete(
    "/v1/orgs/:orgId/llm-providers/:llmProviderId",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Delete organization LLM provider",
      description: "Deletes an organization LLM provider and removes its models and access rules.",
      responses: {
        204: emptyResponse("Organization LLM provider deleted successfully."),
        400: jsonResponse("The provider deletion path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to delete organization LLM providers.", unauthorizedSchema),
        403: jsonResponse("Only the provider creator or a workspace admin can delete providers.", forbiddenSchema),
        404: jsonResponse("The provider could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgLlmProviderParamsSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")

      let llmProviderId: LlmProviderId
      try {
        llmProviderId = parseLlmProviderId(params.llmProviderId)
      } catch {
        return c.json({ error: "llm_provider_not_found" }, 404)
      }

      const providerRows = await db
        .select()
        .from(LlmProviderTable)
        .where(and(eq(LlmProviderTable.id, llmProviderId), eq(LlmProviderTable.organizationId, payload.organization.id)))
        .limit(1)

      const provider = providerRows[0]
      if (!provider) {
        return c.json({ error: "llm_provider_not_found" }, 404)
      }

      if (!canManageLlmProvider(payload, provider)) {
        return c.json({
          error: "forbidden",
          message: "Only the provider creator or a workspace admin can delete providers.",
        }, 403)
      }

      await db.transaction(async (tx) => {
        await tx.delete(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.llmProviderId, provider.id))
        await tx.delete(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId, provider.id))
        await tx.delete(LlmProviderTable).where(eq(LlmProviderTable.id, provider.id))
      })

      return c.body(null, 204)
    },
  )

  app.delete(
    "/v1/orgs/:orgId/llm-providers/:llmProviderId/access/:accessId",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Remove LLM provider access grant",
      description: "Removes one explicit member or team access grant from an organization LLM provider.",
      responses: {
        204: emptyResponse("Organization LLM provider access removed successfully."),
        400: jsonResponse("The provider access deletion path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage provider access.", unauthorizedSchema),
        403: jsonResponse("Only the provider creator or a workspace admin can manage provider access.", forbiddenSchema),
        404: jsonResponse("The provider or access grant could not be found.", notFoundSchema),
        409: jsonResponse("The request tried to remove a protected provider access entry.", conflictSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgLlmProviderParamsSchema.extend(idParamSchema("accessId", "llmProviderAccess").shape)),
    resolveOrganizationContextMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")

      let llmProviderId: LlmProviderId
      let accessId: LlmProviderAccessId
      try {
        llmProviderId = parseLlmProviderId(params.llmProviderId)
        accessId = parseLlmProviderAccessId(params.accessId)
      } catch {
        return c.json({ error: "not_found" }, 404)
      }

      const providerRows = await db
        .select()
        .from(LlmProviderTable)
        .where(and(eq(LlmProviderTable.id, llmProviderId), eq(LlmProviderTable.organizationId, payload.organization.id)))
        .limit(1)

      const provider = providerRows[0]
      if (!provider) {
        return c.json({ error: "llm_provider_not_found" }, 404)
      }

      if (!canManageLlmProvider(payload, provider)) {
        return c.json({ error: "forbidden", message: "Only the provider creator or a workspace admin can manage access." }, 403)
      }

      const accessRows = await db
        .select()
        .from(LlmProviderAccessTable)
        .where(and(eq(LlmProviderAccessTable.id, accessId), eq(LlmProviderAccessTable.llmProviderId, provider.id)))
        .limit(1)

      const access = accessRows[0]
      if (!access) {
        return c.json({ error: "llm_provider_access_not_found" }, 404)
      }

      if (access.orgMembershipId === provider.createdByOrgMembershipId) {
        return c.json({
          error: "protected_access",
          message: "The provider creator always keeps direct access.",
        }, 409)
      }

      await db.delete(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.id, access.id))
      return c.body(null, 204)
    },
  )
}
