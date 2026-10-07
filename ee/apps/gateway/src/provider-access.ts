import { and, eq, isNotNull, isNull, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  GatewayKeyTable, GatewayProviderAccessTable, GatewayProviderTable, GatewayCredentialSetTable,
  GatewayModelGroupTable, GatewayModelGroupModelTable, GatewayProviderModelTable,
  MemberTable, TeamTable, TeamMemberTable,
} from "@openwork-ee/den-db"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { createGatewayModelAlias, parseGatewayModelAlias } from "@openwork-ee/utils/gateway-routing"
import type { GatewaySelectionConflict, GatewayUsableModel } from "@openwork/types/den/gateway"
import type { GatewayContext } from "./middleware/gateway-auth.js"

export type GatewayAccessScope = GatewayContext & { gatewayProviderId: typeof GatewayProviderTable.$inferSelect.id }
export type GatewayAccessRow = {
  grant: typeof GatewayProviderAccessTable.$inferSelect
  group: typeof GatewayModelGroupTable.$inferSelect
  credentialSet: typeof GatewayCredentialSetTable.$inferSelect
  model: typeof GatewayProviderModelTable.$inferSelect | null
}
export type LoadGatewayAccess = (scope: GatewayAccessScope) => Promise<GatewayAccessRow[]>
export type GatewayAccessProvider = Pick<typeof GatewayProviderTable.$inferSelect, "id" | "provider_id" | "name">
/** An access row across every provider the member can reach, tagged with its provider. */
export type GatewayMemberAccessRow = GatewayAccessRow & { provider: GatewayAccessProvider }
export type LoadMemberGatewayAccess = (scope: GatewayContext) => Promise<GatewayMemberAccessRow[]>
type AccessDb = Pick<typeof import("./db.js").db, "select">

// All relations are application-enforced, so every ownership/status edge is
// checked here. Plain read: callers re-check in their flow rather than locking.
export async function loadGatewayAccess(scope: GatewayAccessScope, executor: AccessDb): Promise<GatewayAccessRow[]> {
  return gatewayAccessQuery(scope, executor)
}

/** Same authorization as loadGatewayAccess, for every active provider in the member's organization. */
export async function loadMemberGatewayAccess(scope: GatewayContext, executor: AccessDb): Promise<GatewayMemberAccessRow[]> {
  return gatewayAccessQuery({ ...scope, gatewayProviderId: undefined }, executor)
}

export const loadMemberGatewayAccessFromDb: LoadMemberGatewayAccess = async (scope) => loadMemberGatewayAccess(scope, (await import("./db.js")).db)

