/**
 * `connectors.mcp`: external MCP connections (Connectors › MCP) and who can
 * use them.
 *
 * Exported per connection: URL, auth type, credential mode, direct exposure,
 * API-key transport, OAuth settings (issuer, scopes, manual endpoints) and the
 * administrator's pre-registered OAuth client (client id, token endpoint auth
 * method), plus direct access grants (org-wide, teams, people by email).
 *
 * Secrets become placeholders: the shared API key, each request header value
 * and the pre-registered client's secret. Never exported at all: the
 * org-shared OAuth tokens (runtime sign-in state; people sign in again),
 * per-member credentials, SDK-registered (dynamic) OAuth clients and cached
 * discovery, readiness and health state.
 *
 * Not in v1: native-provider connections (kind `native_provider`), the tool
 * policy, and grants that come from marketplace plugin bindings (those follow
 * the plugin). An apply never changes them.
 *
 * Applies through the same handlers as POST/PUT/DELETE /v1/mcp-connections
 * (`createExternalConnectionResponse`, `replaceExternalConnectionResponse`,
 * `deleteExternalConnection`): API-key and no-auth connections are probed
 * before they are saved (a failed probe fails the item), and OAuth discovery
 * is checked.
 */
import { manualOAuthEndpointSchema } from "@openwork/enterprise-mcp-client"
import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { ExternalMcpConnectionAccessGrantTable, ExternalMcpConnectionTable, OrgOAuthClientTable } from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigApplyStep, ConfigSpec } from "@openwork/types/den/config-blobs"
import { z } from "zod"
import {
  getExternalMcpConnection,
  isSdkRegisteredOAuthClient,
  listDirectExternalMcpConnectionAccess,
  normalizeExternalMcpIdentityUrl,
} from "../../capability-sources/external-mcp-connections.js"
import { externalMcpRequestHeaderNames } from "../../capability-sources/external-mcp-request-headers.js"
import { externalMcpUrlCredentialProblems, redactExternalMcpUrlCredentials } from "../../capability-sources/external-mcp-url-credentials.js"
import { normalizeOAuthClientExtra } from "../../capability-sources/oauth-credentials.js"
import {
  createExternalConnectionResponse,
  deleteExternalConnection,
  replaceExternalConnectionResponse,
  type CreateExternalConnectionBody,
  type UpdateConnectionBody,
} from "../../routes/org/mcp-connections.js"
import { hasPermission } from "../../routes/org/shared.js"
import { defineConfigArea, type ConfigApplyOp, type ConfigApplyResult, type ConfigAreaContext, type ConfigItem } from "../area.js"
import {
  CONFIG_APPLY_SESSION_ID,
  ConfigApplyError,
  ConfigStepLog,
  applyWithSteps,
  audienceRefs,
  audienceSteps,
  configRouteContext,
  expectRouteOk,
  idDiff,
  isJsonObject,
  loadMemberEmails,
  loadTeamNames,
  opTouched,
  pathUnder,
  resolvedRefIds,
  resolvedSecret,
  secretEffects,
  secretIsSet,
  secretPlaceholder,
  specAudienceSchema,
  specObject,
  specSecretSchema,
  stringField,
  touches,
  type JsonObject,
} from "./route-support.js"

const AREA = "connectors.mcp"

const tokenEndpointAuthMethodSchema = z.enum(["client_secret_basic", "client_secret_post"])

/** Same rule as the route's manual sign-in addresses (HTTPS, no URL credentials or credential-like query parameters). */
const manualOAuthEndpointUrlSchema = z.string().trim().url().max(2048).refine(
  (value) => manualOAuthEndpointSchema.safeParse(value).success,
  "Use HTTPS (HTTP is allowed only on localhost), without URL credentials, fragments or credential-like query parameters.",
)

