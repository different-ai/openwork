import { and, desc, eq, inArray, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  InvitationTable,
  LlmProviderAccessTable,
  LlmProviderMemberCredentialTable,
  LlmProviderModelTable,
  LlmProviderTable,
  MemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { CustomProviderConfigError, normalizeCustomProviderConfig } from "../../llm/custom-provider.js"
import { probeEndpoint, verifyModels } from "../../llm/endpoint-probe.js"
import {
  ProviderCredentialError,
  decodeProviderCredential,
  listConfiguredEnvKeys,
  readProviderEnvNames,
  resolveProviderCredential,
} from "../../llm/provider-credentials.js"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  queryValidator,
  resolveMemberTeamsMiddleware,
} from "../../middleware/index.js"
import { getModelsDevProvider, listModelsDevProviders } from "../../llm/models-dev.js"
import type { MemberTeamsContext } from "../../middleware/member-teams.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { repairMemberInferenceAccessIfNeeded } from "../../inference.js"
import { listAccessibleLlmProviderAccess, listGrantedLlmProviderMemberIds } from "./llm-provider-access.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdmin, ensureOrganizationAdminRole, idParamSchema, memberHasRole, orgAccessFailureStatus } from "./shared.js"

type LlmProviderId = typeof LlmProviderTable.$inferSelect.id
type LlmProviderAccessId = typeof LlmProviderAccessTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type TeamId = typeof TeamTable.$inferSelect.id
type LlmProviderRow = typeof LlmProviderTable.$inferSelect
type LlmProviderMemberCredentialRow = typeof LlmProviderMemberCredentialTable.$inferSelect

type NonMcpDescribeRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeNonMcpRoute = (options: NonMcpDescribeRouteOptions) => describeRoute(options)

type RouteFailure = {
  status: number
  error: string
  message?: string
}

function getInvitedMemberName(email: string) {
  const [localPart, domain = "invited"] = email.split("@")
  return `${localPart} ${domain.split(".")[0] ?? "invited"}`.trim()
}

const providerCatalogParamsSchema = z.object({
  providerId: z.string().trim().min(1).max(255),
})

const orgLlmProviderParamsSchema = idParamSchema("llmProviderId", "llmProvider")
const orgLlmProviderMemberCredentialParamsSchema = orgLlmProviderParamsSchema.extend({
  orgMembershipId: denTypeIdSchema("member"),
})

const llmProviderListQuerySchema = z.object({
  scope: z.enum(["usable", "manageable"]).optional().default("usable"),
})

const llmProviderWriteSchema = z.object({
  name: z.string().trim().min(1).max(255),
  source: z.enum(["models_dev", "custom"]),
  providerId: z.string().trim().min(1).max(255).optional(),
  modelIds: z.array(z.string().trim().min(1).max(255)).min(1).optional(),
  customConfigText: z.string().trim().min(1).optional(),
  customConfig: z.unknown().optional(),
  credentialMode: z.enum(["shared", "per_member"]).optional().default("shared"),
  apiKey: z.string().trim().max(65535).optional(),
  apiKeys: z.record(z.string().trim().min(1).max(255), z.string().trim().max(65535)).optional(),
  memberIds: z.array(denTypeIdSchema("member")).max(500).optional().default([]),
  teamIds: z.array(denTypeIdSchema("team")).max(500).optional().default([]),
  // Grants the whole organization (current and future members) access via a
  // single org-wide access row instead of materialized member ids.
  allMembers: z.boolean().optional().default(false),
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

  if (value.source === "custom" && !value.customConfigText && value.customConfig === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["customConfigText"],
      message: "Paste a custom provider config.",
    })
  }
})

const memberCredentialInputFields = {
  apiKey: z.string().trim().min(1).max(65535).optional(),
  apiKeys: z.record(
    z.string().trim().min(1).max(255),
    z.string().trim().min(1).max(65535),
  ).refine((value) => Object.keys(value).length > 0, "Provide at least one credential.").optional(),
}

function requireExactlyOneCredential(
  value: { apiKey?: string; apiKeys?: Record<string, string> },
  ctx: z.RefinementCtx,
) {
  if ((value.apiKey === undefined) === (value.apiKeys === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one of apiKey or apiKeys.",
    })
  }
}

const memberCredentialWriteSchema = z.object(memberCredentialInputFields)
  .superRefine(requireExactlyOneCredential)

const adminMemberCredentialWriteSchema = z.object({
  ...memberCredentialInputFields,
  externalPrincipalId: z.string().trim().min(1).max(255).optional(),
  externalCredentialId: z.string().trim().min(1).max(255).optional(),
  expectedVersion: z.number().int().positive().optional(),
}).superRefine(requireExactlyOneCredential)

const endpointProbeRequestSchema = z.object({
  api: z.string().trim().min(1).max(2048),
  apiKey: z.string().trim().max(65535).optional(),
  modelIds: z.array(z.string().trim().min(1).max(255)).max(8).optional(),
})

