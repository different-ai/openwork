import { randomBytes } from "node:crypto"
import { and, desc, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  InferenceProviderAccessTable,
  InferenceProviderCredentialTable,
  InferenceProviderModelTable,
  InferenceProviderOauthStateTable,
  InferenceProviderTable,
  LlmProviderAccessTable,
  LlmProviderMemberCredentialTable,
  LlmProviderModelTable,
  LlmProviderTable,
  MemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  INFERENCE_PROVIDER_CREDENTIAL_KINDS,
  INFERENCE_PROVIDER_CREDENTIAL_MODES,
  INFERENCE_PROVIDER_STATUSES,
  parseInferenceProviderSecret,
  type InferenceProviderCredentialKind,
} from "@openwork/types/den/inference"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { createPkcePair, OAuthTokenExchangeError, resolvePublicApiBaseUrl } from "../../capability-sources/generic-oauth.js"
import { connectCallbackPage } from "../../capability-sources/oauth-callback-page.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { ensureMemberInferenceKey } from "../../inference.js"
import {
  buildGatewayProviderConfig,
  buildProviderConfigSnapshot,
  isSupportedGatewayNpm,
  readProviderConfigNpm,
  upstreamBaseUrlSettingError,
} from "../../llm/inference-provider-config.js"
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleAuthorizationCode,
  GOOGLE_CLOUD_PLATFORM_SCOPE,
  GOOGLE_OAUTH_INFERENCE_PROVIDER_IDS,
  isGoogleOAuthInferenceProviderId,
  revokeGoogleToken,
} from "../../llm/inference-provider-google-oauth.js"
import { getModelsDevProvider } from "../../llm/models-dev.js"
import { decodeProviderCredential, readProviderEnvNames } from "../../llm/provider-credentials.js"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  publicRoute,
  queryValidator,
  resolveMemberTeamsMiddleware,
} from "../../middleware/index.js"
import type { MemberTeamsContext } from "../../middleware/member-teams.js"
import {
  denTypeIdSchema,
  emptyResponse,
  forbiddenSchema,
  htmlResponse,
  invalidRequestSchema,
  jsonResponse,
  notFoundSchema,
  unauthorizedSchema,
} from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdmin, idParamSchema, memberHasRole, orgAccessFailureStatus } from "./shared.js"

type InferenceProviderRow = typeof InferenceProviderTable.$inferSelect
type InferenceProviderId = InferenceProviderRow["id"]
type InferenceProviderModelRow = typeof InferenceProviderModelTable.$inferSelect
type InferenceProviderCredentialRow = typeof InferenceProviderCredentialTable.$inferSelect
type InferenceProviderAccessRow = typeof InferenceProviderAccessTable.$inferSelect
type OrganizationId = InferenceProviderRow["organization_id"]
type MemberId = typeof MemberTable.$inferSelect.id
type TeamId = typeof TeamTable.$inferSelect.id
type LlmProviderId = typeof LlmProviderTable.$inferSelect.id

type NonMcpDescribeRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeNonMcpRoute = (options: NonMcpDescribeRouteOptions) => describeRoute(options)

const ORG_CREDENTIAL_SUBJECT = "org"
const INFERENCE_PROVIDER_SOURCE = "openwork_gateway"

type RouteFailure = {
  status: 400 | 403 | 404
  error: string
  message?: string
}

type RouteFailureError = Error & { failure: RouteFailure }

function failure(status: RouteFailure["status"], error: string, message?: string): RouteFailureError {
  const failureError: RouteFailureError = Object.assign(new Error(message ?? error), {
    failure: { status, error, message },
  })
  return failureError
}

function isRouteFailureError(value: unknown): value is RouteFailureError {
  return value instanceof Error && "failure" in value
}

type CurrentMemberPayload = { currentMember: { id: MemberId; isOwner: boolean; role: string } }

function isOrganizationAdmin(payload: CurrentMemberPayload) {
  return payload.currentMember.isOwner || memberHasRole(payload.currentMember.role, "admin")
}

function canManageInferenceProvider(payload: CurrentMemberPayload, provider: InferenceProviderRow) {
  return isOrganizationAdmin(payload) || provider.created_by_org_membership_id === payload.currentMember.id
}

// --- Schemas ---

const inferenceProviderParamsSchema = idParamSchema("inferenceProviderId", "inferenceProvider")

const listQuerySchema = z.object({
  scope: z.enum(["usable", "manageable"]).optional().default("usable"),
})

const credentialInputSchema = z.object({
  kind: z.enum(INFERENCE_PROVIDER_CREDENTIAL_KINDS),
  secret: z.string().trim().min(1).max(65535),
})

const apiKeysInputSchema = z.record(z.string().trim().min(1).max(255), z.string().trim().min(1).max(65535))
  .refine((value) => Object.keys(value).length > 0, "Provide at least one credential.")

const settingsSchema = z.record(z.string(), z.unknown())

const accessInputFields = {
  memberIds: z.array(denTypeIdSchema("member")).max(500).optional(),
  teamIds: z.array(denTypeIdSchema("team")).max(500).optional(),
  // Grants the whole organization (current and future members) via one org-wide row.
  allMembers: z.boolean().optional(),
}

// Customer-owned OAuth client for credentialMode "member" (plan §5.6). Omit to
// keep the stored value; send an empty string to clear it.
const oauthClientInputFields = {
  oauthClientId: z.string().trim().max(255).optional(),
  oauthClientSecret: z.string().trim().max(4096).optional(),
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(255),
  providerId: z.string().trim().min(1).max(255),
  modelIds: z.array(z.string().trim().min(1).max(255)).min(1).max(500),
  credentialMode: z.enum(INFERENCE_PROVIDER_CREDENTIAL_MODES).optional().default("org"),
  status: z.enum(INFERENCE_PROVIDER_STATUSES).optional().default("active"),
  settings: settingsSchema.optional().default({}),
  credential: credentialInputSchema.optional(),
  apiKeys: apiKeysInputSchema.optional(),
  ...oauthClientInputFields,
  ...accessInputFields,
}).superRefine(rejectDoubleCredential)

const patchSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  providerId: z.string().trim().min(1).max(255).optional(),
  modelIds: z.array(z.string().trim().min(1).max(255)).min(1).max(500).optional(),
  credentialMode: z.enum(INFERENCE_PROVIDER_CREDENTIAL_MODES).optional(),
  status: z.enum(INFERENCE_PROVIDER_STATUSES).optional(),
  settings: settingsSchema.optional(),
  credential: credentialInputSchema.optional(),
  apiKeys: apiKeysInputSchema.optional(),
  ...oauthClientInputFields,
  ...accessInputFields,
}).superRefine(rejectDoubleCredential)

const migrateSchema = z.object({
  llmProviderId: denTypeIdSchema("llmProvider"),
})

const oauthStartQuerySchema = z.object({
  redirectTo: z.string().trim().min(1).max(2048).optional(),
})

const oauthCallbackQuerySchema = z.object({
  code: z.string().trim().min(1).max(4096).optional(),
  state: z.string().trim().min(1).max(255).optional(),
  error: z.string().trim().max(255).optional(),
})

function rejectDoubleCredential(
  value: { credential?: unknown; apiKeys?: unknown },
  ctx: z.RefinementCtx,
) {
  if (value.credential !== undefined && value.apiKeys !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either credential or apiKeys, not both.",
    })
  }
}