const specSchema = z.object({
  /**
   * The MCP server address. It can't carry credentials (a user name or
   * password, or `access_token`, `api_key`, `token`… in the query): use the
   * API key or a request header instead. An export shows any found in a stored
   * URL as `[redacted]`.
   */
  url: z.string().trim().url().max(2048),
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]),
  exposeDirectly: z.boolean(),
  /** How the shared or personal API key is sent. Only meaningful for apikey connections. */
  apiKeyAuthScheme: z.enum(["bearer", "token"]),
  /** The shared API key (apikey + shared only; otherwise null). */
  apiKey: specSecretSchema.nullable(),
  requestHeaders: z.array(z.object({
    name: z.string().trim().min(1).max(256),
    value: specSecretSchema,
  }).strict()).max(4),
  oauth: z.object({
    authorizationServerIssuer: z.string().trim().url().max(2048).nullable(),
    requestedScopes: z.array(z.string().trim().min(1).max(255)),
    manualOAuthEndpoints: z.object({
      authorizationEndpoint: manualOAuthEndpointUrlSchema,
      tokenEndpoint: manualOAuthEndpointUrlSchema,
    }).strict().nullable(),
    /** The administrator's pre-registered client. null: Den registers one itself when someone signs in. */
    client: z.object({
      clientId: z.string().trim().min(1).max(512),
      tokenEndpointAuthMethod: tokenEndpointAuthMethodSchema.nullable(),
      clientSecret: specSecretSchema,
    }).strict().nullable(),
  }).strict().nullable(),
  access: specAudienceSchema.extend({ orgWide: z.boolean() }).strict(),
}).strict()

type OAuthSpec = NonNullable<z.infer<typeof specSchema>["oauth"]>

function readTokenEndpointAuthMethod(value: unknown): "client_secret_basic" | "client_secret_post" | null {
  return value === "client_secret_basic" || value === "client_secret_post" ? value : null
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index])
}

/** The plain (non-secret) fields of a spec at apply time. Refs and secrets are read separately. */
const applySpecSchema = specSchema.omit({ apiKey: true, requestHeaders: true, oauth: true, access: true }).extend({
  oauth: z.object({
    authorizationServerIssuer: z.string().nullable(),
    requestedScopes: z.array(z.string()),
    manualOAuthEndpoints: z.object({ authorizationEndpoint: z.string(), tokenEndpoint: z.string() }).nullable(),
    client: z.object({ clientId: z.string(), tokenEndpointAuthMethod: tokenEndpointAuthMethodSchema.nullable() }).passthrough().nullable(),
  }).nullable(),
  access: z.object({ orgWide: z.boolean() }).passthrough(),
}).passthrough()

function parseApplySpec(spec: JsonObject) {
  const parsed = applySpecSchema.safeParse(spec)
  if (!parsed.success) throw new ConfigApplyError("invalid_spec", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
  return parsed.data
}

type HeaderDecision = { name: string; value: string | null | undefined }

function readHeaderDecisions(value: unknown): HeaderDecision[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): HeaderDecision[] => {
    if (!isJsonObject(entry) || typeof entry.name !== "string") return []
    const secret = resolvedSecret(entry.value, `request header ${entry.name}`)
    if (!secret || secret.decision === "keep") return [{ name: entry.name, value: undefined }]
    if (secret.decision === "unset") return [{ name: entry.name, value: null }]
    return [{ name: entry.name, value: secret.value }]
  })
}

function readAccess(spec: JsonObject) {
  const access = isJsonObject(spec.access) ? spec.access : {}
  return {
    orgWide: access.orgWide === true,
    teamIds: resolvedRefIds(access.teams, "access.teams"),
    memberIds: resolvedRefIds(access.members, "access.members"),
  }
}

function readClientSecret(spec: JsonObject) {
  const oauth = isJsonObject(spec.oauth) ? spec.oauth : null
  const client = oauth && isJsonObject(oauth.client) ? oauth.client : null
  return client ? resolvedSecret(client.clientSecret, "oauth.client.clientSecret") : null
}

/** A manual sign-in address that fails the route's rule only because of its user name, password or query string. */
function manualEndpointCredentials(value: string): boolean {
  if (manualOAuthEndpointSchema.safeParse(value).success) return false
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return false
  }
  if (!url.username && !url.password && !url.search) return false
  url.username = ""
  url.password = ""
  url.search = ""
  return manualOAuthEndpointSchema.safeParse(url.toString()).success
}