const endpointProbeResponseSchema = z.object({
  result: z.object({
    ok: z.boolean(),
    vendor: z.enum(["azure", "openai-compatible"]),
    normalizedApi: z.string().nullable(),
    attempted: z.array(z.string()),
    models: z.array(z.object({ id: z.string() })),
    hint: z.string().nullable(),
    status: z.number().nullable(),
  }),
  verifications: z.array(z.object({
    id: z.string(),
    status: z.enum(["ok", "adjusted", "failed"]),
    npm: z.enum(["@ai-sdk/openai-compatible", "@ai-sdk/openai"]),
    message: z.string().nullable(),
  })).optional(),
}).meta({ ref: "LlmProviderTestConnectionResponse" })

const providerCatalogListResponseSchema = z.object({
  providers: z.array(z.object({}).passthrough()),
}).meta({ ref: "LlmProviderCatalogListResponse" })

const providerCatalogResponseSchema = z.object({
  provider: z.object({}).passthrough(),
}).meta({ ref: "LlmProviderCatalogResponse" })

const llmProviderListResponseSchema = z.object({
  llmProviders: z.array(z.object({}).passthrough()),
}).meta({ ref: "LlmProviderListResponse" })

const memberCredentialConnectionSchema = z.object({
  state: z.enum(["missing", "active", "blocked", "stale", "error"]),
})
const llmProviderResponseSchema = z.object({
  llmProvider: z.object({
    memberCredential: memberCredentialConnectionSchema.optional(),
  }).passthrough(),
}).meta({ ref: "LlmProviderResponse" })

const providerCatalogUnavailableSchema = z.object({
  error: z.literal("provider_catalog_unavailable"),
  message: z.string(),
}).meta({ ref: "ProviderCatalogUnavailableError" })

const conflictSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
}).meta({ ref: "ConflictError" })

