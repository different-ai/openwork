/**
 * Config-blob area `settings.auth-security` (Settings › Auth & Security).
 * One area, three kinds of item, told apart by `spec.kind`:
 *
 * - `session` (exactly one; id = organization id): Require SSO, Restrict this
 *   domain to our SSO, session length, maximum session length and fresh admin
 *   sessions. Stored in `organization.metadata`; applied through PATCH
 *   /v1/org's own function (routes/org/core.ts updateOrganizationAction).
 * - `sso-connection` (one per connection; id = `sso_connection.id`): name,
 *   protocol, IdP issuer, email domains, enabled, and the non-secret parts of
 *   the provider's encrypted `oidc_config` / `saml_config`, read field by field
 *   through an allowlist. The OIDC client secret is a `$secret` placeholder.
 *   Applied through the SSO routes' own functions (routes/org/sso.ts
 *   registerConnection / enableConnection / disableConnection /
 *   deleteConnection, sso.ts renameOrganizationSsoConnection).
 * - `scim` (at most one; id = `scim_provider.id`): the group mapping mode.
 *   The SCIM bearer token is never exported and can't be carried: it only
 *   exists as a hash-like encrypted value on the source and the identity
 *   provider holds the plaintext. A target without SCIM gets a warning to
 *   generate a token after the import. The IdP's groups and the teams they
 *   created are exported for reading only (`groups`): the IdP pushes them.
 *
 * Never carried: domain verification (DNS proof belongs to the target; a new
 * connection starts unverified unless the target already verified its
 * domains), connection tests and the enabled state of a new connection
 * (enabling needs a real IdP test), redirect / ACS URLs (per instance; listed
 * in the warnings for the IdP admin), SCIM tokens, SSO identities.
 *
 * Guard rails against locking people out:
 * - Require SSO / Restrict domain can only be turned on when the target
 *   already has a ready SSO connection (enabled + verified domain). With
 *   ssoPerOrganization the route's own rule also applies: only a session
 *   signed in through this organization's SSO may turn it on, which an import
 *   never has, so the import reports how to finish it by hand.
 * - The last ready connection can't be disabled, deleted or reconfigured
 *   (which disables it until tested again) while SSO is required.
 *
 * Better Auth registers SSO providers only for a signed-in session, so a
 * configuration write runs under a short-lived session of the applying
 * member, deleted right after (`withActorAuthHeaders`).
 */
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable, ScimGroupTable, ScimProviderTable, SsoConnectionTable, SsoProviderTable, TeamTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigApplyStep, ConfigFieldChange, ResolvedConfigSecret } from "@openwork/types/den/config-blobs"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { makeSignature } from "better-auth/crypto"
import { z } from "zod"
import { auth } from "../../auth.js"
import { auditChangeCapture } from "../../audit/request-capture.js"
import { env } from "../../env.js"
import { organizationFeatureEnabled } from "../../features.js"
import { normalizeOrganizationMetadata } from "../../organization-limits.js"
import { permissionDeniedMessage } from "../../permissions/effective.js"
import { resolvePermissionsForMember } from "../../permissions/resolve.js"
import { updateOrganizationAction } from "../../routes/org/core.js"
import { updateScimGroupMappingMode } from "../../routes/org/scim.js"
import { deleteConnection, disableConnection, enableConnection, registerConnection } from "../../routes/org/sso.js"
import {
  ADMIN_REAUTH_MINUTES,
  DEFAULT_ADMIN_REAUTH_MINUTES,
  DEFAULT_MAX_SESSION_LENGTH_DAYS,
  DEFAULT_SESSION_LENGTH_HOURS,
  MAX_SESSION_LENGTH_DAYS,
  readSessionSecuritySettings,
  SESSION_LENGTH_HOURS,
} from "../../session-security-settings.js"
import {
  getOrganizationSsoConnection,
  getSsoAcsUrl,
  getSsoMetadataUrl,
  getSsoOidcRedirectUrl,
  getSsoProviderForConnection,
  hasEnabledOrganizationSsoConnection,
  listOrganizationSsoConnections,
  renameOrganizationSsoConnection,
} from "../../sso.js"
import { getSsoDomainVerificationDnsName } from "../../sso-domain-verification.js"
import { defaultSsoConnectionName, parseSsoDomains } from "../../sso-domains.js"
import { isOrganizationSsoReady } from "../../sso-readiness.js"
import { getSsoTestPresentation } from "../../sso-test-lifecycle.js"
import { ConfigApplyItemError, defineConfigArea, type ConfigApplyOp, type ConfigApplyResult, type ConfigAreaContext, type ConfigItem, type ConfigPreflightInfo, type ConfigPreflightResult } from "../area.js"
import { ConfigApplyError, configRouteContext, expectRouteOk, isJsonObject, resolvedSecret, secretPlaceholder, specObject, specSecretSchema, type ConfigRouteContext, type JsonObject } from "./route-support.js"

const AREA = "settings.auth-security"
const SESSION_ITEM_NAME = "Sign-in and sessions"
const SCIM_ITEM_NAME = "SCIM provisioning"

type SsoConnection = typeof SsoConnectionTable.$inferSelect
type SsoProvider = typeof SsoProviderTable.$inferSelect

// ---------------------------------------------------------------------------
// Spec

const sessionSpecSchema = z.object({
  kind: z.literal("session"),
  /** Members must sign in with this organization's SSO to open it. */
  requireSso: z.boolean().default(false),
  /** ssoPerOrganization: every email on the verified SSO domain must sign in with this organization's SSO. */
  restrictDomainToSso: z.boolean().default(false),
  /** Hours a sign-in lasts without activity. */
  sessionLengthHours: z.literal(SESSION_LENGTH_HOURS).default(DEFAULT_SESSION_LENGTH_HOURS),
  /** Days a sign-in lasts at most. */
  maxSessionLengthDays: z.literal(MAX_SESSION_LENGTH_DAYS).default(DEFAULT_MAX_SESSION_LENGTH_DAYS),
  /** Minutes since sign-in before sensitive changes ask again; 0 is off. */
  adminReauthMinutes: z.literal(ADMIN_REAUTH_MINUTES).default(DEFAULT_ADMIN_REAUTH_MINUTES),
}).strict()

