import { randomBytes } from "node:crypto"
import { and, desc, eq, gt, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, GatewayCredentialSetTable, GatewayLiteLlmIssuedKeyTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderOauthStateTable, GatewayProviderTable, LlmProviderAccessTable, LlmProviderMemberCredentialTable, LlmProviderModelTable, LlmProviderTable, MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { GATEWAY_PROVIDER_CREDENTIAL_KINDS, GATEWAY_PROVIDER_CREDENTIAL_MODES, GATEWAY_PROVIDER_CREDENTIAL_STATUSES, GATEWAY_PROVIDER_STATUSES, type GatewayAccessGrantWrite, type GatewayProviderConnectResponse, type GatewayProviderSummary } from "@openwork/types/den/gateway"
import { GATEWAY_MEMBER_SIGN_IN_METHODS, MICROSOFT_FOUNDRY_PROVIDER_ID, gatewayAwsSsoSettingsSchema, gatewayMemberConnectionsResponseSchema } from "@openwork/types/den/inference"
import type { Context, Hono, MiddlewareHandler } from "hono"
import { attributeAuditRequest, auditSessionUserAttribution } from "../../audit/request-capture.js"
import type {} from "hono/request-id"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { createPkcePair, OAuthTokenExchangeError, resolvePublicApiBaseUrl } from "../../capability-sources/generic-oauth.js"
import { connectCallbackPage } from "../../capability-sources/oauth-callback-page.js"
import { bindProviderGrantAuditTarget, loadProviderAudit, providerAuditMutation, providerAuditStep, providerRequestAuditContext, recordProviderAttempt, type ProviderAuditCapture } from "../../audit/provider.js"
import { recheckAuditEntitlement } from "../../audit/capture.js"
import { db } from "../../db.js"
import { organizationFeatureEnabled, requireFeature } from "../../features.js"
import { env } from "../../env.js"
import { gatewayManagementUnavailable, gatewayManagementUnavailableSchema } from "../../gateway-deployment.js"
import { ensureMemberGatewayKey } from "../../gateway-keys.js"
import { gatewayMemberConnections } from "../../llm/gateway-member-connections.js"
import { GatewayWriteError, reusableAwsCredential, enableGatewayGroupModels, gatewayCatalog, gatewayGrantSummary, gatewaySummary, refreshGatewayCatalog, resolveGatewayCatalog, trustedProviderCatalog, validateGatewaySettings, writeGatewayGrant, writeGatewayGroup, writeGatewayModels, writeGatewaySet, type GatewayMemberId, type GatewayProvider, type GatewaySet, type GatewayTx } from "../../llm/gateway-matrix.js"
import { buildProviderConfigSnapshot, gatewayConfigurationError, gatewayModelConfigurationError, isSupportedGatewayNpm, nonSecretProviderConfig, publicProviderSettings, readProviderConfigNpm, upstreamBaseUrlSettingError } from "../../llm/inference-provider-config.js"
import { buildGoogleAuthorizeUrl, exchangeGoogleAuthorizationCode, googleOAuthClientBinding, googleOAuthNonce, readGoogleOAuthAttempt, revokeGoogleToken, verifyGoogleIdentity } from "../../llm/inference-provider-google-oauth.js"
import { buildMicrosoftAuthorizeUrl, exchangeMicrosoftAuthorizationCode, microsoftOAuthNonce, verifyMicrosoftIdentity } from "../../llm/inference-provider-microsoft-oauth.js"
import { gatewayMemberSignInMethod, isCloudSignInMethod, memberSignInBinding, memberSignInBrand, memberSignInConfigurationError, readAwsSsoSettings, type GatewayMemberSignInMethod } from "../../llm/gateway-member-sign-in.js"
import { awsSsoFetch, pollAwsSsoSignIn, readAwsSsoAttempt, startAwsSsoSignIn } from "../../llm/inference-provider-aws-sso.js"
import { AwsSsoError, logoutAwsSso } from "@openwork-ee/utils/aws-identity-center"
import { effectiveGatewayGrants, lockMemberOAuthAuthorization, memberGatewayTeams, revokeUpstreamCredentials } from "../../llm/inference-provider-lifecycle.js"
import { isMigrationSourceLockConflict } from "../../llm/inference-provider-migration.js"
import { getModelsDevProvider } from "../../llm/models-dev.js"
import { LiteLlmError, createLiteLlmClient, normalizeLiteLlmBaseUrl } from "../../llm/litellm.js"
import { liteLlmCatalogProvider } from "../../llm/litellm-settings.js"
import { deleteLiteLlmIssuedKeys, liteLlmMemberIssueStatus, provisionLiteLlmMember, pruneLiteLlmIssuedKeys, reconcileLiteLlmIssuedKeys, scheduleLiteLlmProvisioning } from "../../llm/litellm-issued.js"
import { applyLiteLlmSync, connectLiteLlmMemberKey, createLiteLlmProvider, liteLlmAdminKey, updateLiteLlmIssueSettings, disconnectLiteLlmMember, emptySettings, liteLlmEndpoints, liteLlmErrorResponse, liteLlmMemberSet, planLiteLlmCatalog, planLiteLlmSync, pruneLiteLlmAssignments, readLiteLlmSettings, recordLiteLlmSyncError, replaceLiteLlmSyncKey, verifyLiteLlmKey } from "../../llm/litellm-sync.js"
import { LITELLM_PROVIDER_ID, isLiteLlmProviderId } from "@openwork-ee/utils/litellm-catalog"
import { decodeProviderCredential, readProviderEnvNames, runtimeProviderEnvNames } from "../../llm/provider-credentials.js"
import { jsonValidator, orgMemberRoute, paramValidator, publicRoute, queryValidator, userSessionRoute } from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, htmlResponse, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { readSignedSessionCookieToken } from "../../session.js"
import { resolvePermissionsForMember } from "../../permissions/resolve.js"
import { hasPermission, idParamSchema, orgAccessFailureStatus, permissionDeniedMessage, permissionFailureHeaders, requirePermission } from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"
import { registerOrgGatewayUsageRoutes } from "./gateway-usage.js"
import { registerOrgGatewayUsageLimitRoutes } from "./gateway-usage-limits.js"

const paramsSchema = idParamSchema("inferenceProviderId", "inferenceProvider")
const groupParams = paramsSchema.extend(idParamSchema("groupId", "gatewayModelGroup").shape)
const setParams = paramsSchema.extend(idParamSchema("credentialSetId", "gatewayCredentialSet").shape)
const grantParams = paramsSchema.extend(idParamSchema("grantId", "inferenceProviderAccess").shape)
const nameSchema = z.string().trim().min(1).max(255)
const modelIdsSchema = z.array(nameSchema).max(500)
const pinnedModelIdsSchema = modelIdsSchema.refine((ids) => new Set(ids).size === ids.length, "Pinned models must be unique.")
const enableModelsSchema = z.object({ modelGroupId: denTypeIdSchema("gatewayModelGroup"), modelIds: modelIdsSchema.min(1) }).strict()
const modelManagementGroupSchema = z.object({ id: denTypeIdSchema("gatewayModelGroup"), name: z.string(), status: z.enum(GATEWAY_PROVIDER_STATUSES), modelIds: modelIdsSchema })
const modelManagementProviderSchema = z.object({ id: denTypeIdSchema("inferenceProvider"), name: z.string(), providerId: z.string(), status: z.enum(GATEWAY_PROVIDER_STATUSES), modelIds: modelIdsSchema, modelGroups: z.array(modelManagementGroupSchema) })
const credentialSchema = z.object({ kind: z.enum(GATEWAY_PROVIDER_CREDENTIAL_KINDS), secret: z.string().trim().min(1).max(65535) }).strict()
const apiKeysSchema = z.record(nameSchema, z.string().trim().max(65535))
const oauthFields = {
  oauthClientId: z.string().trim().max(255).optional(), oauthClientSecret: z.string().trim().max(4096).optional(),
  oauthTenantId: z.string().trim().max(64).optional().describe("Microsoft Foundry member sets: the Entra ID directory (tenant) ID. Empty string clears."),
  awsSso: gatewayAwsSsoSettingsSchema.nullable().optional().describe("Amazon Bedrock member sets: IAM Identity Center access portal URL, its region, the AWS account ID and the permission set name members get. null clears."),
}
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
const reuseCredentialFromSchema = denTypeIdSchema("inferenceProvider").describe("Amazon Bedrock only: copy the organization AWS keys of another Amazon Bedrock provider in this organization, server-side. Mutually exclusive with credential and apiKeys.")
const createSchema = z.object({ name: nameSchema, providerId: nameSchema, modelIds: universeSchema.default([]), settings: settingsSchema.optional(), status: z.enum(GATEWAY_PROVIDER_STATUSES).optional(), ...legacyFields, reuseCredentialFrom: reuseCredentialFromSchema.optional() }).strict().superRefine(singleCredential)
const patchSchema = z.object({ name: nameSchema.optional(), providerId: nameSchema.optional(), modelIds: universeSchema.optional(), pinnedModelIds: pinnedModelIdsSchema.optional(), settings: settingsSchema.optional(), status: z.enum(GATEWAY_PROVIDER_STATUSES).optional(), ...legacyFields }).strict().superRefine((input, ctx) => {
  singleCredential(input, ctx)
  if (input.pinnedModelIds !== undefined && Object.keys(input).length !== 1) {
    ctx.addIssue({ code: "custom", path: ["pinnedModelIds"], message: "Update pinned models separately from provider configuration." })
  }
})
const oauthQuery = z.object({ credentialSetId: denTypeIdSchema("gatewayCredentialSet").optional(), redirectTo: z.string().trim().min(1).max(2048).optional() }).strict()
function singleCredential(input: { credential?: unknown; apiKeys?: unknown; reuseCredentialFrom?: unknown; credentialMode?: unknown }, ctx: z.RefinementCtx) {
  if (input.credential !== undefined && input.apiKeys !== undefined) ctx.addIssue({ code: "custom", message: "Provide credential or apiKeys, not both." })
  if (input.reuseCredentialFrom !== undefined && (input.credential !== undefined || input.apiKeys !== undefined || input.credentialMode === "member")) {
    ctx.addIssue({ code: "custom", message: "reuseCredentialFrom replaces credential and apiKeys and requires organization credentials." })
  }
}

const groupSchema = groupWrite.extend({ id: denTypeIdSchema("gatewayModelGroup"), description: z.string().nullable(), status: z.enum(GATEWAY_PROVIDER_STATUSES) })
const credentialStatus = z.enum(["ready", "member_auth_required", "org_credential_missing"])
const setSchema = z.object({ id: denTypeIdSchema("gatewayCredentialSet"), name: z.string(), createdAt: z.string().datetime().optional(), createdBy: z.object({ id: denTypeIdSchema("member"), name: z.string().nullable(), email: z.string().nullable() }).nullable().optional(), credentialMode: z.enum(GATEWAY_PROVIDER_CREDENTIAL_MODES), status: z.enum(GATEWAY_PROVIDER_STATUSES), configured: z.boolean(), credentialStatus, oauthClientId: z.string().nullable().optional(), hasOauthClientSecret: z.boolean().optional(), oauthTenantId: z.string().nullable().optional(), awsSso: gatewayAwsSsoSettingsSchema.nullable().optional() })
const grantSchema = grantWrite.extend({ id: denTypeIdSchema("inferenceProviderAccess") })
const modelSchema = z.object({ id: z.string(), name: z.string(), config: z.object({ id: z.string() }).catchall(z.unknown()), upstreamModelId: z.string(), modelGroupId: denTypeIdSchema("gatewayModelGroup"), modelGroupName: z.string(), credentialSetId: denTypeIdSchema("gatewayCredentialSet"), credentialSetName: z.string() })
const summarySchema = z.object({
  modelIds: universeSchema, pinnedModelIds: z.array(z.string()).describe("Ordered catalog model IDs in management responses; only caller-usable gwm aliases in public list/connect responses. Pins never grant access."), catalogWarning: z.string().optional(),
  id: denTypeIdSchema("inferenceProvider"), providerId: z.string(), name: z.string(), source: z.literal("openwork_gateway"), credentialMode: z.enum(GATEWAY_PROVIDER_CREDENTIAL_MODES), credentialStatus, authUrl: z.string().nullable(), status: z.enum(GATEWAY_PROVIDER_STATUSES), createdAt: z.string().datetime().optional(), updatedAt: z.string().datetime(), providerConfig: z.record(z.string(), z.unknown()),
  models: z.array(modelSchema),
  authorizationRequests: z.array(z.object({ credentialSetId: denTypeIdSchema("gatewayCredentialSet"), name: z.string(), authUrl: z.string(), models: z.array(modelSchema).optional() })),
  migration: z.object({ llmProviderId: denTypeIdSchema("llmProvider"), runtimeEnvNames: z.array(z.string()) }).optional(),
}).meta({ ref: "GatewayProviderSummary" })
const liteLlmStatusSchema = z.object({ mode: z.enum(GATEWAY_PROVIDER_CREDENTIAL_MODES), keySource: z.enum(["personal", "issued"]).nullable(), issueStrategy: z.enum(["per_team", "mirror"]).nullable(), mirrorFallback: z.enum(["per_team", "error"]).nullable(), issuedMemberCount: z.number().int(), attentionCount: z.number().int(), attention: z.array(z.object({ memberId: denTypeIdSchema("member"), name: z.string().nullable(), email: z.string().nullable(), reason: z.enum(["not_in_litellm", "no_key_to_mirror", "no_models", "error"]) })), baseUrl: z.string().nullable(), spendTracking: z.boolean(), hasSyncKey: z.boolean(), lastSyncedAt: z.string().datetime().nullable(), lastSyncError: z.string().nullable(), modelCount: z.number().int(), teamCount: z.number().int(), connectedMemberCount: z.number().int() }).meta({ ref: "GatewayLiteLlmStatus" })
const detailsSchema = summarySchema.extend({ litellm: liteLlmStatusSchema.optional(), settings: z.record(z.string(), z.unknown()), modelGroups: z.array(groupSchema), credentialSets: z.array(setSchema), accessGrants: z.array(grantSchema), oauthCallbackUrl: z.string().optional(), credentials: z.array(z.object({ id: denTypeIdSchema("inferenceProviderCredential"), credentialSetId: denTypeIdSchema("gatewayCredentialSet"), subject: z.string(), orgMembershipId: denTypeIdSchema("member").nullable(), memberName: z.string().nullable(), memberEmail: z.string().nullable(), kind: z.enum(GATEWAY_PROVIDER_CREDENTIAL_KINDS), status: z.enum(GATEWAY_PROVIDER_CREDENTIAL_STATUSES), expiresAt: z.string().datetime().nullable() })).optional() }).meta({ ref: "GatewayProviderDetails" })
const detailsResponse = z.object({ inferenceProvider: detailsSchema })
const connectResponse = z.object({ inferenceProvider: summarySchema.extend({ apiKey: z.string(), apiKeys: z.record(z.string(), z.string()) }) })
const gatewayErrorSchema = z.object({ error: z.string(), message: z.string().optional() })
const liteLlmKeySchema = z.string().trim().min(1).max(4096)
const liteLlmModeSchema = z.enum(["org", "member", "issued"]).describe("org: one organization LiteLLM key for everyone, with OpenWork spend tracking. member: each person connects their own LiteLLM key. issued: OpenWork creates a LiteLLM key for each allowed person, found by their OpenWork email. In member and issued modes apiKey is a LiteLLM admin key and OpenWork spend tracking is off.")
const liteLlmIssueStrategySchema = z.enum(["per_team", "mirror"]).describe("issued mode. per_team: one key per LiteLLM team the person belongs to, or one key without a team when they are in none. mirror: a copy of their oldest active key (team, models, aliases, tags, expiry; never key-level budgets or rate limits).")
const liteLlmMirrorFallbackSchema = z.enum(["per_team", "error"]).describe("issued + mirror: for someone with no key to copy, create per-team keys, or report them and create nothing.")
const liteLlmCreateSchema = z.object({ name: nameSchema.default("LiteLLM"), baseUrl: z.string().trim().min(1).max(2048).describe("LiteLLM proxy URL, with or without /v1."), mode: liteLlmModeSchema, issueStrategy: liteLlmIssueStrategySchema.optional(), mirrorFallback: liteLlmMirrorFallbackSchema.optional(), apiKey: liteLlmKeySchema.describe("Organization key (org mode) or admin key (member and issued modes). Write-only."), allMembers: z.boolean().optional(), memberIds: z.array(denTypeIdSchema("member")).max(500).optional(), teamIds: z.array(denTypeIdSchema("team")).max(500).optional() }).strict()
const liteLlmSyncResultSchema = z.object({ modelCount: z.number().int(), groupCount: z.number().int(), teamCount: z.number().int(), members: z.object({ matched: z.number().int(), rejected: z.number().int(), unavailable: z.number().int(), removed: z.number().int() }), warnings: z.array(z.string()), issued: z.object({ people: z.number().int(), keys: z.number().int(), notInLiteLlm: z.number().int(), noKeyToMirror: z.number().int(), noModels: z.number().int(), errors: z.number().int(), removed: z.number().int() }).optional() })
const liteLlmIssueStatusSchema = z.object({ status: z.string(), message: z.string().nullable(), keyCount: z.number().int() })
const liteLlmConnectResultSchema = z.object({ connected: z.literal(true), modelGroupId: denTypeIdSchema("gatewayModelGroup"), modelGroupName: z.string(), modelIds: z.array(z.string()) })

function route(summary: string, description: string, schema?: z.ZodType, status: 200 | 201 | 204 = 200, secret = false, metadata: Pick<DescribeRouteOptions, "security" | "responses"> & { "x-mcp"?: boolean; "x-mcp-search-aliases"?: string[] } = {}) {
  const options: DescribeRouteOptions & { "x-mcp"?: boolean; "x-mcp-search-aliases"?: string[] } = {
    ...metadata,
    tags: ["Inference Providers"], summary, description,
    responses: { [status]: schema ? jsonResponse(summary, schema) : emptyResponse(summary), 400: jsonResponse("Invalid request or provider configuration.", z.union([invalidRequestSchema, gatewayErrorSchema])), 401: jsonResponse("Sign-in required.", unauthorizedSchema), 403: jsonResponse("Access denied or Gateway management disabled.", z.union([forbiddenSchema, gatewayManagementUnavailableSchema])), 404: jsonResponse("Resource not found.", notFoundSchema), 409: jsonResponse("Selection or resource conflict.", gatewayErrorSchema), ...metadata.responses },
    ...(secret ? { "x-mcp": false as const } : {}),
  }
  return describeRoute(options)
}

type Actor = NonNullable<OrgRouteVariables["organizationContext"]>
type GatewayManagementKey = "gateway_providers.view" | "gateway_providers.manage"
const VIEW: GatewayManagementKey = "gateway_providers.view"
const MANAGE: GatewayManagementKey = "gateway_providers.manage"
const managementRead: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  const permission = await requirePermission(c, VIEW)
  if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response), permissionFailureHeaders(permission.response))
  const unavailable = gatewayManagementUnavailable()
  if (unavailable) return c.json(unavailable, 403)
  await next()
}
const providerAuditRequests = new WeakMap<Request, { providerId: string; capture: ProviderAuditCapture | null }>()
const managementWrite: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  const actor = c.get("organizationContext")
  const step = providerAuditStep(c.req.method, c.req.routePath)
  const parsed = paramsSchema.safeParse({ inferenceProviderId: c.req.param("inferenceProviderId") })
  const providerId = parsed.success ? parsed.data.inferenceProviderId : createDenTypeId("inferenceProvider")
  const capture = actor && step && "auditCaptureEnabled" in env && env.auditCaptureEnabled === true
    ? await loadProviderAudit(db, true, providerRequestAuditContext({ organizationId: actor.organization.id, memberId: actor.currentMember.id, userId: actor.currentMember.userId, credentialId: c.get("apiKey")?.id, providerId, workflowStep: step, routeParams: { groupId: c.req.param("groupId"), credentialSetId: c.req.param("credentialSetId"), grantId: c.req.param("grantId") }, serverRequestId: c.get("requestId"), headers: c.req.raw.headers }), step)
    : null
  providerAuditRequests.set(c.req.raw, { providerId, capture })
  let status = 500
  try {
    const permission = await requirePermission(c, MANAGE)
    if (!permission.ok) {
      const failureStatus = orgAccessFailureStatus(permission.response)
      status = failureStatus
      return c.json(permission.response, failureStatus, permissionFailureHeaders(permission.response))
    }
    const unavailable = gatewayManagementUnavailable()
    if (unavailable) { status = 403; return c.json(unavailable, 403) }
    await next()
    status = c.res.status
  } finally {
    providerAuditRequests.delete(c.req.raw)
    await recordProviderAttempt(db, capture, status)
  }
}
async function providerTransaction<T>(c: { req: { raw: Request; param: (key: string) => string | undefined }; get: (key: "organizationContext") => OrgRouteVariables["organizationContext"] }, mutate: (tx: GatewayTx, provider: GatewayProvider) => Promise<T>): Promise<T> {
  const actor = c.get("organizationContext")
  const id = c.req.param("inferenceProviderId")
  if (!actor || !id) throw new GatewayWriteError(403, "forbidden")
  return db.transaction(async (tx) => {
    const capture = providerAuditRequests.get(c.req.raw)?.capture ?? null
    // Match membership/role mutation order: organization before member/provider.
    if (capture) await recheckAuditEntitlement(tx, actor.organization.id)
    const provider = await getProvider(tx, actor, id, true)
    await requireLiveManage(tx, actor)
    return providerAuditMutation(tx, capture, () => mutate(tx, provider))
  })
}
/**
 * Re-checks Manage Gateway providers inside a management write transaction,
 * after liveMember has locked the caller's member row, so a permission revoked
 * after managementWrite (e.g. while catalog or LiteLLM calls were awaited) is
 * seen before the mutation. Reads only through `tx` (read-only, share locks):
 * no second pool connection while this transaction holds row locks. The
 * recent sign-in part of the check stays with managementWrite.
 */