const memberCredentialStateSchema = z.enum(["active", "blocked", "stale", "error"])
const memberCredentialSummarySchema = z.object({
  state: memberCredentialStateSchema,
  version: z.number().int().positive(),
  updatedAt: z.string().datetime(),
}).meta({ ref: "LlmProviderMemberCredentialSummary" })
const memberCredentialListResponseSchema = z.object({
  memberCredentials: z.array(z.object({
    orgMembershipId: denTypeIdSchema("member"),
    state: z.enum(["missing", "active", "blocked", "stale", "error"]),
    externalPrincipalId: z.string().nullable(),
    externalCredentialId: z.string().nullable(),
    version: z.number().int().positive().nullable(),
    updatedAt: z.string().datetime().nullable(),
  })),
}).meta({ ref: "LlmProviderMemberCredentialListResponse" })
const memberCredentialDeleteResponseSchema = z.object({
  ok: z.literal(true),
}).meta({ ref: "LlmProviderMemberCredentialDeleteResponse" })
const versionConflictSchema = z.object({
  error: z.literal("version_conflict"),
}).meta({ ref: "LlmProviderCredentialVersionConflictError" })
const notPerMemberSchema = z.object({
  error: z.literal("not_per_member"),
}).meta({ ref: "LlmProviderNotPerMemberError" })
const credentialBlockedSchema = z.object({
  error: z.literal("credential_blocked"),
}).meta({ ref: "LlmProviderCredentialBlockedError" })
const memberCredentialBadRequestSchema = z.union([
  invalidRequestSchema,
  notPerMemberSchema,
  z.object({ error: z.literal("invalid_api_keys"), message: z.string().optional() }),
])

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
}) {
  const access = await listAccessibleLlmProviderAccess({
    organizationId: input.organizationId,
    currentMemberId: input.currentMemberId,
    teamIds: input.memberTeams.map((team) => team.id),
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
    .where(and(eq(MemberTable.organizationId, input.organizationId), inArray(MemberTable.id, memberIds), isNull(MemberTable.removedAt)))

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

function resolveCredentialColumn(input: {
  providerConfig: Record<string, unknown>
  existingProvider: Pick<LlmProviderRow, "apiKey" | "providerConfig"> | null
  apiKey?: string
  apiKeys?: Record<string, string>
}) {
  try {
    return resolveProviderCredential({
      envNames: readProviderEnvNames(input.providerConfig),
      existing: input.existingProvider
        ? {
            value: input.existingProvider.apiKey,
            envNames: readProviderEnvNames(input.existingProvider.providerConfig ?? {}),
          }
        : null,
      apiKey: input.apiKey,
      apiKeys: input.apiKeys,
    })
  } catch (error) {
    if (error instanceof ProviderCredentialError) {
      throw createFailure(400, "invalid_api_keys", error.message)
    }

    throw error
  }
}

function resolveMemberCredentialSecret(
  provider: Pick<LlmProviderRow, "providerConfig">,
  input: z.infer<typeof memberCredentialWriteSchema>,
) {
  const secret = resolveCredentialColumn({
    providerConfig: provider.providerConfig,
    existingProvider: null,
    apiKey: input.apiKey,
    apiKeys: input.apiKeys,
  })
  if (!secret) {
    throw createFailure(400, "invalid_api_keys", "Provide a non-empty credential.")
  }
  return secret
}

function memberCredentialSummary(credential: LlmProviderMemberCredentialRow) {
  return {
    state: credential.state,
    version: credential.version,
    updatedAt: credential.updatedAt.toISOString(),
  }
}

type MemberCredentialWriteResult = {
  status: "ok"
  credential: LlmProviderMemberCredentialRow
} | {
  status: "version_conflict"
} | {
  status: "blocked"
}

async function upsertMemberCredential(input: {
  organizationId: LlmProviderMemberCredentialRow["organizationId"]
  llmProviderId: LlmProviderId
  orgMembershipId: MemberId
  secret: string
  createdBy: LlmProviderMemberCredentialRow["createdBy"]
  /**
   * A blocked binding is admin-owned: member self-service must not overwrite
   * it back to active. Admin provisioning passes true, which is the explicit
   * unblock path.
   */
  allowBlockedOverwrite: boolean
  externalPrincipalId?: string
  externalCredentialId?: string
  expectedVersion?: number
}): Promise<MemberCredentialWriteResult> {
  return db.transaction(async (tx): Promise<MemberCredentialWriteResult> => {
    const rows = await tx
      .select()
      .from(LlmProviderMemberCredentialTable)
      .where(and(
        eq(LlmProviderMemberCredentialTable.organizationId, input.organizationId),
        eq(LlmProviderMemberCredentialTable.llmProviderId, input.llmProviderId),
        eq(LlmProviderMemberCredentialTable.orgMembershipId, input.orgMembershipId),
      ))
      .limit(1)
      .for("update")
    const existing = rows[0]
    if (existing?.state === "blocked" && !input.allowBlockedOverwrite) {
      return { status: "blocked" }
    }
    if (input.expectedVersion !== undefined && existing?.version !== input.expectedVersion) {
      return { status: "version_conflict" }
    }

    const updatedAt = new Date()
    if (existing) {
      const credential: LlmProviderMemberCredentialRow = {
        ...existing,
        secret: input.secret,
        externalPrincipalId: input.externalPrincipalId ?? existing.externalPrincipalId,
        externalCredentialId: input.externalCredentialId ?? existing.externalCredentialId,
        state: "active",
        version: existing.version + 1,
        createdBy: input.createdBy,
        updatedAt,
      }
      await tx
        .update(LlmProviderMemberCredentialTable)
        .set({
          secret: credential.secret,
          externalPrincipalId: credential.externalPrincipalId,
          externalCredentialId: credential.externalCredentialId,
          state: credential.state,
          version: credential.version,
          createdBy: credential.createdBy,
          updatedAt,
        })
        .where(eq(LlmProviderMemberCredentialTable.id, existing.id))
      return { status: "ok", credential }
    }

    const credential: LlmProviderMemberCredentialRow = {
      id: createDenTypeId("llmProviderMemberCredential"),
      organizationId: input.organizationId,
      llmProviderId: input.llmProviderId,
      orgMembershipId: input.orgMembershipId,
      secret: input.secret,
      externalPrincipalId: input.externalPrincipalId ?? null,
      externalCredentialId: input.externalCredentialId ?? null,
      state: "active",
      version: 1,
      createdBy: input.createdBy,
      createdAt: updatedAt,
      updatedAt,
    }
    await tx.insert(LlmProviderMemberCredentialTable).values(credential)
    return { status: "ok", credential }
  })
}

async function getLlmProvider(input: {
  organizationId: LlmProviderRow["organizationId"]
  llmProviderId: LlmProviderId
}) {
  const rows = await db
    .select()
    .from(LlmProviderTable)
    .where(and(
      eq(LlmProviderTable.organizationId, input.organizationId),
      eq(LlmProviderTable.id, input.llmProviderId),
    ))
    .limit(1)
  return rows[0] ?? null
}

async function normalizeLlmProviderInput(
  input: z.infer<typeof llmProviderWriteSchema>,
  existingProvider: Pick<LlmProviderRow, "apiKey" | "providerConfig"> | null = null,
) {
  if (input.source === "models_dev") {
    const provider = await getModelsDevProvider(input.providerId ?? "")
    if (!provider) {
      throw createFailure(404, "provider_not_found", "The selected provider was not found in models.dev.")
    }

    const requestedModelIds = [...new Set(input.modelIds ?? [])]
    const modelsById = new Map(provider.models.map((model) => [model.id, model]))
    // Azure model lists come from the resource's *deployments*, which admins
    // can name anything — accept ids outside the models.dev catalog for
    // Azure providers instead of rejecting the save.
    const allowDeploymentIds = provider.npm === "@ai-sdk/azure"
    const models = requestedModelIds.map((modelId) => {
      const model = modelsById.get(modelId)
      if (!model) {
        if (allowDeploymentIds) {
          return { id: modelId, name: modelId, config: { id: modelId, name: modelId } }
        }
        throw createFailure(404, "model_not_found", `Model ${modelId} is not available for ${provider.name}.`)
      }
      return model
    })

    return {
      source: input.source,
      providerId: provider.id,
      name: input.name,
      providerConfig: provider.config,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        config: model.config,
      })),
      apiKey: resolveCredentialColumn({
        providerConfig: provider.config,
        existingProvider,
        apiKey: input.apiKey,
        apiKeys: input.apiKeys,
      }),
    }
  }

  try {
    const customProvider = normalizeCustomProviderConfig({
      customConfigText: input.customConfigText,
      customConfig: input.customConfig,
    })

    return {
      source: input.source,
      providerId: customProvider.providerId,
      name: input.name,
      providerConfig: customProvider.providerConfig,
      models: customProvider.models,
      apiKey: resolveCredentialColumn({
        providerConfig: customProvider.providerConfig,
        existingProvider,
        apiKey: input.apiKey,
        apiKeys: input.apiKeys,
      }),
    }
  } catch (error) {
    if (error instanceof CustomProviderConfigError) {
      throw createFailure(400, "invalid_custom_provider_config", error.message)
    }

    throw error
  }
}