const oidcSpecSchema = z.object({
  clientId: z.string().trim().min(1).max(512),
  clientSecret: specSecretSchema,
  scopes: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  /** false: endpoints are discovered from the issuer at apply time. */
  skipDiscovery: z.boolean().default(true),
  authorizationEndpoint: z.string().url().max(2048).nullable().default(null),
  tokenEndpoint: z.string().url().max(2048).nullable().default(null),
  jwksEndpoint: z.string().url().max(2048).nullable().default(null),
  userInfoEndpoint: z.string().url().max(2048).nullable().default(null),
  tokenEndpointAuthentication: z.enum(["client_secret_basic", "client_secret_post"]).nullable().default(null),
}).strict()

const samlSpecSchema = z.object({
  entryPoint: z.string().url().max(2048),
  /** The identity provider's public signing certificate (PEM). Never a private key. */
  cert: z.string().trim().min(1).max(20_000).nullable().default(null),
  /** SP entity id; null uses this instance's default (its web origin). */
  audience: z.string().trim().min(1).max(2048).nullable().default(null),
}).strict()

/** Per-instance setup state, exported for reading only (never compared or applied). */
const ssoSetupSchema = z.object({
  domainVerified: z.boolean(),
  testStatus: z.string().max(32),
  redirectUrl: z.string().max(4096).nullable(),
  acsUrl: z.string().max(4096).nullable(),
  metadataUrl: z.string().max(4096).nullable(),
}).strict()

const ssoConnectionSpecSchema = z.object({
  kind: z.literal("sso-connection"),
  protocol: z.enum(["oidc", "saml"]),
  /** OIDC issuer URL, or the SAML identity provider's entity id. */
  issuer: z.string().url().max(2048),
  domains: z.array(z.string().trim().toLowerCase().min(1).max(253)).min(1).max(20),
  /** Applied on an existing connection only; a new one always starts disabled until tested. */
  enabled: z.boolean().default(false),
  oidc: oidcSpecSchema.nullable().default(null),
  saml: samlSpecSchema.nullable().default(null),
  setup: ssoSetupSchema.optional(),
}).strict()

const scimGroupInfoSchema = z.object({
  displayName: z.string().max(255),
  /** The team the IdP group created (create_teams), by name; null when none. */
  team: z.string().max(255).nullable(),
}).strict()

const scimSpecSchema = z.object({
  kind: z.literal("scim"),
  groupMappingMode: z.enum(["metadata_only", "create_teams"]).default("metadata_only"),
  /** The identity provider's groups, for reading only: the IdP pushes them on the target. */
  groups: z.array(scimGroupInfoSchema).max(2_000).optional(),
}).strict()

/** At apply time the placeholder carries a decision (keep / value / unset) instead: read by `resolvedSecret`. */
const ssoConnectionApplySchema = ssoConnectionSpecSchema.extend({
  oidc: oidcSpecSchema.extend({ clientSecret: z.unknown() }).nullable().default(null),
})

const authSecuritySpecSchema = z.discriminatedUnion("kind", [sessionSpecSchema, ssoConnectionSpecSchema, scimSpecSchema])

type SessionSpec = z.infer<typeof sessionSpecSchema>
type SsoConnectionSpec = z.infer<typeof ssoConnectionApplySchema>
type SessionField = Exclude<keyof SessionSpec, "kind">
const SESSION_FIELDS: readonly SessionField[] = ["requireSso", "restrictDomainToSso", "sessionLengthHours", "maxSessionLengthDays", "adminReauthMinutes"]

// ---------------------------------------------------------------------------
// Small helpers

function specKind(spec: unknown): string | null {
  return isJsonObject(spec) && typeof spec.kind === "string" ? spec.kind : null
}

function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase()
}

function sortedDomains(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim().toLowerCase()).sort() : []
}

function parseConfigJson(value: string | null): JsonObject | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/** First segment of a change path: "oidc.clientId" → "oidc", "domains[1]" → "domains". */
function topField(path: string): string {
  const match = /^[^.[\]]+/.exec(path)
  return match ? match[0] : path
}

function changedTopFields(changes: readonly ConfigFieldChange[]): Set<string> {
  return new Set(changes.map((change) => topField(change.path)))
}

/** Parses an item's spec at apply time; a mismatch is an item failure naming the field. */
function parseSpec<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(specObject(value))
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const field = issue?.path.filter((segment): segment is string | number => typeof segment !== "symbol").join(".")
  throw failure("invalid_spec", issue ? `${field || "spec"}: ${issue.message}` : "The setting is not valid.", field ? { field } : {})
}

function failure(code: string, message: string, options: { field?: string; step?: ConfigApplyStep; status?: number } = {}, stepsDone: ConfigApplyStep[] = []): ConfigApplyItemError {
  return new ConfigApplyItemError({ code, message, ...options }, stepsDone)
}

/** Re-throws a route error (ConfigApplyError) as an item failure that names the step and what was already written. */
async function step<T>(stepsDone: ConfigApplyStep[], current: ConfigApplyStep, field: string | undefined, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run()
    stepsDone.push(current)
    return result
  } catch (error) {
    if (error instanceof ConfigApplyItemError) throw error
    const code = error instanceof ConfigApplyError ? error.code : "apply_failed"
    const status = error instanceof ConfigApplyError ? error.status : undefined
    const message = error instanceof Error ? error.message : String(error)
    throw failure(code, message, { ...(field ? { field } : {}), step: current, ...(status ? { status } : {}) }, [...stepsDone])
  }
}