function redactManualEndpoint(value: string): string {
  const url = new URL(value.trim())
  if (url.username) url.username = "[redacted]"
  if (url.password) url.password = "[redacted]"
  const next = new URLSearchParams()
  for (const parameter of url.searchParams.keys()) if (!next.has(parameter)) next.append(parameter, "[redacted]")
  url.search = next.toString()
  return url.toString()
}

/**
 * Credentials in the connection's URL or manual sign-in addresses, replaced
 * before anything plans with them (format.md › Secrets: values never travel
 * in a blob). The problems name the field, never the value.
 */
export function redactConnectionCredentials(spec: ConfigSpec): { spec: ConfigSpec; problems: string[] } {
  const problems: string[] = []
  let next: ConfigSpec = spec
  if (typeof spec.url === "string") {
    const redacted = redactExternalMcpUrlCredentials(spec.url)
    if (redacted.found.length > 0) {
      problems.push(`url: holds a credential (${redacted.found.join(", ")}); MCP URLs can't carry credentials, so use the API key or a request header instead`)
      next = { ...next, url: redacted.url }
    }
  }
  const oauth = isJsonObject(spec.oauth) ? spec.oauth : null
  const manual = oauth && isJsonObject(oauth.manualOAuthEndpoints) ? oauth.manualOAuthEndpoints : null
  if (oauth && manual) {
    const endpoints: JsonObject = { ...manual }
    let changed = false
    for (const field of ["authorizationEndpoint", "tokenEndpoint"]) {
      const value = manual[field]
      if (typeof value !== "string" || !manualEndpointCredentials(value)) continue
      problems.push(`oauth.manualOAuthEndpoints.${field}: holds credentials or credential-like query parameters; sign-in addresses can't carry them`)
      endpoints[field] = redactManualEndpoint(value)
      changed = true
    }
    if (changed) next = { ...next, oauth: { ...oauth, manualOAuthEndpoints: endpoints } }
  }
  return { spec: next, problems }
}

/** The route's own rule, for the URL an op would save: no credentials, redacted ones included. */
function urlCredentialBlock(url: unknown, name: string, current: boolean): string | null {
  if (typeof url !== "string") return null
  const problems = externalMcpUrlCredentialProblems(url)
  if (problems.length === 0) return null
  return current
    ? `The saved URL of "${name}" holds a credential, which an import can't save again. Remove it from the URL in Connectors (use the API key or a request header instead), then plan again. ${problems.join(" ")}`
    : `The URL of "${name}" holds a credential; MCP URLs can't carry credentials (use the API key or a request header instead). ${problems.join(" ")}`
}