async function loadLlmProviders(input: {
  organizationId: typeof LlmProviderTable.$inferSelect.organizationId
  currentMemberId: MemberId
  memberTeams: Array<{ id: TeamId }>
  isAdmin: boolean
  scope: "usable" | "manageable"
}) {
  const accessibleAccess = await listAccessibleLlmProviderAccess({
    organizationId: input.organizationId,
    currentMemberId: input.currentMemberId,
    teamIds: input.memberTeams.map((team) => team.id),
  })

  const accessibleProviderIds = [...new Set(accessibleAccess.map((entry) => entry.llmProviderId))]
  if (input.scope === "usable" && accessibleProviderIds.length === 0) {
    return []
  }

  const providerWhere = input.scope === "manageable"
    ? input.isAdmin
      ? eq(LlmProviderTable.organizationId, input.organizationId)
      : and(
          eq(LlmProviderTable.organizationId, input.organizationId),
          eq(LlmProviderTable.createdByOrgMembershipId, input.currentMemberId),
        )
    : and(
        eq(LlmProviderTable.organizationId, input.organizationId),
        inArray(LlmProviderTable.id, accessibleProviderIds),
      )

  const providers = await db
    .select()
    .from(LlmProviderTable)
    .where(providerWhere)
    .orderBy(desc(LlmProviderTable.updatedAt))

  if (providers.length === 0) {
    return []
  }

  const providerIds = providers.map((provider) => provider.id)
  const [models, myCredentials] = await Promise.all([
    db
      .select()
      .from(LlmProviderModelTable)
      .where(inArray(LlmProviderModelTable.llmProviderId, providerIds)),
    input.scope === "usable"
      ? db
          .select({ llmProviderId: LlmProviderMemberCredentialTable.llmProviderId })
          .from(LlmProviderMemberCredentialTable)
          .where(and(
            eq(LlmProviderMemberCredentialTable.organizationId, input.organizationId),
            eq(LlmProviderMemberCredentialTable.orgMembershipId, input.currentMemberId),
            eq(LlmProviderMemberCredentialTable.state, "active"),
            inArray(LlmProviderMemberCredentialTable.llmProviderId, providerIds),
          ))
      : Promise.resolve([]),
  ])
  const myCredentialProviderIds = new Set(myCredentials.map((credential) => credential.llmProviderId))

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
      invitation: {
        email: InvitationTable.email,
      },
    })
    .from(LlmProviderAccessTable)
    .innerJoin(MemberTable, eq(LlmProviderAccessTable.orgMembershipId, MemberTable.id))
    .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .leftJoin(InvitationTable, eq(MemberTable.inviteId, InvitationTable.id))
    .where(and(inArray(LlmProviderAccessTable.llmProviderId, providerIds), isNotNull(LlmProviderAccessTable.orgMembershipId), isNull(MemberTable.removedAt)))

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

  // Org-wide grants: one access row per provider with neither member nor team.
  const everyoneAccessRows = await db
    .select({
      llmProviderId: LlmProviderAccessTable.llmProviderId,
    })
    .from(LlmProviderAccessTable)
    .where(and(
      inArray(LlmProviderAccessTable.llmProviderId, providerIds),
      isNull(LlmProviderAccessTable.orgMembershipId),
      isNull(LlmProviderAccessTable.teamId),
    ))
  const everyoneProviderIds = new Set(everyoneAccessRows.map((row) => row.llmProviderId))

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
    ...(input.scope === "usable" ? {
      hasMyCredential: provider.credentialMode === "per_member" && myCredentialProviderIds.has(provider.id),
    } : {}),
    hasApiKey: Boolean(provider.apiKey && provider.apiKey.trim().length > 0),
    configuredEnvKeys: listConfiguredEnvKeys(provider.apiKey, readProviderEnvNames(provider.providerConfig ?? {})),
    models: (modelsByProviderId.get(provider.id) ?? [])
      .map((model) => ({
        id: model.modelId,
        name: model.name,
        config: model.modelConfig,
        createdAt: model.createdAt,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    access: {
      allMembers: everyoneProviderIds.has(provider.id),
      members: (memberAccessByProviderId.get(provider.id) ?? []).map((row) => {
        const email = row.user?.email ?? row.invitation?.email ?? "invited@example.com"
        return {
          id: row.access.id,
          orgMembershipId: row.member.id,
          role: row.member.role,
          user: {
            id: row.user?.id ?? row.member.id,
            name: row.user?.name ?? getInvitedMemberName(email),
            email,
            image: row.user?.image ?? null,
          },
          createdAt: row.access.createdAt,
        }
      }),
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
  app.post(
    "/v1/llm-providers/test-connection",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Test a custom LLM provider endpoint",
      description: "Probes an OpenAI-compatible endpoint (Azure AI Foundry, LiteLLM, vLLM, gateways) with the given credential: normalizes common base-URL mistakes, calls GET /models, and returns the model ids the endpoint actually serves — on Azure these are the deployment names. Nothing is stored.",
      responses: {
        200: jsonResponse("Probe completed (ok=false carries a human hint).", endpointProbeResponseSchema),
        400: jsonResponse("The probe request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to test provider endpoints.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(endpointProbeRequestSchema),
    async (c) => {
      const input = c.req.valid("json")
      const result = await probeEndpoint({ api: input.api, apiKey: input.apiKey ?? "" })
      if (result.ok && result.normalizedApi && input.modelIds?.length) {
        const verifications = await verifyModels({
          api: result.normalizedApi,
          apiKey: input.apiKey ?? "",
          modelIds: input.modelIds,
        })
        return c.json({ result, verifications })
      }
      return c.json({ result })
    },
  )

  app.get(
    "/v1/llm-provider-catalog",
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
    orgMemberRoute(),
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
    "/v1/llm-provider-catalog/:providerId",
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
    orgMemberRoute(),
    paramValidator(providerCatalogParamsSchema),
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
    "/v1/llm-providers",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "List organization LLM providers",
      description: "Lists usable providers by default. Pass scope=manageable to list providers the current member can administer in Den.",
      responses: {
        200: jsonResponse("Accessible organization LLM providers returned successfully.", llmProviderListResponseSchema),
        400: jsonResponse("The provider list path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list organization LLM providers.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(llmProviderListQuerySchema),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const query = c.req.valid("query")
      const payload = c.get("organizationContext")
      const memberTeams = c.get("memberTeams") ?? []

      // Desktop entitlement is based on this list. If org inference is enabled
      // but this member's OpenWork provider/key was deleted, re-provision before
      // listing so Subscribe CTAs don't lie about an already-enabled org.
      if (query.scope === "usable") {
        try {
          await repairMemberInferenceAccessIfNeeded({
            organizationId: payload.organization.id,
            memberId: payload.currentMember.id,
          })
        } catch {
          // Keep listing other providers even if OpenWork re-provision fails.
        }
      }

      const providers = await loadLlmProviders({
        organizationId: payload.organization.id,
        currentMemberId: payload.currentMember.id,
        memberTeams,
        isAdmin: isOrganizationAdmin(payload),
        scope: query.scope,
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
    "/v1/llm-providers/:llmProviderId/connect",
    describeNonMcpRoute({
      tags: ["LLM Providers"],
      "x-mcp": false,
      summary: "Get LLM provider connect payload",
      description: "Returns one accessible organization LLM provider with the concrete model configuration needed to connect to it.",
      responses: {
        200: jsonResponse("Provider connection payload returned successfully.", llmProviderResponseSchema),
        400: jsonResponse("The provider connect path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to connect to an organization LLM provider.", unauthorizedSchema),
        403: jsonResponse("Only members with access can connect to this provider.", forbiddenSchema),
        404: jsonResponse("The provider could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(orgLlmProviderParamsSchema),
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

      let credential = decodeProviderCredential(provider.apiKey)
      let memberCredential: z.infer<typeof memberCredentialConnectionSchema> | null = null
      if (provider.credentialMode === "per_member") {
        const bindingRows = await db
          .select()
          .from(LlmProviderMemberCredentialTable)
          .where(and(
            eq(LlmProviderMemberCredentialTable.organizationId, payload.organization.id),
            eq(LlmProviderMemberCredentialTable.llmProviderId, llmProviderId),
            eq(LlmProviderMemberCredentialTable.orgMembershipId, payload.currentMember.id),
          ))
          .limit(1)
        const binding = bindingRows[0]
        const credentialState = binding?.state ?? "missing"
        memberCredential = { state: credentialState }
        credential = credentialState === "active" && binding
          ? decodeProviderCredential(binding.secret)
          : { apiKey: null, apiKeys: null }
      }

      // This route must stay 200 for granted callers: published desktop builds
      // fail the entire sync on non-OK connect responses, while null credentials
      // already make those clients skip only this provider.
      // Decode the stored credential so the wire format stays additive: legacy
      // single-secret providers keep returning `apiKey`, multi-env providers
      // return `apiKeys` with `apiKey: null` so old clients fail with their
      // missing-credential error instead of applying a JSON blob as the key.
      return c.json({
        llmProvider: {
          ...provider,
          apiKey: credential.apiKey,
          apiKeys: credential.apiKeys,
          ...(memberCredential ? { memberCredential } : {}),
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

  app.put(
    "/v1/llm-providers/:llmProviderId/my-credential",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Set the calling member's LLM provider credential",
      description: "Stores a write-only credential for the calling member on a granted per-member provider.",
      responses: {
        200: jsonResponse("Member credential stored.", memberCredentialSummarySchema),
        400: jsonResponse("The provider is not per-member or the credential is invalid.", memberCredentialBadRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller has not been granted this provider.", forbiddenSchema),
        404: jsonResponse("The provider could not be found.", notFoundSchema),
        409: jsonResponse("The credential is blocked and only an admin can replace it.", credentialBlockedSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(orgLlmProviderParamsSchema),
    jsonValidator(memberCredentialWriteSchema),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      const memberTeams = c.get("memberTeams") ?? []
      const llmProviderId = parseLlmProviderId(params.llmProviderId)
      const provider = await getLlmProvider({ organizationId: payload.organization.id, llmProviderId })
      if (!provider) return c.json({ error: "llm_provider_not_found" }, 404)

      const accessible = await canAccessLlmProvider({
        organizationId: payload.organization.id,
        llmProviderId,
        currentMemberId: payload.currentMember.id,
        memberTeams,
      })
      if (!accessible) {
        return c.json({ error: "forbidden", message: "You do not have access to this provider." }, 403)
      }
      if (provider.credentialMode !== "per_member") {
        return c.json({ error: "not_per_member" }, 400)
      }

      let secret: string
      try {
        secret = resolveMemberCredentialSecret(provider, input)
      } catch (error) {
        if (isRouteFailure(error)) return c.json({ error: error.error, message: error.message }, 400)
        throw error
      }
      const result = await upsertMemberCredential({
        organizationId: payload.organization.id,
        llmProviderId,
        orgMembershipId: payload.currentMember.id,
        secret,
        createdBy: "member",
        allowBlockedOverwrite: false,
      })
      if (result.status === "blocked") {
        return c.json({ error: "credential_blocked" }, 409)
      }
      if (result.status !== "ok") {
        throw new Error("member_credential_write_unexpected_conflict")
      }
      return c.json(memberCredentialSummary(result.credential))
    },
  )

  app.delete(
    "/v1/llm-providers/:llmProviderId/my-credential",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Delete the calling member's LLM provider credential",
      responses: {
        200: jsonResponse("Member credential deleted.", memberCredentialDeleteResponseSchema),
        400: jsonResponse("The provider is not per-member.", z.union([invalidRequestSchema, notPerMemberSchema])),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller has not been granted this provider.", forbiddenSchema),
        404: jsonResponse("The provider could not be found.", notFoundSchema),
        409: jsonResponse("The credential is blocked and only an admin can remove it.", credentialBlockedSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(orgLlmProviderParamsSchema),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")
      const memberTeams = c.get("memberTeams") ?? []
      const llmProviderId = parseLlmProviderId(params.llmProviderId)
      const provider = await getLlmProvider({ organizationId: payload.organization.id, llmProviderId })
      if (!provider) return c.json({ error: "llm_provider_not_found" }, 404)

      const accessible = await canAccessLlmProvider({
        organizationId: payload.organization.id,
        llmProviderId,
        currentMemberId: payload.currentMember.id,
        memberTeams,
      })
      if (!accessible) {
        return c.json({ error: "forbidden", message: "You do not have access to this provider." }, 403)
      }
      if (provider.credentialMode !== "per_member") {
        return c.json({ error: "not_per_member" }, 400)
      }

      // A blocked binding is admin-owned: deleting it here would let the
      // member re-create an active one, bypassing the block.
      const deleted = await db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: LlmProviderMemberCredentialTable.id, state: LlmProviderMemberCredentialTable.state })
          .from(LlmProviderMemberCredentialTable)
          .where(and(
            eq(LlmProviderMemberCredentialTable.organizationId, payload.organization.id),
            eq(LlmProviderMemberCredentialTable.llmProviderId, llmProviderId),
            eq(LlmProviderMemberCredentialTable.orgMembershipId, payload.currentMember.id),
          ))
          .limit(1)
          .for("update")
        const existing = rows[0]
        if (!existing) return { status: "ok" as const }
        if (existing.state === "blocked") return { status: "blocked" as const }
        await tx.delete(LlmProviderMemberCredentialTable).where(eq(LlmProviderMemberCredentialTable.id, existing.id))
        return { status: "ok" as const }
      })
      if (deleted.status === "blocked") {
        return c.json({ error: "credential_blocked" }, 409)
      }
      return c.json({ ok: true })
    },
  )

  app.get(
    "/v1/llm-providers/:llmProviderId/member-credentials",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "List member credential states for an LLM provider",
      description: "Admin-only. Lists credential state and external identifiers for every granted member without returning secret material.",
      responses: {
        200: jsonResponse("Granted member credential states returned.", memberCredentialListResponseSchema),
        400: jsonResponse("The provider id is invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can list member credentials.", forbiddenSchema),
        404: jsonResponse("The provider could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(orgLlmProviderParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can list member credentials.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const params = c.req.valid("param")
      const llmProviderId = parseLlmProviderId(params.llmProviderId)
      const provider = await getLlmProvider({ organizationId: payload.organization.id, llmProviderId })
      if (!provider) return c.json({ error: "llm_provider_not_found" }, 404)

      const memberIds = await listGrantedLlmProviderMemberIds({
        organizationId: payload.organization.id,
        llmProviderId,
      })
      const credentials = memberIds.length > 0
        ? await db
            .select()
            .from(LlmProviderMemberCredentialTable)
            .where(and(
              eq(LlmProviderMemberCredentialTable.organizationId, payload.organization.id),
              eq(LlmProviderMemberCredentialTable.llmProviderId, llmProviderId),
              inArray(LlmProviderMemberCredentialTable.orgMembershipId, memberIds),
            ))
        : []
      const credentialsByMemberId = new Map(credentials.map((credential) => [credential.orgMembershipId, credential]))

      return c.json({
        memberCredentials: memberIds.sort().map((orgMembershipId) => {
          const credential = credentialsByMemberId.get(orgMembershipId)
          return {
            orgMembershipId,
            state: credential?.state ?? "missing",
            externalPrincipalId: credential?.externalPrincipalId ?? null,
            externalCredentialId: credential?.externalCredentialId ?? null,
            version: credential?.version ?? null,
            updatedAt: credential?.updatedAt.toISOString() ?? null,
          }
        }),
      })
    },
  )

  app.put(
    "/v1/llm-providers/:llmProviderId/member-credentials/:orgMembershipId",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Set one member's LLM provider credential",
      description: "Admin-only. Stores write-only credential material and optional external provisioner identifiers.",
      responses: {
        200: jsonResponse("Member credential stored.", memberCredentialSummarySchema),
        400: jsonResponse("The provider is not per-member or the credential is invalid.", memberCredentialBadRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can provision member credentials.", forbiddenSchema),
        404: jsonResponse("The provider or member could not be found.", notFoundSchema),
        409: jsonResponse("The member credential version changed.", versionConflictSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(orgLlmProviderMemberCredentialParamsSchema),
    jsonValidator(adminMemberCredentialWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can provision member credentials.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const params = c.req.valid("param")
      const input = c.req.valid("json")
      const llmProviderId = parseLlmProviderId(params.llmProviderId)
      const orgMembershipId = parseMemberId(params.orgMembershipId)
      const provider = await getLlmProvider({ organizationId: payload.organization.id, llmProviderId })
      if (!provider) return c.json({ error: "llm_provider_not_found" }, 404)
      if (provider.credentialMode !== "per_member") {
        return c.json({ error: "not_per_member" }, 400)
      }

      const memberRows = await db
        .select({ id: MemberTable.id })
        .from(MemberTable)
        .where(and(
          eq(MemberTable.organizationId, payload.organization.id),
          eq(MemberTable.id, orgMembershipId),
          isNull(MemberTable.removedAt),
        ))
        .limit(1)
      if (!memberRows[0]) return c.json({ error: "member_not_found" }, 404)

      let secret: string
      try {
        secret = resolveMemberCredentialSecret(provider, input)
      } catch (error) {
        if (isRouteFailure(error)) return c.json({ error: error.error, message: error.message }, 400)
        throw error
      }
      const result = await upsertMemberCredential({
        organizationId: payload.organization.id,
        llmProviderId,
        orgMembershipId,
        secret,
        createdBy: "admin",
        allowBlockedOverwrite: true,
        externalPrincipalId: input.externalPrincipalId,
        externalCredentialId: input.externalCredentialId,
        expectedVersion: input.expectedVersion,
      })
      if (result.status === "version_conflict") {
        return c.json({ error: "version_conflict" }, 409)
      }
      if (result.status !== "ok") {
        throw new Error("member_credential_admin_write_unexpected_conflict")
      }
      return c.json(memberCredentialSummary(result.credential))
    },
  )

  app.post(
    "/v1/llm-providers/:llmProviderId/member-credentials/:orgMembershipId/block",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Block one member's LLM provider credential",
      responses: {
        200: jsonResponse("Member credential blocked.", memberCredentialSummarySchema),
        400: jsonResponse("The provider or member id is invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can block member credentials.", forbiddenSchema),
        404: jsonResponse("The provider or member credential could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(orgLlmProviderMemberCredentialParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can block member credentials.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const params = c.req.valid("param")
      const llmProviderId = parseLlmProviderId(params.llmProviderId)
      const orgMembershipId = parseMemberId(params.orgMembershipId)
      const provider = await getLlmProvider({ organizationId: payload.organization.id, llmProviderId })
      if (!provider) return c.json({ error: "llm_provider_not_found" }, 404)

      const rows = await db
        .select()
        .from(LlmProviderMemberCredentialTable)
        .where(and(
          eq(LlmProviderMemberCredentialTable.organizationId, payload.organization.id),
          eq(LlmProviderMemberCredentialTable.llmProviderId, llmProviderId),
          eq(LlmProviderMemberCredentialTable.orgMembershipId, orgMembershipId),
        ))
        .limit(1)
      const existing = rows[0]
      if (!existing) return c.json({ error: "member_credential_not_found" }, 404)

      const credential: LlmProviderMemberCredentialRow = {
        ...existing,
        state: "blocked",
        version: existing.version + 1,
        updatedAt: new Date(),
      }
      await db
        .update(LlmProviderMemberCredentialTable)
        .set({ state: credential.state, version: credential.version, updatedAt: credential.updatedAt })
        .where(eq(LlmProviderMemberCredentialTable.id, existing.id))
      return c.json(memberCredentialSummary(credential))
    },
  )

  app.post(
    "/v1/llm-providers",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Create organization LLM provider",
      description: "Creates a new organization-scoped LLM provider from either a models.dev provider template, pasted JSON/JSONC custom configuration, or MCP-supplied customConfig object.",
      responses: {
        201: jsonResponse("Organization LLM provider created successfully.", llmProviderResponseSchema),
        400: jsonResponse("The provider creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create organization LLM providers.", unauthorizedSchema),
        404: jsonResponse("A referenced provider, model, member, or team could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
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
            credentialMode: input.credentialMode,
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

          const accessRows = input.allMembers
            ? [
                // One org-wide grant plus the creator's protected direct row.
                {
                  id: createDenTypeId("llmProviderAccess"),
                  llmProviderId,
                  orgMembershipId: null,
                  teamId: null,
                  createdAt: now,
                },
                {
                  id: createDenTypeId("llmProviderAccess"),
                  llmProviderId,
                  orgMembershipId: payload.currentMember.id,
                  teamId: null,
                  createdAt: now,
                },
              ]
            : [
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
            credentialMode: input.credentialMode,
            hasApiKey: Boolean(normalized.apiKey),
            configuredEnvKeys: listConfiguredEnvKeys(normalized.apiKey, readProviderEnvNames(normalized.providerConfig)),
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
    "/v1/llm-providers/:llmProviderId",
    describeRoute({
      tags: ["LLM Providers"],
      summary: "Update organization LLM provider",
      description: "Updates an existing organization LLM provider, including its provider config, selected models, secret, and access grants. Custom providers accept JSON/JSONC text or an MCP-supplied customConfig object.",
      responses: {
        200: jsonResponse("Organization LLM provider updated successfully.", llmProviderResponseSchema),
        400: jsonResponse("The provider update request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update organization LLM providers.", unauthorizedSchema),
        403: jsonResponse("Only the provider creator or a workspace admin can update providers.", forbiddenSchema),
        404: jsonResponse("The provider or a referenced resource could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(orgLlmProviderParamsSchema),
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

      if (isOrganizationAdmin(payload)) {
        const permission = ensureOrganizationAdmin(c, "Only the provider creator or a workspace admin can update providers.")
        if (!permission.ok) {
          return c.json(permission.response, orgAccessFailureStatus(permission.response))
        }
      }

      try {
        const normalized = await normalizeLlmProviderInput(input, provider)
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
              credentialMode: input.credentialMode,
              apiKey: normalized.apiKey,
              updatedAt,
            })
            .where(eq(LlmProviderTable.id, provider.id))

          if (provider.credentialMode !== input.credentialMode) {
            await tx
              .delete(LlmProviderMemberCredentialTable)
              .where(eq(LlmProviderMemberCredentialTable.llmProviderId, provider.id))
          }

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

          const accessRows = input.allMembers
            ? [
                // One org-wide grant plus the creator's protected direct row.
                {
                  id: createDenTypeId("llmProviderAccess"),
                  llmProviderId: provider.id,
                  orgMembershipId: null,
                  teamId: null,
                  createdAt: updatedAt,
                },
                {
                  id: createDenTypeId("llmProviderAccess"),
                  llmProviderId: provider.id,
                  orgMembershipId: provider.createdByOrgMembershipId,
                  teamId: null,
                  createdAt: updatedAt,
                },
              ]
            : [
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
            credentialMode: input.credentialMode,
            apiKey: undefined,
            hasApiKey: Boolean(normalized.apiKey),
            configuredEnvKeys: listConfiguredEnvKeys(normalized.apiKey, readProviderEnvNames(normalized.providerConfig)),
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
    "/v1/llm-providers/:llmProviderId",
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
    orgMemberRoute(),
    paramValidator(orgLlmProviderParamsSchema),
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

      if (isOrganizationAdmin(payload)) {
        const permission = ensureOrganizationAdmin(c, "Only the provider creator or a workspace admin can delete providers.")
        if (!permission.ok) {
          return c.json(permission.response, orgAccessFailureStatus(permission.response))
        }
      }

      await db.transaction(async (tx) => {
        await tx.delete(LlmProviderMemberCredentialTable).where(eq(LlmProviderMemberCredentialTable.llmProviderId, provider.id))
        await tx.delete(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.llmProviderId, provider.id))
        await tx.delete(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId, provider.id))
        await tx.delete(LlmProviderTable).where(eq(LlmProviderTable.id, provider.id))
      })

      return c.body(null, 204)
    },
  )

  app.delete(
    "/v1/llm-providers/:llmProviderId/access/:accessId",
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
    orgMemberRoute(),
    paramValidator(orgLlmProviderParamsSchema.extend(idParamSchema("accessId", "llmProviderAccess").shape)),
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

      if (isOrganizationAdmin(payload)) {
        const permission = ensureOrganizationAdmin(c, "Only the provider creator or a workspace admin can manage access.")
        if (!permission.ok) {
          return c.json(permission.response, orgAccessFailureStatus(permission.response))
        }
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