const inferenceProviderSummarySchema = z.object({
  id: denTypeIdSchema("inferenceProvider"),
  providerId: z.string(),
  name: z.string(),
  source: z.literal(INFERENCE_PROVIDER_SOURCE),
  credentialMode: z.enum(INFERENCE_PROVIDER_CREDENTIAL_MODES),
  status: z.enum(INFERENCE_PROVIDER_STATUSES),
  updatedAt: z.string().datetime(),
  providerConfig: z.record(z.string(), z.unknown()),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    config: z.record(z.string(), z.unknown()),
  })),
  credentialStatus: z.enum(["ready", "member_auth_required", "org_credential_missing"]),
  authUrl: z.string().nullable().describe("Absolute URL of the member OAuth start endpoint when credentialStatus is member_auth_required; otherwise null."),
  access: z.object({
    allMembers: z.boolean(),
    memberIds: z.array(denTypeIdSchema("member")),
    teamIds: z.array(denTypeIdSchema("team")),
  }).optional(),
  oauthClientId: z.string().nullable().optional(),
  hasOauthClientSecret: z.boolean().optional(),
  credentials: z.array(z.object({
    subject: z.string(),
    orgMembershipId: denTypeIdSchema("member").nullable(),
    memberName: z.string().nullable(),
    memberEmail: z.string().nullable(),
    kind: z.enum(INFERENCE_PROVIDER_CREDENTIAL_KINDS),
    status: z.string(),
    expiresAt: z.string().datetime().nullable(),
  })).optional(),
}).meta({ ref: "InferenceProviderSummary" })

const inferenceProviderListResponseSchema = z.object({
  inferenceProviders: z.array(inferenceProviderSummarySchema),
}).meta({ ref: "InferenceProviderListResponse" })

const inferenceProviderResponseSchema = z.object({
  inferenceProvider: inferenceProviderSummarySchema,
}).meta({ ref: "InferenceProviderResponse" })

const inferenceProviderConnectResponseSchema = z.object({
  inferenceProvider: inferenceProviderSummarySchema.extend({
    apiKey: z.string(),
    apiKeys: z.record(z.string(), z.string()),
  }),
}).meta({ ref: "InferenceProviderConnectResponse" })

const unsupportedProviderSchema = z.object({
  error: z.literal("unsupported_provider"),
  message: z.string().optional(),
}).meta({ ref: "InferenceProviderUnsupportedError" })

const unsupportedCredentialModeSchema = z.object({
  error: z.literal("unsupported_credential_mode"),
  message: z.string().optional(),
}).meta({ ref: "InferenceProviderUnsupportedCredentialModeError" })

const oauthClientRequiredSchema = z.object({
  error: z.literal("oauth_client_required"),
  message: z.string().optional(),
}).meta({ ref: "InferenceProviderOauthClientRequiredError" })

const writeBadRequestSchema = z.union([
  invalidRequestSchema,
  unsupportedProviderSchema,
  unsupportedCredentialModeSchema,
  oauthClientRequiredSchema,
])

const oauthStartBadRequestSchema = z.union([
  invalidRequestSchema,
  unsupportedCredentialModeSchema,
  oauthClientRequiredSchema,
  z.object({ error: z.literal("invalid_redirect"), message: z.string().optional() }),
])

const oauthStartResponseSchema = z.object({
  authUrl: z.string(),
}).meta({ ref: "InferenceProviderOauthStartResponse" })

// --- Access resolution (mirrors llm-provider-access.ts) ---

async function listAccessibleInferenceProviderIds(input: {
  organizationId: OrganizationId
  currentMemberId: MemberId
  teamIds: TeamId[]
}) {
  const rows = await db
    .select({ inferenceProviderId: InferenceProviderAccessTable.inference_provider_id })
    .from(InferenceProviderAccessTable)
    .innerJoin(InferenceProviderTable, eq(InferenceProviderAccessTable.inference_provider_id, InferenceProviderTable.id))
    .where(and(
      eq(InferenceProviderTable.organization_id, input.organizationId),
      or(
        eq(InferenceProviderAccessTable.org_membership_id, input.currentMemberId),
        ...(input.teamIds.length > 0 ? [inArray(InferenceProviderAccessTable.team_id, input.teamIds)] : []),
        and(
          isNull(InferenceProviderAccessTable.org_membership_id),
          isNull(InferenceProviderAccessTable.team_id),
        ),
      ),
    ))
  return [...new Set(rows.map((row) => row.inferenceProviderId))]
}

async function resolveMemberIds(input: { organizationId: OrganizationId; values: string[] }) {
  const uniqueValues = [...new Set(input.values)]
  if (uniqueValues.length === 0) {
    return [] as MemberId[]
  }
  const memberIds = uniqueValues.map((value) => {
    try {
      return normalizeDenTypeId("member", value)
    } catch {
      throw failure(404, "member_not_found")
    }
  })
  const rows = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), inArray(MemberTable.id, memberIds), isNull(MemberTable.removedAt)))
  if (rows.length !== memberIds.length) {
    throw failure(404, "member_not_found")
  }
  return memberIds
}

async function resolveTeamIds(input: { organizationId: OrganizationId; values: string[] }) {
  const uniqueValues = [...new Set(input.values)]
  if (uniqueValues.length === 0) {
    return [] as TeamId[]
  }
  const teamIds = uniqueValues.map((value) => {
    try {
      return normalizeDenTypeId("team", value)
    } catch {
      throw failure(404, "team_not_found")
    }
  })
  const rows = await db
    .select({ id: TeamTable.id })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, input.organizationId), inArray(TeamTable.id, teamIds)))
  if (rows.length !== teamIds.length) {
    throw failure(404, "team_not_found")
  }
  return teamIds
}

type AccessGrant = { allMembers: boolean; memberIds: MemberId[]; teamIds: TeamId[] }

function buildAccessRows(input: {
  inferenceProviderId: InferenceProviderId
  creatorMemberId: MemberId
  access: AccessGrant
  now: Date
}): Array<typeof InferenceProviderAccessTable.$inferInsert> {
  const row = (orgMembershipId: MemberId | null, teamId: TeamId | null) => ({
    id: createDenTypeId("inferenceProviderAccess"),
    inference_provider_id: input.inferenceProviderId,
    org_membership_id: orgMembershipId,
    team_id: teamId,
    created_at: input.now,
  })
  if (input.access.allMembers) {
    // One org-wide grant plus the creator's protected direct row.
    return [row(null, null), row(input.creatorMemberId, null)]
  }
  const protectedMemberIds = [...new Set([input.creatorMemberId, ...input.access.memberIds])]
  return [
    ...protectedMemberIds.map((memberId) => row(memberId, null)),
    ...input.access.teamIds.map((teamId) => row(null, teamId)),
  ]
}

function accessFromRows(rows: InferenceProviderAccessRow[]): AccessGrant {
  return {
    allMembers: rows.some((row) => row.org_membership_id === null && row.team_id === null),
    memberIds: rows.flatMap((row) => (row.org_membership_id ? [row.org_membership_id] : [])),
    teamIds: rows.flatMap((row) => (row.team_id ? [row.team_id] : [])),
  }
}

// --- Catalog + credential normalization ---

type NormalizedCatalog = {
  providerId: string
  providerConfig: Record<string, unknown>
  models: Array<{ id: string; name: string; config: Record<string, unknown> }>
}

