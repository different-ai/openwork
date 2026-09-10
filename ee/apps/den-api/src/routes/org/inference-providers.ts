import { randomBytes } from "node:crypto"
import { and, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { GatewayCredentialSetTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderOauthStateTable, GatewayProviderTable, LlmProviderAccessTable, LlmProviderMemberCredentialTable, LlmProviderModelTable, LlmProviderTable, MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { GATEWAY_PROVIDER_CREDENTIAL_KINDS, GATEWAY_PROVIDER_CREDENTIAL_MODES, GATEWAY_PROVIDER_CREDENTIAL_STATUSES, GATEWAY_PROVIDER_STATUSES, type GatewayAccessGrantWrite, type GatewayProviderConnectResponse, type GatewayProviderSummary } from "@openwork/types/den/gateway"
import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { createPkcePair, OAuthTokenExchangeError, resolvePublicApiBaseUrl } from "../../capability-sources/generic-oauth.js"
import { connectCallbackPage } from "../../capability-sources/oauth-callback-page.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { gatewayManagementUnavailable, gatewayManagementUnavailableSchema } from "../../gateway-deployment.js"
import { ensureMemberGatewayKey } from "../../gateway-keys.js"
import { GatewayWriteError, gatewayCatalog, gatewayGrantSummary, gatewaySummary, refreshGatewayCatalog, resolveGatewayCatalog, validateGatewaySettings, writeGatewayGrant, writeGatewayGroup, writeGatewayModels, writeGatewaySet, type GatewayMemberId, type GatewayProvider, type GatewaySet, type GatewayTx } from "../../llm/gateway-matrix.js"
import { gatewayConfigurationError, gatewayModelConfigurationError, isSupportedGatewayNpm, nonSecretProviderConfig, publicProviderSettings, readProviderConfigNpm } from "../../llm/inference-provider-config.js"
import { buildGoogleAuthorizeUrl, exchangeGoogleAuthorizationCode, GOOGLE_CLOUD_PLATFORM_SCOPE, revokeGoogleToken } from "../../llm/inference-provider-google-oauth.js"
import { effectiveGatewayGrants, lockMemberOAuthAuthorization, memberGatewayTeams, revokeGoogleCredentials } from "../../llm/inference-provider-lifecycle.js"
import { isMigrationSourceLockConflict } from "../../llm/inference-provider-migration.js"
import { getModelsDevProvider } from "../../llm/models-dev.js"
import { decodeProviderCredential, readProviderEnvNames, runtimeProviderEnvNames } from "../../llm/provider-credentials.js"
import { jsonValidator, orgMemberRoute, paramValidator, publicRoute, queryValidator } from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, htmlResponse, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { ensureOrganizationAdmin, ensureOrganizationAdminRole, idParamSchema, memberHasRole, orgAccessFailureStatus } from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"
import { registerOrgGatewayUsageRoutes } from "./gateway-usage.js"

const paramsSchema = idParamSchema("inferenceProviderId", "inferenceProvider")
const groupParams = paramsSchema.extend(idParamSchema("groupId", "gatewayModelGroup").shape)
const setParams = paramsSchema.extend(idParamSchema("credentialSetId", "gatewayCredentialSet").shape)
const grantParams = paramsSchema.extend(idParamSchema("grantId", "inferenceProviderAccess").shape)
const nameSchema = z.string().trim().min(1).max(255)
const modelIdsSchema = z.array(nameSchema).max(500)
const credentialSchema = z.object({ kind: z.enum(GATEWAY_PROVIDER_CREDENTIAL_KINDS), secret: z.string().trim().min(1).max(65535) }).strict()
const apiKeysSchema = z.record(nameSchema, z.string().trim().max(65535))
const oauthFields = { oauthClientId: z.string().trim().max(255).optional(), oauthClientSecret: z.string().trim().max(4096).optional() }
const groupWrite = z.object({ name: nameSchema, description: z.string().max(10000).nullable().optional(), modelIds: modelIdsSchema, status: z.enum(GATEWAY_PROVIDER_STATUSES).optional() }).strict()
const setWrite = z.object({ name: nameSchema, credentialMode: z.enum(GATEWAY_PROVIDER_CREDENTIAL_MODES), credential: credentialSchema.optional(), apiKeys: apiKeysSchema.optional(), ...oauthFields, status: z.enum(GATEWAY_PROVIDER_STATUSES).optional() }).strict()
const audienceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("organization") }).strict(),
  z.object({ type: z.literal("team"), teamId: denTypeIdSchema("team") }).strict(),
  z.object({ type: z.literal("member"), memberId: denTypeIdSchema("member") }).strict(),
])
const grantWrite = z.object({ modelGroupId: denTypeIdSchema("gatewayModelGroup"), credentialSetId: denTypeIdSchema("gatewayCredentialSet"), audience: audienceSchema }).strict()
const settingsSchema = z.object({ project: z.string().trim().max(255).optional(), location: z.string().trim().max(63).optional(), resourceName: z.string().trim().max(63).optional(), apiVersion: z.string().trim().max(64).optional(), region: z.string().trim().max(63).optional(), upstreamBaseUrl: z.string().trim().max(2048).optional() }).strict()
const legacyFields = { credentialMode: z.enum(GATEWAY_PROVIDER_CREDENTIAL_MODES).optional(), credential: credentialSchema.optional(), apiKeys: apiKeysSchema.optional(), ...oauthFields, allMembers: z.boolean().optional(), memberIds: z.array(denTypeIdSchema("member")).max(500).optional(), teamIds: z.array(denTypeIdSchema("team")).max(500).optional() }
const universeSchema = modelIdsSchema.describe("Provider universe policy: [] follows all supported catalog models; nonempty restricts to these IDs. Does not grant group membership.")
const createSchema = z.object({ name: nameSchema, providerId: nameSchema, modelIds: universeSchema.default([]), settings: settingsSchema.optional(), status: z.enum(GATEWAY_PROVIDER_STATUSES).optional(), ...legacyFields }).strict().superRefine(singleCredential)
const patchSchema = z.object({ name: nameSchema.optional(), providerId: nameSchema.optional(), modelIds: universeSchema.optional(), settings: settingsSchema.optional(), status: z.enum(GATEWAY_PROVIDER_STATUSES).optional(), ...legacyFields }).strict().superRefine(singleCredential)
const oauthQuery = z.object({ credentialSetId: denTypeIdSchema("gatewayCredentialSet").optional(), redirectTo: z.string().trim().min(1).max(2048).optional() }).strict()
function singleCredential(input: { credential?: unknown; apiKeys?: unknown }, ctx: z.RefinementCtx) {
  if (input.credential !== undefined && input.apiKeys !== undefined) ctx.addIssue({ code: "custom", message: "Provide credential or apiKeys, not both." })
}