function gatewayAccessQuery(scope: GatewayContext & { gatewayProviderId: GatewayAccessScope["gatewayProviderId"] | undefined }, executor: AccessDb) {
  const grants = GatewayProviderAccessTable
  const groups = GatewayModelGroupTable
  const sets = GatewayCredentialSetTable
  const models = GatewayProviderModelTable
  const links = GatewayModelGroupModelTable
  const provider = { id: GatewayProviderTable.id, provider_id: GatewayProviderTable.provider_id, name: GatewayProviderTable.name }
  return executor.select({ grant: grants, group: groups, credentialSet: sets, model: models, provider })
    .from(MemberTable)
    .innerJoin(GatewayKeyTable, and(eq(GatewayKeyTable.org_membership_id, MemberTable.id), eq(GatewayKeyTable.organization_id, MemberTable.organizationId)))
    .innerJoin(GatewayProviderTable, eq(GatewayProviderTable.organization_id, MemberTable.organizationId))
    .innerJoin(grants, eq(grants.gateway_provider_id, GatewayProviderTable.id))
    .innerJoin(groups, and(eq(groups.id, grants.model_group_id), eq(groups.gateway_provider_id, GatewayProviderTable.id)))
    .innerJoin(sets, and(eq(sets.id, grants.credential_set_id), eq(sets.gateway_provider_id, GatewayProviderTable.id)))
    .leftJoin(links, eq(links.model_group_id, groups.id))
    .leftJoin(models, and(eq(models.id, links.gateway_provider_model_id), eq(models.gateway_provider_id, GatewayProviderTable.id),
      // Applied on every read, OAuth fence and pre-egress recheck, even if rows are stale.
      sql`(JSON_LENGTH(${GatewayProviderTable.model_ids}) = 0 OR JSON_CONTAINS(${GatewayProviderTable.model_ids}, JSON_QUOTE(${models.model_id})))`))
    .where(and(
      eq(MemberTable.id, scope.orgMembershipId), eq(MemberTable.organizationId, scope.organizationId), isNull(MemberTable.removedAt), isNotNull(MemberTable.userId),
      eq(GatewayKeyTable.id, scope.gatewayKeyId), eq(GatewayKeyTable.status, "active"), isNull(GatewayKeyTable.revoked_at),
      // Omitted only by loadMemberGatewayAccess; the org boundary still comes from the member join.
      scope.gatewayProviderId === undefined ? undefined : eq(GatewayProviderTable.id, scope.gatewayProviderId),
      eq(GatewayProviderTable.status, "active"), eq(groups.status, "active"), eq(sets.status, "active"),
      or(
        and(eq(grants.org_membership_id, MemberTable.id), isNull(grants.team_id), eq(grants.audience_key, sql`concat('member:', ${MemberTable.id})`)),
        and(isNull(grants.org_membership_id), isNull(grants.team_id), eq(grants.audience_key, "organization")),
        and(isNull(grants.org_membership_id), eq(grants.audience_key, sql`concat('team:', ${grants.team_id})`),
          sql`exists (select 1 from ${TeamMemberTable} inner join ${TeamTable} on ${TeamTable.id} = ${TeamMemberTable.teamId}
            where ${TeamMemberTable.orgMembershipId} = ${MemberTable.id} and ${TeamTable.id} = ${grants.team_id}
            and ${TeamTable.organizationId} = ${MemberTable.organizationId})`),
      ),
    ))
}

export const loadGatewayAccessFromDb: LoadGatewayAccess = async (scope) => loadGatewayAccess(scope, (await import("./db.js")).db)

export type GatewayGrantSelection = {
  row: GatewayAccessRow
  requestedModel: string | null
  upstreamModel: string | null
}
export type GatewaySelectionResult =
  | { kind: "selected"; selection: GatewayGrantSelection }
  | { kind: "denied"; code: "invalid_gateway_selection" | "model_access_denied" | "provider_access_denied" }
  | { kind: "conflict"; conflict: GatewaySelectionConflict }

export function sameGatewaySelection(expected: GatewayGrantSelection, current: GatewayGrantSelection) {
  const a = expected.row
  const b = current.row
  return a.grant.id === b.grant.id && a.grant.audience_key === b.grant.audience_key
    && a.group.id === b.group.id && a.credentialSet.id === b.credentialSet.id
    && expected.upstreamModel === current.upstreamModel
    && (expected.requestedModel === null || a.model?.id === b.model?.id)
    && a.credentialSet.credential_mode === b.credentialSet.credential_mode
    && a.credentialSet.oauth_client_id === b.credentialSet.oauth_client_id
    && a.credentialSet.oauth_client_secret === b.credentialSet.oauth_client_secret
    && (a.credentialSet.oauth_tenant_id ?? null) === (b.credentialSet.oauth_tenant_id ?? null)
    && JSON.stringify(a.credentialSet.aws_sso ?? null) === JSON.stringify(b.credentialSet.aws_sso ?? null)
    && a.credentialSet.updated_at.getTime() === b.credentialSet.updated_at.getTime()
}