async function normalizeCatalogInput(input: { providerId: string; modelIds: string[] }): Promise<NormalizedCatalog> {
  const provider = await getModelsDevProvider(input.providerId)
  if (!provider) {
    throw failure(404, "provider_not_found", "The selected provider was not found in models.dev.")
  }
  if (!isSupportedGatewayNpm(provider.npm)) {
    throw failure(400, "unsupported_provider", `${provider.name} (${provider.npm ?? "no SDK"}) cannot be routed through the OpenWork inference gateway.`)
  }

  const modelsById = new Map(provider.models.map((model) => [model.id, model]))
  const models = [...new Set(input.modelIds)].map((modelId) => {
    const model = modelsById.get(modelId)
    if (!model) {
      throw failure(404, "model_not_found", `Model ${modelId} is not available for ${provider.name}.`)
    }
    return { id: model.id, name: model.name, config: model.config }
  })

  return { providerId: provider.id, providerConfig: buildProviderConfigSnapshot(provider), models }
}

function validateSettings(providerConfig: Record<string, unknown>, settings: Record<string, unknown>) {
  const upstreamBaseUrlError = upstreamBaseUrlSettingError(settings)
  if (upstreamBaseUrlError) {
    throw failure(400, "invalid_settings", upstreamBaseUrlError)
  }
  const npm = readProviderConfigNpm(providerConfig)
  const requireString = (key: string) => {
    if (typeof settings[key] !== "string" || !settings[key].trim()) {
      throw failure(400, "invalid_settings", `settings.${key} is required for this provider.`)
    }
  }
  if (npm === "@ai-sdk/google-vertex" || npm === "@ai-sdk/google-vertex/anthropic") {
    requireString("project")
    requireString("location")
  }
  if (npm === "@ai-sdk/azure") {
    requireString("resourceName")
  }
}

/**
 * credentialMode "member" is Google-only in this version: the member row is a
 * Google OAuth token minted through the org's own OAuth client (plan §5.6).
 */
function validateCredentialMode(provider: Pick<InferenceProviderRow, "credential_mode" | "provider_id" | "oauth_client_id" | "oauth_client_secret">) {
  if (provider.credential_mode !== "member") {
    return
  }
  if (!isGoogleOAuthInferenceProviderId(provider.provider_id)) {
    throw failure(400, "unsupported_credential_mode", `Per-member credentials are only supported for ${GOOGLE_OAUTH_INFERENCE_PROVIDER_IDS.join(" and ")}.`)
  }
  if (!provider.oauth_client_id || !provider.oauth_client_secret) {
    throw failure(400, "oauth_client_required", "Per-member credentials require oauthClientId and oauthClientSecret from the organization's own Google OAuth client.")
  }
}

/** Absent keeps the stored value; an empty string clears it. */
function resolveOauthClientField(input: string | undefined, existing: string | null) {
  if (input === undefined) {
    return existing
  }
  return input === "" ? null : input
}

type CredentialInput = { kind: InferenceProviderCredentialKind; secret: string }

function normalizeCredentialInput(input: {
  credential?: CredentialInput
  apiKeys?: Record<string, string>
  envNames: string[]
}): CredentialInput | null {
  if (input.apiKeys) {
    for (const key of Object.keys(input.apiKeys)) {
      if (!input.envNames.includes(key)) {
        throw failure(400, "invalid_api_keys", `${key} is not one of this provider's env keys (${input.envNames.join(", ") || "none"}).`)
      }
    }
    return { kind: "api_key_map", secret: JSON.stringify(input.apiKeys) }
  }
  if (!input.credential) {
    return null
  }
  try {
    parseInferenceProviderSecret(input.credential.kind, input.credential.secret)
  } catch (error) {
    throw failure(400, "invalid_credential", error instanceof Error ? error.message : "The credential secret is malformed.")
  }
  return input.credential
}

function llmCredentialToInferenceCredential(stored: string | null): CredentialInput | null {
  const decoded = decodeProviderCredential(stored)
  if (decoded.apiKeys) {
    return { kind: "api_key_map", secret: JSON.stringify(decoded.apiKeys) }
  }
  if (decoded.apiKey) {
    return { kind: "api_key", secret: decoded.apiKey }
  }
  return null
}

// --- Summaries ---

type CredentialStatus = "ready" | "member_auth_required" | "org_credential_missing"

type CredentialWithMember = {
  credential: InferenceProviderCredentialRow
  memberName: string | null
  memberEmail: string | null
}

function credentialStatusFor(input: {
  provider: InferenceProviderRow
  credentials: CredentialWithMember[]
  currentMemberId: MemberId
}): CredentialStatus {
  const active = input.credentials.map((row) => row.credential).filter((credential) => credential.status === "active")
  if (input.provider.credential_mode === "member") {
    return active.some((credential) => credential.org_membership_id === input.currentMemberId)
      ? "ready"
      : "member_auth_required"
  }
  return active.some((credential) => credential.subject === ORG_CREDENTIAL_SUBJECT) ? "ready" : "org_credential_missing"
}

function oauthStartUrl(publicBaseUrl: string, inferenceProviderId: InferenceProviderId) {
  return `${publicBaseUrl}/v1/inference-providers/${inferenceProviderId}/oauth/start`
}

function oauthCallbackUrl(publicBaseUrl: string) {
  return `${publicBaseUrl}/v1/inference-providers/oauth/callback`
}