async function requireLiveManage(tx: GatewayTx, actor: Actor) {
  if (!(await holdsLiveManage(tx, actor))) throw new GatewayWriteError(403, "forbidden", permissionDeniedMessage(MANAGE))
}
/** Whether the caller still holds Manage Gateway providers, read only through `tx` (see requireLiveManage). */
async function holdsLiveManage(tx: GatewayTx, actor: Actor) {
  const permissions = await resolvePermissionsForMember({ organizationId: actor.organization.id, memberId: actor.currentMember.id, database: tx })
  return permissions.has(MANAGE)
}
// Re-reads the caller's member row so a removal that landed after the route
// check still fails here. Write transactions behind managementWrite then call
// requireLiveManage with the same transaction.
async function liveMember(database: GatewayTx | typeof db, actor: Actor, lock: boolean) {
  const query = database.select().from(MemberTable).where(and(eq(MemberTable.id, actor.currentMember.id), eq(MemberTable.organizationId, actor.organization.id), isNull(MemberTable.removedAt)))
  const [member] = await (lock ? query.for("update") : query)
  if (!member?.userId) throw new GatewayWriteError(403, "forbidden")
  return member
}
async function getProvider(database: GatewayTx | typeof db, actor: Actor, id: string, lock = false) {
  await liveMember(database, actor, lock)
  const query = database.select().from(GatewayProviderTable).where(and(eq(GatewayProviderTable.id, normalizeDenTypeId("inferenceProvider", id)), eq(GatewayProviderTable.organization_id, actor.organization.id)))
  const [provider] = await (lock ? query.for("update") : query)
  if (!provider) throw new GatewayWriteError(404, "inference_provider_not_found")
  return provider
}
function respond(c: { json: (body: unknown, status: 400 | 403 | 404 | 409) => Response }, error: unknown) {
  if (error instanceof GatewayWriteError) {
    return c.json({ error: error.code, message: error.message }, error.status)
  }
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
  const hasCredentialInput = input.credential !== undefined || input.apiKeys !== undefined || input.credentialMode === "member" || input.oauthClientId !== undefined || input.oauthClientSecret !== undefined || input.oauthTenantId !== undefined || input.awsSso !== undefined
  if (!hasCredentialInput && audiences.length) throw new GatewayWriteError(400, "credential_required", "Configure credentials before granting initial provider access.")
  const set = hasCredentialInput
    ? await writeGatewaySet(tx, provider, { name: "Default credentials", credentialMode: input.credentialMode ?? "org", credential: input.credential, apiKeys: input.apiKeys, oauthClientId: input.oauthClientId, oauthClientSecret: input.oauthClientSecret, oauthTenantId: input.oauthTenantId, awsSso: input.awsSso }, { createdByOrgMembershipId: creatorId })
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

/**
 * Binds a browser entry attempt to the set's sign-in configuration. Google
 * attempts bind the OAuth client; LiteLLM attempts bind the provider and set,
 * because each member pastes their own LiteLLM key instead.
 */
function memberAttemptBinding(provider: GatewayProvider, set: GatewaySet, verifier: string): string | null {
  if (isLiteLlmProviderId(provider.provider_id)) return googleOAuthClientBinding(verifier, `litellm:${provider.id}`, set.id)
  const method = gatewayMemberSignInMethod(provider.provider_id)
  return method ? memberSignInBinding(method, set, verifier) : null
}

/**
 * AWS and Microsoft sign-in and Microsoft Foundry are behind the
 * gatewayCloudSignIn feature (packages/features/src/registry.ts). Browser routes
 * have no organization context, so they check the provider's organization.
 * Turning it off stops new providers and sign-ins; existing credentials keep working.
 */
async function requireCloudSignInFeature(organizationId: GatewayProvider["organization_id"]): Promise<void> {
  if (!await organizationFeatureEnabled(organizationId, "gatewayCloudSignIn")) throw new GatewayWriteError(404, "feature_disabled", "AWS and Microsoft sign-in aren't turned on for this organization.")
}

/** Gate writes that create Microsoft Foundry providers or configure AWS or Microsoft member sign-in. */
async function requireCloudSignInForWrite(organizationId: GatewayProvider["organization_id"], providerId: string, input: { credentialMode?: string; oauthTenantId?: string; awsSso?: unknown }, creating = false) {
  const cloud = isCloudSignInMethod(gatewayMemberSignInMethod(providerId))
  if ((creating && providerId === MICROSOFT_FOUNDRY_PROVIDER_ID) || (cloud && (input.credentialMode === "member" || input.oauthTenantId !== undefined || (input.awsSso !== undefined && input.awsSso !== null)))) {
    await requireCloudSignInFeature(organizationId)
  }
}
/**
 * LiteLLM is behind the `litellm` feature (packages/features/src/registry.ts).
 * Organization routes use requireFeature("litellm"); the browser Connect routes
 * have no organization context, so they check the provider's organization.
 * Removing an existing LiteLLM provider stays possible either way.
 */
async function requireLiteLlmFeature(organizationId: GatewayProvider["organization_id"]): Promise<void> {
  if (!await organizationFeatureEnabled(organizationId, "litellm")) throw new GatewayWriteError(404, "feature_disabled", "LiteLLM isn't turned on for this organization.")
}

async function liteLlmCall<T>(run: () => Promise<T>): Promise<T> {
  try { return await run() } catch (error) {
    if (error instanceof LiteLlmError) throw liteLlmErrorResponse(error)
    throw error
  }
}
function liteLlmAudiences(input: { allMembers?: boolean; memberIds?: string[]; teamIds?: string[] }): GatewayAccessGrantWrite["audience"][] {
  return [
    ...(input.allMembers ? [{ type: "organization" as const }] : []),
    ...[...new Set(input.memberIds ?? [])].map((memberId) => ({ type: "member" as const, memberId })),
    ...[...new Set(input.teamIds ?? [])].map((teamId) => ({ type: "team" as const, teamId })),
  ]
}

/** Member OAuth entry verified against the live browser session: provider org + initiating member. */
async function attributeMemberOAuthEntry(c: Context, input: { organizationId: string; userId: string; memberId: string }) {
  const attribution = auditSessionUserAttribution(input.userId, input.memberId)
  if (!attribution) return null
  const audited = await attributeAuditRequest(c, { organizationId: input.organizationId, ...attribution })
  return audited.ok ? null : audited.response
}

type BrowserSession = Pick<typeof AuthSessionTable.$inferSelect, "id" | "token" | "userId">
type OauthState = typeof GatewayProviderOauthStateTable.$inferSelect

/**
 * Load a browser sign-in attempt for the new browser routes: the live signed
 * cookie must belong to the initiating user, and the provider's sign-in method
 * and configuration must still match what the attempt was started with.
 */
async function loadBrowserSignInAttempt(c: Context, handle: string, method: GatewayMemberSignInMethod) {
  const cookieToken = await readSignedSessionCookieToken(c)
  const [session] = cookieToken ? await db.select().from(AuthSessionTable).where(and(eq(AuthSessionTable.token, cookieToken), gt(AuthSessionTable.expiresAt, new Date()))).limit(1) : []
  if (!session) return { response: c.json({ error: "browser_signin_required", message: "Sign in to OpenWork in this browser, then continue here." }, 401) }
  const [entry] = await db.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.state, handle)).limit(1)
  const attempt = entry ? readGoogleOAuthAttempt(entry.code_verifier) : null
  if (!entry || !attempt || entry.used_at || entry.expires_at.getTime() <= Date.now()) throw new GatewayWriteError(400, "oauth_entry_expired", "This connection attempt expired or was already used. Start Connect again.")
  if (attempt.userId !== session.userId) throw new GatewayWriteError(403, "browser_account_mismatch", "Use the same OpenWork account that started Connect. Sign out in this browser and sign in with that account.")
  const [provider] = await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, entry.gateway_provider_id))
  const [set] = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, entry.credential_set_id))
  if (!provider || !set || provider.status !== "active" || gatewayMemberSignInMethod(provider.provider_id) !== method
    || attempt.clientBinding !== memberSignInBinding(method, set, attempt.verifier)) throw new GatewayWriteError(403, "oauth_configuration_changed", "Provider configuration changed. Start Connect again.")
  if (isCloudSignInMethod(method)) await requireCloudSignInFeature(provider.organization_id)
  // The live signed cookie matches the entry's initiating user: attribute to
  // the provider's organization and the entry's member before any write.
  const auditBlocked = await attributeMemberOAuthEntry(c, { organizationId: provider.organization_id, userId: session.userId, memberId: entry.org_membership_id })
  if (auditBlocked) return { response: auditBlocked }
  return { entry, attempt, provider, set, session }
}

