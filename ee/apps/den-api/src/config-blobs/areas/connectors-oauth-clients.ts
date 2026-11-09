/**
 * `connectors.oauth-clients`: the org's own OAuth apps for native providers
 * (Google Workspace, Microsoft 365, …), one per provider key.
 *
 * Scope (v1): rows whose `provider_id` is a registered native provider key.
 * Rows keyed by a connection id belong to that connection: an external MCP
 * connection's pre-registered client is exported inside `connectors.mcp`
 * (`oauth.client`), because its provider id IS the connection's id and a
 * separate item would reference its own owner. Clients of native-provider
 * connections (kind `native_provider`) and the sandbox's sample Microsoft
 * client are not exported in v1.
 *
 * Exported: client id, selected optional features, tenant id. Never the
 * client secret (a `$secret` placeholder) nor anything else in `extra`
 * (registration tokens, cached discovery).
 *
 * Applies through POST /v1/oauth-providers/:providerId/client
 * (`saveOrgOAuthProviderClient`): identity changes revoke members' sign-ins
 * first, as in the dashboard. Den has no route that removes an OAuth app, so
 * items are never deleted.
 */
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { OrgOAuthClientTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { normalizeOAuthClientExtra } from "../../capability-sources/oauth-credentials.js"
import { readProviderTenantId } from "../../capability-sources/oauth-tenant.js"
import { getNativeOAuthProvider } from "../../capability-sources/provider-registry.js"
import { isSandboxMicrosoftClient } from "../../capability-sources/sandbox-microsoft-endpoints.js"
import { saveOrgOAuthProviderClient, type SaveOrgOAuthProviderClientBody } from "../../routes/org/oauth-providers.js"
import { defineConfigArea, type ConfigApplyResult, type ConfigItem } from "../area.js"
import {
  ConfigApplyError,
  configRouteContext,
  expectRouteOk,
  resolvedSecret,
  secretPlaceholder,
  secretWrite,
  specObject,
  specSecretSchema,
} from "./route-support.js"

const AREA = "connectors.oauth-clients"

const specSchema = z.object({
  providerId: z.string().trim().min(1).max(255),
  clientId: z.string().trim().min(1).max(512),
  /** Optional permission features the members are asked for. null leaves the stored selection as it is. */
  features: z.array(z.string().trim().min(1).max(128)).nullable(),
  /** Microsoft Entra tenant, for providers bound to one tenant. */
  tenantId: z.string().trim().min(1).max(253).nullable(),
  clientSecret: specSecretSchema,
}).strict()

function readFeatures(extra: Record<string, unknown> | null): string[] | null {
  const value = extra?.features
  if (!Array.isArray(value)) return null
  return value.filter((feature): feature is string => typeof feature === "string").sort()
}

export const connectorsOAuthClientsArea = defineConfigArea({
  key: AREA,
  label: "OAuth apps",
  path: ["Connectors", "OAuth apps"],
  specVersion: 1,
  specSchema,
  dependsOn: [],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "oauth_clients.view",
  managePermission: "oauth_clients.manage",
  tables: ["org_oauth_client"],
  naturalKeys: [{
    label: "provider",
    get: (item) => typeof item.spec.providerId === "string" ? item.spec.providerId : null,
  }],
  secretFields: ["clientSecret"],
  uniqueFields: [{
    label: "provider",
    get: (item) => typeof item.spec.providerId === "string" ? item.spec.providerId : null,
  }],
  transactional: false,
  // Changing the client id or tenant revokes members' tokens at the provider.
  externalEffects: true,
  protectedFromDelete: () => "OAuth apps can't be removed in Den; change the client instead.",

  async exportItems(ctx) {
    const rows = await ctx.db
      .select()
      .from(OrgOAuthClientTable)
      .where(eq(OrgOAuthClientTable.organizationId, normalizeDenTypeId("organization", ctx.organizationId)))
    const items: ConfigItem[] = []
    for (const row of rows) {
      const provider = getNativeOAuthProvider(row.providerId)
      if (!provider) continue
      const extra = normalizeOAuthClientExtra(row.extra)
      if (isSandboxMicrosoftClient(extra)) continue
      items.push({
        id: row.id,
        key: null,
        name: provider.displayName,
        spec: {
          providerId: row.providerId,
          clientId: row.clientId,
          features: readFeatures(extra),
          tenantId: provider.tenantIdExtraKey ? readProviderTenantId(extra, provider.tenantIdExtraKey) : null,
          clientSecret: secretPlaceholder(AREA, row.id, "clientSecret", Boolean(row.clientSecret)),
        },
      })
    }
    return items.sort((left, right) => String(left.spec.providerId).localeCompare(String(right.spec.providerId)))
  },

  async apply(ctx, op): Promise<ConfigApplyResult> {
    if (op.kind === "delete") {
      throw new ConfigApplyError("not_supported", "OAuth apps can't be removed in Den.")
    }
    const spec = specObject(op.item.spec)
    const providerId = typeof spec.providerId === "string" ? spec.providerId : ""
    const clientId = typeof spec.clientId === "string" ? spec.clientId : ""
    if (!getNativeOAuthProvider(providerId)) {
      throw new ConfigApplyError("unknown_oauth_provider", `"${providerId}" is not a known provider on this server.`)
    }
    if (op.kind === "update" && op.previous.spec.providerId !== providerId) {
      throw new ConfigApplyError("immutable_field", "An OAuth app's provider can't change; create one for the other provider instead.")
    }
    const secret = secretWrite(resolvedSecret(spec.clientSecret, "clientSecret"))
    const body: SaveOrgOAuthProviderClientBody = {
      clientId,
      ...(Array.isArray(spec.features) ? { features: spec.features.filter((feature): feature is string => typeof feature === "string") } : {}),
      ...(typeof spec.tenantId === "string" ? { tenantId: spec.tenantId } : {}),
      ...(secret !== undefined ? { clientSecret: secret } : {}),
    }
    const { c, payload } = await configRouteContext(ctx)
    await expectRouteOk(await saveOrgOAuthProviderClient(c, payload, providerId, body, {
      requireLiteralProvider: true,
      ...(op.kind === "create" && op.preferredId ? { preferredId: normalizeDenTypeId("orgOAuthClient", op.preferredId) } : {}),
    }), `Save the ${providerId} OAuth app`)

    const [row] = await ctx.db
      .select({ id: OrgOAuthClientTable.id })
      .from(OrgOAuthClientTable)
      .where(and(
        eq(OrgOAuthClientTable.organizationId, payload.organization.id),
        eq(OrgOAuthClientTable.providerId, providerId),
      ))
      .limit(1)
    if (!row) throw new ConfigApplyError("not_saved", `The ${providerId} OAuth app was not saved.`)
    return { localId: row.id }
  },
})