async function heldPermissions(ctx: ConfigAreaContext) {
  return resolvePermissionsForMember({
    organizationId: normalizeDenTypeId("organization", ctx.organizationId),
    memberId: normalizeDenTypeId("member", ctx.actor.memberId),
  })
}

/** The route's permission marker (orgPermissionRoute), which the in-process call does not run. */
async function requireActorPermission(ctx: ConfigAreaContext, key: PermissionKey) {
  if (!(await heldPermissions(ctx)).has(key)) throw failure("forbidden", permissionDeniedMessage(key), { status: 403 })
}

/**
 * Runs `run` with request headers carrying a real session of the applying
 * member. Better Auth's SSO plugin only registers providers for a signed-in
 * session (it reads the user and checks their membership itself); an apply
 * runs from a worker with no browser session. The session is created for
 * this call only and deleted afterwards.
 */
async function withActorAuthHeaders<T>(ctx: ConfigAreaContext, run: (headers: Headers) => Promise<T>): Promise<T> {
  const authContext = await auth.$context
  const session = await authContext.internalAdapter.createSession(normalizeDenTypeId("user", ctx.actor.userId), true)
  try {
    const signature = await makeSignature(session.token, authContext.secret)
    const headers = new Headers({ cookie: `${authContext.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}` })
    return await run(headers)
  } finally {
    await authContext.internalAdapter.deleteSession(session.token).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Reads

type SessionState = { spec: SessionSpec; metadataRequireSso: boolean; metadataRestrictDomain: boolean }

async function readSessionState(ctx: ConfigAreaContext): Promise<SessionState> {
  const [row] = await ctx.db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", ctx.organizationId)))
    .limit(1)
  if (!row) throw failure("organization_not_found", "The organization no longer exists.", { status: 404 })
  const metadata = normalizeOrganizationMetadata(row.metadata).metadata
  const settings = readSessionSecuritySettings(row.metadata)
  const requireSso = metadata.requireSso === true
  const restrictDomainToSso = metadata.restrictDomainToSso === true
  return {
    spec: { kind: "session", requireSso, restrictDomainToSso, ...settings },
    metadataRequireSso: requireSso,
    metadataRestrictDomain: restrictDomainToSso,
  }
}

function sessionItem(ctx: ConfigAreaContext, spec: SessionSpec): ConfigItem {
  return { id: ctx.organizationId, key: null, name: SESSION_ITEM_NAME, spec }
}

/** The audience Den uses when none was entered: this instance's own, so it is never carried. */
function portableAudience(value: unknown): string | null {
  const audience = stringOrNull(value)
  if (!audience) return null
  return normalizeIssuer(audience) === normalizeIssuer(env.betterAuthUrl) ? null : audience
}

/** A public certificate only; anything that looks like key material is never exported. */
function portableCertificate(value: unknown): string | null {
  const cert = stringOrNull(value)
  if (!cert || /PRIVATE KEY/i.test(cert)) return null
  return cert
}

function ssoConnectionItem(connection: SsoConnection, provider: SsoProvider | null): ConfigItem {
  const protocol = connection.kind === "saml" ? "saml" : "oidc"
  const oidcConfig = protocol === "oidc" ? parseConfigJson(provider?.oidcConfig ?? null) : null
  const samlConfig = protocol === "saml" ? parseConfigJson(provider?.samlConfig ?? null) : null
  const tokenAuth = oidcConfig?.tokenEndpointAuthentication
  const spec: SsoConnectionSpec = {
    kind: "sso-connection",
    protocol,
    issuer: connection.issuer,
    domains: parseSsoDomains(connection.domain).sort(),
    enabled: isOrganizationSsoReady({ connection, provider }),
    // Allowlist: everything else in the encrypted configuration (secrets,
    // attribute mapping, PKCE, callback URLs, cached metadata) stays behind.
    oidc: protocol === "oidc" ? {
      clientId: stringOrNull(oidcConfig?.clientId) ?? "",
      clientSecret: secretPlaceholder(AREA, connection.id, "oidc.clientSecret", Boolean(stringOrNull(oidcConfig?.clientSecret))),
      scopes: Array.isArray(oidcConfig?.scopes) ? oidcConfig.scopes.filter((scope): scope is string => typeof scope === "string") : [],
      skipDiscovery: typeof oidcConfig?.skipDiscovery === "boolean" ? oidcConfig.skipDiscovery : true,
      authorizationEndpoint: stringOrNull(oidcConfig?.authorizationEndpoint),
      tokenEndpoint: stringOrNull(oidcConfig?.tokenEndpoint),
      jwksEndpoint: stringOrNull(oidcConfig?.jwksEndpoint),
      userInfoEndpoint: stringOrNull(oidcConfig?.userInfoEndpoint),
      tokenEndpointAuthentication: tokenAuth === "client_secret_basic" || tokenAuth === "client_secret_post" ? tokenAuth : null,
    } : null,
    saml: protocol === "saml" ? {
      entryPoint: stringOrNull(samlConfig?.entryPoint) ?? connection.issuer,
      cert: portableCertificate(samlConfig?.cert),
      audience: portableAudience(samlConfig?.audience),
    } : null,
    setup: {
      domainVerified: provider?.domainVerified ?? false,
      testStatus: getSsoTestPresentation(connection).testStatus,
      redirectUrl: protocol === "oidc" ? getSsoOidcRedirectUrl(connection.providerId) : null,
      acsUrl: protocol === "saml" ? getSsoAcsUrl(connection.providerId) : null,
      metadataUrl: protocol === "saml" ? getSsoMetadataUrl(connection.providerId) : null,
    },
  }
  return { id: connection.id, key: null, name: connection.name?.trim() || defaultSsoConnectionName(connection.issuer), spec }
}

async function readSsoItems(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const connectionIds = ids === null ? null : ids.filter((id) => isDenTypeId("ssoConnection", id)).map((id) => normalizeDenTypeId("ssoConnection", id))
  const connections = connectionIds === null
    ? await listOrganizationSsoConnections(organizationId, ctx.db)
    : connectionIds.length === 0 ? [] : await ctx.db.select().from(SsoConnectionTable)
      .where(and(eq(SsoConnectionTable.organizationId, organizationId), inArray(SsoConnectionTable.id, connectionIds)))
  const items: ConfigItem[] = []
  for (const connection of connections) items.push(ssoConnectionItem(connection, await getSsoProviderForConnection(connection, ctx.db)))
  return items
}

async function readScimItem(ctx: ConfigAreaContext): Promise<ConfigItem | null> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const [provider] = await ctx.db.select().from(ScimProviderTable).where(eq(ScimProviderTable.organizationId, organizationId)).limit(1)
  if (!provider) return null
  const groups = await ctx.db
    .select({ displayName: ScimGroupTable.displayName, team: TeamTable.name })
    .from(ScimGroupTable)
    .leftJoin(TeamTable, eq(TeamTable.id, ScimGroupTable.teamId))
    .where(and(eq(ScimGroupTable.organizationId, organizationId), eq(ScimGroupTable.providerId, provider.providerId)))
  return {
    id: provider.id,
    key: null,
    name: SCIM_ITEM_NAME,
    spec: {
      kind: "scim",
      groupMappingMode: provider.groupMappingMode === "create_teams" ? "create_teams" : "metadata_only",
      groups: groups
        .map((group) => ({ displayName: group.displayName, team: group.team ?? null }))
        .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    },
  }
}

async function readItemsById(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const wanted = ids === null ? null : new Set(ids)
  const items: ConfigItem[] = []
  if (!wanted || wanted.has(ctx.organizationId)) items.push(sessionItem(ctx, (await readSessionState(ctx)).spec))
  items.push(...await readSsoItems(ctx, ids))
  if (!wanted || ids?.some((id) => isDenTypeId("scimProvider", id))) {
    if ((await heldPermissions(ctx)).has("scim.view")) {
      const scim = await readScimItem(ctx)
      if (scim && (!wanted || wanted.has(scim.id))) items.push(scim)
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// Lock-out guard

/** Whether turning off / replacing / removing this connection would leave an organization that requires SSO with no way in. */
async function wouldLockOut(ctx: ConfigAreaContext, connection: SsoConnection): Promise<string | null> {
  const state = await readSessionState(ctx)
  if (!state.metadataRequireSso && !state.metadataRestrictDomain) return null
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  let readyOthers = 0
  let thisReady = false
  for (const candidate of await listOrganizationSsoConnections(organizationId, ctx.db)) {
    const ready = isOrganizationSsoReady({ connection: candidate, provider: await getSsoProviderForConnection(candidate, ctx.db) })
    if (!ready) continue
    if (candidate.id === connection.id) thisReady = true
    else readyOthers += 1
  }
  if (!thisReady || readyOthers > 0) return null
  return "This is the organization's only working SSO connection and SSO is required: members could no longer sign in. Turn off \"Require SSO\" (and \"Restrict this domain to our SSO\") first, then import again."
}

// ---------------------------------------------------------------------------
// Apply: session settings

async function applySession(ctx: ConfigAreaContext, op: Exclude<ConfigApplyOp, { kind: "delete" }>): Promise<ConfigApplyResult> {
  await requireActorPermission(ctx, "organization.update")
  const next = parseSpec(sessionSpecSchema, op.item.spec)
  const current = (await readSessionState(ctx)).spec
  const named = op.kind === "update" ? changedTopFields(op.changes) : new Set<string>(SESSION_FIELDS)
  const warnings: string[] = []
  const localId = ctx.organizationId
  let fields = SESSION_FIELDS.filter((field) => named.has(field) && current[field] !== next[field])

  if (fields.includes("restrictDomainToSso") && !await organizationFeatureEnabled(normalizeDenTypeId("organization", ctx.organizationId), "ssoPerOrganization")) {
    warnings.push("\"Restrict this domain to our SSO\" was not changed: it isn't available for this organization.")
    fields = fields.filter((field) => field !== "restrictDomainToSso")
  }
  if (fields.length === 0) return { localId, warnings, steps: [] }

  const steps: ConfigApplyStep[] = fields.map((field) => ({ action: "set", target: field, detail: String(next[field]) }))
  const enabling = fields.filter((field) => (field === "requireSso" || field === "restrictDomainToSso") && next[field] === true)
  if (enabling.length > 0 && !await hasEnabledOrganizationSsoConnection(normalizeDenTypeId("organization", ctx.organizationId))) {
    throw failure("sso_not_ready", "SSO can't be required yet: this organization has no enabled SSO connection with a verified domain. Set up, verify, test and enable a connection, then turn on \"Require SSO\".", { field: enabling[0], step: steps.find((entry) => entry.target === enabling[0]) })
  }

  const { c, payload } = await configRouteContext(ctx)
  const input = {
    ...(fields.includes("requireSso") ? { requireSso: next.requireSso } : {}),
    ...(fields.includes("restrictDomainToSso") ? { restrictDomainToSso: next.restrictDomainToSso } : {}),
    ...(fields.includes("sessionLengthHours") ? { sessionLengthHours: next.sessionLengthHours } : {}),
    ...(fields.includes("maxSessionLengthDays") ? { maxSessionLengthDays: next.maxSessionLengthDays } : {}),
    ...(fields.includes("adminReauthMinutes") ? { adminReauthMinutes: next.adminReauthMinutes } : {}),
  }
  try {
    await expectRouteOk(await updateOrganizationAction(c, payload, input), "Update sign-in settings")
  } catch (error) {
    if (error instanceof ConfigApplyError && error.code === "sso_session_required") {
      throw failure(error.code, "Requiring SSO must be turned on by an admin signed in through this organization's SSO, so nobody is locked out. Sign in with SSO and turn it on in Settings › Auth & Security; nothing was changed.", { field: enabling[0] ?? "requireSso", status: 409 })
    }
    const code = error instanceof ConfigApplyError ? error.code : "apply_failed"
    throw failure(code, error instanceof Error ? error.message : String(error), { ...(steps[0] ? { step: steps[0] } : {}) })
  }
  return { localId, warnings, steps }
}

// ---------------------------------------------------------------------------
// Apply: SSO connections

function registrationBody(spec: SsoConnectionSpec, name: string, clientSecret: string | null): { kind: "oidc" | "saml"; body: JsonObject } {
  const common = { issuer: spec.issuer, domains: spec.domains, name }
  if (spec.protocol === "saml") {
    if (!spec.saml) throw failure("invalid_spec", "A SAML connection needs its saml settings.", { field: "saml" })
    if (!spec.saml.cert) throw failure("needs_input", "Enter the identity provider's signing certificate (saml.cert).", { field: "saml.cert" })
    return {
      kind: "saml",
      body: { ...common, entryPoint: spec.saml.entryPoint, cert: spec.saml.cert, ...(spec.saml.audience ? { audience: spec.saml.audience } : {}) },
    }
  }
  const oidc = spec.oidc
  if (!oidc) throw failure("invalid_spec", "An OIDC connection needs its oidc settings.", { field: "oidc" })
  if (!clientSecret) throw failure("needs_input", "Enter the OIDC client secret for this connection.", { field: "oidc.clientSecret" })
  const optional = (key: string, value: string | null) => value ? { [key]: value } : {}
  return {
    kind: "oidc",
    body: {
      ...common,
      clientId: oidc.clientId,
      clientSecret,
      ...(oidc.scopes.length > 0 ? { scopes: oidc.scopes } : {}),
      skipDiscovery: oidc.skipDiscovery,
      ...optional("authorizationEndpoint", oidc.authorizationEndpoint),
      ...optional("tokenEndpoint", oidc.tokenEndpoint),
      ...optional("jwksEndpoint", oidc.jwksEndpoint),
      ...optional("userInfoEndpoint", oidc.userInfoEndpoint),
      ...optional("tokenEndpointAuthentication", oidc.tokenEndpointAuthentication),
    },
  }
}

/** The client secret to register with: a new value, or (keep) the one this connection already stores. */
function clientSecretFor(spec: SsoConnectionSpec, decision: ResolvedConfigSecret | null, stored: SsoProvider | null): string | null {
  if (spec.protocol !== "oidc") return null
  if (decision?.decision === "value") return decision.value
  if (decision?.decision === "unset") throw failure("invalid_spec", "An OIDC connection can't work without a client secret; enter one instead of unsetting it.", { field: "oidc.clientSecret" })
  return stringOrNull(parseConfigJson(stored?.oidcConfig ?? null)?.clientSecret)
}

function setupWarnings(connection: SsoConnection, provider: SsoProvider | null, wasEnabled: boolean): string[] {
  const warnings: string[] = []
  const domains = parseSsoDomains(connection.domain)
  if (!provider?.domainVerified) {
    const records = domains.map((domain) => getSsoDomainVerificationDnsName(connection.providerId, domain)).join(", ")
    warnings.push(`Domain verification doesn't carry over: verify ${domains.join(", ")} for this organization (DNS TXT record${domains.length > 1 ? "s" : ""} ${records}) in Settings › Auth & Security.`)
  }
  if (connection.kind === "saml") {
    warnings.push(`Ask the identity provider admin to use this instance's SAML URLs: ACS ${getSsoAcsUrl(connection.providerId)}, metadata ${getSsoMetadataUrl(connection.providerId)}.`)
  } else {
    warnings.push(`Ask the identity provider admin to add this redirect URL to the OIDC app: ${getSsoOidcRedirectUrl(connection.providerId)}.`)
  }
  warnings.push(wasEnabled
    ? "The connection was enabled in the source but starts disabled here: test it and enable it in Settings › Auth & Security."
    : "The connection is disabled until it is tested and enabled in Settings › Auth & Security.")
  return warnings
}

async function register(ctx: ConfigAreaContext, route: ConfigRouteContext, kind: "oidc" | "saml", body: JsonObject, target: SsoConnection | null | undefined): Promise<SsoConnection> {
  let outcome: Awaited<ReturnType<typeof registerConnection>>
  try {
    outcome = await withActorAuthHeaders(ctx, (headers) => registerConnection({ kind, payload: route.payload, headers, capture: auditChangeCapture(route.c), body, target }))
  } catch (error) {
    throw new ConfigApplyError("sso_registration_failed", error instanceof Error ? error.message : "The SSO connection could not be saved.")
  }
  if (outcome.ok) return outcome.connection
  if (outcome.status === 402) throw new ConfigApplyError("plan_required", "SSO requires a Team or Enterprise plan.", 402)
  const detail = outcome.body.details[0]
  throw new ConfigApplyError("invalid_request", detail ? detail.message : "The SSO configuration was rejected.", 400)
}

async function loadConnection(ctx: ConfigAreaContext, id: string): Promise<SsoConnection> {
  if (!isDenTypeId("ssoConnection", id)) throw failure("not_found", "The SSO connection no longer exists.", { status: 404 })
  const [connection] = await ctx.db.select().from(SsoConnectionTable)
    .where(and(eq(SsoConnectionTable.organizationId, normalizeDenTypeId("organization", ctx.organizationId)), eq(SsoConnectionTable.id, normalizeDenTypeId("ssoConnection", id))))
    .limit(1)
  if (!connection) throw failure("not_found", "The SSO connection no longer exists.", { status: 404 })
  return connection
}

async function createSsoConnection(ctx: ConfigAreaContext, op: Extract<ConfigApplyOp, { kind: "create" }>): Promise<ConfigApplyResult> {
  const spec = parseSpec(ssoConnectionApplySchema, op.item.spec)
  const raw = specObject(op.item.spec)
  const decision = spec.protocol === "oidc" && isJsonObject(raw.oidc) ? resolvedSecret(raw.oidc.clientSecret, "oidc.clientSecret") : null
  if (decision?.decision === "keep") throw failure("needs_input", "A new connection has no stored client secret to keep: enter the OIDC client secret.", { field: "oidc.clientSecret" })
  const { kind, body } = registrationBody(spec, op.item.name, clientSecretFor(spec, decision, null))
  const route = await configRouteContext(ctx)
  const existing = await listOrganizationSsoConnections(route.payload.organization.id, ctx.db)
  const createStep: ConfigApplyStep = { action: "create", target: "connection", detail: `${kind.toUpperCase()} ${spec.domains.join(", ")}` }
  // Same target as the dashboard: the first connection through /v1/sso/<kind>, more through /v1/sso/connections/<kind>.
  const connection = await step([], createStep, undefined, () => register(ctx, route, kind, body, existing.length === 0 ? undefined : null))
  const provider = await getSsoProviderForConnection(connection, ctx.db.$primary)
  return { localId: connection.id, warnings: setupWarnings(connection, provider, spec.enabled), steps: [createStep] }
}

const CONFIG_FIELDS = new Set(["protocol", "issuer", "domains", "oidc", "saml"])

async function updateSsoConnection(ctx: ConfigAreaContext, op: Extract<ConfigApplyOp, { kind: "update" }>): Promise<ConfigApplyResult> {
  if (specKind(op.previous.spec) !== "sso-connection") throw failure("kind_mismatch", "This item is a different kind of setting on the target.", { field: "kind" })
  const spec = parseSpec(ssoConnectionApplySchema, op.item.spec)
  const raw = specObject(op.item.spec)
  const connection = await loadConnection(ctx, op.targetId)
  const route = await configRouteContext(ctx)
  const changed = changedTopFields(op.changes)
  const replaceConfig = [...changed].some((field) => CONFIG_FIELDS.has(field)) || op.secretPaths.length > 0
  const rename = changed.has("name")
  const enabledChange = changed.has("enabled")
  const steps: ConfigApplyStep[] = []
  const warnings: string[] = []

  if (replaceConfig) {
    const lockOut = await wouldLockOut(ctx, connection)
    if (lockOut) throw failure("would_lock_out", lockOut, { field: [...changed].find((field) => CONFIG_FIELDS.has(field)) ?? "oidc.clientSecret", status: 409 })
    const stored = await getSsoProviderForConnection(connection, ctx.db)
    const decision = spec.protocol === "oidc" && isJsonObject(raw.oidc) ? resolvedSecret(raw.oidc.clientSecret, "oidc.clientSecret") : null
    const keepFromOtherProtocol = decision?.decision !== "value" && connection.kind !== spec.protocol
    if (spec.protocol === "oidc" && keepFromOtherProtocol) throw failure("needs_input", "The connection changes to OIDC: enter its client secret.", { field: "oidc.clientSecret" })
    const { kind, body } = registrationBody(spec, op.item.name, clientSecretFor(spec, decision, stored))
    const oldest = await getOrganizationSsoConnection(route.payload.organization.id, ctx.db)
    const isPrimary = oldest?.id === connection.id
    const replaceStep: ConfigApplyStep = { action: "update", target: "connection", detail: `configuration (${[...changed].filter((field) => CONFIG_FIELDS.has(field)).concat(op.secretPaths.length > 0 ? ["client secret"] : []).join(", ")})` }
    const updated = await step(steps, replaceStep, undefined, () => register(ctx, route, kind, body, isPrimary ? undefined : connection))
    const provider = await getSsoProviderForConnection(updated, ctx.db.$primary)
    warnings.push(...setupWarnings(updated, provider, spec.enabled).filter((warning) => !warning.startsWith("The connection was enabled") && !warning.startsWith("The connection is disabled")))
    warnings.push("The new configuration disables the connection until it is tested again in Settings › Auth & Security.")
    if (rename) steps.push({ action: "set", target: "name", detail: op.item.name })
  } else if (rename) {
    await step(steps, { action: "set", target: "name", detail: op.item.name }, "name", async () => {
      const renamed = await renameOrganizationSsoConnection(connection, op.item.name.trim() || null, auditChangeCapture(route.c))
      if (!renamed) throw new ConfigApplyError("not_found", "The SSO connection no longer exists.", 404)
    })
  }

  if (enabledChange) {
    const fresh = await loadConnection(ctx, connection.id)
    if (spec.enabled) {
      // Enabling needs a verified domain and a successful test of the current configuration.
      const enabled = await enableConnection(route.payload, fresh, auditChangeCapture(route.c))
      if (enabled.ok) steps.push({ action: "set", target: "enabled", detail: "true" })
      else warnings.push(`The connection was not enabled: ${enabled.message}`)
    } else if (fresh.status === "enabled") {
      const lockOut = await wouldLockOut(ctx, fresh)
      if (lockOut) throw failure("would_lock_out", lockOut, { field: "enabled", status: 409 }, [...steps])
      await step(steps, { action: "set", target: "enabled", detail: "false" }, "enabled", async () => {
        const disabled = await disableConnection(route.payload, fresh, auditChangeCapture(route.c))
        if (!disabled.ok) throw new ConfigApplyError("not_found", "The SSO connection no longer exists.", 404)
      })
    }
  }
  return { localId: connection.id, warnings, steps }
}

async function deleteSsoConnection(ctx: ConfigAreaContext, op: Extract<ConfigApplyOp, { kind: "delete" }>): Promise<ConfigApplyResult> {
  const connection = await loadConnection(ctx, op.targetId)
  const lockOut = await wouldLockOut(ctx, connection)
  if (lockOut) throw failure("would_lock_out", lockOut, { status: 409 })
  const route = await configRouteContext(ctx)
  const deleteStep: ConfigApplyStep = { action: "delete", target: "connection" }
  await step([], deleteStep, undefined, () => deleteConnection(route.payload, connection, auditChangeCapture(route.c)))
  return { localId: connection.id, steps: [deleteStep] }
}

// ---------------------------------------------------------------------------
// Apply: SCIM

async function applyScim(ctx: ConfigAreaContext, op: Exclude<ConfigApplyOp, { kind: "delete" }>): Promise<ConfigApplyResult> {
  await requireActorPermission(ctx, "scim.manage")
  const next = parseSpec(scimSpecSchema, op.item.spec)
  const route = await configRouteContext(ctx)
  const [provider] = await ctx.db.select().from(ScimProviderTable).where(eq(ScimProviderTable.organizationId, route.payload.organization.id)).limit(1)
  if (!provider) {
    // Nothing to write: a SCIM connection only exists once its token is generated (needs an enabled SSO connection).
    return {
      localId: op.item.sourceId ?? ctx.organizationId,
      warnings: [
        "SCIM provisioning isn't set up here and its token can't be carried over: once an SSO connection is enabled, generate a SCIM token in Settings › Auth & Security and give it and the SCIM URL to the identity provider.",
        `Then set group mapping to "${next.groupMappingMode === "create_teams" ? "Create teams from groups" : "Keep groups as metadata"}". The identity provider pushes its groups again; teams are created from them.`,
      ],
      steps: [],
    }
  }
  const current = provider.groupMappingMode === "create_teams" ? "create_teams" : "metadata_only"
  const named = op.kind === "update" ? changedTopFields(op.changes).has("groupMappingMode") : true
  if (!named || current === next.groupMappingMode) return { localId: provider.id, steps: [] }
  const modeStep: ConfigApplyStep = { action: "set", target: "groupMappingMode", detail: next.groupMappingMode }
  await step([], modeStep, "groupMappingMode", async () => {
    const updated = await updateScimGroupMappingMode({ payload: route.payload, connection: provider, mode: next.groupMappingMode, capture: auditChangeCapture(route.c) })
    if (!updated.ok) throw new ConfigApplyError("forbidden", permissionDeniedMessage(updated.permission), 403)
  })
  return { localId: provider.id, steps: [modeStep] }
}

// ---------------------------------------------------------------------------
// Preflight

/** The SSO switches this op turns on, as the session apply would compute them. */
function enabledSwitches(op: Exclude<ConfigApplyOp, { kind: "delete" }>): Array<"requireSso" | "restrictDomainToSso"> {
  const next = sessionSpecSchema.safeParse(op.item.spec)
  if (!next.success) return []
  const previous = op.kind === "update" ? sessionSpecSchema.safeParse(op.previous.spec) : null
  const named = op.kind === "update" ? changedTopFields(op.changes) : null
  return (["requireSso", "restrictDomainToSso"] as const).filter((field) => next.data[field]
    && (named === null || named.has(field))
    && !(previous?.success && previous.data[field]))
}

async function sessionPreflight(ctx: ConfigAreaContext, op: Exclude<ConfigApplyOp, { kind: "delete" }>): Promise<ConfigPreflightResult | null> {
  let switches = enabledSwitches(op)
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const perOrganization = await organizationFeatureEnabled(organizationId, "ssoPerOrganization")
  const warnings: string[] = []
  if (switches.includes("restrictDomainToSso") && !perOrganization) {
    warnings.push("\"Restrict this domain to our SSO\" isn't available for this organization and won't be changed.")
    switches = switches.filter((field) => field !== "restrictDomainToSso")
  }
  if (switches.length === 0) return warnings.length > 0 ? { warnings } : null
  if (!await hasEnabledOrganizationSsoConnection(organizationId)) {
    return { block: "SSO can't be required yet: this organization has no enabled SSO connection with a verified domain. Set up, verify, test and enable a connection first (a connection this import creates starts disabled), or skip this item and turn on \"Require SSO\" by hand later." }
  }
  if (perOrganization) {
    return { block: "Requiring SSO must be turned on by an admin signed in through this organization's SSO, so nobody is locked out; an import can't. Skip this item (or set it to off) and turn it on in Settings › Auth & Security." }
  }
  return warnings.length > 0 ? { warnings } : null
}

function ssoConnectionPreflight(op: Exclude<ConfigApplyOp, { kind: "delete" }>, info: ConfigPreflightInfo): ConfigPreflightResult | null {
  const spec = ssoConnectionApplySchema.safeParse(op.item.spec)
  if (!spec.success) return null
  if (spec.data.protocol === "saml" && !spec.data.saml?.cert && op.kind === "create") {
    return { block: "Enter the identity provider's signing certificate (saml.cert) in the file, or skip this connection." }
  }
  if (spec.data.protocol !== "oidc") return null
  const decision = info.secrets.find((secret) => secret.field === "oidc.clientSecret")?.decision
  if (decision === "unset") return { block: "An OIDC connection can't work without a client secret: enter one instead of leaving it unset, or skip this connection." }
  if (op.kind === "create" && decision === "keep") return { block: "A new connection has no stored client secret to keep: enter the OIDC client secret." }
  return null
}

// ---------------------------------------------------------------------------
// Irreversible effects

function sessionIrreversible(op: ConfigApplyOp): string[] {
  if (op.kind === "delete") return []
  const next = sessionSpecSchema.safeParse(op.item.spec)
  if (!next.success) return []
  const previous = op.kind === "update" ? sessionSpecSchema.safeParse(op.previous.spec) : null
  const before = previous?.success ? previous.data : null
  const out: string[] = []
  if ((next.data.requireSso && before?.requireSso !== true) || (next.data.restrictDomainToSso && before?.restrictDomainToSso !== true)) {
    out.push("Members signed in with a password or Google must sign in again with SSO to open the organization.")
  }
  if (!before || next.data.sessionLengthHours < before.sessionLengthHours || next.data.maxSessionLengthDays < before.maxSessionLengthDays) {
    out.push("Members' sign-ins longer than the new session limits end now; they must sign in again.")
  }
  return out
}

function ssoIrreversible(op: ConfigApplyOp): string[] {
  if (op.kind === "delete") return ["The SSO identities linked through this connection are removed; members link them again after SSO is set up anew."]
  if (op.kind === "create") return []
  const changed = changedTopFields(op.changes)
  const out: string[] = []
  if ([...changed].some((field) => CONFIG_FIELDS.has(field)) || op.secretPaths.length > 0) {
    out.push("The connection is disabled until its new configuration is tested; members can't sign in with it meanwhile.")
    out.push("Its domain verification may restart: the DNS record must be checked again unless another connection already verified the domains.")
  }
  return out
}

function scimIrreversible(op: ConfigApplyOp): string[] {
  if (op.kind !== "update" || !changedTopFields(op.changes).has("groupMappingMode")) return []
  return [
    "Teams created from SCIM groups lose their permission sets and Admin designation; an owner must set them again.",
    "Switching to \"Create teams from groups\" replaces those teams' members with the identity provider's group members.",
  ]
}

// ---------------------------------------------------------------------------

export const settingsAuthSecurityArea = defineConfigArea({
  key: AREA,
  label: "Auth & Security",
  path: ["Settings", "Auth & Security"],
  specVersion: 1,
  specSchema: authSecuritySpecSchema,
  // No references: SCIM groups and their teams are pushed by the identity provider (see `groups`).
  dependsOn: [],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "sso.view",
  managePermission: "sso.manage",
  // organization.metadata (requireSso, restrictDomainToSso, session settings) is shared with settings.general's `organization`.
  tables: ["sso_connection", "sso_provider", "scim_provider"],
  naturalKeys: [
    { label: "setting", get: (item) => {
      const kind = specKind(item.spec)
      return kind === "session" || kind === "scim" ? kind : null
    } },
    { label: "issuer and domains", get: (item) => {
      if (specKind(item.spec) !== "sso-connection" || typeof item.spec.issuer !== "string") return null
      return `${String(item.spec.protocol)} ${normalizeIssuer(item.spec.issuer)} ${sortedDomains(item.spec.domains).join(",")}`
    } },
    { label: "issuer", get: (item) => specKind(item.spec) === "sso-connection" && typeof item.spec.issuer === "string" ? normalizeIssuer(item.spec.issuer) : null },
  ],
  secretFields: ["oidc.clientSecret"],
  informationalFields: ["setup", "groups"],
  transactional: false,
  // OIDC discovery at the issuer; the IdP must be updated with this instance's URLs.
  externalEffects: true,
  protectedFromDelete: (item) => {
    const kind = specKind(item.spec)
    if (kind === "session") return "Sign-in settings can't be deleted."
    if (kind === "scim") return "Removing SCIM provisioning deprovisions the people and teams it manages: do it in Settings › Auth & Security."
    return null
  },
  async preflight(ctx, op, info) {
    if (op.kind === "delete") return null
    const kind = specKind(op.item.spec)
    if (kind === "session") return sessionPreflight(ctx, op)
    if (kind === "sso-connection") return ssoConnectionPreflight(op, info)
    return null
  },

  irreversible(op) {
    const kind = specKind(op.kind === "delete" ? op.previous.spec : op.item.spec)
    if (kind === "session") return sessionIrreversible(op)
    if (kind === "scim") return scimIrreversible(op)
    if (kind === "sso-connection") return ssoIrreversible(op)
    return []
  },

  async exportItems(ctx) {
    return readItemsById(ctx, null)
  },

  async readItems(ctx, ids) {
    return readItemsById(ctx, ids)
  },

  async apply(ctx, op): Promise<ConfigApplyResult> {
    const kind = specKind(op.kind === "delete" ? op.previous.spec : op.item.spec)
    if (op.kind === "update" && specKind(op.previous.spec) !== kind) {
      throw failure("kind_mismatch", "This item is a different kind of setting on the target: match it to an item of the same kind.", { field: "kind" })
    }
    if (kind === "session") {
      if (op.kind === "delete") throw failure("not_deletable", "Sign-in settings can't be deleted.")
      return applySession(ctx, op)
    }
    if (kind === "scim") {
      if (op.kind === "delete") throw failure("not_deletable", "SCIM provisioning can't be removed by an import.")
      return applyScim(ctx, op)
    }
    if (kind === "sso-connection") {
      await requireActorPermission(ctx, "sso.manage")
      if (op.kind === "create") return createSsoConnection(ctx, op)
      if (op.kind === "update") return updateSsoConnection(ctx, op)
      return deleteSsoConnection(ctx, op)
    }
    throw failure("invalid_spec", `Unknown kind of Auth & Security setting: ${kind ?? "missing"}.`, { field: "kind" })
  },
})
