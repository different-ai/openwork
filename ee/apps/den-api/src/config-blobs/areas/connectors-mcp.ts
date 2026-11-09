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
import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { ExternalMcpConnectionAccessGrantTable, ExternalMcpConnectionTable, OrgOAuthClientTable } from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import {
  getExternalMcpConnection,
  isSdkRegisteredOAuthClient,
  normalizeExternalMcpIdentityUrl,
} from "../../capability-sources/external-mcp-connections.js"
import { externalMcpRequestHeaderNames } from "../../capability-sources/external-mcp-request-headers.js"
import { normalizeOAuthClientExtra } from "../../capability-sources/oauth-credentials.js"
import {
  createExternalConnectionResponse,
  deleteExternalConnection,
  replaceExternalConnectionResponse,
  type CreateExternalConnectionBody,
  type UpdateConnectionBody,
} from "../../routes/org/mcp-connections.js"
import { hasPermission } from "../../routes/org/shared.js"
import { defineConfigArea, type ConfigApplyResult, type ConfigItem } from "../area.js"
import {
  CONFIG_APPLY_SESSION_ID,
  ConfigApplyError,
  audienceRefs,
  configRouteContext,
  expectRouteOk,
  isJsonObject,
  loadMemberEmails,
  loadTeamNames,
  resolvedRefIds,
  resolvedSecret,
  secretPlaceholder,
  specAudienceSchema,
  specObject,
  specSecretSchema,
  stringField,
  type JsonObject,
} from "./route-support.js"

const AREA = "connectors.mcp"

const tokenEndpointAuthMethodSchema = z.enum(["client_secret_basic", "client_secret_post"])