export function selectGatewayGrant(rows: GatewayAccessRow[], requestedModel: string | null, accessGrantId: string | null): GatewaySelectionResult {
  const alias = parseGatewayModelAlias(requestedModel)
  if ((requestedModel?.startsWith("gwm_") && !alias) || (accessGrantId !== null && !isDenTypeId("inferenceProviderAccess", accessGrantId))) {
    return { kind: "denied", code: "invalid_gateway_selection" }
  }
  const candidates = rows.filter((row) => (!accessGrantId || row.grant.id === accessGrantId)
    && (alias ? row.group.id === alias.modelGroupId && row.credentialSet.id === alias.credentialSetId && row.model?.id === alias.gatewayProviderModelId
      : requestedModel === null || row.model?.model_id === requestedModel))
  if (!candidates.length) return { kind: "denied", code: requestedModel === null ? "provider_access_denied" : "model_access_denied" }
  const priority = (row: GatewayAccessRow) => row.grant.org_membership_id !== null ? 3 : row.grant.team_id !== null ? 2 : 1
  // Model-less requests cannot infer intent from audience priority across sets.
  const highest = candidates.reduce((highest, row) => Math.max(highest, priority(row)), 0)
  const winners = requestedModel === null && accessGrantId === null ? candidates : candidates.filter((row) => priority(row) === highest)
  winners.sort((a, b) => a.grant.id < b.grant.id ? -1 : a.grant.id > b.grant.id ? 1 : 0)
  if (new Set(winners.map((row) => row.credentialSet.id)).size > 1) {
    return { kind: "conflict", conflict: {
      error: "gateway_selection_required",
      message: "Select a model group and credential set, or supply an authorized x-openwork-gateway-grant-id.",
      selections: [...new Map(winners.map((row) => [row.grant.id, {
        modelGroupId: row.group.id, modelGroupName: row.group.name, credentialSetId: row.credentialSet.id,
        credentialSetName: row.credentialSet.name, accessGrantId: row.grant.id,
      }])).values()],
    } }
  }
  // Model-less equivalent sets still attribute to the most specific stable rule.
  const row = winners.find((row) => priority(row) === highest)
  if (!row) return { kind: "denied", code: "provider_access_denied" }
  return { kind: "selected", selection: { row, requestedModel, upstreamModel: requestedModel === null ? null : row.model?.model_id ?? null } }
}

export function accessibleGatewayModels(rows: GatewayAccessRow[]) {
  const models = new Map<string, GatewayUsableModel & { object: "model"; created: number; owned_by: string }>()
  for (const row of rows) {
    if (!row.model) continue
    const id = createGatewayModelAlias({ modelGroupId: row.group.id, credentialSetId: row.credentialSet.id, gatewayProviderModelId: row.model.id })
    const name = `${row.model.name} (${row.group.name} / ${row.credentialSet.name})`
    models.set(id, { id, object: "model", created: 0, owned_by: row.model.gateway_provider_id,
      name, upstreamModelId: row.model.model_id,
      config: { ...row.model.model_config, id, name },
      modelGroupId: row.group.id, modelGroupName: row.group.name, credentialSetId: row.credentialSet.id, credentialSetName: row.credentialSet.name })
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** One entry of the OpenAI List Models response, plus the fields a client needs to call it. */
export type GatewayListedModel = {
  id: string
  object: "model"
  /** Unix seconds when the model was added to the provider. */
  created: number
  /** The upstream provider type, such as "anthropic" or "openai". */
  owned_by: string
  name: string
  openwork: {
    /** The ipr_ id that goes in /api/v1/providers/{provider_id}/... to call this model. */
    provider_id: string
    provider_name: string
    upstream_model_id: string
  }
}

/** Every model the member's grants allow, across providers, in the OpenAI list shape. */
export function listGatewayModels(rows: GatewayMemberAccessRow[]): { object: "list"; data: GatewayListedModel[] } {
  const models = new Map<string, GatewayListedModel>()
  for (const row of rows) {
    if (!row.model || row.model.gateway_provider_id !== row.provider.id) continue
    const id = createGatewayModelAlias({ modelGroupId: row.group.id, credentialSetId: row.credentialSet.id, gatewayProviderModelId: row.model.id })
    models.set(id, {
      id,
      object: "model",
      created: Math.floor(row.model.created_at.getTime() / 1000),
      owned_by: row.provider.provider_id,
      name: `${row.model.name} (${row.group.name} / ${row.credentialSet.name})`,
      openwork: { provider_id: row.provider.id, provider_name: row.provider.name, upstream_model_id: row.model.model_id },
    })
  }
  const data = [...models.values()].sort((a, b) =>
    a.openwork.provider_name.localeCompare(b.openwork.provider_name) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { object: "list", data }
}