const groupSchema = groupWrite.extend({ id: denTypeIdSchema("gatewayModelGroup"), description: z.string().nullable(), status: z.enum(GATEWAY_PROVIDER_STATUSES) })
const credentialStatus = z.enum(["ready", "member_auth_required", "org_credential_missing"])
const setSchema = z.object({ id: denTypeIdSchema("gatewayCredentialSet"), name: z.string(), createdAt: z.string().datetime().optional(), createdBy: z.object({ id: denTypeIdSchema("member"), name: z.string().nullable(), email: z.string().nullable() }).nullable().optional(), credentialMode: z.enum(GATEWAY_PROVIDER_CREDENTIAL_MODES), status: z.enum(GATEWAY_PROVIDER_STATUSES), configured: z.boolean(), credentialStatus, oauthClientId: z.string().nullable().optional(), hasOauthClientSecret: z.boolean().optional() })
const grantSchema = grantWrite.extend({ id: denTypeIdSchema("inferenceProviderAccess") })
const summarySchema = z.object({
  modelIds: universeSchema, catalogWarning: z.string().optional(),
  id: denTypeIdSchema("inferenceProvider"), providerId: z.string(), name: z.string(), source: z.literal("openwork_gateway"), credentialMode: z.enum(GATEWAY_PROVIDER_CREDENTIAL_MODES), credentialStatus, authUrl: z.string().nullable(), status: z.enum(GATEWAY_PROVIDER_STATUSES), updatedAt: z.string().datetime(), providerConfig: z.record(z.string(), z.unknown()),
  models: z.array(z.object({ id: z.string(), name: z.string(), config: z.object({ id: z.string() }).catchall(z.unknown()), upstreamModelId: z.string(), modelGroupId: denTypeIdSchema("gatewayModelGroup"), modelGroupName: z.string(), credentialSetId: denTypeIdSchema("gatewayCredentialSet"), credentialSetName: z.string() })),
  authorizationRequests: z.array(z.object({ credentialSetId: denTypeIdSchema("gatewayCredentialSet"), name: z.string(), authUrl: z.string() })),
  migration: z.object({ llmProviderId: denTypeIdSchema("llmProvider"), runtimeEnvNames: z.array(z.string()) }).optional(),
}).meta({ ref: "GatewayProviderSummary" })
const detailsSchema = summarySchema.extend({ settings: z.record(z.string(), z.unknown()), modelGroups: z.array(groupSchema), credentialSets: z.array(setSchema), accessGrants: z.array(grantSchema), oauthCallbackUrl: z.string().optional(), credentials: z.array(z.object({ id: denTypeIdSchema("inferenceProviderCredential"), credentialSetId: denTypeIdSchema("gatewayCredentialSet"), subject: z.string(), orgMembershipId: denTypeIdSchema("member").nullable(), memberName: z.string().nullable(), memberEmail: z.string().nullable(), kind: z.enum(GATEWAY_PROVIDER_CREDENTIAL_KINDS), status: z.enum(GATEWAY_PROVIDER_CREDENTIAL_STATUSES), expiresAt: z.string().datetime().nullable() })).optional() }).meta({ ref: "GatewayProviderDetails" })
const detailsResponse = z.object({ inferenceProvider: detailsSchema })
const connectResponse = z.object({ inferenceProvider: summarySchema.extend({ apiKey: z.string(), apiKeys: z.record(z.string(), z.string()) }) })
const conflictSchema = z.object({ error: z.string(), message: z.string().optional() })

function route(summary: string, schema?: z.ZodType, status: 200 | 201 | 204 = 200, secret = false) {
  const options: DescribeRouteOptions & { "x-mcp"?: false } = {
    tags: ["Inference Providers"], summary,
    responses: { [status]: schema ? jsonResponse(summary, schema) : emptyResponse(summary), 400: jsonResponse("Invalid request.", invalidRequestSchema), 401: jsonResponse("Sign-in required.", unauthorizedSchema), 403: jsonResponse("Access denied or Gateway management disabled.", z.union([forbiddenSchema, gatewayManagementUnavailableSchema])), 404: jsonResponse("Resource not found.", notFoundSchema), 409: jsonResponse("Selection or resource conflict.", conflictSchema) },
    ...(secret ? { "x-mcp": false as const } : {}),
  }
  return describeRoute(options)
}