export const connectorsMcpArea = defineConfigArea({
  key: AREA,
  label: "MCP connections",
  path: ["Connectors", "MCP"],
  idPrefix: denTypeIdPrefixes.externalMcpConnection,
  specVersion: 1,
  specSchema,
  dependsOn: ["members.teams", "members.people"],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "connections.view",
  managePermission: "connections.manage",
  tables: ["external_mcp_connection", "external_mcp_connection_access_grant"],
  naturalKeys: [{
    label: "URL",
    get: (item) => typeof item.spec.url === "string" ? normalizeExternalMcpIdentityUrl(item.spec.url) : null,
  }],
  secretFields: ["apiKey", "requestHeaders[].value", "oauth.client.clientSecret"],
  redactCredentials: redactConnectionCredentials,
  arrayKeys: { requestHeaders: "name" },
  transactional: false,
  externalEffects: true,

  // POST/PUT /v1/mcp-connections refuse a URL with credentials; so does an import, before it runs.
  async preflight(_ctx, op) {
    if (op.kind === "delete") return null
    if (op.kind === "create" || touches(op.changes, "url")) {
      const block = urlCredentialBlock(op.item.spec.url, op.item.name, false)
      return block ? { block } : null
    }
    const block = urlCredentialBlock(op.previous.spec.url, op.previous.name, true)
    return block ? { block } : null
  },

  irreversible: (op) => {
    if (op.kind === "delete") {
      return [
        `People's sign-ins and personal keys for "${op.previous.name}" are deleted; they connect again after a restore.`,
        `Its shared API key, request header values and OAuth client secret are deleted; they must be re-entered to restore it.`,
      ]
    }
    if (op.kind !== "update") return []
    const out: string[] = []
    const changes = op.changes
    if (touches(changes, "url", "authType", "credentialMode", "apiKeyAuthScheme", "oauth.authorizationServerIssuer", "oauth.manualOAuthEndpoints")) {
      out.push(`Members' sign-ins to "${op.previous.name}" are revoked; they sign in again.`)
      if (touches(changes, "url", "authType", "credentialMode", "apiKeyAuthScheme", "oauth.authorizationServerIssuer") && isJsonObject(op.previous.spec.oauth) && isJsonObject(op.previous.spec.oauth.client)) {
        const secret = isJsonObject(op.item.spec.oauth) && isJsonObject(op.item.spec.oauth.client) ? op.item.spec.oauth.client.clientSecret : undefined
        if (secretIsSet(op.previous.spec.oauth.client.clientSecret) && !(isJsonObject(secret) && secret.decision === "value")) {
          out.push(`The OAuth client secret of "${op.previous.name}" is deleted (its identity changes); it must be re-entered.`)
        }
      }
    }
    if (op.previous.spec.authType === "apikey" && op.previous.spec.credentialMode === "per_member" && changes.some((change) => pathUnder(change.path, "access") && (change.removed?.length ?? 0) > 0)) {
      out.push(`People who lose access to "${op.previous.name}" lose their stored personal API key.`)
    }
    out.push(...secretEffects(op.item.spec.apiKey, `shared API key of "${op.previous.name}"`, op.previous.spec.apiKey))
    const headers = Array.isArray(op.item.spec.requestHeaders) ? op.item.spec.requestHeaders : []
    for (const header of headers) {
      if (!isJsonObject(header) || typeof header.name !== "string") continue
      const before = Array.isArray(op.previous.spec.requestHeaders) ? op.previous.spec.requestHeaders.find((entry) => isJsonObject(entry) && entry.name === header.name) : undefined
      out.push(...secretEffects(header.value, `value of request header ${header.name}`, isJsonObject(before) ? before.value : { set: false }))
    }
    if (isJsonObject(op.item.spec.oauth) && isJsonObject(op.item.spec.oauth.client)) {
      const previousClient = isJsonObject(op.previous.spec.oauth) && isJsonObject(op.previous.spec.oauth.client) ? op.previous.spec.oauth.client : null
      out.push(...secretEffects(op.item.spec.oauth.client.clientSecret, `OAuth client secret of "${op.previous.name}"`, previousClient?.clientSecret ?? { set: false }))
    }
    return [...new Set(out)]
  },

  async exportItems(ctx) {
    return readConnections(ctx, null)
  },

  async readItems(ctx, ids) {
    return readConnections(ctx, ids)
  },

  async apply(ctx, op): Promise<ConfigApplyResult> {
    return applyWithSteps((log) => applyConnection(ctx, op, log))
  },
})