/**
 * Store a member's own credential after sign-in, re-checking access, the browser
 * session and the attempt under the member/provider/set/state locks. The OAuth
 * callback has already claimed its state; the AWS poll claims it here.
 */
async function storeMemberCredential(input: {
  provider: GatewayProvider
  set: GatewaySet
  state: OauthState
  browserSession: BrowserSession
  userId: string
  claim?: boolean
  values: { kind: "oauth_google" | "oauth_azure" | "aws_sso"; secret: string; expires_at: Date; scopes: string | null }
}) {
  const { provider, set, state } = input
  return db.transaction(async (tx) => {
    if (!await lockMemberOAuthAuthorization(tx, provider, set, state.org_membership_id, input.userId)) return false
    const [liveSession] = await tx.select().from(AuthSessionTable).where(and(eq(AuthSessionTable.id, input.browserSession.id), eq(AuthSessionTable.token, input.browserSession.token), eq(AuthSessionTable.userId, input.browserSession.userId), gt(AuthSessionTable.expiresAt, new Date()))).for("update")
    if (!liveSession) return false
    const [current] = await tx.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.id, state.id)).for("update")
    if (!current || current.expires_at.getTime() <= Date.now() || current.credential_set_id !== set.id || current.state !== state.state || current.code_verifier !== state.code_verifier || current.org_membership_id !== state.org_membership_id || current.gateway_provider_id !== provider.id || current.redirect_to !== state.redirect_to) return false
    if (input.claim ? current.used_at : !current.used_at) return false
    if (input.claim) await tx.update(GatewayProviderOauthStateTable).set({ used_at: new Date() }).where(eq(GatewayProviderOauthStateTable.id, state.id))
    const [existing] = await tx.select().from(GatewayProviderCredentialTable).where(and(eq(GatewayProviderCredentialTable.credential_set_id, set.id), eq(GatewayProviderCredentialTable.subject, state.org_membership_id))).for("update")
    const now = new Date()
    if (input.values.expires_at.getTime() <= now.getTime()) return false
    const values = { ...input.values, last_refreshed_at: now, refreshing_until: null, last_error: null, status: "active" as const, updated_at: now }
    if (existing) {
      if (existing.gateway_provider_id !== provider.id || existing.organization_id !== provider.organization_id || existing.org_membership_id !== state.org_membership_id) return false
      await tx.update(GatewayProviderCredentialTable).set(values).where(eq(GatewayProviderCredentialTable.id, existing.id))
    } else await tx.insert(GatewayProviderCredentialTable).values({ id: createDenTypeId("inferenceProviderCredential"), gateway_provider_id: provider.id, credential_set_id: set.id, organization_id: provider.organization_id, subject: state.org_membership_id, org_membership_id: state.org_membership_id, ...values })
    return true
  })
}

/** AWS sign-in failures as API errors: what the person or an administrator should do next. */
function awsSsoWriteError(error: unknown): unknown {
  if (!(error instanceof AwsSsoError)) return error
  if (error.transient) return new GatewayWriteError(409, "aws_sso_unavailable", error.message)
  if (error.code === "aws_sso_role_forbidden" || error.code === "aws_sso_access_denied") return new GatewayWriteError(403, error.code, error.message)
  if (error.code === "aws_sso_invalid_request") return new GatewayWriteError(400, error.code, "IAM Identity Center rejected the sign-in. Ask your administrator to check the AWS access portal URL and Identity Center region.")
  return new GatewayWriteError(400, error.code, error.message)
}

export function registerOrgInferenceProviderRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  registerOrgGatewayUsageRoutes(app)
  registerOrgGatewayUsageLimitRoutes(app)
  // Agent-facing management reads never refresh or change the catalog. The existing provider summaries do.
  app.get("/v1/inference-providers/model-management", route("List inference gateway providers and model groups for model enablement", "Read-only organization Gateway provider and group selection. Returns saved upstream model IDs, not picker aliases or credentials. An empty provider modelIds policy means all supported catalog models. Requires the View Gateway providers permission and Gateway management.", z.object({ inferenceProviders: z.array(modelManagementProviderSchema) }), 200, false, { "x-mcp": true, "x-mcp-search-aliases": ["find OpenAI provider model groups", "manage provider models", "choose model group to add models"] }), orgMemberRoute(), managementRead, async (c) => {
    try {
      const actor = c.get("organizationContext")
      await liveMember(db, actor, false)
      const providers = await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.organization_id, actor.organization.id))
      const inferenceProviders = []
      for (const provider of providers) {
        const groups = await db.select().from(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.gateway_provider_id, provider.id))
        const models = await db.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id))
        const links = groups.length ? await db.select().from(GatewayModelGroupModelTable).where(inArray(GatewayModelGroupModelTable.model_group_id, groups.map((group) => group.id))) : []
        inferenceProviders.push({ id: provider.id, name: provider.name, providerId: provider.provider_id, status: provider.status, modelIds: provider.model_ids,
          modelGroups: groups.map((group) => ({ id: group.id, name: group.name, status: group.status,
            modelIds: links.filter((link) => link.model_group_id === group.id).flatMap((link) => models.find((model) => model.id === link.gateway_provider_model_id)?.model_id ?? []) })) })
      }
      return c.json({ inferenceProviders })
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/:inferenceProviderId/available-models", route("List available upstream models for inference gateway provider", "Read-only trusted models.dev catalog for this provider, including models outside its current policy. Does not enable models or modify saved configuration; unsupported Gateway SDK models are excluded. Requires the View Gateway providers permission and Gateway management.", z.object({ models: z.array(z.object({ id: z.string(), name: z.string() })) }), 200, false, { "x-mcp": true, "x-mcp-search-aliases": ["find new OpenAI models", "available models to add to provider"] }), orgMemberRoute(), managementRead, paramValidator(paramsSchema), async (c) => {
    try {
      const provider = await getProvider(db, c.get("organizationContext"), c.req.valid("param").inferenceProviderId)
      const catalog = await trustedProviderCatalog(provider)
      if (!catalog || catalog.id !== provider.provider_id || catalog.npm !== readProviderConfigNpm(provider.provider_config)) throw new GatewayWriteError(409, "provider_catalog_changed")
      return c.json({ models: resolveGatewayCatalog(catalog, [], provider.provider_config).models.map((model) => ({ id: model.id, name: model.name })) })
    } catch (error) { return respond(c, error) }
  })

  app.post("/v1/inference-providers/:inferenceProviderId/enable-models", route("Add models to inference gateway provider group", "Add upstream catalog model IDs to one explicitly selected existing model group without removing other models or changing access grants. Empty provider modelIds policy stays unrestricted; nonempty policy widens. Repeated calls are idempotent. Requires the Manage Gateway providers permission and Gateway management; session callers must recently reauthenticate.", z.object({ inferenceProviderId: denTypeIdSchema("inferenceProvider"), modelGroupId: denTypeIdSchema("gatewayModelGroup"), modelIds: modelIdsSchema, groupModelIds: modelIdsSchema, addedModelIds: modelIdsSchema }), 200, false, { "x-mcp": true, "x-mcp-search-aliases": ["add model to OpenAI provider", "enable models in provider", "add Luna and Sol to model group"] }), orgMemberRoute(), managementWrite, paramValidator(paramsSchema), jsonValidator(enableModelsSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      const before = await getProvider(db, actor, params.inferenceProviderId)
      const catalog = await trustedProviderCatalog(before)
      if (!catalog) throw new GatewayWriteError(409, "provider_catalog_unavailable")
      const result = await providerTransaction(c, async (tx, provider) => {
        return enableGatewayGroupModels(tx, provider, catalog, normalizeDenTypeId("gatewayModelGroup", input.modelGroupId), input.modelIds)
      })
      return c.json(result)
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/member-connections", route("List the caller's member sign-in connections", "Requires a signed-in user session and current organization membership, without an administrator gate. Returns independently selectable member credential sets (Google, AWS IAM Identity Center or Microsoft Entra ID sign-in) with current effective access, credential readiness, the signed-in account name and an opaque completed-authorization revision. Includes retained nonrevoked caller-owned credentials after grant loss or provider disablement for disconnection. Never returns another member's credentials, Google subject, OAuth client details or tokens. Readiness is not a Vertex IAM probe.", gatewayMemberConnectionsResponseSchema), userSessionRoute(), orgMemberRoute(), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const userId = c.get("user")?.id
      if (!userId) throw new GatewayWriteError(403, "forbidden")
      c.header("Cache-Control", "no-store")
      return c.json(await gatewayMemberConnections({ organizationId: actor.organization.id, memberId: actor.currentMember.id, userId }))
    } catch (error) { return respond(c, error) }
  })
  app.get("/v1/inference-providers", route("List organization inference gateway providers", "Defaults to scope=usable: returns active providers granted to the caller through active model groups and credential sets, with usable model aliases and any member authorization requests. A granted provider can remain discoverable with no usable models. scope=manageable requires the View Gateway providers permission and enabled Gateway management, and returns provider details including disabled providers; credential secrets are never returned.", z.object({ inferenceProviders: z.array(z.union([detailsSchema, summarySchema])) })), orgMemberRoute(), queryValidator(z.object({ scope: z.enum(["usable", "manageable"]).default("usable") })), async (c) => {
    try {
    const actor = c.get("organizationContext")
    const manage = c.req.valid("query").scope === "manageable"
    if (manage) {
      const permission = await requirePermission(c, VIEW)
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response), permissionFailureHeaders(permission.response))
      const unavailable = gatewayManagementUnavailable()
      if (unavailable) return c.json(unavailable, 403)
    }
    await liveMember(db, actor, false)
    let liteLlm: Promise<boolean> | null = null
    const liteLlmOn = () => (liteLlm ??= organizationFeatureEnabled(actor.organization.id, "litellm"))
    const providers = await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.organization_id, actor.organization.id)).orderBy(desc(GatewayProviderTable.updated_at))
    const summaries: Array<GatewayProviderSummary | null> = providers.map(() => null)
    let next = 0
    let failure: { error: unknown } | undefined
    // Each summary keeps its DB reads sequential; two workers bound connection
    // use while avoiding a serial wait across every provider in the list.
    await Promise.all(Array.from({ length: Math.min(2, providers.length) }, async () => {
      while (!failure && next < providers.length) {
        const index = next++
        const provider = providers[index]
        try {
          if (!manage && provider.status !== "active") continue
          // An organization set may be unconfigured; keep its granted provider discoverable without leaking models.
          if (!manage) {
            const teams = await memberGatewayTeams(db, provider.organization_id, actor.currentMember.id)
            const grants = await db.select({ grant: GatewayProviderAccessTable }).from(GatewayProviderAccessTable)
              .innerJoin(GatewayModelGroupTable, and(eq(GatewayModelGroupTable.id, GatewayProviderAccessTable.model_group_id), eq(GatewayModelGroupTable.gateway_provider_id, provider.id), eq(GatewayModelGroupTable.status, "active")))
              .innerJoin(GatewayCredentialSetTable, and(eq(GatewayCredentialSetTable.id, GatewayProviderAccessTable.credential_set_id), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id), eq(GatewayCredentialSetTable.status, "active")))
              .where(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id))
            if (!effectiveGatewayGrants(grants.map((row) => row.grant), actor.currentMember.id, teams.map((team) => team.id)).length) continue
            // Zero-touch LiteLLM keys: create this person's keys in the background on first use.
            if (isLiteLlmProviderId(provider.provider_id) && await liteLlmOn()) scheduleLiteLlmProvisioning(provider, actor.currentMember.id)
          }
          summaries[index] = await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), manage)
        } catch (error) {
          // Drain active workers and stop scheduling before returning a failure.
          // Catalog mutations must not continue after the failed list response.
          failure ??= { error }
        }
      }
    }))
    if (failure) throw failure.error
    return c.json({ inferenceProviders: summaries.filter((summary) => summary !== null) })
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/:inferenceProviderId", route("Get inference gateway provider", "Returns management details for an organization provider, including public settings, model groups, credential-set status, access grants and credential metadata without secrets. Requires the View Gateway providers permission and enabled Gateway management.", detailsResponse), orgMemberRoute(), managementRead, paramValidator(paramsSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const provider = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      return c.json({ inferenceProvider: await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), true) })
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/:inferenceProviderId/connect", route("Get inference gateway provider connect payload", "Returns the caller's provider summary plus their Gateway apiKey and an apiKeys map for the provider's runtime environment names, never upstream provider secrets. Requires an active provider and an effective grant through active model groups and credential sets; member authorization may still be required before models are usable.", connectResponse, 200, true), orgMemberRoute(), paramValidator(paramsSchema), async (c) => {
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

  app.post("/v1/inference-providers", route("Create inference gateway provider", "Creates an organization Gateway provider from the trusted catalog and returns its management details. Empty modelIds follows all supported catalog models; a nonempty list restricts the provider universe. Creates an initial model group; legacy credential and audience fields can also create a default credential set and grants. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", detailsResponse, 201), orgMemberRoute(), managementWrite, jsonValidator(createSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const input = c.req.valid("json")
      await requireCloudSignInForWrite(actor.organization.id, input.providerId, input, true)
      const catalog = await gatewayCatalog(input.providerId, input.modelIds)
      validateGatewaySettings(catalog.config, input.settings ?? {})
      const now = new Date()
      const provider: GatewayProvider = { id: normalizeDenTypeId("inferenceProvider", providerAuditRequests.get(c.req.raw)?.providerId ?? createDenTypeId("inferenceProvider")), organization_id: actor.organization.id, created_by_org_membership_id: actor.currentMember.id, provider_id: catalog.catalog.id, name: input.name, model_ids: [...new Set(input.modelIds)], pinned_model_ids: [], provider_config: catalog.config, settings: input.settings ?? {}, credential_mode: input.credentialMode ?? "org", oauth_client_id: null, oauth_client_secret: null, status: input.status ?? "active", created_at: now, updated_at: now }
      await db.transaction(async (tx) => {
        const capture = providerAuditRequests.get(c.req.raw)?.capture ?? null
        if (capture) await recheckAuditEntitlement(tx, actor.organization.id)
        const member = await liveMember(tx, actor, true)
        await requireLiveManage(tx, actor)
        await providerAuditMutation(tx, capture, async () => {
          await tx.insert(GatewayProviderTable).values(provider)
          await writeGatewayModels(tx, provider, catalog.models)
          const credential = input.reuseCredentialFrom === undefined ? input.credential : await reusableAwsCredential(tx, provider, input.reuseCredentialFrom)
          await defaultMatrix(tx, provider, { ...input, credential }, member.id)
        })
      })
      return c.json({ inferenceProvider: await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), true) }, 201)
    } catch (error) { return respond(c, error) }
  })

  app.patch("/v1/inference-providers/:inferenceProviderId", route("Update inference gateway provider", "Partially updates the provider name, model universe or status and returns management details. A pin-only PATCH with pinnedModelIds replaces the ordered catalog-model pins without changing models, groups, credentials or grants; duplicates and unknown models are rejected. Pins do not grant access. Provider identity and upstream destination are immutable; changing them requires a new provider. Legacy credential or audience fields are rejected with matrix_write_required: edit credential sets and access grants instead. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", detailsResponse), orgMemberRoute(), managementWrite, paramValidator(paramsSchema), jsonValidator(patchSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const input = c.req.valid("json")
      if (input.credentialMode !== undefined || input.credential !== undefined || input.apiKeys !== undefined || input.oauthClientId !== undefined || input.oauthClientSecret !== undefined || input.oauthTenantId !== undefined || input.awsSso !== undefined || input.memberIds !== undefined || input.teamIds !== undefined || input.allMembers !== undefined) {
        throw new GatewayWriteError(409, "matrix_write_required", "Edit credential-sets and access-grants explicitly. Flat PATCH cannot replace the access matrix.")
      }
      const pinnedModelIds = input.pinnedModelIds
      if (pinnedModelIds !== undefined) {
        const provider = await db.transaction(async (tx) => {
          const existing = await getProvider(tx, actor, c.req.valid("param").inferenceProviderId, true)
          await requireLiveManage(tx, actor)
          const models = (await tx.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, existing.id)))
            .filter((model) => (!existing.model_ids.length || existing.model_ids.includes(model.model_id))
              && !gatewayModelConfigurationError(existing.provider_config, [model.model_config]))
          if (pinnedModelIds.some((id) => !models.some((model) => model.model_id === id))) {
            throw new GatewayWriteError(404, "model_not_found", "Pins accept configured catalog model IDs from this provider only.")
          }
          const updated_at = new Date()
          await tx.update(GatewayProviderTable).set({ pinned_model_ids: pinnedModelIds, updated_at }).where(eq(GatewayProviderTable.id, existing.id))
          return { ...existing, pinned_model_ids: pinnedModelIds, updated_at }
        })
        return c.json({ inferenceProvider: await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), true) })
      }
      const before = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      const trusted = await trustedProviderCatalog(before)
      const provider = await providerTransaction(c, async (tx, existing) => {
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
  app.get("/v1/inference-providers/:inferenceProviderId/models", route("List configured gateway catalog models", "Returns supported catalog models within the saved modelIds policy, independently of model-group membership or caller-usable aliases. Callers who also hold Manage Gateway providers first refresh the stored models from the catalog; View-only callers get the stored models without any refresh or write. If catalog refresh is unavailable or incompatible, retains the saved configuration and returns catalogWarning. Requires the View Gateway providers permission and enabled Gateway management.", z.object({ modelIds: universeSchema, catalogWarning: z.string().optional(), models: z.array(z.object({ id: z.string(), name: z.string(), config: z.record(z.string(), z.unknown()) })) })), orgMemberRoute(), managementRead, paramValidator(paramsSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      // Admitted by View Gateway providers. The refresh can delete stored models and their
      // group links, so only callers holding Manage Gateway providers trigger it, re-checked
      // through the refresh's own write transaction; everyone else gets a read-only response.
      // (Pre-Permissions every admin could refresh here without a recent sign-in, so neither is
      // required for the refresh; admins hold both keys by default.)
      const mayManage = await hasPermission(c, MANAGE)
      const { provider, catalogWarning } = await refreshGatewayCatalog(
        await getProvider(db, actor, c.req.valid("param").inferenceProviderId),
        undefined,
        mayManage ? { mayWrite: (tx) => holdsLiveManage(tx, actor) } : { write: false },
      )
      const models = (await db.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id)))
        .filter((model) => (!provider.model_ids.length || provider.model_ids.includes(model.model_id)) && !gatewayModelConfigurationError(provider.provider_config, [model.model_config]))
      return c.json({ modelIds: provider.model_ids, ...(catalogWarning ? { catalogWarning } : {}), models: models.map((model) => ({ id: model.model_id, name: model.name, config: nonSecretProviderConfig(model.model_config) })) })
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/:inferenceProviderId/model-groups", route("List gateway model groups", "Returns the provider's model groups, including disabled groups, with catalog model IDs in the current provider universe. Requires the View Gateway providers permission and enabled Gateway management.", z.object({ modelGroups: z.array(groupSchema) })), orgMemberRoute(), managementRead, paramValidator(paramsSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const provider = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      const details = await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), true)
      return c.json({ modelGroups: details.modelGroups })
    } catch (error) { return respond(c, error) }
  })
  app.post("/v1/inference-providers/:inferenceProviderId/model-groups", route("Create gateway model group", "Creates and returns a model group using supported catalog model IDs from this provider; creating a group alone grants no access. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", z.object({ modelGroup: groupSchema }), 201), orgMemberRoute(), managementWrite, paramValidator(paramsSchema), jsonValidator(groupWrite), async (c) => {
    try {
      const actor = c.get("organizationContext")
      await refreshGatewayCatalog(await getProvider(db, actor, c.req.valid("param").inferenceProviderId), providerAuditRequests.get(c.req.raw)?.capture ?? null)
      const result = await providerTransaction(c, async (tx, provider) => {
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
  app.patch("/v1/inference-providers/:inferenceProviderId/model-groups/:groupId", route("Update gateway model group", "Partially updates a group's name, description, status or model membership. Supplied modelIds replaces membership; omitted modelIds preserves it. IDs must belong to the provider's supported catalog universe. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", z.object({ modelGroup: groupSchema })), orgMemberRoute(), managementWrite, paramValidator(groupParams), jsonValidator(groupWrite.partial()), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const params = c.req.valid("param")
      await refreshGatewayCatalog(await getProvider(db, actor, params.inferenceProviderId), providerAuditRequests.get(c.req.raw)?.capture ?? null)
      const result = await providerTransaction(c, async (tx, provider) => {
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
  app.delete("/v1/inference-providers/:inferenceProviderId/model-groups/:groupId", route("Delete gateway model group", "Deletes the group and its model links, returning an empty 204. Referencing access grants must be removed first or the operation returns model_group_in_use. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", undefined, 204), orgMemberRoute(), managementWrite, paramValidator(groupParams), async (c) => {
    try {
      const params = c.req.valid("param")
      await providerTransaction(c, async (tx, provider) => {
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

  app.get("/v1/inference-providers/:inferenceProviderId/credential-sets", route("List gateway credential sets", "Returns credential-set configuration status, creator metadata and OAuth client metadata without stored secrets. Member credential readiness is evaluated for the caller. Requires the View Gateway providers permission and enabled Gateway management.", z.object({ credentialSets: z.array(setSchema) })), orgMemberRoute(), managementRead, paramValidator(paramsSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const provider = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      const details = await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), true)
      return c.json({ credentialSets: details.credentialSets })
    } catch (error) { return respond(c, error) }
  })
  app.post("/v1/inference-providers/:inferenceProviderId/credential-sets", route("Create gateway credential set", "Creates an organization credential set with a supported shared credential, or a member set where each member signs in with their own account: a Google OAuth client (Vertex), an Entra ID tenant and app registration (Microsoft Foundry) or IAM Identity Center settings (Amazon Bedrock). Returns configuration status without secrets; access grants are created separately. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", z.object({ credentialSet: setSchema }), 201), orgMemberRoute(), managementWrite, paramValidator(paramsSchema), jsonValidator(setWrite.superRefine(singleCredential)), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const before = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      await requireCloudSignInForWrite(actor.organization.id, before.provider_id, c.req.valid("json"))
      const trusted = await trustedProviderCatalog(before)
      const result = await providerTransaction(c, async (tx, provider) => {
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
  app.patch("/v1/inference-providers/:inferenceProviderId/credential-sets/:credentialSetId", route("Update gateway credential set", "Partially updates a credential set and returns status without secrets. Omitted credential fields preserve stored credentials. Changing mode or OAuth client configuration, or disabling the set, invalidates pending sign-ins and revokes affected credentials; renaming alone does not. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", z.object({ credentialSet: setSchema })), orgMemberRoute(), managementWrite, paramValidator(setParams), jsonValidator(setWrite.partial().superRefine(singleCredential)), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const params = c.req.valid("param")
      const before = await getProvider(db, actor, params.inferenceProviderId)
      await requireCloudSignInForWrite(actor.organization.id, before.provider_id, c.req.valid("json"))
      const trusted = await trustedProviderCatalog(before)
      const result = await providerTransaction(c, async (tx, provider) => {
        if (!trusted || trusted.id !== provider.provider_id) throw new GatewayWriteError(400, "provider_requires_configuration")
        const set = await writeGatewaySet(tx, { ...provider, provider_config: { ...provider.provider_config, env: trusted.env } }, c.req.valid("json"), normalizeDenTypeId("gatewayCredentialSet", params.credentialSetId))
        await touch(tx, provider)
        return { provider, ...set }
      })
      await revokeUpstreamCredentials(result.revoked)
      const details = await gatewaySummary(result.provider, actor.currentMember.id, publicBase(c.req.raw), true)
      const credentialSet = details.credentialSets.find((set) => set.id === result.id)
      if (!credentialSet) throw new GatewayWriteError(404, "credential_set_not_found")
      return c.json({ credentialSet })
    } catch (error) { return respond(c, error) }
  })
  app.delete("/v1/inference-providers/:inferenceProviderId/credential-sets/:credentialSetId", route("Delete gateway credential set", "Deletes a credential set, its credentials and pending sign-ins, revokes applicable Google tokens, and returns an empty 204. Referencing grants must be removed first or the operation returns credential_set_in_use. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", undefined, 204), orgMemberRoute(), managementWrite, paramValidator(setParams), async (c) => {
    try {
      const params = c.req.valid("param")
      const credentials = await providerTransaction(c, async (tx, provider) => {
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
      await revokeUpstreamCredentials(credentials)
      return c.body(null, 204)
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/:inferenceProviderId/access-grants", route("List gateway access grants", "Returns all provider grants linking a model group and credential set to an organization, team or member audience. Requires the View Gateway providers permission and enabled Gateway management.", z.object({ accessGrants: z.array(grantSchema) })), orgMemberRoute(), managementRead, paramValidator(paramsSchema), async (c) => {
    try {
      const provider = await getProvider(db, c.get("organizationContext"), c.req.valid("param").inferenceProviderId)
      const rows = await db.select().from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id))
      return c.json({ accessGrants: rows.map(gatewayGrantSummary) })
    } catch (error) { return respond(c, error) }
  })
  app.post("/v1/inference-providers/:inferenceProviderId/access-grants", route("Create gateway access grant", "Links a model group and credential set from this provider to an organization, team or member audience and returns the grant. An identical existing grant returns access_grant_exists. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", z.object({ accessGrant: grantSchema }), 201), orgMemberRoute(), managementWrite, paramValidator(paramsSchema), jsonValidator(grantWrite), async (c) => {
    try {
      const input = c.req.valid("json")
      bindProviderGrantAuditTarget(providerAuditRequests.get(c.req.raw)?.capture ?? null, input)
      const id = await providerTransaction(c, async (tx, provider) => {
        const id = await writeGatewayGrant(tx, provider, input)
        await touch(tx, provider)
        return id
      })
      return c.json({ accessGrant: { id, ...input } }, 201)
    } catch (error) { return respond(c, error) }
  })
  app.patch("/v1/inference-providers/:inferenceProviderId/access-grants/:grantId", route("Update gateway access grant", "Partially updates one grant's model group, credential set or audience, preserving omitted fields. Both resources must belong to this provider and a team or member must belong to this organization. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", z.object({ accessGrant: grantSchema })), orgMemberRoute(), managementWrite, paramValidator(grantParams), jsonValidator(grantWrite.partial()), async (c) => {
    try {
      const input = c.req.valid("json")
      const params = c.req.valid("param")
      const accessGrant = await providerTransaction(c, async (tx, provider) => {
        const id = normalizeDenTypeId("inferenceProviderAccess", params.grantId)
        const [existing] = await tx.select().from(GatewayProviderAccessTable).where(and(eq(GatewayProviderAccessTable.id, id), eq(GatewayProviderAccessTable.gateway_provider_id, provider.id)))
        if (!existing) throw new GatewayWriteError(404, "access_grant_not_found")
        const merged = { ...gatewayGrantSummary(existing), ...input }
        await writeGatewayGrant(tx, provider, merged, id)
        await pruneLiteLlmAssignments(tx, provider)
        if (isLiteLlmProviderId(provider.provider_id)) await pruneLiteLlmIssuedKeys(tx, provider)
        await touch(tx, provider)
        return merged
      })
      return c.json({ accessGrant })
    } catch (error) { return respond(c, error) }
  })
  // The legacy delete URL remains an exact single-grant operation, without creator exceptions.
  for (const path of ["/v1/inference-providers/:inferenceProviderId/access-grants/:grantId", "/v1/inference-providers/:inferenceProviderId/access/:grantId"]) {
    app.delete(path, route("Remove inference provider access grant", "Deletes exactly the selected grant and returns an empty 204; the legacy /access/{grantId} URL has the same behavior. Other grants and member credentials are retained, and OAuth callbacks recheck remaining access. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", undefined, 204), orgMemberRoute(), managementWrite, paramValidator(grantParams), async (c) => {
      try {
        const params = c.req.valid("param")
        await providerTransaction(c, async (tx, provider) => {
          const id = normalizeDenTypeId("inferenceProviderAccess", params.grantId)
          const [grant] = await tx.select().from(GatewayProviderAccessTable).where(and(eq(GatewayProviderAccessTable.id, id), eq(GatewayProviderAccessTable.gateway_provider_id, provider.id)))
          if (!grant) throw new GatewayWriteError(404, "access_grant_not_found")
          // Callback reauthorization rejects lost set access while preserving consent through other grants.
          await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, id))
          await pruneLiteLlmAssignments(tx, provider)
          if (isLiteLlmProviderId(provider.provider_id)) await pruneLiteLlmIssuedKeys(tx, provider)
          await touch(tx, provider)
        })
        return c.body(null, 204)
      } catch (error) { return respond(c, error) }
    })
  }

  app.delete("/v1/inference-providers/:inferenceProviderId", route("Delete inference gateway provider", "Deletes the provider, models, groups, credential sets, grants, credentials and pending sign-ins, and revokes applicable Google tokens. Returns an empty 204; historical request logs and usage rollups are retained. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", undefined, 204), orgMemberRoute(), managementWrite, paramValidator(paramsSchema), async (c) => {
    try {
      const before = await getProvider(db, c.get("organizationContext"), c.req.valid("param").inferenceProviderId)
      // Keys OpenWork created in LiteLLM go first, while the admin key is still stored.
      if (isLiteLlmProviderId(before.provider_id)) await deleteLiteLlmIssuedKeys(before)
      const credentials = await providerTransaction(c, async (tx, provider) => {
        await tx.delete(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.gateway_provider_id, provider.id))
        await tx.delete(GatewayLiteLlmIssuedKeyTable).where(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, provider.id))
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
      await revokeUpstreamCredentials(credentials)
      return c.body(null, 204)
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/:inferenceProviderId/oauth/start", route("Begin sign-in for a member inference credential", "Starts a member's own Google, Microsoft or AWS sign-in (or LiteLLM key connection) for a granted member credential set. Requires a user session. Returns { authUrl } for Accept: application/json, otherwise redirects to the Den web /gateway/connect bridge. The ten-minute entry handle binds the initiating user, organization, provider, set, client configuration and allowlisted redirectTo. It is not authentication and cannot be used at the Google callback. The bridge must establish a matching signed-in browser session before browser-start creates Google state and PKCE.", z.object({ authUrl: z.string() }), 200, false, { security: [{ bearerAuth: [] }], responses: { 302: emptyResponse("Redirect to the Den browser connection page.") } }), userSessionRoute(), orgMemberRoute(), paramValidator(paramsSchema), queryValidator(oauthQuery), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const provider = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      if (provider.status !== "active") throw new GatewayWriteError(404, "inference_provider_not_found")
      const query = c.req.valid("query")
      const set = await selectOAuthSet(provider, actor.currentMember.id, query.credentialSetId)
      const signInMethod = gatewayMemberSignInMethod(provider.provider_id)
      if (isCloudSignInMethod(signInMethod)) await requireCloudSignInFeature(provider.organization_id)
      if (!isLiteLlmProviderId(provider.provider_id)) {
        const configurationError = signInMethod ? memberSignInConfigurationError(signInMethod, set) : "This provider does not support member sign-in."
        if (configurationError) throw new GatewayWriteError(400, "oauth_client_required", `An administrator must finish this credential set's sign-in setup. ${configurationError}`)
      }
      const redirectTo = oauthRedirect(query.redirectTo)
      const verifier = randomBytes(32).toString("base64url")
      const state = `entry.${randomBytes(32).toString("base64url")}`
      const member = await liveMember(db, actor, false)
      const userId = c.get("user")?.id
      if (!userId || member.userId !== userId) throw new GatewayWriteError(403, "forbidden")
      const clientBinding = memberAttemptBinding(provider, set, verifier)
      if (!clientBinding) throw new GatewayWriteError(400, "oauth_client_required")
      const attempt = { verifier, userId, clientBinding }
      await db.transaction(async (tx) => {
        if (!await lockMemberOAuthAuthorization(tx, provider, set, actor.currentMember.id, userId)) throw new GatewayWriteError(403, "forbidden")
        await tx.insert(GatewayProviderOauthStateTable).values({ id: createDenTypeId("inferenceProviderOauthState"), gateway_provider_id: provider.id, credential_set_id: set.id, org_membership_id: actor.currentMember.id, state, code_verifier: JSON.stringify(attempt), redirect_to: redirectTo, expires_at: new Date(Date.now() + 600_000) })
      })
      c.header("Cache-Control", "no-store")
      c.header("Referrer-Policy", "no-referrer")
      const entryUrl = new URL("/gateway/connect", env.webUrl)
      entryUrl.searchParams.set("attempt", state)
      const authUrl = entryUrl.toString()
      if (c.req.header("accept")?.includes("application/json")) return c.json({ authUrl })
      return c.redirect(authUrl, 302)
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/oauth/browser-status", route("Check browser readiness for member sign-in", "Read-only check of a ten-minute entry handle and the live signed OpenWork browser cookie, never a bearer substitute. Returns sign_in_required without a live cookie, account_mismatch for another signed-in user without revealing identities, or ready only after validating the original member, provider, credential set, OAuth client configuration and current grants. Does not consume or rotate the entry, create Google state, exchange tokens or revoke credentials. Browser-start and callback independently repeat authorization checks.", z.object({ status: z.enum(["sign_in_required", "account_mismatch", "ready"]), method: z.enum([...GATEWAY_MEMBER_SIGN_IN_METHODS, "litellm_key", "litellm_issued"]).optional().describe("Present when ready. google and microsoft: continue with browser-start. aws_sso: start AWS device sign-in with browser-aws-start, then poll browser-aws-poll. litellm_key: submit the member's LiteLLM key to browser-litellm-key. litellm_issued: OpenWork creates the key; issue reports why it has not yet, and browser-litellm-check retries."), providerName: z.string().optional(), issue: liteLlmIssueStatusSchema.optional() }), 200, true, { security: [], responses: { 403: jsonResponse("Provider access or OAuth configuration changed.", gatewayErrorSchema) } }), publicRoute, async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    await next()
  }, queryValidator(z.object({ attempt: z.string().regex(/^entry\.[A-Za-z0-9_-]{43}$/) }).strict()), async (c) => {
    try {
      const [entry] = await db.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.state, c.req.valid("query").attempt)).limit(1)
      const attempt = entry ? readGoogleOAuthAttempt(entry.code_verifier) : null
      if (!entry || !attempt || entry.used_at || entry.expires_at.getTime() <= Date.now()) throw new GatewayWriteError(400, "oauth_entry_expired", "This connection attempt expired or was already used. Start Connect again.")
      const cookieToken = await readSignedSessionCookieToken(c)
      const [session] = cookieToken ? await db.select().from(AuthSessionTable).where(and(eq(AuthSessionTable.token, cookieToken), gt(AuthSessionTable.expiresAt, new Date()))).limit(1) : []
      if (!session) return c.json({ status: "sign_in_required" })
      if (attempt.userId !== session.userId) return c.json({ status: "account_mismatch" })
      const [provider] = await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, entry.gateway_provider_id))
      const [set] = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, entry.credential_set_id))
      if (!provider || !set || attempt.clientBinding !== memberAttemptBinding(provider, set, attempt.verifier)) throw new GatewayWriteError(403, "oauth_configuration_changed", "Provider configuration changed. Start Connect again.")
      oauthRedirect(entry.redirect_to ?? undefined)
      const liteLlmMode = isLiteLlmProviderId(provider.provider_id) ? readLiteLlmSettings(provider.settings)?.keySource ?? "personal" : null
      const signInMethod = gatewayMemberSignInMethod(provider.provider_id)
      if (isCloudSignInMethod(signInMethod)) await requireCloudSignInFeature(provider.organization_id)
      const method = liteLlmMode === "issued" ? "litellm_issued" as const : liteLlmMode ? "litellm_key" as const : signInMethod ?? "google"
      // The live signed cookie matches the entry's initiating user: attribute to
      // the provider's organization and the entry's member before any write.
      const auditBlocked = await attributeMemberOAuthEntry(c, { organizationId: provider.organization_id, userId: session.userId, memberId: entry.org_membership_id })
      if (auditBlocked) return auditBlocked
      const status = await db.transaction(async (tx) => {
        if (!await lockMemberOAuthAuthorization(tx, provider, set, entry.org_membership_id, attempt.userId)) throw new GatewayWriteError(403, "forbidden")
        const [liveSession] = await tx.select().from(AuthSessionTable).where(and(eq(AuthSessionTable.id, session.id), eq(AuthSessionTable.token, session.token), eq(AuthSessionTable.userId, session.userId), gt(AuthSessionTable.expiresAt, new Date()))).for("update")
        if (!liveSession) return "sign_in_required"
        const [current] = await tx.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.id, entry.id)).for("update")
        if (!current || current.state !== entry.state || current.used_at || current.expires_at.getTime() <= Date.now() || current.code_verifier !== entry.code_verifier || current.gateway_provider_id !== provider.id || current.credential_set_id !== set.id || current.org_membership_id !== entry.org_membership_id || current.redirect_to !== entry.redirect_to) throw new GatewayWriteError(400, "oauth_entry_expired", "This connection attempt expired or was already used. Start Connect again.")
        return "ready"
      })
      const issue = status === "ready" && method === "litellm_issued" ? await liteLlmMemberIssueStatus(provider.id, entry.org_membership_id) : null
      return c.json(status === "ready" ? { status, method, providerName: provider.name, ...(issue ? { issue } : {}) } : { status })
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/oauth/browser-start", route("Continue member Google or Microsoft sign-in in a signed-in browser", "Consumes a ten-minute entry handle only with a live signed Den cookie for the initiating user. Rechecks the original member, provider, credential set and sign-in configuration, independent of the browser's active organization. Returns { authUrl } for JSON clients or redirects to Google or Microsoft. Bearer authentication alone is not accepted. AWS sign-in uses browser-aws-start instead.", z.object({ authUrl: z.string() }), 200, true, { security: [], responses: { 302: emptyResponse("Continue to Google or Microsoft.") } }), publicRoute, queryValidator(z.object({ attempt: z.string().regex(/^entry\.[A-Za-z0-9_-]{43}$/) }).strict()), async (c) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    try {
      const cookieToken = await readSignedSessionCookieToken(c)
      const [session] = cookieToken ? await db.select().from(AuthSessionTable).where(and(eq(AuthSessionTable.token, cookieToken), gt(AuthSessionTable.expiresAt, new Date()))).limit(1) : []
      if (!session) return c.json({ error: "browser_signin_required", message: "Sign in to OpenWork in this browser, then continue here." }, 401)
      const [entry] = await db.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.state, c.req.valid("query").attempt)).limit(1)
      const attempt = entry ? readGoogleOAuthAttempt(entry.code_verifier) : null
      if (!entry || !attempt || entry.used_at || entry.expires_at.getTime() <= Date.now()) throw new GatewayWriteError(400, "oauth_entry_expired", "This connection attempt expired or was already used. Start Connect again.")
      if (attempt.userId !== session.userId) throw new GatewayWriteError(403, "browser_account_mismatch", "Use the same OpenWork account that started Connect. Sign out in this browser and sign in with that account.")
      const [provider] = await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, entry.gateway_provider_id))
      const [set] = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, entry.credential_set_id))
      if (provider && isLiteLlmProviderId(provider.provider_id)) throw new GatewayWriteError(400, "litellm_key_required", "This provider uses your own LiteLLM key, not Google sign-in.")
      const method = provider ? gatewayMemberSignInMethod(provider.provider_id) : null
      if (method === "aws_sso") throw new GatewayWriteError(400, "aws_device_sign_in_required", "This provider uses AWS sign-in. Start it from the connect page.")
      if (!provider || !set || !method || attempt.clientBinding !== memberSignInBinding(method, set, attempt.verifier)) throw new GatewayWriteError(403, "oauth_configuration_changed", "Provider configuration changed. Start Connect again.")
      if (isCloudSignInMethod(method)) await requireCloudSignInFeature(provider.organization_id)
      oauthRedirect(entry.redirect_to ?? undefined)
      // The live signed cookie matches the entry's initiating user: attribute to
      // the provider's organization and the entry's member before any write.
      const auditBlocked = await attributeMemberOAuthEntry(c, { organizationId: provider.organization_id, userId: session.userId, memberId: entry.org_membership_id })
      if (auditBlocked) return auditBlocked
      const { verifier, challenge } = createPkcePair()
      const state = `${method}.${randomBytes(32).toString("base64url")}`
      const clientBinding = memberSignInBinding(method, set, verifier)
      if (!clientBinding) throw new GatewayWriteError(403, "oauth_configuration_changed", "Provider configuration changed. Start Connect again.")
      const nextAttempt = { verifier, userId: attempt.userId, clientBinding }
      await db.transaction(async (tx) => {
        if (!await lockMemberOAuthAuthorization(tx, provider, set, entry.org_membership_id, attempt.userId)) throw new GatewayWriteError(403, "forbidden")
        const [liveSession] = await tx.select().from(AuthSessionTable).where(and(eq(AuthSessionTable.id, session.id), eq(AuthSessionTable.token, session.token), eq(AuthSessionTable.userId, session.userId), gt(AuthSessionTable.expiresAt, new Date()))).for("update")
        if (!liveSession) throw new GatewayWriteError(403, "browser_signin_required")
        const [current] = await tx.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.id, entry.id)).for("update")
        if (!current || current.state !== entry.state || current.used_at || current.expires_at.getTime() <= Date.now() || current.code_verifier !== entry.code_verifier || current.gateway_provider_id !== provider.id || current.credential_set_id !== set.id || current.org_membership_id !== entry.org_membership_id || current.redirect_to !== entry.redirect_to) throw new GatewayWriteError(400, "oauth_entry_expired")
        await tx.update(GatewayProviderOauthStateTable).set({ state, code_verifier: JSON.stringify(nextAttempt), expires_at: new Date(Date.now() + 600_000) }).where(eq(GatewayProviderOauthStateTable.id, entry.id))
      })
      const redirectUri = `${publicBase(c.req.raw)}/v1/inference-providers/oauth/callback`
      const authUrl = method === "microsoft"
        ? buildMicrosoftAuthorizeUrl({ tenantId: set.oauth_tenant_id ?? "", clientId: set.oauth_client_id ?? "", redirectUri, state, codeChallenge: challenge, nonce: microsoftOAuthNonce(verifier, state) })
        : buildGoogleAuthorizeUrl({ clientId: set.oauth_client_id ?? "", redirectUri, state, codeChallenge: challenge, nonce: googleOAuthNonce(verifier, state) })
      if (c.req.header("accept")?.includes("application/json")) return c.json({ authUrl })
      return c.redirect(authUrl, 302)
    } catch (error) { return respond(c, error) }
  })

  app.get("/v1/inference-providers/oauth/callback", describeRoute({
    tags: ["Authentication"], summary: "Google or Microsoft OAuth callback for a member inference credential",
    description: "Browser callback with no bearer-token or API-key authentication. The handler requires a signed Den session cookie backed by an unexpired live session for the same user who started Connect; OAuth state alone is not browser authentication. Validates single-use, unexpired state, rechecks current membership and active provider/group/set access before and after the PKCE exchange, verifies the ID token, and stores only that member's credential. Returns HTML on success or failure when no validated client redirect applies; otherwise redirects to the validated destination, with an error parameter on failure. Invalid query parameters return a JSON validation error.",
    security: [],
    responses: {
      200: htmlResponse("Connected."),
      302: emptyResponse("Validated client redirect on success or with an error parameter on failure."),
      400: { description: "Sign-in failed (HTML) or invalid callback query (JSON).", content: { ...htmlResponse("Sign-in failed.").content, ...jsonResponse("Invalid callback query.", invalidRequestSchema).content } },
    },
  }), publicRoute, queryValidator(z.object({ code: z.string().trim().min(1).max(4096).optional(), state: z.string().trim().min(1).max(255).optional(), error: z.string().trim().max(255).optional() })), async (c) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    const query = c.req.valid("query")
    const requestId = c.get("requestId")
    const stateMethod: "google" | "microsoft" = query.state?.startsWith("microsoft.") ? "microsoft" : "google"
    const brand = memberSignInBrand(stateMethod)
    const fail = (message: string, redirectTo: string | null = null, code?: string) => {
      if (redirectTo) { const url = new URL(redirectTo); url.searchParams.set("error", message); if (code) url.searchParams.set("errorCode", code); return c.redirect(url.toString(), 302) }
      return c.html(connectCallbackPage({ ok: false, name: brand, message, referenceId: requestId }), 400)
    }
    // State is transferable, not browser authentication. Desktop may start with a
    // bearer session, but the browser must independently sign in as the same user.
    // Read the live session row so a revoked/expired cookie cannot use cached auth.
    const cookieToken = await readSignedSessionCookieToken(c)
    const [browserSession] = cookieToken ? await db.select({ id: AuthSessionTable.id, token: AuthSessionTable.token, userId: AuthSessionTable.userId }).from(AuthSessionTable)
      .where(and(eq(AuthSessionTable.token, cookieToken), gt(AuthSessionTable.expiresAt, new Date()))).limit(1) : []
    const signInMessage = "Sign in to Den in this browser with the same OpenWork account that started Connect, then start Connect again."
    if (!browserSession) return fail(signInMessage)
    if (!query.state) return fail("Missing state.")
    if (!/^(?:google|microsoft)\.[A-Za-z0-9_-]{43}$/.test(query.state)) return fail("This sign-in link has expired or was already used. Start Connect again.")
    const [state] = await db.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.state, query.state)).limit(1)
    if (!state) return fail("This sign-in link has expired or was already used. Start Connect again.")
    const [initiator] = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(eq(MemberTable.id, state.org_membership_id)).limit(1)
    const attempt = readGoogleOAuthAttempt(state.code_verifier)
    if (!attempt || !initiator?.userId || initiator.userId !== attempt.userId || attempt.userId !== browserSession.userId) return fail(signInMessage)
    if (state.used_at || state.expires_at.getTime() <= Date.now()) return fail("This sign-in link has expired or was already used. Start Connect again.")
    const [provider] = await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, state.gateway_provider_id))
    const [set] = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, state.credential_set_id))
    if (!provider || !set || gatewayMemberSignInMethod(provider.provider_id) !== stateMethod || attempt.clientBinding !== memberSignInBinding(stateMethod, set, attempt.verifier)) return fail("This credential set is no longer available.")
    const clientId = set.oauth_client_id ?? ""
    const clientSecret = set.oauth_client_secret ?? ""
    let redirectTo: string | null = null
    try { redirectTo = oauthRedirect(state.redirect_to ?? undefined) } catch { return fail("The sign-in redirect is no longer allowed.") }
    const auditBlocked = await attributeMemberOAuthEntry(c, { organizationId: provider.organization_id, userId: attempt.userId, memberId: state.org_membership_id })
    if (auditBlocked) return auditBlocked
    const claimed = await db.transaction(async (tx) => {
      if (!await lockMemberOAuthAuthorization(tx, provider, set, state.org_membership_id, attempt.userId)) return false
      const [liveSession] = await tx.select().from(AuthSessionTable).where(and(eq(AuthSessionTable.id, browserSession.id), eq(AuthSessionTable.token, browserSession.token), eq(AuthSessionTable.userId, browserSession.userId), gt(AuthSessionTable.expiresAt, new Date()))).for("update")
      if (!liveSession) return false
      const [current] = await tx.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.id, state.id)).for("update")
      if (!current || current.used_at || current.expires_at.getTime() <= Date.now() || current.credential_set_id !== set.id || current.state !== state.state || current.code_verifier !== state.code_verifier || current.org_membership_id !== state.org_membership_id || current.gateway_provider_id !== provider.id || current.redirect_to !== state.redirect_to) return false
      return affectedRows(await tx.update(GatewayProviderOauthStateTable).set({ used_at: new Date() }).where(and(eq(GatewayProviderOauthStateTable.id, state.id), isNull(GatewayProviderOauthStateTable.used_at)))) === 1
    })
    if (!claimed) return fail("Provider access changed or the sign-in link was already used. Start Connect again.")
    if (query.error || !query.code) return fail(query.error === "access_denied" ? `${brand} access was denied.` : `${brand} did not return an authorization code.`, redirectTo)
    // Google refresh tokens can be revoked; Entra ID has no per-token revocation for confidential clients.
    const cleanupWarning = stateMethod === "google" ? " Cleanup revocation may affect existing Google connections using the same OAuth client, including your previous connection. You may need to reconnect those connections." : ""
    let issuedToken: string | null = null
    const redirectUri = `${publicBase(c.req.raw)}/v1/inference-providers/oauth/callback`
    try {
      const exchangeStartedAt = Date.now()
      let values: { kind: "oauth_google" | "oauth_azure"; secret: string; expires_at: Date; scopes: string | null }
      if (stateMethod === "microsoft") {
        const tenantId = set.oauth_tenant_id ?? ""
        const tokens = await exchangeMicrosoftAuthorizationCode({ tenantId, clientId, clientSecret, code: query.code, codeVerifier: attempt.verifier, redirectUri })
        const identity = await verifyMicrosoftIdentity({ idToken: tokens.idToken, tenantId, clientId, nonce: microsoftOAuthNonce(attempt.verifier, state.state) })
        values = { kind: "oauth_azure", expires_at: new Date(exchangeStartedAt + tokens.expiresIn * 1000), scopes: tokens.scope,
          secret: JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, tokenType: "Bearer", microsoftIdentity: { ...identity, authorizationRevision: randomBytes(32).toString("base64url") } }) }
      } else {
        const tokens = await exchangeGoogleAuthorizationCode({ clientId, clientSecret, code: query.code, codeVerifier: attempt.verifier, redirectUri })
        issuedToken = tokens.refresh_token
        const googleIdentity = await verifyGoogleIdentity({ idToken: tokens.id_token, clientId, nonce: googleOAuthNonce(attempt.verifier, state.state) })
        values = { kind: "oauth_google", expires_at: new Date(exchangeStartedAt + tokens.expires_in * 1000), scopes: tokens.scope,
          secret: JSON.stringify({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, tokenType: tokens.token_type, googleIdentity: { ...googleIdentity, authorizationRevision: randomBytes(32).toString("base64url") } }) }
      }
      const stored = await storeMemberCredential({ provider, set, state, browserSession, userId: attempt.userId, values })
      if (!stored) {
        if (issuedToken) await revokeGoogleToken({ token: issuedToken })
        issuedToken = null
        return fail(`Provider access changed during sign-in. Start Connect again.${cleanupWarning}`, redirectTo)
      }
      issuedToken = null
    } catch (error) {
      if (issuedToken) await revokeGoogleToken({ token: issuedToken })
      console.error("gateway_oauth_callback_failed", { requestId, providerId: provider.id, credentialSetId: set.id, method: stateMethod, code: error instanceof OAuthTokenExchangeError ? error.code : "oauth_callback_failed" })
      const message = error instanceof OAuthTokenExchangeError ? error.message : `OpenWork could not finish ${brand} sign-in. Try Connect again.`
      return fail(issuedToken ? `${message}${cleanupWarning}` : message, redirectTo, error instanceof OAuthTokenExchangeError ? error.code : "oauth_callback_failed")
    }
    return redirectTo ? c.redirect(redirectTo, 302) : c.html(connectCallbackPage({ ok: true, name: set.name }))
  })

  app.post("/v1/inference-providers/oauth/browser-aws-start", route("Start member AWS sign-in from a signed-in browser", "For Amazon Bedrock member credential sets. Consumes the ten-minute entry handle from oauth/start, with the signed-in browser session of the same user, and starts an IAM Identity Center device sign-in against the set's own Identity Center instance. Returns AWS's approval page and code to show the person, and a new attempt handle for browser-aws-poll. Bearer authentication alone is not accepted.", z.object({ attempt: z.string(), verificationUri: z.string(), verificationUriComplete: z.string(), userCode: z.string(), interval: z.number().int(), expiresIn: z.number().int() }), 200, true, { security: [] }), publicRoute, async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    await next()
  }, jsonValidator(z.object({ attempt: z.string().regex(/^entry\.[A-Za-z0-9_-]{43}$/) }).strict()), async (c) => {
    try {
      const loaded = await loadBrowserSignInAttempt(c, c.req.valid("json").attempt, "aws_sso")
      if ("response" in loaded) return loaded.response
      const { entry, attempt, provider, set, session } = loaded
      const sso = readAwsSsoSettings(set.aws_sso)
      if (!sso) throw new GatewayWriteError(403, "oauth_configuration_changed", "Provider configuration changed. Start Connect again.")
      const started = await startAwsSsoSignIn({ sso }).catch((error: unknown) => { throw awsSsoWriteError(error) })
      const state = `aws_sso.${randomBytes(32).toString("base64url")}`
      const nextAttempt = { verifier: attempt.verifier, userId: attempt.userId, clientBinding: attempt.clientBinding, aws: started.aws }
      await db.transaction(async (tx) => {
        if (!await lockMemberOAuthAuthorization(tx, provider, set, entry.org_membership_id, attempt.userId)) throw new GatewayWriteError(403, "forbidden")
        const [liveSession] = await tx.select().from(AuthSessionTable).where(and(eq(AuthSessionTable.id, session.id), eq(AuthSessionTable.token, session.token), eq(AuthSessionTable.userId, session.userId), gt(AuthSessionTable.expiresAt, new Date()))).for("update")
        if (!liveSession) throw new GatewayWriteError(403, "browser_signin_required")
        const [current] = await tx.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.id, entry.id)).for("update")
        if (!current || current.state !== entry.state || current.used_at || current.expires_at.getTime() <= Date.now() || current.code_verifier !== entry.code_verifier || current.gateway_provider_id !== provider.id || current.credential_set_id !== set.id || current.org_membership_id !== entry.org_membership_id) throw new GatewayWriteError(400, "oauth_entry_expired", "This connection attempt expired or was already used. Start Connect again.")
        await tx.update(GatewayProviderOauthStateTable).set({ state, code_verifier: JSON.stringify(nextAttempt), expires_at: new Date(Date.now() + Math.min(600, started.device.expiresIn) * 1000) }).where(eq(GatewayProviderOauthStateTable.id, entry.id))
      })
      return c.json({ attempt: state, verificationUri: started.device.verificationUri, verificationUriComplete: started.device.verificationUriComplete, userCode: started.device.userCode, interval: started.device.interval, expiresIn: Math.min(600, started.device.expiresIn) })
    } catch (error) { return respond(c, error) }
  })

  app.post("/v1/inference-providers/oauth/browser-aws-poll", route("Check a member AWS sign-in from a signed-in browser", "Polls the IAM Identity Center device sign-in started by browser-aws-start, at most once per AWS polling interval. pending: the person has not approved yet; retry after retryAfter seconds. connected: OpenWork checked that the sign-in gets credentials for the set's AWS account and permission set, and stored them as the member's own credential; the handle is consumed. Bearer authentication alone is not accepted.", z.object({ status: z.enum(["pending", "connected"]), retryAfter: z.number().int().optional(), accountName: z.string().nullable().optional() }), 200, true, { security: [] }), publicRoute, async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    await next()
  }, jsonValidator(z.object({ attempt: z.string().regex(/^aws_sso\.[A-Za-z0-9_-]{43}$/) }).strict()), async (c) => {
    try {
      const loaded = await loadBrowserSignInAttempt(c, c.req.valid("json").attempt, "aws_sso")
      if ("response" in loaded) return loaded.response
      const { entry, provider, set, session } = loaded
      const pending = readAwsSsoAttempt(entry.code_verifier)
      const sso = readAwsSsoSettings(set.aws_sso)
      if (!pending || !sso) throw new GatewayWriteError(400, "oauth_entry_expired", "This connection attempt expired or was already used. Start Connect again.")
      const now = Date.now()
      if (pending.aws.nextPollAt > now) return c.json({ status: "pending" as const, retryAfter: Math.max(1, Math.ceil((pending.aws.nextPollAt - now) / 1000)) })
      // Claim this poll slot first so two tabs never spend the same device code.
      const claimed = { ...pending, aws: { ...pending.aws, nextPollAt: now + pending.aws.interval * 1000 } }
      const claimedVerifier = JSON.stringify(claimed)
      const won = affectedRows(await db.update(GatewayProviderOauthStateTable).set({ code_verifier: claimedVerifier })
        .where(and(eq(GatewayProviderOauthStateTable.id, entry.id), eq(GatewayProviderOauthStateTable.state, entry.state), isNull(GatewayProviderOauthStateTable.used_at)))) === 1
      if (!won) return c.json({ status: "pending" as const, retryAfter: pending.aws.interval })
      const result = await pollAwsSsoSignIn({ sso, aws: pending.aws }).catch(async (error: unknown) => {
        // A final answer from AWS ends this attempt; a transient one keeps it.
        if (error instanceof AwsSsoError && !error.transient) await db.update(GatewayProviderOauthStateTable).set({ used_at: new Date() }).where(eq(GatewayProviderOauthStateTable.id, entry.id))
        throw awsSsoWriteError(error)
      })
      if (result.kind === "pending") {
        if (!result.slowDown) return c.json({ status: "pending" as const, retryAfter: pending.aws.interval })
        const interval = Math.min(60, pending.aws.interval + 5)
        await db.update(GatewayProviderOauthStateTable).set({ code_verifier: JSON.stringify({ ...claimed, aws: { ...claimed.aws, interval, nextPollAt: Date.now() + interval * 1000 } }) })
          .where(and(eq(GatewayProviderOauthStateTable.id, entry.id), isNull(GatewayProviderOauthStateTable.used_at)))
        return c.json({ status: "pending" as const, retryAfter: interval })
      }
      const stored = await storeMemberCredential({ provider, set, state: { ...entry, code_verifier: claimedVerifier }, browserSession: session, userId: pending.userId, claim: true,
        values: { kind: "aws_sso", secret: JSON.stringify(result.secret), expires_at: result.expiresAt, scopes: "sso:account:access" } })
      if (!stored) {
        await logoutAwsSso({ region: sso.region, accessToken: result.secret.accessToken, fetchImpl: awsSsoFetch() })
        throw new GatewayWriteError(403, "forbidden", "Provider access changed during sign-in. Start Connect again.")
      }
      return c.json({ status: "connected" as const, accountName: result.secret.identity.userName })
    } catch (error) { return respond(c, error) }
  })

  app.delete("/v1/inference-providers/:inferenceProviderId/oauth", route("Disconnect the caller's member sign-in for an inference provider", "Immediately revokes and erases the caller's local credential and cancels pending sign-ins, even after inference grant loss or provider disablement. Requires current organization membership, not inference access. Specify credentialSetId when multiple sets exist. Google revocation is best effort with sanitized outcome telemetry and no retained retry tokens; revoking a Google grant can affect other connections using that grant. Returns an empty 204.", undefined, 204), orgMemberRoute(), paramValidator(paramsSchema), queryValidator(z.object({ credentialSetId: denTypeIdSchema("gatewayCredentialSet").optional() }).strict()), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const provider = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      if (isLiteLlmProviderId(provider.provider_id) && readLiteLlmSettings(provider.settings)?.keySource === "issued") throw new GatewayWriteError(409, "litellm_keys_managed", "OpenWork manages these LiteLLM keys. Ask your admin to remove your access instead.")
      const selected = c.req.valid("query").credentialSetId
      const sets = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.gateway_provider_id, provider.id))
      const candidates = selected ? sets.filter((set) => set.id === selected) : sets.filter((set) => set.credential_mode === "member")
      if (!candidates.length) throw new GatewayWriteError(404, "credential_set_not_found")
      if (candidates.length !== 1) throw new GatewayWriteError(409, "credential_set_required")
      const set = candidates[0]
      const credentials = await db.transaction(async (tx) => {
        const member = await liveMember(tx, actor, true)
        if (member.userId !== c.get("user")?.id) throw new GatewayWriteError(403, "forbidden")
        await getProvider(tx, actor, provider.id, true)
        const [currentSet] = await tx.select().from(GatewayCredentialSetTable).where(and(eq(GatewayCredentialSetTable.id, set.id), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id))).for("update")
        if (!currentSet) throw new GatewayWriteError(404, "credential_set_not_found")
        await tx.delete(GatewayProviderOauthStateTable).where(and(eq(GatewayProviderOauthStateTable.credential_set_id, set.id), eq(GatewayProviderOauthStateTable.org_membership_id, actor.currentMember.id)))
        const where = and(eq(GatewayProviderCredentialTable.credential_set_id, set.id), eq(GatewayProviderCredentialTable.gateway_provider_id, provider.id), eq(GatewayProviderCredentialTable.organization_id, actor.organization.id), eq(GatewayProviderCredentialTable.subject, actor.currentMember.id), eq(GatewayProviderCredentialTable.org_membership_id, actor.currentMember.id))
        const rows = await tx.select().from(GatewayProviderCredentialTable).where(where).for("update")
        await tx.update(GatewayProviderCredentialTable).set({ status: "revoked", secret: "{}", expires_at: null, scopes: null, refreshing_until: null, last_error: null, updated_at: new Date() }).where(where)
        if (isLiteLlmProviderId(provider.provider_id)) await disconnectLiteLlmMember(tx, provider, actor.currentMember.id)
        return rows.filter((row) => row.status !== "revoked")
      })
      await revokeUpstreamCredentials(credentials)
      return c.body(null, 204)
    } catch (error) { return respond(c, error) }
  })

  app.post("/v1/inference-providers/litellm", route("Create LiteLLM gateway provider", "Connects the organization's own LiteLLM proxy and syncs its models. mode=org stores one organization LiteLLM key used for everyone, creates an \"All LiteLLM models\" group granted to the given audiences, and keeps OpenWork spend tracking and limits on. mode=member stores a LiteLLM admin key used only to sync models and teams; each person then connects their own LiteLLM key, which picks the shared group matching that key's models. The given audiences are granted the empty \"Can connect a LiteLLM key\" group, and OpenWork spend tracking is off because LiteLLM budgets those keys. Keys are write-only. Requires the Manage Gateway providers permission and Gateway management; session callers must recently reauthenticate.", z.object({ inferenceProvider: detailsSchema, sync: liteLlmSyncResultSchema }), 201, true), orgMemberRoute(), requireFeature("litellm"), managementWrite, jsonValidator(liteLlmCreateSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const input = c.req.valid("json")
      const endpoints = await liteLlmCall(async () => normalizeLiteLlmBaseUrl(input.baseUrl))
      const urlError = upstreamBaseUrlSettingError({ upstreamBaseUrl: endpoints.inferenceBaseUrl })
      if (urlError) throw new GatewayWriteError(400, "invalid_settings", urlError)
      if (input.mode !== "issued" && (input.issueStrategy !== undefined || input.mirrorFallback !== undefined)) throw new GatewayWriteError(400, "invalid_request", "issueStrategy and mirrorFallback apply to issued mode only.")
      const credentialMode = input.mode === "org" ? "org" as const : "member" as const
      const client = createLiteLlmClient(endpoints)
      const plan = await liteLlmCall(() => planLiteLlmCatalog(client, credentialMode, input.apiKey))
      const now = new Date()
      const issue = { keySource: input.mode === "issued" ? "issued" as const : "personal" as const, issueStrategy: input.issueStrategy ?? "per_team", mirrorFallback: input.mirrorFallback ?? "per_team" }
      const provider: GatewayProvider = { id: createDenTypeId("inferenceProvider"), organization_id: actor.organization.id, created_by_org_membership_id: actor.currentMember.id, provider_id: LITELLM_PROVIDER_ID, name: input.name, model_ids: [], pinned_model_ids: [], provider_config: buildProviderConfigSnapshot(liteLlmCatalogProvider({ settings: {} })), settings: { upstreamBaseUrl: endpoints.inferenceBaseUrl, litellm: emptySettings(credentialMode, "pending", issue) }, credential_mode: credentialMode, oauth_client_id: null, oauth_client_secret: null, status: "active", created_at: now, updated_at: now }
      const sync = await db.transaction(async (tx) => {
        const member = await liveMember(tx, actor, true)
        await requireLiveManage(tx, actor)
        const created = await createLiteLlmProvider(tx, provider, { name: input.name, mode: credentialMode, endpoints, apiKey: input.apiKey, audiences: liteLlmAudiences(input), creatorId: member.id }, plan)
        return created.result
      })
      // Everyone allowed gets keys straight away; nobody has to connect anything.
      const issued = issue.keySource === "issued" ? await liteLlmCall(() => reconcileLiteLlmIssuedKeys(provider, client)) : undefined
      return c.json({ inferenceProvider: await gatewaySummary(provider, actor.currentMember.id, publicBase(c.req.raw), true), sync: { ...sync, ...(issued ? { issued } : {}) } }, 201)
    } catch (error) { return respond(c, error) }
  })

  app.post("/v1/inference-providers/:inferenceProviderId/litellm/sync", route("Sync LiteLLM models and groups", "Reads the LiteLLM proxy with the stored organization key (org mode) or admin key (member mode) and refreshes the provider's models. Org mode refreshes the \"All LiteLLM models\" group. Member mode refreshes team groups, re-checks every connected member key, moves members to the group matching their key's models, revokes keys LiteLLM rejects, and removes automatic grants of people who may no longer connect. A failed read keeps the last synced catalog and records the error. Requires the Manage Gateway providers permission and Gateway management.", z.object({ inferenceProvider: detailsSchema, sync: liteLlmSyncResultSchema }), 200, false, { "x-mcp-search-aliases": ["sync litellm models", "refresh litellm model groups"] }), orgMemberRoute(), requireFeature("litellm"), managementWrite, paramValidator(paramsSchema), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const before = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      if (!isLiteLlmProviderId(before.provider_id)) throw new GatewayWriteError(409, "litellm_not_configured", "Only LiteLLM providers can be synced.")
      const plan = await planLiteLlmSync(before).catch(async (error: unknown) => {
        if (error instanceof LiteLlmError) {
          await recordLiteLlmSyncError(before.id, error.message)
          throw liteLlmErrorResponse(error)
        }
        throw error
      })
      const result = await providerTransaction(c, async (tx, provider) => ({ provider, sync: await applyLiteLlmSync(tx, provider, plan) }))
      const issued = readLiteLlmSettings(result.provider.settings)?.keySource === "issued" ? await liteLlmCall(() => reconcileLiteLlmIssuedKeys(result.provider)) : undefined
      return c.json({ inferenceProvider: await gatewaySummary(result.provider, actor.currentMember.id, publicBase(c.req.raw), true), sync: { ...result.sync, ...(issued ? { issued } : {}) } })
    } catch (error) { return respond(c, error) }
  })

  app.patch("/v1/inference-providers/:inferenceProviderId/litellm", route("Update LiteLLM key or key creation", "Verifies and stores a new organization LiteLLM key (org mode) or LiteLLM admin key (member and issued modes), and in issued mode changes how keys are created, then syncs. Changing issueStrategy replaces existing created keys at that sync. The proxy URL and mode are fixed; create a new provider to change them. Keys are write-only. Requires the Manage Gateway providers permission and Gateway management; session callers must recently reauthenticate.", z.object({ inferenceProvider: detailsSchema, sync: liteLlmSyncResultSchema }), 200, true), orgMemberRoute(), requireFeature("litellm"), managementWrite, paramValidator(paramsSchema), jsonValidator(z.object({ apiKey: liteLlmKeySchema.optional(), issueStrategy: liteLlmIssueStrategySchema.optional(), mirrorFallback: liteLlmMirrorFallbackSchema.optional() }).strict().refine((input) => Object.keys(input).length > 0, "Provide apiKey, issueStrategy or mirrorFallback.")), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const input = c.req.valid("json")
      const before = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      const settings = isLiteLlmProviderId(before.provider_id) ? readLiteLlmSettings(before.settings) : null
      if (!settings) throw new GatewayWriteError(409, "litellm_not_configured", "Only LiteLLM providers have a LiteLLM key.")
      const issuedMode = settings.mode === "member" && settings.keySource === "issued"
      if (!issuedMode && (input.issueStrategy !== undefined || input.mirrorFallback !== undefined)) throw new GatewayWriteError(409, "litellm_not_issued", "Only providers where OpenWork creates keys have key creation settings.")
      const client = createLiteLlmClient(liteLlmEndpoints(before))
      const apiKey = input.apiKey
      if (apiKey !== undefined) await liteLlmCall(() => planLiteLlmCatalog(client, settings.mode, apiKey))
      await providerTransaction(c, async (tx, provider) => {
        if (apiKey !== undefined) await replaceLiteLlmSyncKey(tx, provider, apiKey)
        if (input.issueStrategy !== undefined || input.mirrorFallback !== undefined) await updateLiteLlmIssueSettings(tx, provider, { issueStrategy: input.issueStrategy, mirrorFallback: input.mirrorFallback })
      })
      const refreshed = await getProvider(db, actor, before.id)
      const plan = await liteLlmCall(() => planLiteLlmSync(refreshed, client))
      const result = await providerTransaction(c, async (tx, provider) => ({ provider, sync: await applyLiteLlmSync(tx, provider, plan) }))
      const issued = issuedMode ? await liteLlmCall(() => reconcileLiteLlmIssuedKeys(result.provider, client)) : undefined
      return c.json({ inferenceProvider: await gatewaySummary(result.provider, actor.currentMember.id, publicBase(c.req.raw), true), sync: { ...result.sync, ...(issued ? { issued } : {}) } })
    } catch (error) { return respond(c, error) }
  })

  app.put("/v1/inference-providers/:inferenceProviderId/litellm/member-key", route("Connect the caller's LiteLLM key", "Stores the caller's own LiteLLM key for a per-user LiteLLM provider after checking it with the LiteLLM proxy, and grants the shared model group whose models match what that key can reach. Requires a user session and an admin grant that lets the caller connect a key. Replacing the key re-matches the group. The key is write-only. Disconnect with DELETE /v1/inference-providers/{inferenceProviderId}/oauth.", liteLlmConnectResultSchema, 200, true), userSessionRoute(), orgMemberRoute(), requireFeature("litellm"), paramValidator(paramsSchema), jsonValidator(z.object({ apiKey: liteLlmKeySchema, credentialSetId: denTypeIdSchema("gatewayCredentialSet").optional() }).strict()), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const input = c.req.valid("json")
      const userId = c.get("user")?.id
      if (!userId) throw new GatewayWriteError(403, "forbidden")
      const provider = await getProvider(db, actor, c.req.valid("param").inferenceProviderId)
      if (provider.status !== "active" || !isLiteLlmProviderId(provider.provider_id)) throw new GatewayWriteError(404, "inference_provider_not_found")
      const set = await liteLlmMemberSet(db, provider, input.credentialSetId)
      const adminKey = await liteLlmAdminKey(provider)
      const verified = await liteLlmCall(() => verifyLiteLlmKey(createLiteLlmClient(liteLlmEndpoints(provider)), input.apiKey, adminKey))
      const assignment = await db.transaction(async (tx) => {
        if (!await lockMemberOAuthAuthorization(tx, provider, set, actor.currentMember.id, userId)) throw new GatewayWriteError(403, "forbidden", "Your admin has not given you access to connect a LiteLLM key.")
        return connectLiteLlmMemberKey(tx, provider, actor.currentMember.id, input.apiKey, verified)
      })
      if (assignment.kind !== "assigned") throw new GatewayWriteError(409, "litellm_no_shared_models")
      c.header("Cache-Control", "no-store")
      return c.json({ connected: true as const, modelGroupId: assignment.modelGroupId, modelGroupName: assignment.modelGroupName, modelIds: assignment.modelIds })
    } catch (error) { return respond(c, error) }
  })

  app.post("/v1/inference-providers/oauth/browser-litellm-key", route("Connect a LiteLLM key from a signed-in browser", "Completes a LiteLLM Connect started in the desktop app: the ten-minute entry handle from oauth/start plus the signed-in browser session of the same user. Checks the key with the LiteLLM proxy, stores it as the member's own credential and grants the matching shared model group. A rejected key keeps the handle usable so the person can retry; success consumes it. Bearer authentication alone is not accepted.", liteLlmConnectResultSchema, 200, true, { security: [] }), publicRoute, async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    await next()
  }, jsonValidator(z.object({ attempt: z.string().regex(/^entry\.[A-Za-z0-9_-]{43}$/), apiKey: liteLlmKeySchema }).strict()), async (c) => {
    try {
      const input = c.req.valid("json")
      const cookieToken = await readSignedSessionCookieToken(c)
      const [session] = cookieToken ? await db.select().from(AuthSessionTable).where(and(eq(AuthSessionTable.token, cookieToken), gt(AuthSessionTable.expiresAt, new Date()))).limit(1) : []
      if (!session) return c.json({ error: "browser_signin_required", message: "Sign in to OpenWork in this browser, then continue here." }, 401)
      const [entry] = await db.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.state, input.attempt)).limit(1)
      const attempt = entry ? readGoogleOAuthAttempt(entry.code_verifier) : null
      if (!entry || !attempt || entry.used_at || entry.expires_at.getTime() <= Date.now()) throw new GatewayWriteError(400, "oauth_entry_expired", "This connection attempt expired or was already used. Start Connect again.")
      if (attempt.userId !== session.userId) throw new GatewayWriteError(403, "browser_account_mismatch", "Use the same OpenWork account that started Connect. Sign out in this browser and sign in with that account.")
      const [provider] = await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, entry.gateway_provider_id))
      const [set] = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, entry.credential_set_id))
      if (provider && isLiteLlmProviderId(provider.provider_id)) await requireLiteLlmFeature(provider.organization_id)
      if (!provider || !set || !isLiteLlmProviderId(provider.provider_id) || attempt.clientBinding !== memberAttemptBinding(provider, set, attempt.verifier)) throw new GatewayWriteError(403, "oauth_configuration_changed", "Provider configuration changed. Start Connect again.")
      // The live signed cookie matches the entry's initiating user: attribute to
      // the provider's organization and the entry's member before any write.
      const auditBlocked = await attributeMemberOAuthEntry(c, { organizationId: provider.organization_id, userId: session.userId, memberId: entry.org_membership_id })
      if (auditBlocked) return auditBlocked
      const adminKey = await liteLlmAdminKey(provider)
      const verified = await liteLlmCall(() => verifyLiteLlmKey(createLiteLlmClient(liteLlmEndpoints(provider)), input.apiKey, adminKey))
      const assignment = await db.transaction(async (tx) => {
        if (!await lockMemberOAuthAuthorization(tx, provider, set, entry.org_membership_id, attempt.userId)) throw new GatewayWriteError(403, "forbidden", "Your admin has not given you access to connect a LiteLLM key.")
        const [liveSession] = await tx.select().from(AuthSessionTable).where(and(eq(AuthSessionTable.id, session.id), eq(AuthSessionTable.token, session.token), eq(AuthSessionTable.userId, session.userId), gt(AuthSessionTable.expiresAt, new Date()))).for("update")
        if (!liveSession) throw new GatewayWriteError(403, "browser_signin_required")
        const [current] = await tx.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.id, entry.id)).for("update")
        if (!current || current.state !== entry.state || current.used_at || current.expires_at.getTime() <= Date.now() || current.code_verifier !== entry.code_verifier || current.gateway_provider_id !== provider.id || current.credential_set_id !== set.id || current.org_membership_id !== entry.org_membership_id) throw new GatewayWriteError(400, "oauth_entry_expired", "This connection attempt expired or was already used. Start Connect again.")
        const result = await connectLiteLlmMemberKey(tx, provider, entry.org_membership_id, input.apiKey, verified)
        await tx.update(GatewayProviderOauthStateTable).set({ used_at: new Date() }).where(and(eq(GatewayProviderOauthStateTable.id, entry.id), isNull(GatewayProviderOauthStateTable.used_at)))
        return result
      })
      if (assignment.kind !== "assigned") throw new GatewayWriteError(409, "litellm_no_shared_models")
      return c.json({ connected: true as const, modelGroupId: assignment.modelGroupId, modelGroupName: assignment.modelGroupName, modelIds: assignment.modelIds })
    } catch (error) { return respond(c, error) }
  })

  app.post("/v1/inference-providers/oauth/browser-litellm-check", route("Retry creating the caller's LiteLLM keys from a signed-in browser", "For LiteLLM providers where OpenWork creates each person's key. Uses the ten-minute entry handle from oauth/start plus the signed-in browser session of the same user to look the person up in LiteLLM by email again and create their keys. Returns the outcome; success consumes the handle. Bearer authentication alone is not accepted.", liteLlmIssueStatusSchema, 200, true, { security: [] }), publicRoute, async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    await next()
  }, jsonValidator(z.object({ attempt: z.string().regex(/^entry\.[A-Za-z0-9_-]{43}$/) }).strict()), async (c) => {
    try {
      const input = c.req.valid("json")
      const cookieToken = await readSignedSessionCookieToken(c)
      const [session] = cookieToken ? await db.select().from(AuthSessionTable).where(and(eq(AuthSessionTable.token, cookieToken), gt(AuthSessionTable.expiresAt, new Date()))).limit(1) : []
      if (!session) return c.json({ error: "browser_signin_required", message: "Sign in to OpenWork in this browser, then continue here." }, 401)
      const [entry] = await db.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.state, input.attempt)).limit(1)
      const attempt = entry ? readGoogleOAuthAttempt(entry.code_verifier) : null
      if (!entry || !attempt || entry.used_at || entry.expires_at.getTime() <= Date.now()) throw new GatewayWriteError(400, "oauth_entry_expired", "This connection attempt expired or was already used. Start Connect again.")
      if (attempt.userId !== session.userId) throw new GatewayWriteError(403, "browser_account_mismatch", "Use the same OpenWork account that started Connect. Sign out in this browser and sign in with that account.")
      const [provider] = await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, entry.gateway_provider_id))
      const [set] = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, entry.credential_set_id))
      if (!provider || !set || provider.status !== "active" || !isLiteLlmProviderId(provider.provider_id) || attempt.clientBinding !== memberAttemptBinding(provider, set, attempt.verifier)) throw new GatewayWriteError(403, "oauth_configuration_changed", "Provider configuration changed. Start Connect again.")
      await requireLiteLlmFeature(provider.organization_id)
      // The live signed cookie matches the entry's initiating user: attribute to
      // the provider's organization and the entry's member before any write.
      const auditBlocked = await attributeMemberOAuthEntry(c, { organizationId: provider.organization_id, userId: session.userId, memberId: entry.org_membership_id })
      if (auditBlocked) return auditBlocked
      await liteLlmCall(() => provisionLiteLlmMember(provider, entry.org_membership_id, { force: true }))
      const status = await liteLlmMemberIssueStatus(provider.id, entry.org_membership_id)
      if (status.keyCount > 0) await db.update(GatewayProviderOauthStateTable).set({ used_at: new Date() }).where(and(eq(GatewayProviderOauthStateTable.id, entry.id), isNull(GatewayProviderOauthStateTable.used_at)))
      return c.json(status)
    } catch (error) { return respond(c, error) }
  })

  app.post("/v1/inference-providers/migrate-from-llm-provider", route("Move an LLM provider to the inference gateway", "Atomically converts a supported shared models.dev LLM provider into a Gateway provider with its models, shared credential and audiences, then deletes the source. Returns Gateway management details; validation failure preserves the source. Per-member credentials and providers needing explicit Azure/Vertex configuration are rejected. Requires the Manage Gateway providers permission and enabled Gateway management; session callers must recently reauthenticate.", detailsResponse, 201), orgMemberRoute(), managementWrite, jsonValidator(z.object({ llmProviderId: denTypeIdSchema("llmProvider") }).strict()), async (c) => {
    try {
      const actor = c.get("organizationContext")
      const sourceId = normalizeDenTypeId("llmProvider", c.req.valid("json").llmProviderId)
      const [before] = await db.select({ providerId: LlmProviderTable.providerId }).from(LlmProviderTable)
        .where(and(eq(LlmProviderTable.id, sourceId), eq(LlmProviderTable.organizationId, actor.organization.id)))
      if (!before) throw new GatewayWriteError(409, "migration_source_unavailable")
      const trusted = await getModelsDevProvider(before.providerId)
      const provider = await db.transaction(async (tx) => {
        const member = await liveMember(tx, actor, true)
        await requireLiveManage(tx, actor)
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
        if (["@ai-sdk/azure", "@ai-sdk/google-vertex", "@ai-sdk/google-vertex/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/amazon-bedrock/mantle"].includes(npm)) throw invalid("Azure/Vertex/Bedrock needs explicit gateway configuration.")
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
        const provider: GatewayProvider = { id: createDenTypeId("inferenceProvider"), organization_id: actor.organization.id, created_by_org_membership_id: source.createdByOrgMembershipId, provider_id: source.providerId, name: source.name, model_ids: models.map((model) => model.modelId), pinned_model_ids: [], provider_config: { ...config, env: trusted.env }, settings: { migration: { llmProviderId: source.id, runtimeEnvNames: runtimeProviderEnvNames(source) } }, credential_mode: "org", oauth_client_id: null, oauth_client_secret: null, status: "active", created_at: now, updated_at: now }
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