type Actor = NonNullable<OrgRouteVariables["organizationContext"]>
const managementMessage = "Only workspace owners and admins can manage inference providers."
const managementRead: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  const permission = ensureOrganizationAdminRole(c, managementMessage)
  if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
  const unavailable = gatewayManagementUnavailable()
  if (unavailable) return c.json(unavailable, 403)
  await next()
}
const managementWrite: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  const permission = ensureOrganizationAdmin(c, managementMessage)
  if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
  const unavailable = gatewayManagementUnavailable()
  if (unavailable) return c.json(unavailable, 403)
  await next()
}
async function liveMember(database: GatewayTx | typeof db, actor: Actor, lock: boolean, manage = false) {
  const query = database.select().from(MemberTable).where(and(eq(MemberTable.id, actor.currentMember.id), eq(MemberTable.organizationId, actor.organization.id), isNull(MemberTable.removedAt)))
  const [member] = await (lock ? query.for("update") : query)
  if (!member?.userId) throw new GatewayWriteError(403, "forbidden")
  if (manage && !ensureOrganizationAdminRole({ get: () => ({ ...actor, currentMember: { ...actor.currentMember, role: member.role, isOwner: memberHasRole(member.role, "owner") } }) }, managementMessage).ok) {
    throw new GatewayWriteError(403, "forbidden")
  }
  return member
}
async function getProvider(database: GatewayTx | typeof db, actor: Actor, id: string, manage = false, lock = false) {
  await liveMember(database, actor, lock, manage)
  const query = database.select().from(GatewayProviderTable).where(and(eq(GatewayProviderTable.id, normalizeDenTypeId("inferenceProvider", id)), eq(GatewayProviderTable.organization_id, actor.organization.id)))
  const [provider] = await (lock ? query.for("update") : query)
  if (!provider) throw new GatewayWriteError(404, "inference_provider_not_found")
  return provider
}
function respond(c: { json: (body: unknown, status: 400 | 403 | 404 | 409) => Response }, error: unknown) {
  if (error instanceof GatewayWriteError) return c.json({ error: error.code, message: error.message }, error.status)
  throw error
}
function publicBase(request: Request) {
  if (env.apiPublicUrl) {
    const url = new URL(env.apiPublicUrl)
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid_api_public_url")
  }
  return resolvePublicApiBaseUrl(request, env.apiPublicUrl)
}
function oauthRedirect(value?: string): string | null {
  if (value === undefined) return null
  try {
    const url = new URL(value)
    if (!url.username && !url.password && (url.protocol === "openwork:" || ["https:", "http:"].includes(url.protocol) && env.publicUrlTrustedOrigins.includes(url.origin))) return url.toString()
  } catch { /* Reject malformed redirects rather than reflecting them. */ }
  throw new GatewayWriteError(400, "invalid_redirect")
}
function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}
async function touch(tx: GatewayTx, provider: GatewayProvider) {
  await tx.update(GatewayProviderTable).set({ updated_at: new Date() }).where(eq(GatewayProviderTable.id, provider.id))
}
async function defaultMatrix(tx: GatewayTx, provider: GatewayProvider, input: z.infer<typeof createSchema>, creatorId: GatewayMemberId) {
  const audiences: GatewayAccessGrantWrite["audience"][] = [
    ...(input.allMembers ? [{ type: "organization" as const }] : []),
    ...[...new Set(input.memberIds ?? [])].map((memberId) => ({ type: "member" as const, memberId })),
    ...[...new Set(input.teamIds ?? [])].map((teamId) => ({ type: "team" as const, teamId })),
  ]
  const hasCredentialInput = input.credential !== undefined || input.apiKeys !== undefined || input.credentialMode === "member" || input.oauthClientId !== undefined || input.oauthClientSecret !== undefined
  if (!hasCredentialInput && audiences.length) throw new GatewayWriteError(400, "credential_required", "Configure credentials before granting initial provider access.")
  const set = hasCredentialInput
    ? await writeGatewaySet(tx, provider, { name: "Default credentials", credentialMode: input.credentialMode ?? "org", credential: input.credential, apiKeys: input.apiKeys, oauthClientId: input.oauthClientId, oauthClientSecret: input.oauthClientSecret }, { createdByOrgMembershipId: creatorId })
    : null
  const models = await tx.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id))
  if (!models.length && audiences.length) throw new GatewayWriteError(400, "model_required", "No supported catalog models are available for the requested initial access grants.")
  const groupId = await writeGatewayGroup(tx, provider, { name: "All Allowed Models", modelIds: models.map((model) => model.model_id) })
  if (!set) return { groupId, setId: null }
  for (const audience of audiences) await writeGatewayGrant(tx, provider, { modelGroupId: groupId, credentialSetId: set.id, audience })
  return { groupId, setId: set.id }
}
async function selectOAuthSet(provider: GatewayProvider, memberId: GatewayMemberId, selected?: string): Promise<GatewaySet> {
  const sets = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.gateway_provider_id, provider.id))
  const groups = await db.select().from(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.gateway_provider_id, provider.id))
  const rows = await db.select().from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id))
  const teams = await memberGatewayTeams(db, provider.organization_id, memberId)
  const grants = effectiveGatewayGrants(rows.filter((grant) => groups.some((group) => group.id === grant.model_group_id && group.status === "active") && sets.some((set) => set.id === grant.credential_set_id && set.status === "active")), memberId, teams.map((team) => team.id))
  const candidates = sets.filter((set) => set.credential_mode === "member" && set.status === "active" && grants.some((grant) => grant.credential_set_id === set.id))
  const chosen = selected ? candidates.filter((set) => set.id === selected) : candidates
  if (!chosen.length) throw new GatewayWriteError(403, "forbidden", "No granted member credential set matches this selection.")
  if (chosen.length !== 1) throw new GatewayWriteError(409, "credential_set_required", "Specify credentialSetId when more than one member credential set is available.")
  return chosen[0]
}

export function registerOrgInferenceProviderRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  registerOrgGatewayUsageRoutes(app)
  app.get("/v1/inference-providers", route("List organization inference gateway providers", z.object({ inferenceProviders: z.array(z.union([detailsSchema, summarySchema])) })), orgMemberRoute(), queryValidator(z.object({ scope: z.enum(["usable", "manageable"]).default("usable") })), async (c) => {
    try {
    const actor = c.get("organizationContext")
    const manage = c.req.valid("query").scope === "manageable"
    if (manage) {
      const permission = ensureOrganizationAdminRole(c, managementMessage)
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
      const unavailable = gatewayManagementUnavailable()
      if (unavailable) return c.json(unavailable, 403)
    }
    await liveMember(db, actor, false, manage)
    const providers = await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.organization_id, actor.organization.id)).orderBy(desc(GatewayProviderTable.updated_at))
    const summaries: GatewayProviderSummary[] = []
    for (const provider of providers) {
      if (!manage && provider.status !== "active") continue
      // An organization set may be unconfigured; keep its granted provider discoverable without leaking models.
      if (!manage) {
        const teams = await memberGatewayTeams(db, provider.organization_id, actor.currentMember.id)
        const grants = await db.select({ grant: GatewayProviderAccessTable }).from(GatewayProviderAccessTable)
          .innerJoin(GatewayModelGroupTable, and(eq(GatewayModelGroupTable.id, GatewayProviderAccessTable.model_group_id), eq(GatewayModelGroupTable.gateway_provider_id, provider.id), eq(GatewayModelGroupTable.status, "active")))
          .innerJoin(GatewayCredentialSetTable, and(eq(GatewayCredentialSetTable.id, GatewayProviderAccessTable.credential_set_id), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id), eq(GatewayCredentialSetTable.status, "active")))
          .where(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id))
        if (!effectiveGatewayGrants(grants.map((row) => row.grant), actor.currentMember.id, teams.map((team) => team.id)).length) continue
      }
      summaries.push(await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), manage))
    }
    return c.json({ inferenceProviders: summaries })
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/:inferenceProviderId", route("Get inference gateway provider", detailsResponse), orgMemberRoute(), managementRead, paramValidator(paramsSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const provider = await getProvider(db, actor, c.req.valid("param").inferenceProviderId, true)
      return c.json({ inferenceProvider: await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), true) })
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/:inferenceProviderId/connect", route("Get inference gateway provider connect payload", connectResponse, 200, true), orgMemberRoute(), paramValidator(paramsSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const provider = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      if (provider.status !== "active") throw new GatewayWriteError(404, "inference_provider_not_found")
      const teams = await memberGatewayTeams(db, provider.organization_id, actor.currentMember.id)
      const grants = await db.select({ grant: GatewayProviderAccessTable }).from(GatewayProviderAccessTable)
        .innerJoin(GatewayModelGroupTable, and(eq(GatewayModelGroupTable.id, GatewayProviderAccessTable.model_group_id), eq(GatewayModelGroupTable.gateway_provider_id, provider.id), eq(GatewayModelGroupTable.status, "active")))
        .innerJoin(GatewayCredentialSetTable, and(eq(GatewayCredentialSetTable.id, GatewayProviderAccessTable.credential_set_id), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id), eq(GatewayCredentialSetTable.status, "active")))
        .where(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id))
      if (!effectiveGatewayGrants(grants.map((row) => row.grant), actor.currentMember.id, teams.map((team) => team.id)).length) throw new GatewayWriteError(403, "forbidden")
      const summary = await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), false)
      const apiKey = await ensureMemberGatewayKey({ organizationId: actor.organization.id, memberId: actor.currentMember.id })
      const apiKeys = Object.fromEntries(readProviderEnvNames(summary.providerConfig).map((name) => [name, apiKey]))
      const response: GatewayProviderConnectResponse = { inferenceProvider: { ...summary, apiKey, apiKeys } }
      return c.json(response)
    } catch (error) { return respond(c, error) }
  })

  app.post("/v1/inference-providers", route("Create inference gateway provider", detailsResponse, 201), orgMemberRoute(), managementWrite, jsonValidator(createSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const input = c.req.valid("json")
      const catalog = await gatewayCatalog(input.providerId, input.modelIds)
      validateGatewaySettings(catalog.config, input.settings ?? {})
      const now = new Date()
      const provider: GatewayProvider = { id: createDenTypeId("inferenceProvider"), organization_id: actor.organization.id, created_by_org_membership_id: actor.currentMember.id, provider_id: catalog.catalog.id, name: input.name, model_ids: [...new Set(input.modelIds)], provider_config: catalog.config, settings: input.settings ?? {}, credential_mode: input.credentialMode ?? "org", oauth_client_id: null, oauth_client_secret: null, status: input.status ?? "active", created_at: now, updated_at: now }
      await db.transaction(async (tx) => {
        const member = await liveMember(tx, actor, true, true)
        await tx.insert(GatewayProviderTable).values(provider)
        await writeGatewayModels(tx, provider, catalog.models)
        await defaultMatrix(tx, provider, input, member.id)
      })
      return c.json({ inferenceProvider: await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), true) }, 201)
    } catch (error) { return respond(c, error) }
  })

  app.patch("/v1/inference-providers/:inferenceProviderId", route("Update inference gateway provider", detailsResponse), orgMemberRoute(), managementWrite, paramValidator(paramsSchema), jsonValidator(patchSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const input = c.req.valid("json")
      if (input.credentialMode !== undefined || input.credential !== undefined || input.apiKeys !== undefined || input.oauthClientId !== undefined || input.oauthClientSecret !== undefined || input.memberIds !== undefined || input.teamIds !== undefined || input.allMembers !== undefined) {
        throw new GatewayWriteError(409, "matrix_write_required", "Edit credential-sets and access-grants explicitly. Flat PATCH cannot replace the access matrix.")
      }
      const before = await getProvider(db, actor, c.req.valid("param").inferenceProviderId, true)
      const trusted = await getModelsDevProvider(before.provider_id)
      const provider = await db.transaction(async (tx) => {
        const existing = await getProvider(tx, actor, c.req.valid("param").inferenceProviderId, true, true)
        if (input.providerId !== undefined && input.providerId !== existing.provider_id) throw new GatewayWriteError(409, "provider_identity_immutable", "Create a separate provider rather than moving existing groups and credentials to another catalog provider.")
        if (!trusted || trusted.id !== existing.provider_id || trusted.npm !== readProviderConfigNpm(existing.provider_config)) throw new GatewayWriteError(400, "provider_requires_configuration")
        const config = existing.provider_config
        if (input.settings !== undefined) {
          const persisted: Record<string, unknown> = settingsSchema.parse(publicProviderSettings(existing.settings))
          validateGatewaySettings(config, { ...persisted, ...input.settings })
          if (Object.entries(input.settings).some(([key, value]) => value !== persisted[key])) {
            throw new GatewayWriteError(409, "provider_destination_immutable", "Create a separate provider to change the upstream account or destination. Existing credentials cannot be relocated.")
          }
        }
        const modelIds = input.modelIds === undefined ? existing.model_ids : [...new Set(input.modelIds)]
        const catalog = resolveGatewayCatalog(trusted, modelIds, config, input.modelIds !== undefined)
        if (input.status === "disabled" && existing.status === "active") await tx.delete(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.gateway_provider_id, existing.id))
        const provider: GatewayProvider = { ...existing, name: input.name ?? existing.name, model_ids: modelIds, status: input.status ?? existing.status, updated_at: new Date() }
        await writeGatewayModels(tx, provider, catalog.models)
        await tx.update(GatewayProviderTable).set({ name: provider.name, model_ids: modelIds, status: provider.status, updated_at: provider.updated_at }).where(eq(GatewayProviderTable.id, provider.id))
        return provider
      })
      return c.json({ inferenceProvider: await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), true) })
    } catch (error) { return respond(c, error) }
  })

  // The management catalog is independent of selected wire models and group memberships.
  app.get("/v1/inference-providers/:inferenceProviderId/models", route("List configured gateway catalog models", z.object({ modelIds: universeSchema, catalogWarning: z.string().optional(), models: z.array(z.object({ id: z.string(), name: z.string(), config: z.record(z.string(), z.unknown()) })) })), orgMemberRoute(), managementRead, paramValidator(paramsSchema), async (c) => {
    try {
      const { provider, catalogWarning } = await refreshGatewayCatalog(await getProvider(db, c.get("organizationContext"), c.req.valid("param").inferenceProviderId, true))
      const models = (await db.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id)))
        .filter((model) => (!provider.model_ids.length || provider.model_ids.includes(model.model_id)) && !gatewayModelConfigurationError(provider.provider_config, [model.model_config]))
      return c.json({ modelIds: provider.model_ids, ...(catalogWarning ? { catalogWarning } : {}), models: models.map((model) => ({ id: model.model_id, name: model.name, config: nonSecretProviderConfig(model.model_config) })) })
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/:inferenceProviderId/model-groups", route("List gateway model groups", z.object({ modelGroups: z.array(groupSchema) })), orgMemberRoute(), managementRead, paramValidator(paramsSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const provider = await getProvider(db, actor, c.req.valid("param").inferenceProviderId, true)
      const details = await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), true)
      return c.json({ modelGroups: details.modelGroups })
    } catch (error) { return respond(c, error) }
  })
  app.post("/v1/inference-providers/:inferenceProviderId/model-groups", route("Create gateway model group", z.object({ modelGroup: groupSchema }), 201), orgMemberRoute(), managementWrite, paramValidator(paramsSchema), jsonValidator(groupWrite), async (c) => {
    try {
      const actor = c.get("organizationContext")
      await refreshGatewayCatalog(await getProvider(db, actor, c.req.valid("param").inferenceProviderId, true))
      const result = await db.transaction(async (tx) => {
        const provider = await getProvider(tx, actor, c.req.valid("param").inferenceProviderId, true, true)
        const id = await writeGatewayGroup(tx, provider, c.req.valid("json"))
        await touch(tx, provider)
        return { provider, id }
      })
      const details = await gatewaySummary(result.provider, actor.currentMember.id, publicBase(c.req.raw), true)
      const modelGroup = details.modelGroups.find((group) => group.id === result.id)
      if (!modelGroup) throw new GatewayWriteError(404, "model_group_not_found")
      return c.json({ modelGroup }, 201)
    } catch (error) { return respond(c, error) }
  })
  app.patch("/v1/inference-providers/:inferenceProviderId/model-groups/:groupId", route("Update gateway model group", z.object({ modelGroup: groupSchema })), orgMemberRoute(), managementWrite, paramValidator(groupParams), jsonValidator(groupWrite.partial()), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const params = c.req.valid("param")
      await refreshGatewayCatalog(await getProvider(db, actor, params.inferenceProviderId, true))
      const result = await db.transaction(async (tx) => {
        const provider = await getProvider(tx, actor, params.inferenceProviderId, true, true)
        const id = await writeGatewayGroup(tx, provider, c.req.valid("json"), normalizeDenTypeId("gatewayModelGroup", params.groupId))
        await touch(tx, provider)
        return { provider, id }
      })
      const details = await gatewaySummary(result.provider, actor.currentMember.id, publicBase(c.req.raw), true)
      const modelGroup = details.modelGroups.find((group) => group.id === result.id)
      if (!modelGroup) throw new GatewayWriteError(404, "model_group_not_found")
      return c.json({ modelGroup })
    } catch (error) { return respond(c, error) }
  })
  app.delete("/v1/inference-providers/:inferenceProviderId/model-groups/:groupId", route("Delete gateway model group", undefined, 204), orgMemberRoute(), managementWrite, paramValidator(groupParams), async (c) => {
    try {
      const params = c.req.valid("param")
      await db.transaction(async (tx) => {
        const provider = await getProvider(tx, c.get("organizationContext"), params.inferenceProviderId, true, true)
        const id = normalizeDenTypeId("gatewayModelGroup", params.groupId)
        const [group] = await tx.select().from(GatewayModelGroupTable).where(and(eq(GatewayModelGroupTable.id, id), eq(GatewayModelGroupTable.gateway_provider_id, provider.id)))
        if (!group) throw new GatewayWriteError(404, "model_group_not_found")
        const [grant] = await tx.select({ id: GatewayProviderAccessTable.id }).from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.model_group_id, id)).limit(1)
        if (grant) throw new GatewayWriteError(409, "model_group_in_use", "Delete referencing access grants first.")
        await tx.delete(GatewayModelGroupModelTable).where(eq(GatewayModelGroupModelTable.model_group_id, id))
        await tx.delete(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.id, id))
        await touch(tx, provider)
      })
      return c.body(null, 204)
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/:inferenceProviderId/credential-sets", route("List gateway credential sets", z.object({ credentialSets: z.array(setSchema) })), orgMemberRoute(), managementRead, paramValidator(paramsSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const provider = await getProvider(db, actor, c.req.valid("param").inferenceProviderId, true)
      const details = await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), true)
      return c.json({ credentialSets: details.credentialSets })
    } catch (error) { return respond(c, error) }
  })
  app.post("/v1/inference-providers/:inferenceProviderId/credential-sets", route("Create gateway credential set", z.object({ credentialSet: setSchema }), 201), orgMemberRoute(), managementWrite, paramValidator(paramsSchema), jsonValidator(setWrite.superRefine(singleCredential)), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const before = await getProvider(db, actor, c.req.valid("param").inferenceProviderId, true)
      const trusted = await getModelsDevProvider(before.provider_id)
      const result = await db.transaction(async (tx) => {
        const provider = await getProvider(tx, actor, c.req.valid("param").inferenceProviderId, true, true)
        if (!trusted || trusted.id !== provider.provider_id) throw new GatewayWriteError(400, "provider_requires_configuration")
        const set = await writeGatewaySet(tx, { ...provider, provider_config: { ...provider.provider_config, env: trusted.env } }, c.req.valid("json"), { createdByOrgMembershipId: actor.currentMember.id })
        await touch(tx, provider)
        return { provider, ...set }
      })
      const details = await gatewaySummary(result.provider, actor.currentMember.id, publicBase(c.req.raw), true)
      const credentialSet = details.credentialSets.find((set) => set.id === result.id)
      if (!credentialSet) throw new GatewayWriteError(404, "credential_set_not_found")
      return c.json({ credentialSet }, 201)
    } catch (error) { return respond(c, error) }
  })
  app.patch("/v1/inference-providers/:inferenceProviderId/credential-sets/:credentialSetId", route("Update gateway credential set", z.object({ credentialSet: setSchema })), orgMemberRoute(), managementWrite, paramValidator(setParams), jsonValidator(setWrite.partial().superRefine(singleCredential)), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const params = c.req.valid("param")
      const before = await getProvider(db, actor, params.inferenceProviderId, true)
      const trusted = await getModelsDevProvider(before.provider_id)
      const result = await db.transaction(async (tx) => {
        const provider = await getProvider(tx, actor, params.inferenceProviderId, true, true)
        if (!trusted || trusted.id !== provider.provider_id) throw new GatewayWriteError(400, "provider_requires_configuration")
        const set = await writeGatewaySet(tx, { ...provider, provider_config: { ...provider.provider_config, env: trusted.env } }, c.req.valid("json"), normalizeDenTypeId("gatewayCredentialSet", params.credentialSetId))
        await touch(tx, provider)
        return { provider, ...set }
      })
      await revokeGoogleCredentials(result.revoked)
      const details = await gatewaySummary(result.provider, actor.currentMember.id, publicBase(c.req.raw), true)
      const credentialSet = details.credentialSets.find((set) => set.id === result.id)
      if (!credentialSet) throw new GatewayWriteError(404, "credential_set_not_found")
      return c.json({ credentialSet })
    } catch (error) { return respond(c, error) }
  })
  app.delete("/v1/inference-providers/:inferenceProviderId/credential-sets/:credentialSetId", route("Delete gateway credential set", undefined, 204), orgMemberRoute(), managementWrite, paramValidator(setParams), async (c) => {
    try {
      const params = c.req.valid("param")
      const credentials = await db.transaction(async (tx) => {
        const provider = await getProvider(tx, c.get("organizationContext"), params.inferenceProviderId, true, true)
        const id = normalizeDenTypeId("gatewayCredentialSet", params.credentialSetId)
        const [set] = await tx.select().from(GatewayCredentialSetTable).where(and(eq(GatewayCredentialSetTable.id, id), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id))).for("update")
        if (!set) throw new GatewayWriteError(404, "credential_set_not_found")
        const [grant] = await tx.select({ id: GatewayProviderAccessTable.id }).from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.credential_set_id, id)).limit(1)
        if (grant) throw new GatewayWriteError(409, "credential_set_in_use", "Delete referencing access grants first.")
        await tx.delete(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.credential_set_id, id))
        const rows = await tx.select().from(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.credential_set_id, id)).for("update")
        await tx.delete(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.credential_set_id, id))
        await tx.delete(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, id))
        await touch(tx, provider)
        return rows.filter((row) => row.status !== "revoked")
      })
      await revokeGoogleCredentials(credentials)
      return c.body(null, 204)
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/:inferenceProviderId/access-grants", route("List gateway access grants", z.object({ accessGrants: z.array(grantSchema) })), orgMemberRoute(), managementRead, paramValidator(paramsSchema), async (c) => {
    try {
      const provider = await getProvider(db, c.get("organizationContext"), c.req.valid("param").inferenceProviderId, true)
      const rows = await db.select().from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id))
      return c.json({ accessGrants: rows.map(gatewayGrantSummary) })
    } catch (error) { return respond(c, error) }
  })
  app.post("/v1/inference-providers/:inferenceProviderId/access-grants", route("Create gateway access grant", z.object({ accessGrant: grantSchema }), 201), orgMemberRoute(), managementWrite, paramValidator(paramsSchema), jsonValidator(grantWrite), async (c) => {
    try {
      const input = c.req.valid("json")
      const id = await db.transaction(async (tx) => {
        const provider = await getProvider(tx, c.get("organizationContext"), c.req.valid("param").inferenceProviderId, true, true)
        const id = await writeGatewayGrant(tx, provider, input)
        await touch(tx, provider)
        return id
      })
      return c.json({ accessGrant: { id, ...input } }, 201)
    } catch (error) { return respond(c, error) }
  })
  app.patch("/v1/inference-providers/:inferenceProviderId/access-grants/:grantId", route("Update gateway access grant", z.object({ accessGrant: grantSchema })), orgMemberRoute(), managementWrite, paramValidator(grantParams), jsonValidator(grantWrite.partial()), async (c) => {
    try {
      const input = c.req.valid("json")
      const params = c.req.valid("param")
      const accessGrant = await db.transaction(async (tx) => {
        const provider = await getProvider(tx, c.get("organizationContext"), params.inferenceProviderId, true, true)
        const id = normalizeDenTypeId("inferenceProviderAccess", params.grantId)
        const [existing] = await tx.select().from(GatewayProviderAccessTable).where(and(eq(GatewayProviderAccessTable.id, id), eq(GatewayProviderAccessTable.gateway_provider_id, provider.id)))
        if (!existing) throw new GatewayWriteError(404, "access_grant_not_found")
        const merged = { ...gatewayGrantSummary(existing), ...input }
        await writeGatewayGrant(tx, provider, merged, id)
        await touch(tx, provider)
        return merged
      })
      return c.json({ accessGrant })
    } catch (error) { return respond(c, error) }
  })
  // The legacy delete URL remains an exact single-grant operation, without creator exceptions.
  for (const path of ["/v1/inference-providers/:inferenceProviderId/access-grants/:grantId", "/v1/inference-providers/:inferenceProviderId/access/:grantId"]) {
    app.delete(path, route("Remove inference provider access grant", undefined, 204), orgMemberRoute(), managementWrite, paramValidator(grantParams), async (c) => {
      try {
        const params = c.req.valid("param")
        await db.transaction(async (tx) => {
          const provider = await getProvider(tx, c.get("organizationContext"), params.inferenceProviderId, true, true)
          const id = normalizeDenTypeId("inferenceProviderAccess", params.grantId)
          const [grant] = await tx.select().from(GatewayProviderAccessTable).where(and(eq(GatewayProviderAccessTable.id, id), eq(GatewayProviderAccessTable.gateway_provider_id, provider.id)))
          if (!grant) throw new GatewayWriteError(404, "access_grant_not_found")
          // Callback reauthorization rejects lost set access while preserving consent through other grants.
          await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, id))
          await touch(tx, provider)
        })
        return c.body(null, 204)
      } catch (error) { return respond(c, error) }
    })
  }

  app.delete("/v1/inference-providers/:inferenceProviderId", route("Delete inference gateway provider", undefined, 204), orgMemberRoute(), managementWrite, paramValidator(paramsSchema), async (c) => {
    try {
      const credentials = await db.transaction(async (tx) => {
        const provider = await getProvider(tx, c.get("organizationContext"), c.req.valid("param").inferenceProviderId, true, true)
        await tx.delete(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.gateway_provider_id, provider.id))
        const credentials = await tx.select().from(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.gateway_provider_id, provider.id)).for("update")
        const groups = await tx.select({ id: GatewayModelGroupTable.id }).from(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.gateway_provider_id, provider.id))
        if (groups.length) await tx.delete(GatewayModelGroupModelTable).where(inArray(GatewayModelGroupModelTable.model_group_id, groups.map((group) => group.id)))
        await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id))
        await tx.delete(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.gateway_provider_id, provider.id))
        await tx.delete(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.gateway_provider_id, provider.id))
        await tx.delete(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.gateway_provider_id, provider.id))
        await tx.delete(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id))
        await tx.delete(GatewayProviderTable).where(eq(GatewayProviderTable.id, provider.id))
        // Request logs and rollups deliberately retain historical resource IDs.
        return credentials.filter((row) => row.status !== "revoked")
      })
      await revokeGoogleCredentials(credentials)
      return c.body(null, 204)
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/:inferenceProviderId/oauth/start", route("Begin Google sign-in for a member inference credential", z.object({ authUrl: z.string() })), orgMemberRoute(), paramValidator(paramsSchema), queryValidator(oauthQuery), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const provider = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      if (provider.status !== "active") throw new GatewayWriteError(404, "inference_provider_not_found")
      const query = c.req.valid("query")
      const set = await selectOAuthSet(provider, actor.currentMember.id, query.credentialSetId)
      if (!set.oauth_client_id || !set.oauth_client_secret) throw new GatewayWriteError(400, "oauth_client_required", "An administrator must configure this credential set's Google OAuth client.")
      const redirectTo = oauthRedirect(query.redirectTo)
      const { verifier, challenge } = createPkcePair()
      const state = randomBytes(32).toString("base64url")
      await db.transaction(async (tx) => {
        if (!await lockMemberOAuthAuthorization(tx, provider, set, actor.currentMember.id)) throw new GatewayWriteError(403, "forbidden")
        await tx.insert(GatewayProviderOauthStateTable).values({ id: createDenTypeId("inferenceProviderOauthState"), gateway_provider_id: provider.id, credential_set_id: set.id, org_membership_id: actor.currentMember.id, state, code_verifier: verifier, redirect_to: redirectTo, expires_at: new Date(Date.now() + 600_000) })
      })
      const domains = actor.organization.allowedEmailDomains ?? []
      const authUrl = buildGoogleAuthorizeUrl({ clientId: set.oauth_client_id, redirectUri: `${publicBase(c.req.raw)}/v1/inference-providers/oauth/callback`, state, codeChallenge: challenge, ...(domains.length === 1 && domains[0] ? { hostedDomain: domains[0] } : {}) })
      if (c.req.header("accept")?.includes("application/json")) return c.json({ authUrl })
      return c.redirect(authUrl, 302)
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/oauth/callback", describeRoute({ tags: ["Authentication"], summary: "Google OAuth callback for a member inference credential", responses: { 200: htmlResponse("Connected."), 302: emptyResponse("Validated client redirect."), 400: htmlResponse("Sign-in failed.") } }), publicRoute, queryValidator(z.object({ code: z.string().trim().min(1).max(4096).optional(), state: z.string().trim().min(1).max(255).optional(), error: z.string().trim().max(255).optional() })), async (c) => {
    const query = c.req.valid("query")
    const requestId = c.get("requestId")
    const fail = (message: string, redirectTo: string | null = null) => {
      if (redirectTo) { const url = new URL(redirectTo); url.searchParams.set("error", message); return c.redirect(url.toString(), 302) }
      return c.html(connectCallbackPage({ ok: false, name: "Google", message, referenceId: requestId }), 400)
    }
    if (!query.state) return fail("Missing state.")
    const [state] = await db.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.state, query.state)).limit(1)
    if (!state || state.used_at || state.expires_at.getTime() <= Date.now()) return fail("This sign-in link has expired or was already used. Start Connect again.")
    const [provider] = await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, state.gateway_provider_id))
    const [set] = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, state.credential_set_id))
    if (!provider || !set?.oauth_client_id || !set.oauth_client_secret) return fail("This credential set is no longer available.")
    let redirectTo: string | null = null
    try { redirectTo = oauthRedirect(state.redirect_to ?? undefined) } catch { return fail("The sign-in redirect is no longer allowed.") }
    const claimed = await db.transaction(async (tx) => {
      if (!await lockMemberOAuthAuthorization(tx, provider, set, state.org_membership_id)) return false
      const [current] = await tx.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.id, state.id)).for("update")
      if (!current || current.used_at || current.expires_at.getTime() <= Date.now() || current.credential_set_id !== set.id) return false
      return affectedRows(await tx.update(GatewayProviderOauthStateTable).set({ used_at: new Date() }).where(and(eq(GatewayProviderOauthStateTable.id, state.id), isNull(GatewayProviderOauthStateTable.used_at)))) === 1
    })
    if (!claimed) return fail("Provider access changed or the sign-in link was already used. Start Connect again.")
    if (query.error || !query.code) return fail(query.error === "access_denied" ? "Google access was denied." : "Google did not return an authorization code.", redirectTo)
    let issuedToken: string | null = null
    try {
      const tokens = await exchangeGoogleAuthorizationCode({ clientId: set.oauth_client_id, clientSecret: set.oauth_client_secret, code: query.code, codeVerifier: state.code_verifier, redirectUri: `${publicBase(c.req.raw)}/v1/inference-providers/oauth/callback` })
      issuedToken = tokens.refresh_token ?? tokens.access_token
      const stored = await db.transaction(async (tx) => {
        if (!await lockMemberOAuthAuthorization(tx, provider, set, state.org_membership_id)) return false
        const [current] = await tx.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.id, state.id)).for("update")
        if (!current || !current.used_at || current.expires_at.getTime() <= Date.now() || current.credential_set_id !== set.id) return false
        const [existing] = await tx.select().from(GatewayProviderCredentialTable).where(and(eq(GatewayProviderCredentialTable.credential_set_id, set.id), eq(GatewayProviderCredentialTable.subject, state.org_membership_id))).for("update")
        const now = new Date()
        const values = { kind: "oauth_google" as const, secret: JSON.stringify({ accessToken: tokens.access_token, ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}), ...(tokens.token_type ? { tokenType: tokens.token_type } : {}) }), expires_at: tokens.expires_in ? new Date(now.getTime() + tokens.expires_in * 1000) : null, scopes: tokens.scope ?? GOOGLE_CLOUD_PLATFORM_SCOPE, last_refreshed_at: now, refreshing_until: null, last_error: null, status: "active" as const, updated_at: now }
        if (existing) {
          if (existing.gateway_provider_id !== provider.id || existing.organization_id !== provider.organization_id || existing.org_membership_id !== state.org_membership_id) return false
          await tx.update(GatewayProviderCredentialTable).set(values).where(eq(GatewayProviderCredentialTable.id, existing.id))
        } else await tx.insert(GatewayProviderCredentialTable).values({ id: createDenTypeId("inferenceProviderCredential"), gateway_provider_id: provider.id, credential_set_id: set.id, organization_id: provider.organization_id, subject: state.org_membership_id, org_membership_id: state.org_membership_id, ...values })
        return true
      })
      if (!stored) { await revokeGoogleToken({ token: issuedToken }); issuedToken = null; return fail("Provider access changed during sign-in. Start Connect again.", redirectTo) }
      issuedToken = null
    } catch (error) {
      if (issuedToken) await revokeGoogleToken({ token: issuedToken })
      console.error("gateway_oauth_callback_failed", { requestId, providerId: provider.id, credentialSetId: set.id, code: error instanceof OAuthTokenExchangeError ? error.code : "oauth_callback_failed" })
      return fail("OpenWork could not finish Google sign-in. Try Connect again.", redirectTo)
    }
    return redirectTo ? c.redirect(redirectTo, 302) : c.html(connectCallbackPage({ ok: true, name: set.name }))
  })

  app.delete("/v1/inference-providers/:inferenceProviderId/oauth", route("Disconnect the caller's Google credential for an inference provider", undefined, 204), orgMemberRoute(), paramValidator(paramsSchema), queryValidator(z.object({ credentialSetId: denTypeIdSchema("gatewayCredentialSet").optional() }).strict()), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const provider = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      if (provider.status !== "active") throw new GatewayWriteError(404, "inference_provider_not_found")
      const set = await selectOAuthSet(provider, actor.currentMember.id, c.req.valid("query").credentialSetId)
      const credentials = await db.transaction(async (tx) => {
        if (!await lockMemberOAuthAuthorization(tx, provider, set, actor.currentMember.id)) throw new GatewayWriteError(403, "forbidden")
        await tx.delete(GatewayProviderOauthStateTable).where(and(eq(GatewayProviderOauthStateTable.credential_set_id, set.id), eq(GatewayProviderOauthStateTable.org_membership_id, actor.currentMember.id)))
        const where = and(eq(GatewayProviderCredentialTable.credential_set_id, set.id), eq(GatewayProviderCredentialTable.gateway_provider_id, provider.id), eq(GatewayProviderCredentialTable.organization_id, actor.organization.id), eq(GatewayProviderCredentialTable.subject, actor.currentMember.id), eq(GatewayProviderCredentialTable.org_membership_id, actor.currentMember.id))
        const rows = await tx.select().from(GatewayProviderCredentialTable).where(where).for("update")
        await tx.update(GatewayProviderCredentialTable).set({ status: "revoked", refreshing_until: null, updated_at: new Date() }).where(where)
        return rows.filter((row) => row.status !== "revoked")
      })
      await revokeGoogleCredentials(credentials)
      return c.body(null, 204)
    } catch (error) { return respond(c, error) }
  })

  app.post("/v1/inference-providers/migrate-from-llm-provider", route("Move an LLM provider to the inference gateway", detailsResponse, 201), orgMemberRoute(), managementWrite, jsonValidator(z.object({ llmProviderId: denTypeIdSchema("llmProvider") }).strict()), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const sourceId = normalizeDenTypeId("llmProvider", c.req.valid("json").llmProviderId)
      const [before] = await db.select({ providerId: LlmProviderTable.providerId }).from(LlmProviderTable)
        .where(and(eq(LlmProviderTable.id, sourceId), eq(LlmProviderTable.organizationId, actor.organization.id)))
      if (!before) throw new GatewayWriteError(409, "migration_source_unavailable")
      const trusted = await getModelsDevProvider(before.providerId)
      const provider = await db.transaction(async (tx) => {
        const member = await liveMember(tx, actor, true, true)
        const [source] = await tx.select().from(LlmProviderTable).where(and(eq(LlmProviderTable.id, sourceId), eq(LlmProviderTable.organizationId, actor.organization.id))).for("update", { noWait: true }).catch((error: unknown) => {
          if (isMigrationSourceLockConflict(error)) throw new GatewayWriteError(409, "migration_in_progress")
          throw error
        })
        if (!source) throw new GatewayWriteError(409, "migration_source_unavailable")
        const invalid = (message: string) => new GatewayWriteError(400, "migration_requires_configuration", `${message} The source has been kept.`)
        const memberCredentials = await tx.select({ id: LlmProviderMemberCredentialTable.id }).from(LlmProviderMemberCredentialTable).where(eq(LlmProviderMemberCredentialTable.llmProviderId, source.id)).for("update")
        if (source.source !== "models_dev" || source.credentialMode === "per_member" || memberCredentials.length) throw invalid("Only shared models.dev providers can be converted.")
        const npm = readProviderConfigNpm(source.providerConfig)
        if (!isSupportedGatewayNpm(npm) || !trusted || trusted.id !== source.providerId || trusted.npm !== npm) throw invalid("The provider SDK does not match the trusted catalog.")
        if (["@ai-sdk/azure", "@ai-sdk/google-vertex", "@ai-sdk/google-vertex/anthropic"].includes(npm)) throw invalid("Azure/Vertex needs explicit gateway configuration.")
        const config = nonSecretProviderConfig(source.providerConfig)
        if (JSON.stringify(config) !== JSON.stringify(source.providerConfig) || gatewayConfigurationError(config, {})) throw invalid("Inline secrets or unresolved provider configuration cannot be migrated.")
        const options = typeof config.options === "object" && config.options !== null ? config.options : {}
        const base = "baseURL" in options ? options.baseURL : config.api
        if (base !== undefined) validateGatewaySettings(config, { upstreamBaseUrl: base })
        const models = await tx.select().from(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId, source.id))
        const access = await tx.select().from(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.llmProviderId, source.id))
        if (!models.length || models.some((model) => !trusted.models.some((entry) => entry.id === model.modelId))) throw invalid("All source models must belong to the provider catalog.")
        if (gatewayModelConfigurationError(config, models.map((model) => model.modelConfig)) || models.some((model) => JSON.stringify(nonSecretProviderConfig(model.modelConfig)) !== JSON.stringify(model.modelConfig))) throw invalid("Source model configuration cannot be migrated safely.")
        const decoded = decodeProviderCredential(source.apiKey)
        const credential = decoded.apiKeys ? { kind: "api_key_map" as const, secret: JSON.stringify(decoded.apiKeys) } : decoded.apiKey ? { kind: "api_key" as const, secret: decoded.apiKey } : null
        if (!credential) throw invalid("A shared credential is required.")
        const [creator] = await tx.select({ id: MemberTable.id }).from(MemberTable).where(and(eq(MemberTable.id, source.createdByOrgMembershipId), eq(MemberTable.organizationId, actor.organization.id), isNull(MemberTable.removedAt)))
        if (!creator || access.some((row) => row.orgMembershipId !== null && row.teamId !== null)) throw invalid("Source audiences or creator are invalid.")
        const now = new Date()
        const provider: GatewayProvider = { id: createDenTypeId("inferenceProvider"), organization_id: actor.organization.id, created_by_org_membership_id: source.createdByOrgMembershipId, provider_id: source.providerId, name: source.name, model_ids: models.map((model) => model.modelId), provider_config: { ...config, env: trusted.env }, settings: { migration: { llmProviderId: source.id, runtimeEnvNames: runtimeProviderEnvNames(source) } }, credential_mode: "org", oauth_client_id: null, oauth_client_secret: null, status: "active", created_at: now, updated_at: now }
        await tx.insert(GatewayProviderTable).values(provider)
        await writeGatewayModels(tx, provider, models.map((model) => ({ id: model.modelId, name: model.name, config: model.modelConfig })))
        const matrix = await defaultMatrix(tx, provider, { name: source.name, providerId: source.providerId, modelIds: models.map((model) => model.modelId), credential }, member.id)
        if (!matrix.setId || !matrix.groupId) throw invalid("A shared credential and configured models are required.")
        for (const row of access) await writeGatewayGrant(tx, provider, { modelGroupId: matrix.groupId, credentialSetId: matrix.setId, audience: row.orgMembershipId ? { type: "member", memberId: row.orgMembershipId } : row.teamId ? { type: "team", teamId: row.teamId } : { type: "organization" } })
        await tx.delete(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.llmProviderId, source.id))
        await tx.delete(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId, source.id))
        await tx.delete(LlmProviderTable).where(eq(LlmProviderTable.id, source.id))
        return provider
      })
      return c.json({ inferenceProvider: await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), true) }, 201)
    } catch (error) { return respond(c, error) }
  })
}