function buildSummary(input: {
  provider: InferenceProviderRow
  models: InferenceProviderModelRow[]
  credentials: CredentialWithMember[]
  access: InferenceProviderAccessRow[] | null
  currentMemberId: MemberId
  includeCredentials: boolean
  publicBaseUrl: string
}) {
  const credentialStatus = credentialStatusFor(input)
  return {
    id: input.provider.id,
    providerId: input.provider.provider_id,
    name: input.provider.name,
    source: INFERENCE_PROVIDER_SOURCE,
    credentialMode: input.provider.credential_mode,
    status: input.provider.status,
    updatedAt: input.provider.updated_at.toISOString(),
    providerConfig: buildGatewayProviderConfig(input.provider, env.inferenceProxyBaseUrl),
    models: input.models
      .map((model) => ({ id: model.model_id, name: model.name, config: model.model_config }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    credentialStatus,
    authUrl: credentialStatus === "member_auth_required" ? oauthStartUrl(input.publicBaseUrl, input.provider.id) : null,
    ...(input.access ? { access: accessFromRows(input.access) } : {}),
    ...(input.includeCredentials
      ? {
          oauthClientId: input.provider.oauth_client_id,
          hasOauthClientSecret: Boolean(input.provider.oauth_client_secret),
          credentials: input.credentials.map(({ credential, memberName, memberEmail }) => ({
            subject: credential.subject,
            orgMembershipId: credential.org_membership_id,
            memberName,
            memberEmail,
            kind: credential.kind,
            status: credential.status,
            expiresAt: credential.expires_at?.toISOString() ?? null,
          })),
        }
      : {}),
  }
}

async function loadProviderChildren(providerIds: InferenceProviderId[]) {
  if (providerIds.length === 0) {
    return { models: [], credentials: [], access: [] }
  }
  const [models, credentials, access] = await Promise.all([
    db.select().from(InferenceProviderModelTable).where(inArray(InferenceProviderModelTable.inference_provider_id, providerIds)),
    db
      .select({ credential: InferenceProviderCredentialTable, memberName: AuthUserTable.name, memberEmail: AuthUserTable.email })
      .from(InferenceProviderCredentialTable)
      .leftJoin(MemberTable, eq(MemberTable.id, InferenceProviderCredentialTable.org_membership_id))
      .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(inArray(InferenceProviderCredentialTable.inference_provider_id, providerIds)),
    db.select().from(InferenceProviderAccessTable).where(inArray(InferenceProviderAccessTable.inference_provider_id, providerIds)),
  ])
  return { models, credentials, access }
}

function groupBy<T>(rows: T[], key: (row: T) => InferenceProviderId) {
  const map = new Map<InferenceProviderId, T[]>()
  for (const row of rows) {
    const existing = map.get(key(row)) ?? []
    existing.push(row)
    map.set(key(row), existing)
  }
  return map
}

async function loadSummary(input: {
  provider: InferenceProviderRow
  currentMemberId: MemberId
  manage: boolean
  publicBaseUrl: string
}) {
  const children = await loadProviderChildren([input.provider.id])
  return buildSummary({
    provider: input.provider,
    models: children.models,
    credentials: children.credentials,
    access: input.manage ? children.access : null,
    currentMemberId: input.currentMemberId,
    includeCredentials: input.manage,
    publicBaseUrl: input.publicBaseUrl,
  })
}

function publicBaseUrlFor(request: Request) {
  return resolvePublicApiBaseUrl(request, env.apiPublicUrl)
}

/**
 * Post-callback redirect allowlist. There is no shared OAuth redirect
 * allowlist in den-api, so this accepts the desktop deep-link scheme
 * (`openwork:`) and any origin Den already trusts for public URLs (Den Web /
 * CORS origins). Everything else falls back to the static success page.
 */
function resolveOauthRedirectTo(value: string | undefined): string | null | "invalid" {
  if (value === undefined) {
    return null
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "invalid"
  }
  if (url.username || url.password) {
    return "invalid"
  }
  if (url.protocol === "openwork:") {
    return url.toString()
  }
  if ((url.protocol === "https:" || url.protocol === "http:") && env.publicUrlTrustedOrigins.includes(url.origin)) {
    return url.toString()
  }
  return "invalid"
}

function appendRedirectParams(redirectTo: string, params: Record<string, string>) {
  const url = new URL(redirectTo)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}

async function getMemberCredential(input: { inferenceProviderId: InferenceProviderId; memberId: MemberId }) {
  const rows = await db
    .select()
    .from(InferenceProviderCredentialTable)
    .where(and(
      eq(InferenceProviderCredentialTable.inference_provider_id, input.inferenceProviderId),
      eq(InferenceProviderCredentialTable.subject, input.memberId),
    ))
    .limit(1)
  return rows[0] ?? null
}

async function getInferenceProvider(input: { organizationId: OrganizationId; inferenceProviderId: InferenceProviderId }) {
  const rows = await db
    .select()
    .from(InferenceProviderTable)
    .where(and(
      eq(InferenceProviderTable.organization_id, input.organizationId),
      eq(InferenceProviderTable.id, input.inferenceProviderId),
    ))
    .limit(1)
  return rows[0] ?? null
}

function parseInferenceProviderId(value: string): InferenceProviderId | null {
  try {
    return normalizeDenTypeId("inferenceProvider", value)
  } catch {
    return null
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function replaceModels(tx: Tx, inferenceProviderId: InferenceProviderId, models: NormalizedCatalog["models"], now: Date) {
  await tx.delete(InferenceProviderModelTable).where(eq(InferenceProviderModelTable.inference_provider_id, inferenceProviderId))
  if (models.length > 0) {
    await tx.insert(InferenceProviderModelTable).values(models.map((model) => ({
      id: createDenTypeId("inferenceProviderModel"),
      inference_provider_id: inferenceProviderId,
      model_id: model.id,
      name: model.name,
      model_config: model.config,
      created_at: now,
    })))
  }
}

async function replaceAccess(tx: Tx, input: Parameters<typeof buildAccessRows>[0]) {
  await tx.delete(InferenceProviderAccessTable).where(eq(InferenceProviderAccessTable.inference_provider_id, input.inferenceProviderId))
  await tx.insert(InferenceProviderAccessTable).values(buildAccessRows(input))
}

async function upsertOrgCredential(tx: Tx, input: {
  inferenceProviderId: InferenceProviderId
  organizationId: OrganizationId
  credential: CredentialInput
  now: Date
}) {
  await tx.delete(InferenceProviderCredentialTable).where(and(
    eq(InferenceProviderCredentialTable.inference_provider_id, input.inferenceProviderId),
    eq(InferenceProviderCredentialTable.subject, ORG_CREDENTIAL_SUBJECT),
  ))
  await tx.insert(InferenceProviderCredentialTable).values({
    id: createDenTypeId("inferenceProviderCredential"),
    inference_provider_id: input.inferenceProviderId,
    organization_id: input.organizationId,
    subject: ORG_CREDENTIAL_SUBJECT,
    org_membership_id: null,
    kind: input.credential.kind,
    secret: input.credential.secret,
    status: "active",
    created_at: input.now,
    updated_at: input.now,
  })
}

function respondFailure(c: { json: (body: unknown, status: RouteFailure["status"]) => Response }, error: unknown) {
  if (isRouteFailureError(error)) {
    return c.json({ error: error.failure.error, message: error.failure.message }, error.failure.status)
  }
  throw error
}

export function registerOrgInferenceProviderRoutes<T extends { Variables: OrgRouteVariables & Partial<MemberTeamsContext> }>(app: Hono<T>) {
  app.get(
    "/v1/inference-providers",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "List organization inference gateway providers",
      description: "Lists providers routed through the OpenWork inference gateway. scope=usable (default) returns active providers the member can use; scope=manageable returns providers the member can administer with their access grants.",
      responses: {
        200: jsonResponse("Inference providers returned successfully.", inferenceProviderListResponseSchema),
        400: jsonResponse("The query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list inference providers.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(listQuerySchema),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const query = c.req.valid("query")
      const payload = c.get("organizationContext")
      const memberTeams: Array<{ id: TeamId }> = c.get("memberTeams") ?? []
      const manage = query.scope === "manageable"

      let providerWhere
      if (manage) {
        providerWhere = isOrganizationAdmin(payload)
          ? eq(InferenceProviderTable.organization_id, payload.organization.id)
          : and(
              eq(InferenceProviderTable.organization_id, payload.organization.id),
              eq(InferenceProviderTable.created_by_org_membership_id, payload.currentMember.id),
            )
      } else {
        const accessibleIds = await listAccessibleInferenceProviderIds({
          organizationId: payload.organization.id,
          currentMemberId: payload.currentMember.id,
          teamIds: memberTeams.map((team) => team.id),
        })
        if (accessibleIds.length === 0) {
          return c.json({ inferenceProviders: [] })
        }
        providerWhere = and(
          eq(InferenceProviderTable.organization_id, payload.organization.id),
          eq(InferenceProviderTable.status, "active"),
          inArray(InferenceProviderTable.id, accessibleIds),
        )
      }

      const providers = await db
        .select()
        .from(InferenceProviderTable)
        .where(providerWhere)
        .orderBy(desc(InferenceProviderTable.updated_at))
      const children = await loadProviderChildren(providers.map((provider) => provider.id))
      const modelsByProvider = groupBy(children.models, (row) => row.inference_provider_id)
      const credentialsByProvider = groupBy(children.credentials, (row) => row.credential.inference_provider_id)
      const accessByProvider = groupBy(children.access, (row) => row.inference_provider_id)
      const publicBaseUrl = publicBaseUrlFor(c.req.raw)

      return c.json({
        inferenceProviders: providers.map((provider) => buildSummary({
          provider,
          models: modelsByProvider.get(provider.id) ?? [],
          credentials: credentialsByProvider.get(provider.id) ?? [],
          access: manage ? accessByProvider.get(provider.id) ?? [] : null,
          currentMemberId: payload.currentMember.id,
          includeCredentials: false,
          publicBaseUrl,
        })),
      })
    },
  )

  app.get(
    "/v1/inference-providers/:inferenceProviderId",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Get inference gateway provider",
      description: "Returns one inference provider for management, including access grants and which credential kinds exist. Never includes secret values.",
      responses: {
        200: jsonResponse("Inference provider returned successfully.", inferenceProviderResponseSchema),
        400: jsonResponse("The path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only the provider creator or a workspace admin can view provider management details.", forbiddenSchema),
        404: jsonResponse("The provider could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(inferenceProviderParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const inferenceProviderId = parseInferenceProviderId(c.req.valid("param").inferenceProviderId)
      const provider = inferenceProviderId
        ? await getInferenceProvider({ organizationId: payload.organization.id, inferenceProviderId })
        : null
      if (!provider) {
        return c.json({ error: "inference_provider_not_found" }, 404)
      }
      if (!canManageInferenceProvider(payload, provider)) {
        return c.json({ error: "forbidden", message: "Only the provider creator or a workspace admin can view this provider." }, 403)
      }
      return c.json({
        inferenceProvider: await loadSummary({ provider, currentMemberId: payload.currentMember.id, manage: true, publicBaseUrl: publicBaseUrlFor(c.req.raw) }),
      })
    },
  )

  app.get(
    "/v1/inference-providers/:inferenceProviderId/connect",
    describeNonMcpRoute({
      tags: ["Inference Providers"],
      "x-mcp": false,
      summary: "Get inference gateway provider connect payload",
      description: "Returns the opencode provider block for one accessible inference provider, rewritten to the OpenWork gateway URL, together with the caller's OpenWork inference key. The organization's upstream credential is never returned.",
      responses: {
        200: jsonResponse("Connect payload returned successfully.", inferenceProviderConnectResponseSchema),
        400: jsonResponse("The path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only members with access can connect to this provider.", forbiddenSchema),
        404: jsonResponse("The provider could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(inferenceProviderParamsSchema),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const memberTeams: Array<{ id: TeamId }> = c.get("memberTeams") ?? []
      const inferenceProviderId = parseInferenceProviderId(c.req.valid("param").inferenceProviderId)
      const provider = inferenceProviderId
        ? await getInferenceProvider({ organizationId: payload.organization.id, inferenceProviderId })
        : null
      if (!provider || provider.status !== "active") {
        return c.json({ error: "inference_provider_not_found" }, 404)
      }

      const accessibleIds = await listAccessibleInferenceProviderIds({
        organizationId: payload.organization.id,
        currentMemberId: payload.currentMember.id,
        teamIds: memberTeams.map((team) => team.id),
      })
      if (!accessibleIds.includes(provider.id)) {
        return c.json({ error: "forbidden", message: "You do not have access to this provider." }, 403)
      }

      const [summary, apiKey] = await Promise.all([
        loadSummary({ provider, currentMemberId: payload.currentMember.id, manage: false, publicBaseUrl: publicBaseUrlFor(c.req.raw) }),
        ensureMemberInferenceKey({ organizationId: payload.organization.id, memberId: payload.currentMember.id }),
      ])
      const apiKeys = Object.fromEntries(readProviderEnvNames(summary.providerConfig).map((name) => [name, apiKey]))
      return c.json({ inferenceProvider: { ...summary, apiKey, apiKeys } })
    },
  )

  // Registered before the :inferenceProviderId routes so the literal "oauth"
  // segment never reaches the typeid validator.
  app.get(
    "/v1/inference-providers/oauth/callback",
    describeRoute({
      tags: ["Authentication"],
      summary: "Google OAuth callback for a member inference credential",
      description: "Google redirects here with code+state after the member consents. Identity comes entirely from the single-use state row created by the start endpoint, not a session cookie. Exchanges the code with the organization's own OAuth client, stores the member's token, then redirects to the validated redirectTo or serves a small static success page. Failures redirect with an error= query parameter or render the failure page.",
      responses: {
        200: htmlResponse("Connected — a static success page."),
        302: emptyResponse("Redirects to the redirectTo URL supplied at start, with error= on failure."),
        400: htmlResponse("Missing, reused, or expired state; or the token exchange failed."),
      },
    }),
    publicRoute,
    queryValidator(oauthCallbackQuerySchema),
    async (c) => {
      const query = c.req.valid("query")
      const requestId = c.get("requestId")
      const fail = (input: { redirectTo: string | null; message: string }) => {
        if (input.redirectTo) {
          return c.redirect(appendRedirectParams(input.redirectTo, { error: input.message }), 302)
        }
        return c.html(connectCallbackPage({ ok: false, name: "Google", message: input.message, referenceId: requestId }), 400)
      }

      if (!query.state) {
        return fail({ redirectTo: null, message: "Missing state." })
      }
      const [stateRow] = await db
        .select()
        .from(InferenceProviderOauthStateTable)
        .where(eq(InferenceProviderOauthStateTable.state, query.state))
        .limit(1)
      if (!stateRow || stateRow.used_at || stateRow.expires_at.getTime() < Date.now()) {
        return fail({ redirectTo: null, message: "This sign-in link has expired or was already used. Start Connect again." })
      }
      const now = new Date()
      // Single use: claim the row before touching Google so a replayed callback cannot exchange twice.
      const claimed = await db
        .update(InferenceProviderOauthStateTable)
        .set({ used_at: now })
        .where(and(eq(InferenceProviderOauthStateTable.id, stateRow.id), isNull(InferenceProviderOauthStateTable.used_at)))
      if (affectedRows(claimed) !== 1) {
        return fail({ redirectTo: null, message: "This sign-in link was already used. Start Connect again." })
      }
      const redirectTo = stateRow.redirect_to

      if (query.error || !query.code) {
        return fail({ redirectTo, message: query.error === "access_denied" ? "Google access was denied." : `Google did not return an authorization code${query.error ? ` (${query.error})` : ""}.` })
      }

      const [provider] = await db
        .select()
        .from(InferenceProviderTable)
        .where(eq(InferenceProviderTable.id, stateRow.inference_provider_id))
        .limit(1)
      if (!provider || provider.credential_mode !== "member" || !provider.oauth_client_id || !provider.oauth_client_secret) {
        return fail({ redirectTo, message: "This provider no longer accepts per-member sign-in." })
      }

      try {
        const tokens = await exchangeGoogleAuthorizationCode({
          clientId: provider.oauth_client_id,
          clientSecret: provider.oauth_client_secret,
          code: query.code,
          codeVerifier: stateRow.code_verifier,
          redirectUri: oauthCallbackUrl(publicBaseUrlFor(c.req.raw)),
        })
        const secret = JSON.stringify({
          accessToken: tokens.access_token,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          ...(tokens.token_type ? { tokenType: tokens.token_type } : {}),
        })
        const expiresAt = tokens.expires_in ? new Date(now.getTime() + tokens.expires_in * 1000) : null
        const scopes = tokens.scope ?? GOOGLE_CLOUD_PLATFORM_SCOPE
        await db.transaction(async (tx) => {
          await tx.delete(InferenceProviderCredentialTable).where(and(
            eq(InferenceProviderCredentialTable.inference_provider_id, provider.id),
            eq(InferenceProviderCredentialTable.subject, stateRow.org_membership_id),
          ))
          await tx.insert(InferenceProviderCredentialTable).values({
            id: createDenTypeId("inferenceProviderCredential"),
            inference_provider_id: provider.id,
            organization_id: provider.organization_id,
            subject: stateRow.org_membership_id,
            org_membership_id: stateRow.org_membership_id,
            kind: "oauth_google",
            secret,
            expires_at: expiresAt,
            scopes,
            last_refreshed_at: now,
            status: "active",
            created_at: now,
            updated_at: now,
          })
        })
      } catch (error) {
        const message = error instanceof OAuthTokenExchangeError
          ? error.message
          : "OpenWork could not finish the Google sign-in. Try Connect again."
        console.error("inference_provider_oauth_callback_failed", {
          requestId,
          inferenceProviderId: provider.id,
          organizationId: provider.organization_id,
          code: error instanceof OAuthTokenExchangeError ? error.code : "oauth_callback_failed",
          errorName: error instanceof Error ? error.name : "UnknownError",
        })
        return fail({ redirectTo, message })
      }

      if (redirectTo) {
        return c.redirect(redirectTo, 302)
      }
      return c.html(connectCallbackPage({ ok: true, name: provider.name }))
    },
  )

  app.get(
    "/v1/inference-providers/:inferenceProviderId/oauth/start",
    describeRoute({
      tags: ["Authentication"],
      summary: "Begin Google sign-in for a member inference credential",
      description: "For providers with credentialMode member. Creates a single-use PKCE state (10 minutes) and redirects the browser to Google's authorize URL using the organization's own OAuth client; with Accept: application/json it returns { authUrl } instead so the desktop can open it. redirectTo must be an openwork: deep link or a Den-trusted web origin.",
      responses: {
        200: jsonResponse("Authorize URL (Accept: application/json).", oauthStartResponseSchema),
        302: emptyResponse("Redirects to Google's authorize URL."),
        400: jsonResponse("The provider is not in member credential mode, has no OAuth client, or redirectTo is not allowed.", oauthStartBadRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only members with access can connect to this provider.", forbiddenSchema),
        404: jsonResponse("The provider could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(inferenceProviderParamsSchema),
    queryValidator(oauthStartQuerySchema),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const memberTeams: Array<{ id: TeamId }> = c.get("memberTeams") ?? []
      const inferenceProviderId = parseInferenceProviderId(c.req.valid("param").inferenceProviderId)
      const provider = inferenceProviderId
        ? await getInferenceProvider({ organizationId: payload.organization.id, inferenceProviderId })
        : null
      if (!provider || provider.status !== "active") {
        return c.json({ error: "inference_provider_not_found" }, 404)
      }
      const accessibleIds = await listAccessibleInferenceProviderIds({
        organizationId: payload.organization.id,
        currentMemberId: payload.currentMember.id,
        teamIds: memberTeams.map((team) => team.id),
      })
      if (!accessibleIds.includes(provider.id)) {
        return c.json({ error: "forbidden", message: "You do not have access to this provider." }, 403)
      }
      if (provider.credential_mode !== "member") {
        return c.json({ error: "unsupported_credential_mode", message: "This provider uses an organization credential; no member sign-in is needed." }, 400)
      }
      if (!provider.oauth_client_id || !provider.oauth_client_secret) {
        return c.json({ error: "oauth_client_required", message: "An administrator must add the organization's Google OAuth client to this provider first." }, 400)
      }
      const redirectTo = resolveOauthRedirectTo(c.req.valid("query").redirectTo)
      if (redirectTo === "invalid") {
        return c.json({ error: "invalid_redirect", message: "redirectTo must be an openwork: deep link or a trusted OpenWork web origin." }, 400)
      }

      const { verifier, challenge } = createPkcePair()
      const state = randomBytes(32).toString("base64url")
      const now = new Date()
      await db.insert(InferenceProviderOauthStateTable).values({
        id: createDenTypeId("inferenceProviderOauthState"),
        inference_provider_id: provider.id,
        org_membership_id: payload.currentMember.id,
        state,
        code_verifier: verifier,
        redirect_to: redirectTo,
        expires_at: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
        created_at: now,
      })

      const allowedDomains = payload.organization.allowedEmailDomains ?? []
      const authUrl = buildGoogleAuthorizeUrl({
        clientId: provider.oauth_client_id,
        redirectUri: oauthCallbackUrl(publicBaseUrlFor(c.req.raw)),
        state,
        codeChallenge: challenge,
        ...(allowedDomains.length === 1 && allowedDomains[0] ? { hostedDomain: allowedDomains[0] } : {}),
      })
      if (c.req.header("accept")?.includes("application/json")) {
        return c.json({ authUrl })
      }
      return c.redirect(authUrl, 302)
    },
  )

  app.delete(
    "/v1/inference-providers/:inferenceProviderId/oauth",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Disconnect the caller's Google credential for an inference provider",
      description: "Revokes the calling member's own OAuth token at Google (best effort) and marks the stored credential revoked. The next connect reports member_auth_required again.",
      responses: {
        204: emptyResponse("Credential revoked."),
        400: jsonResponse("The path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("The provider or the caller's credential could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(inferenceProviderParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const inferenceProviderId = parseInferenceProviderId(c.req.valid("param").inferenceProviderId)
      const provider = inferenceProviderId
        ? await getInferenceProvider({ organizationId: payload.organization.id, inferenceProviderId })
        : null
      if (!provider) {
        return c.json({ error: "inference_provider_not_found" }, 404)
      }
      const credential = await getMemberCredential({ inferenceProviderId: provider.id, memberId: payload.currentMember.id })
      if (!credential || credential.status === "revoked") {
        return c.json({ error: "inference_provider_credential_not_found" }, 404)
      }

      let token: string | null = null
      try {
        const parsed = parseInferenceProviderSecret(credential.kind, credential.secret)
        if (parsed.kind === "oauth_google") {
          token = parsed.token.refreshToken ?? parsed.token.accessToken
        }
      } catch {
        // Malformed secret: nothing to revoke upstream; still mark the row revoked below.
      }
      if (token && !(await revokeGoogleToken({ token }))) {
        console.warn("inference_provider_oauth_revoke_failed", {
          requestId: c.get("requestId"),
          inferenceProviderId: provider.id,
          credentialId: credential.id,
        })
      }
      await db
        .update(InferenceProviderCredentialTable)
        .set({ status: "revoked", updated_at: new Date() })
        .where(eq(InferenceProviderCredentialTable.id, credential.id))
      return c.body(null, 204)
    },
  )

  app.post(
    "/v1/inference-providers",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Create inference gateway provider",
      description: "Creates a provider from the models.dev catalog whose calls are routed through the OpenWork inference gateway. The upstream credential is stored server-side and never delivered to devices. credentialMode member (Google Vertex only) requires the organization's own Google OAuth client via oauthClientId and oauthClientSecret; the secret is never returned.",
      responses: {
        201: jsonResponse("Inference provider created successfully.", inferenceProviderResponseSchema),
        400: jsonResponse("The request was invalid or the provider SDK is not supported by the gateway.", writeBadRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("A referenced provider, model, member, or team could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(createSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const input = c.req.valid("json")

      try {
        const catalog = await normalizeCatalogInput({ providerId: input.providerId, modelIds: input.modelIds })
        validateSettings(catalog.providerConfig, input.settings)
        const credential = normalizeCredentialInput({
          credential: input.credential,
          apiKeys: input.apiKeys,
          envNames: readProviderEnvNames(catalog.providerConfig),
        })
        const access: AccessGrant = {
          allMembers: input.allMembers ?? false,
          memberIds: await resolveMemberIds({ organizationId: payload.organization.id, values: input.memberIds ?? [] }),
          teamIds: await resolveTeamIds({ organizationId: payload.organization.id, values: input.teamIds ?? [] }),
        }

        const now = new Date()
        const provider: InferenceProviderRow = {
          id: createDenTypeId("inferenceProvider"),
          organization_id: payload.organization.id,
          created_by_org_membership_id: payload.currentMember.id,
          provider_id: catalog.providerId,
          name: input.name,
          provider_config: catalog.providerConfig,
          settings: input.settings,
          credential_mode: input.credentialMode,
          oauth_client_id: resolveOauthClientField(input.oauthClientId, null),
          oauth_client_secret: resolveOauthClientField(input.oauthClientSecret, null),
          status: input.status,
          created_at: now,
          updated_at: now,
        }
        validateCredentialMode(provider)

        await db.transaction(async (tx) => {
          await tx.insert(InferenceProviderTable).values(provider)
          await replaceModels(tx, provider.id, catalog.models, now)
          await replaceAccess(tx, { inferenceProviderId: provider.id, creatorMemberId: payload.currentMember.id, access, now })
          if (credential) {
            await upsertOrgCredential(tx, { inferenceProviderId: provider.id, organizationId: payload.organization.id, credential, now })
          }
        })

        return c.json({
          inferenceProvider: await loadSummary({ provider, currentMemberId: payload.currentMember.id, manage: true, publicBaseUrl: publicBaseUrlFor(c.req.raw) }),
        }, 201)
      } catch (error) {
        return respondFailure(c, error)
      }
    },
  )

  app.patch(
    "/v1/inference-providers/:inferenceProviderId",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Update inference gateway provider",
      description: "Updates an inference provider. Every field is optional; omitting credential and apiKeys keeps the stored organization credential. Omitting oauthClientId or oauthClientSecret keeps the stored value; an empty string clears it.",
      responses: {
        200: jsonResponse("Inference provider updated successfully.", inferenceProviderResponseSchema),
        400: jsonResponse("The request was invalid or the provider SDK is not supported by the gateway.", writeBadRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only the provider creator or a workspace admin can update providers.", forbiddenSchema),
        404: jsonResponse("The provider or a referenced resource could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(inferenceProviderParamsSchema),
    jsonValidator(patchSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const input = c.req.valid("json")
      const inferenceProviderId = parseInferenceProviderId(c.req.valid("param").inferenceProviderId)
      const existing = inferenceProviderId
        ? await getInferenceProvider({ organizationId: payload.organization.id, inferenceProviderId })
        : null
      if (!existing) {
        return c.json({ error: "inference_provider_not_found" }, 404)
      }
      if (!canManageInferenceProvider(payload, existing)) {
        return c.json({ error: "forbidden", message: "Only the provider creator or a workspace admin can update providers." }, 403)
      }
      if (isOrganizationAdmin(payload)) {
        const permission = ensureOrganizationAdmin(c, "Only the provider creator or a workspace admin can update providers.")
        if (!permission.ok) {
          return c.json(permission.response, orgAccessFailureStatus(permission.response))
        }
      }

      try {
        const existingModels = await db
          .select()
          .from(InferenceProviderModelTable)
          .where(eq(InferenceProviderModelTable.inference_provider_id, existing.id))
        const catalog = input.providerId !== undefined || input.modelIds !== undefined
          ? await normalizeCatalogInput({
              providerId: input.providerId ?? existing.provider_id,
              modelIds: input.modelIds ?? existingModels.map((model) => model.model_id),
            })
          : null
        const providerConfig = catalog?.providerConfig ?? existing.provider_config
        const settings = input.settings ?? existing.settings
        validateSettings(providerConfig, settings)
        const credential = normalizeCredentialInput({
          credential: input.credential,
          apiKeys: input.apiKeys,
          envNames: readProviderEnvNames(providerConfig),
        })
        const access: AccessGrant | null = input.memberIds !== undefined || input.teamIds !== undefined || input.allMembers !== undefined
          ? {
              allMembers: input.allMembers ?? false,
              memberIds: await resolveMemberIds({ organizationId: payload.organization.id, values: input.memberIds ?? [] }),
              teamIds: await resolveTeamIds({ organizationId: payload.organization.id, values: input.teamIds ?? [] }),
            }
          : null

        const now = new Date()
        const provider: InferenceProviderRow = {
          ...existing,
          provider_id: catalog?.providerId ?? existing.provider_id,
          name: input.name ?? existing.name,
          provider_config: providerConfig,
          settings,
          credential_mode: input.credentialMode ?? existing.credential_mode,
          oauth_client_id: resolveOauthClientField(input.oauthClientId, existing.oauth_client_id),
          oauth_client_secret: resolveOauthClientField(input.oauthClientSecret, existing.oauth_client_secret),
          status: input.status ?? existing.status,
          updated_at: now,
        }
        validateCredentialMode(provider)

        await db.transaction(async (tx) => {
          await tx
            .update(InferenceProviderTable)
            .set({
              provider_id: provider.provider_id,
              name: provider.name,
              provider_config: provider.provider_config,
              settings: provider.settings,
              credential_mode: provider.credential_mode,
              oauth_client_id: provider.oauth_client_id,
              oauth_client_secret: provider.oauth_client_secret,
              status: provider.status,
              updated_at: now,
            })
            .where(eq(InferenceProviderTable.id, provider.id))
          if (catalog) {
            await replaceModels(tx, provider.id, catalog.models, now)
          }
          if (access) {
            await replaceAccess(tx, {
              inferenceProviderId: provider.id,
              creatorMemberId: existing.created_by_org_membership_id,
              access,
              now,
            })
          }
          if (credential) {
            await upsertOrgCredential(tx, { inferenceProviderId: provider.id, organizationId: payload.organization.id, credential, now })
          }
        })

        return c.json({
          inferenceProvider: await loadSummary({ provider, currentMemberId: payload.currentMember.id, manage: true, publicBaseUrl: publicBaseUrlFor(c.req.raw) }),
        })
      } catch (error) {
        return respondFailure(c, error)
      }
    },
  )

  app.delete(
    "/v1/inference-providers/:inferenceProviderId",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Delete inference gateway provider",
      description: "Deletes an inference provider together with its models, credentials, and access grants.",
      responses: {
        204: emptyResponse("Inference provider deleted successfully."),
        400: jsonResponse("The path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only the provider creator or a workspace admin can delete providers.", forbiddenSchema),
        404: jsonResponse("The provider could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(inferenceProviderParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const inferenceProviderId = parseInferenceProviderId(c.req.valid("param").inferenceProviderId)
      const provider = inferenceProviderId
        ? await getInferenceProvider({ organizationId: payload.organization.id, inferenceProviderId })
        : null
      if (!provider) {
        return c.json({ error: "inference_provider_not_found" }, 404)
      }
      if (!canManageInferenceProvider(payload, provider)) {
        return c.json({ error: "forbidden", message: "Only the provider creator or a workspace admin can delete providers." }, 403)
      }
      if (isOrganizationAdmin(payload)) {
        const permission = ensureOrganizationAdmin(c, "Only the provider creator or a workspace admin can delete providers.")
        if (!permission.ok) {
          return c.json(permission.response, orgAccessFailureStatus(permission.response))
        }
      }

      await db.transaction(async (tx) => {
        await tx.delete(InferenceProviderCredentialTable).where(eq(InferenceProviderCredentialTable.inference_provider_id, provider.id))
        await tx.delete(InferenceProviderAccessTable).where(eq(InferenceProviderAccessTable.inference_provider_id, provider.id))
        await tx.delete(InferenceProviderModelTable).where(eq(InferenceProviderModelTable.inference_provider_id, provider.id))
        await tx.delete(InferenceProviderTable).where(eq(InferenceProviderTable.id, provider.id))
      })
      return c.body(null, 204)
    },
  )

  app.delete(
    "/v1/inference-providers/:inferenceProviderId/access/:accessId",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Remove inference provider access grant",
      description: "Removes one explicit member or team access grant from an inference provider. The creator's direct grant is protected.",
      responses: {
        204: emptyResponse("Access grant removed successfully."),
        400: jsonResponse("The path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only the provider creator or a workspace admin can manage provider access.", forbiddenSchema),
        404: jsonResponse("The provider or access grant could not be found.", notFoundSchema),
        409: jsonResponse("The request tried to remove a protected access entry.", z.object({ error: z.literal("protected_access"), message: z.string().optional() })),
      },
    }),
    orgMemberRoute(),
    paramValidator(inferenceProviderParamsSchema.extend(idParamSchema("accessId", "inferenceProviderAccess").shape)),
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")
      const inferenceProviderId = parseInferenceProviderId(params.inferenceProviderId)
      let accessId: InferenceProviderAccessRow["id"]
      try {
        accessId = normalizeDenTypeId("inferenceProviderAccess", params.accessId)
      } catch {
        return c.json({ error: "not_found" }, 404)
      }
      const provider = inferenceProviderId
        ? await getInferenceProvider({ organizationId: payload.organization.id, inferenceProviderId })
        : null
      if (!provider) {
        return c.json({ error: "inference_provider_not_found" }, 404)
      }
      if (!canManageInferenceProvider(payload, provider)) {
        return c.json({ error: "forbidden", message: "Only the provider creator or a workspace admin can manage access." }, 403)
      }
      if (isOrganizationAdmin(payload)) {
        const permission = ensureOrganizationAdmin(c, "Only the provider creator or a workspace admin can manage access.")
        if (!permission.ok) {
          return c.json(permission.response, orgAccessFailureStatus(permission.response))
        }
      }

      const [access] = await db
        .select()
        .from(InferenceProviderAccessTable)
        .where(and(eq(InferenceProviderAccessTable.id, accessId), eq(InferenceProviderAccessTable.inference_provider_id, provider.id)))
        .limit(1)
      if (!access) {
        return c.json({ error: "inference_provider_access_not_found" }, 404)
      }
      if (access.org_membership_id === provider.created_by_org_membership_id) {
        return c.json({ error: "protected_access", message: "The provider creator always keeps direct access." }, 409)
      }
      await db.delete(InferenceProviderAccessTable).where(eq(InferenceProviderAccessTable.id, access.id))
      return c.body(null, 204)
    },
  )

  app.post(
    "/v1/inference-providers/migrate-from-llm-provider",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Move an LLM provider to the inference gateway",
      description: "Creates an inference provider from an existing models.dev LLM provider (name, models, access, credential), then deletes the LLM provider in the same transaction. The next desktop sync replaces the device-held credential with the member's OpenWork key.",
      responses: {
        201: jsonResponse("Inference provider created from the LLM provider.", inferenceProviderResponseSchema),
        400: jsonResponse("The LLM provider is not a models.dev provider or its SDK is not supported by the gateway.", writeBadRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only the provider creator or a workspace admin can migrate providers.", forbiddenSchema),
        404: jsonResponse("The LLM provider could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(migrateSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      let llmProviderId: LlmProviderId
      try {
        llmProviderId = normalizeDenTypeId("llmProvider", c.req.valid("json").llmProviderId)
      } catch {
        return c.json({ error: "llm_provider_not_found" }, 404)
      }

      const [llmProvider] = await db
        .select()
        .from(LlmProviderTable)
        .where(and(eq(LlmProviderTable.id, llmProviderId), eq(LlmProviderTable.organizationId, payload.organization.id)))
        .limit(1)
      if (!llmProvider) {
        return c.json({ error: "llm_provider_not_found" }, 404)
      }
      if (!(isOrganizationAdmin(payload) || llmProvider.createdByOrgMembershipId === payload.currentMember.id)) {
        return c.json({ error: "forbidden", message: "Only the provider creator or a workspace admin can migrate providers." }, 403)
      }
      if (isOrganizationAdmin(payload)) {
        const permission = ensureOrganizationAdmin(c, "Only the provider creator or a workspace admin can migrate providers.")
        if (!permission.ok) {
          return c.json(permission.response, orgAccessFailureStatus(permission.response))
        }
      }
      if (llmProvider.source !== "models_dev") {
        return c.json({ error: "unsupported_provider", message: "Only models.dev providers can be moved to the inference gateway." }, 400)
      }

      try {
        const [llmModels, llmAccess] = await Promise.all([
          db.select().from(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId, llmProvider.id)),
          db.select().from(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.llmProviderId, llmProvider.id)),
        ])
        const catalog = await normalizeCatalogInput({
          providerId: llmProvider.providerId,
          modelIds: llmModels.map((model) => model.modelId),
        })
        const credential = llmCredentialToInferenceCredential(llmProvider.apiKey)

        const now = new Date()
        const provider: InferenceProviderRow = {
          id: createDenTypeId("inferenceProvider"),
          organization_id: payload.organization.id,
          created_by_org_membership_id: llmProvider.createdByOrgMembershipId,
          provider_id: catalog.providerId,
          name: llmProvider.name,
          provider_config: catalog.providerConfig,
          settings: {},
          credential_mode: "org",
          oauth_client_id: null,
          oauth_client_secret: null,
          status: "active",
          created_at: now,
          updated_at: now,
        }

        await db.transaction(async (tx) => {
          await tx.insert(InferenceProviderTable).values(provider)
          await replaceModels(tx, provider.id, catalog.models, now)
          if (llmAccess.length > 0) {
            await tx.insert(InferenceProviderAccessTable).values(llmAccess.map((row) => ({
              id: createDenTypeId("inferenceProviderAccess"),
              inference_provider_id: provider.id,
              org_membership_id: row.orgMembershipId,
              team_id: row.teamId,
              created_at: now,
            })))
          }
          if (credential) {
            await upsertOrgCredential(tx, { inferenceProviderId: provider.id, organizationId: payload.organization.id, credential, now })
          }
          await tx.delete(LlmProviderMemberCredentialTable).where(eq(LlmProviderMemberCredentialTable.llmProviderId, llmProvider.id))
          await tx.delete(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.llmProviderId, llmProvider.id))
          await tx.delete(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId, llmProvider.id))
          await tx.delete(LlmProviderTable).where(eq(LlmProviderTable.id, llmProvider.id))
        })

        return c.json({
          inferenceProvider: await loadSummary({ provider, currentMemberId: payload.currentMember.id, manage: true, publicBaseUrl: publicBaseUrlFor(c.req.raw) }),
        }, 201)
      } catch (error) {
        return respondFailure(c, error)
      }
    },
  )
}