const specSchema = z.object({
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
      authorizationEndpoint: z.string().trim().url().max(2048),
      tokenEndpoint: z.string().trim().url().max(2048),
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
  arrayKeys: { requestHeaders: "name" },
  transactional: false,
  externalEffects: true,

  async exportItems(ctx) {
    const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
    const rows = await ctx.db
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(eq(ExternalMcpConnectionTable.organizationId, organizationId), eq(ExternalMcpConnectionTable.kind, "external_mcp")))
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const [grants, clients] = await Promise.all([
      ctx.db
        .select()
        .from(ExternalMcpConnectionAccessGrantTable)
        .where(and(
          eq(ExternalMcpConnectionAccessGrantTable.organizationId, organizationId),
          inArray(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, ids),
          isNull(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId),
        )),
      ctx.db
        .select()
        .from(OrgOAuthClientTable)
        .where(and(eq(OrgOAuthClientTable.organizationId, organizationId), inArray(OrgOAuthClientTable.providerId, ids))),
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
          url: row.url,
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
  },

  async apply(ctx, op): Promise<ConfigApplyResult> {
    const { c, payload, requestId } = await configRouteContext(ctx)

    if (op.kind === "delete") {
      const connection = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: normalizeDenTypeId("externalMcpConnection", op.targetId) })
      if (!connection) return { localId: op.targetId, warnings: ["The connection was already removed."] }
      const result = await deleteExternalConnection(c, payload, connection)
      if (result.response) await expectRouteOk(result.response, `Remove "${connection.name}"`)
      return { localId: connection.id }
    }

    const raw = specObject(op.item.spec)
    const spec = parseApplySpec(raw)
    const access = readAccess(raw)
    const headers = readHeaderDecisions(raw.requestHeaders)
    const apiKeySecret = resolvedSecret(raw.apiKey, "apiKey")
    const clientSecret = readClientSecret(raw)
    const warnings: string[] = []
    const accessInput = { orgWide: access.orgWide, memberIds: access.memberIds, teamIds: access.teamIds }

    if (op.kind === "create") {
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
      const created = await expectRouteOk(await createExternalConnectionResponse(
        c, payload, body, op.item.key ?? undefined, 201, CONFIG_APPLY_SESSION_ID, requestId, false,
        op.preferredId ? { preferredId: normalizeDenTypeId("externalMcpConnection", op.preferredId) } : {},
      ), `Create "${op.item.name}"`)
      return { localId: stringField(created, "id"), ...(warnings.length > 0 ? { warnings } : {}) }
    }

    const connection = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: normalizeDenTypeId("externalMcpConnection", op.targetId) })
    if (!connection) throw new ConfigApplyError("connection_not_found", `The connection "${op.previous.name}" no longer exists.`, 404)
    // Same checks as PUT /v1/mcp-connections/:connectionId before it replaces.
    const canUpdateAnyConnection = await hasPermission(c, "connections.update")
    if (!canUpdateAnyConnection && connection.createdByOrgMembershipId !== payload.currentMember.id) {
      throw new ConfigApplyError("forbidden", `Only people allowed to edit any connection, or its creator, can edit "${connection.name}".`, 403)
    }
    if ((op.item.key ?? null) !== (connection.externalKey ?? null)) {
      warnings.push("A connection's key can't change; the existing key was kept.")
    }
    if (apiKeySecret?.decision === "unset") warnings.push("A saved shared API key can't be cleared by an import; it was kept.")
    const unsetHeaders = headers.filter((header) => header.value === null).map((header) => header.name)
    if (unsetHeaders.length > 0) warnings.push(`Request headers set to "unset" were removed: ${unsetHeaders.join(", ")}.`)

    const stored = connection.oauthConfiguration
    const storedClient = spec.oauth?.client
      ? await ctx.db.select().from(OrgOAuthClientTable).where(and(eq(OrgOAuthClientTable.organizationId, payload.organization.id), eq(OrgOAuthClientTable.providerId, connection.id))).limit(1).then((rows) => rows[0] ?? null)
      : null
    const storedClientExtra = storedClient ? normalizeOAuthClientExtra(storedClient.extra) : null
    const client = spec.oauth?.client ?? null
    const clientChanged = client !== null && (
      client.clientId !== storedClient?.clientId
      || (client.tokenEndpointAuthMethod !== null && client.tokenEndpointAuthMethod !== readTokenEndpointAuthMethod(storedClientExtra?.tokenEndpointAuthMethod))
      || clientSecret?.decision === "value"
    )
    const oauth = spec.authType === "oauth" ? spec.oauth : null
    const issuer = oauth?.authorizationServerIssuer ?? null
    const manual = oauth?.manualOAuthEndpoints ?? null
    const storedManual = stored?.manualOAuthEndpoints ?? null

    const body: UpdateConnectionBody = {
      expectedUpdatedAt: connection.updatedAt.toISOString(),
      name: op.item.name,
      url: spec.url,
      authType: spec.authType,
      credentialMode: spec.credentialMode,
      exposeDirectly: spec.exposeDirectly,
      ...(apiKeySecret?.decision === "value" ? { apiKey: apiKeySecret.value } : {}),
      ...(spec.authType === "apikey" ? { apiKeyAuthScheme: spec.apiKeyAuthScheme } : {}),
      requestHeaders: headers.flatMap((header) => header.value === null ? [] : [header.value === undefined ? { name: header.name } : { name: header.name, value: header.value }]),
      // Unchanged OAuth settings are not resent: a marketplace-bound connection refuses them even when equal.
      ...(oauth && client && clientChanged ? {
        oauthClient: {
          clientId: client.clientId,
          ...(clientSecret?.decision === "value" ? { clientSecret: clientSecret.value } : {}),
          ...(client.tokenEndpointAuthMethod ? { tokenEndpointAuthMethod: client.tokenEndpointAuthMethod } : {}),
        },
      } : {}),
      ...(oauth && issuer !== (stored?.authorizationServerIssuer ?? null) ? { authorizationServerIssuer: issuer } : {}),
      ...(oauth && !sameStrings(oauth.requestedScopes, stored?.requestedScopes ?? []) ? { requestedScopes: oauth.requestedScopes } : {}),
      ...(oauth && (manual?.authorizationEndpoint !== storedManual?.authorizationEndpoint || manual?.tokenEndpoint !== storedManual?.tokenEndpoint)
        ? { manualOAuthEndpoints: manual }
        : {}),
      access: accessInput,
    }
    if (oauth && client === null && op.previous.spec.oauth !== null && isJsonObject(op.previous.spec.oauth) && op.previous.spec.oauth.client !== null) {
      warnings.push("The pre-registered OAuth client can't be removed by an import; it was kept.")
    }
    await expectRouteOk(await replaceExternalConnectionResponse(c, payload, body, connection, canUpdateAnyConnection, c.get("session"), requestId), `Update "${op.item.name}"`)
    return { localId: connection.id, ...(warnings.length > 0 ? { warnings } : {}) }
  },
})