async function applyConnection(ctx: ConfigAreaContext, op: ConfigApplyOp, log: ConfigStepLog): Promise<Omit<ConfigApplyResult, "steps">> {
  const { c, payload, requestId } = await configRouteContext(ctx)

  if (op.kind === "delete") {
    const connection = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: normalizeDenTypeId("externalMcpConnection", op.targetId) })
    if (!connection) return { localId: op.targetId, warnings: ["The connection was already removed."] }
    await log.run({ action: "delete", target: "connection", detail: connection.name }, async () => {
      const result = await deleteExternalConnection(c, payload, connection)
      if (result.response) await expectRouteOk(result.response, `Remove "${connection.name}"`)
    })
    return { localId: connection.id }
  }

  const raw = specObject(op.item.spec)
  const spec = parseApplySpec(raw)
  const specAccess = readAccess(raw)
  const headers = readHeaderDecisions(raw.requestHeaders)
  const apiKeySecret = resolvedSecret(raw.apiKey, "apiKey")
  const clientSecret = readClientSecret(raw)
  const warnings: string[] = []
  const accessInput = { orgWide: specAccess.orgWide, memberIds: specAccess.memberIds, teamIds: specAccess.teamIds }

  if (op.kind === "create") {
    const urlBlock = urlCredentialBlock(spec.url, op.item.name, false)
    if (urlBlock) throw new ConfigApplyError("invalid_mcp_url", urlBlock)
    const droppedHeaders = headers.filter((header) => typeof header.value !== "string").map((header) => header.name)
    if (droppedHeaders.length > 0) warnings.push(`Request headers without a value were not created: ${droppedHeaders.join(", ")}.`)
    if (spec.authType === "apikey" && spec.credentialMode === "shared" && apiKeySecret?.decision !== "value") {
      warnings.push("Created without its shared API key: someone must enter it before the connection works.")
    }
    const client = spec.oauth?.client
    const body: CreateExternalConnectionBody = {
      name: op.item.name,
      url: spec.url,
      authType: spec.authType,
      credentialMode: spec.credentialMode,
      exposeDirectly: spec.exposeDirectly,
      ...(apiKeySecret?.decision === "value" ? { apiKey: apiKeySecret.value } : {}),
      ...(spec.authType === "apikey" ? { apiKeyAuthScheme: spec.apiKeyAuthScheme } : {}),
      ...(spec.authType !== "none" || headers.length > 0
        ? { requestHeaders: headers.flatMap((header) => typeof header.value === "string" ? [{ name: header.name, value: header.value }] : []) }
        : {}),
      ...(spec.authType === "oauth" && spec.oauth
        ? {
            ...(client ? {
              oauthClient: {
                clientId: client.clientId,
                ...(clientSecret?.decision === "value" ? { clientSecret: clientSecret.value } : {}),
                ...(client.tokenEndpointAuthMethod ? { tokenEndpointAuthMethod: client.tokenEndpointAuthMethod } : {}),
              },
            } : {}),
            ...(spec.oauth.manualOAuthEndpoints ? { manualOAuthEndpoints: spec.oauth.manualOAuthEndpoints } : {}),
            ...(spec.oauth.authorizationServerIssuer ? { authorizationServerIssuer: spec.oauth.authorizationServerIssuer } : {}),
            ...(spec.oauth.requestedScopes.length > 0 ? { requestedScopes: spec.oauth.requestedScopes } : {}),
          }
        : {}),
      access: accessInput,
    }
    const localId = await log.run({ action: "create", target: "connection", detail: op.item.name }, async () => {
      const created = await expectRouteOk(await createExternalConnectionResponse(
        c, payload, body, op.item.key ?? undefined, 201, CONFIG_APPLY_SESSION_ID, requestId, false,
        op.preferredId ? { preferredId: normalizeDenTypeId("externalMcpConnection", op.preferredId) } : {},
      ), `Create "${op.item.name}"`)
      return stringField(created, "id")
    })
    return { localId, warnings }
  }

  const connection = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: normalizeDenTypeId("externalMcpConnection", op.targetId) })
  if (!connection) throw new ConfigApplyError("connection_not_found", `The connection "${op.previous.name}" no longer exists.`, 404)
  // Same checks as PUT /v1/mcp-connections/:connectionId before it replaces.
  const canUpdateAnyConnection = await hasPermission(c, "connections.update")
  if (!canUpdateAnyConnection && connection.createdByOrgMembershipId !== payload.currentMember.id) {
    throw new ConfigApplyError("forbidden", `Only people allowed to edit any connection, or its creator, can edit "${connection.name}".`, 403)
  }
  const touched = opTouched(op)
  const inScope = (...paths: string[]) => touches(touched, ...paths)
  if (inScope("key") && (op.item.key ?? null) !== (connection.externalKey ?? null)) {
    warnings.push("A connection's key can't change; the existing key was kept.")
  }
  if (apiKeySecret?.decision === "unset") warnings.push("A saved shared API key can't be cleared by an import; it was kept.")

  // The PUT handler replaces the connection, so every part the plan does not change is sent
  // as stored: updateExternalMcpConnection then writes only what differs (row fields, the
  // OAuth client, and access grants as a diff).
  const name = inScope("name") ? op.item.name : connection.name
  const url = inScope("url") ? spec.url : connection.url
  // The route's schema refuses this URL on PUT; the handler called here has no schema of its own.
  const urlBlock = urlCredentialBlock(url, connection.name, !inScope("url"))
  if (urlBlock) throw new ConfigApplyError("invalid_mcp_url", urlBlock)
  const authType = inScope("authType") ? spec.authType : connection.authType
  const credentialMode = inScope("credentialMode") ? spec.credentialMode : connection.credentialMode
  const authTypeChanges = authType !== connection.authType
  const headersInScope = inScope("requestHeaders") || (inScope("url") && normalizeExternalMcpIdentityUrl(url) !== normalizeExternalMcpIdentityUrl(connection.url))
  const unsetHeaders = headersInScope ? headers.filter((header) => header.value === null).map((header) => header.name) : []
  if (unsetHeaders.length > 0) warnings.push(`Request headers set to "unset" were removed: ${unsetHeaders.join(", ")}.`)

  const stored = connection.oauthConfiguration
  const storedClient = spec.oauth?.client
    ? await ctx.db.select().from(OrgOAuthClientTable).where(and(eq(OrgOAuthClientTable.organizationId, payload.organization.id), eq(OrgOAuthClientTable.providerId, connection.id))).limit(1).then((rows) => rows[0] ?? null)
    : null
  const storedClientExtra = storedClient ? normalizeOAuthClientExtra(storedClient.extra) : null
  const client = spec.oauth?.client ?? null
  const clientChanged = client !== null && (inScope("oauth.client") || authTypeChanges) && (
    client.clientId !== storedClient?.clientId
    || (client.tokenEndpointAuthMethod !== null && client.tokenEndpointAuthMethod !== readTokenEndpointAuthMethod(storedClientExtra?.tokenEndpointAuthMethod))
    || clientSecret?.decision === "value"
  )
  const oauth = authType === "oauth" ? spec.oauth : null
  const issuer = oauth?.authorizationServerIssuer ?? null
  const manual = oauth?.manualOAuthEndpoints ?? null
  const storedManual = stored?.manualOAuthEndpoints ?? null
  const issuerChanged = oauth !== null && (inScope("oauth.authorizationServerIssuer") || authTypeChanges) && issuer !== (stored?.authorizationServerIssuer ?? null)
  const scopesChanged = oauth !== null && (inScope("oauth.requestedScopes") || authTypeChanges) && !sameStrings(oauth.requestedScopes, stored?.requestedScopes ?? [])
  const manualChanged = oauth !== null && (inScope("oauth.manualOAuthEndpoints") || authTypeChanges)
    && (manual?.authorizationEndpoint !== storedManual?.authorizationEndpoint || manual?.tokenEndpoint !== storedManual?.tokenEndpoint)
  const directGrants = await listDirectExternalMcpConnectionAccess({ organizationId: payload.organization.id, connectionId: connection.id })
  const accessNow = {
    orgWide: directGrants.some((grant) => grant.orgWide),
    memberIds: [...new Set(directGrants.flatMap((grant) => grant.orgMembershipId ? [grant.orgMembershipId] : []))],
    teamIds: [...new Set(directGrants.flatMap((grant) => grant.teamId ? [grant.teamId] : []))],
  }
  const access = inScope("access") ? accessInput : accessNow

  const body: UpdateConnectionBody = {
    expectedUpdatedAt: connection.updatedAt.toISOString(),
    name,
    url,
    authType,
    credentialMode,
    ...(inScope("exposeDirectly") ? { exposeDirectly: spec.exposeDirectly } : {}),
    ...(apiKeySecret?.decision === "value" ? { apiKey: apiKeySecret.value } : {}),
    ...(authType === "apikey" && inScope("apiKeyAuthScheme") ? { apiKeyAuthScheme: spec.apiKeyAuthScheme } : {}),
    ...(headersInScope
      ? { requestHeaders: headers.flatMap((header) => header.value === null ? [] : [header.value === undefined ? { name: header.name } : { name: header.name, value: header.value }]) }
      : {}),
    // Unchanged OAuth settings are not resent: a marketplace-bound connection refuses them even when equal.
    ...(oauth && client && clientChanged ? {
      oauthClient: {
        clientId: client.clientId,
        ...(clientSecret?.decision === "value" ? { clientSecret: clientSecret.value } : {}),
        ...(client.tokenEndpointAuthMethod ? { tokenEndpointAuthMethod: client.tokenEndpointAuthMethod } : {}),
      },
    } : {}),
    ...(issuerChanged ? { authorizationServerIssuer: issuer } : {}),
    ...(scopesChanged && oauth ? { requestedScopes: oauth.requestedScopes } : {}),
    ...(manualChanged ? { manualOAuthEndpoints: manual } : {}),
    access,
  }
  if (inScope("oauth.client") && oauth && client === null && op.previous.spec.oauth !== null && isJsonObject(op.previous.spec.oauth) && op.previous.spec.oauth.client !== null) {
    warnings.push("The pre-registered OAuth client can't be removed by an import; it was kept.")
  }

  const steps: ConfigApplyStep[] = [
    ...(name !== connection.name ? [{ action: "set" as const, target: "name", detail: name }] : []),
    ...(url !== connection.url ? [{ action: "set" as const, target: "url", detail: url }] : []),
    ...(authTypeChanges ? [{ action: "set" as const, target: "authType", detail: authType }] : []),
    ...(credentialMode !== connection.credentialMode ? [{ action: "set" as const, target: "credentialMode", detail: credentialMode }] : []),
    ...(body.exposeDirectly !== undefined && body.exposeDirectly !== connection.exposeDirectly ? [{ action: "set" as const, target: "exposeDirectly", detail: String(body.exposeDirectly) }] : []),
    ...(body.apiKeyAuthScheme !== undefined && body.apiKeyAuthScheme !== connection.apiKeyAuthScheme ? [{ action: "set" as const, target: "apiKeyAuthScheme", detail: body.apiKeyAuthScheme }] : []),
    ...(body.apiKey !== undefined ? [{ action: "set" as const, target: "apiKey" }] : []),
    ...(headersInScope ? headerSteps(op.previous.spec.requestHeaders, headers) : []),
    ...(body.oauthClient ? [{ action: "set" as const, target: "oauth.client", detail: body.oauthClient.clientId }] : []),
    ...(issuerChanged ? [{ action: "set" as const, target: "oauth.authorizationServerIssuer", detail: issuer ?? "discovered" }] : []),
    ...(scopesChanged && oauth ? [{ action: "set" as const, target: "oauth.requestedScopes", detail: oauth.requestedScopes.join(" ") || "default" }] : []),
    ...(manualChanged ? [{ action: "set" as const, target: "oauth.manualOAuthEndpoints", detail: manual ? manual.authorizationEndpoint : "discovery" }] : []),
    ...(inScope("access") ? [
      ...(access.orgWide !== accessNow.orgWide ? [{ action: "set" as const, target: "access.orgWide", detail: String(access.orgWide) }] : []),
      ...await audienceSteps(ctx.db, payload.organization.id, "access", {
        teams: idDiff(accessNow.teamIds, access.orgWide ? [] : access.teamIds),
        members: idDiff(accessNow.memberIds, access.orgWide ? [] : access.memberIds),
      }),
    ] : []),
  ]
  const [first, ...rest] = steps
  if (!first) return { localId: connection.id, warnings }
  // One PUT: all of these are written in one transaction, or none.
  await log.run(first, async () => {
    await expectRouteOk(await replaceExternalConnectionResponse(c, payload, body, connection, canUpdateAnyConnection, c.get("session"), requestId), `Update "${op.item.name}"`)
  })
  log.add(...rest)
  return { localId: connection.id, warnings }
}

function headerNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((header) => isJsonObject(header) && typeof header.name === "string" ? [header.name] : [])
}

/** One step per request header added, removed, given a new value or unset. */
function headerSteps(previous: unknown, next: HeaderDecision[]): ConfigApplyStep[] {
  const before = new Set(headerNames(previous))
  const after = new Set(next.filter((header) => header.value !== null).map((header) => header.name))
  return [
    ...next.filter((header) => header.value !== null && !before.has(header.name)).map((header): ConfigApplyStep => ({ action: "add", target: `requestHeaders[${header.name}]` })),
    ...next.filter((header) => typeof header.value === "string" && before.has(header.name)).map((header): ConfigApplyStep => ({ action: "set", target: `requestHeaders[${header.name}].value` })),
    ...[...before].filter((name) => !after.has(name)).map((name): ConfigApplyStep => ({ action: "remove", target: `requestHeaders[${name}]` })),
  ]
}

async function readConnections(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const connectionIds = ids?.flatMap((id) => {
    try {
      return [normalizeDenTypeId("externalMcpConnection", id)]
    } catch {
      return []
    }
  }) ?? null
  if (connectionIds && connectionIds.length === 0) return []
  const rows = await ctx.db
    .select()
    .from(ExternalMcpConnectionTable)
    .where(and(
      eq(ExternalMcpConnectionTable.organizationId, organizationId),
      eq(ExternalMcpConnectionTable.kind, "external_mcp"),
      connectionIds ? inArray(ExternalMcpConnectionTable.id, connectionIds) : undefined,
    ))
  if (rows.length === 0) return []
  const rowIds = rows.map((row) => row.id)
  const [grants, clients] = await Promise.all([
    ctx.db
      .select()
      .from(ExternalMcpConnectionAccessGrantTable)
      .where(and(
        eq(ExternalMcpConnectionAccessGrantTable.organizationId, organizationId),
        inArray(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, rowIds),
        isNull(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId),
      )),
    ctx.db
      .select()
      .from(OrgOAuthClientTable)
      .where(and(eq(OrgOAuthClientTable.organizationId, organizationId), inArray(OrgOAuthClientTable.providerId, rowIds))),
  ])
  const [teamNames, memberEmails] = await Promise.all([
    loadTeamNames(ctx.db, organizationId, grants.flatMap((grant) => grant.teamId ? [grant.teamId] : [])),
    loadMemberEmails(ctx.db, organizationId, grants.flatMap((grant) => grant.orgMembershipId ? [grant.orgMembershipId] : [])),
  ])
  const clientsByConnection = new Map(clients.map((client) => [client.providerId, client]))

  const items: ConfigItem[] = rows.map((row) => {
    const rowGrants = grants.filter((grant) => grant.externalMcpConnectionId === row.id)
    const client = clientsByConnection.get(row.id)
    const clientExtra = client ? normalizeOAuthClientExtra(client.extra) : null
    const configuration = row.oauthConfiguration
    const oauth: OAuthSpec | null = row.authType === "oauth"
      ? {
          authorizationServerIssuer: configuration?.authorizationServerIssuer ?? null,
          requestedScopes: [...(configuration?.requestedScopes ?? [])].sort(),
          manualOAuthEndpoints: configuration?.manualOAuthEndpoints
            ? {
                authorizationEndpoint: configuration.manualOAuthEndpoints.authorizationEndpoint,
                tokenEndpoint: configuration.manualOAuthEndpoints.tokenEndpoint,
              }
            : null,
          client: client && !isSdkRegisteredOAuthClient(clientExtra)
            ? {
                clientId: client.clientId,
                tokenEndpointAuthMethod: readTokenEndpointAuthMethod(clientExtra?.tokenEndpointAuthMethod),
                clientSecret: secretPlaceholder(AREA, row.id, "oauth.client.clientSecret", Boolean(client.clientSecret)),
              }
            : null,
        }
      : null
    const audience = audienceRefs({
      teamIds: rowGrants.flatMap((grant) => grant.teamId ? [grant.teamId] : []),
      memberIds: rowGrants.flatMap((grant) => grant.orgMembershipId ? [grant.orgMembershipId] : []),
      teamNames,
      memberEmails,
    })
    return {
      id: row.id,
      key: row.externalKey,
      name: row.name,
      spec: {
        // A URL saved before the route refused credentials in it: never exported, nor shown in a plan.
        url: redactExternalMcpUrlCredentials(row.url).url,
        authType: row.authType,
        credentialMode: row.credentialMode,
        exposeDirectly: row.exposeDirectly,
        apiKeyAuthScheme: row.authType === "apikey" ? row.apiKeyAuthScheme : "bearer",
        apiKey: row.authType === "apikey" && row.credentialMode === "shared"
          ? secretPlaceholder(AREA, row.id, "apiKey", Boolean(row.apiKey))
          : null,
        requestHeaders: externalMcpRequestHeaderNames(row.requestHeaders).map((name) => ({
          name,
          value: secretPlaceholder(AREA, row.id, `requestHeaders.${name}.value`, true),
        })),
        oauth,
        access: { orgWide: rowGrants.some((grant) => grant.orgWide), ...audience },
      },
    }
  })
  return items.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}
