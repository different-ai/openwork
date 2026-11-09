/**
 * Config-blob area `ai-gateway.providers`: AI Gateway providers with their
 * model universe, model groups, credential sets and access grants
 * (Manage › AI Gateway › AI Providers).
 *
 * Export is an allowlist: the catalog provider id, the documented non-secret
 * destination settings, a custom provider's own model list and LiteLLM's mode.
 * `provider_config` and model configs are never exported (they come from the
 * catalog on the target). Credentials never travel: each credential set's
 * shared organization credential and OAuth client secret are `$secret`
 * placeholders. Per-member credentials, OAuth states, LiteLLM issued keys and
 * member Gateway keys are runtime/personal and never exported or touched.
 * The legacy provider-level `oauth_client_secret` / `credential_mode` columns
 * are compatibility metadata no route writes (credential sets own them), so
 * they are not part of the spec.
 *
 * Apply goes through the same writers as the inference provider routes
 * (`llm/gateway-matrix.ts`, `llm/gateway-provider-writes.ts`), under the same
 * locks, live Manage Gateway providers re-check and provider audit capture.
 * Child rows (models, groups, sets, grants) reuse their source TypeIDs when
 * they are free on the whole instance, so Gateway model aliases
 * (`gwm_<group>_<set>_<model>`) survive a cloud ↔ self-hosted move.
 *
 * LiteLLM providers are exported (so a blob shows them) but cannot be created
 * or changed by a config blob: their models, groups and member keys come from
 * syncing the customer's LiteLLM proxy. Apply fails with a clear message.
 */
import { isDeepStrictEqual } from "node:util"
import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { lockUsageOrganization } from "@openwork-ee/den-db/gateway-usage-limits"
import { AuthUserTable, GatewayCredentialSetTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderOauthStateTable, GatewayProviderTable, MemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { gatewayAudienceKey } from "@openwork-ee/utils/gateway-routing"
import { isLiteLlmProviderId } from "@openwork-ee/utils/litellm-catalog"
import { createDenTypeId, denTypeIdPrefixes, normalizeDenTypeId, type DenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"
import { configRefSchema, configSecretSchema, type ConfigApplyStep, type ConfigFieldChange } from "@openwork/types/den/config-blobs"
import { GATEWAY_PROVIDER_CREDENTIAL_KINDS, GATEWAY_PROVIDER_CREDENTIAL_MODES, GATEWAY_PROVIDER_STATUSES, gatewayAwsSsoSettingsSchema, type GatewayAccessGrantWrite, type GatewayCredentialSetPatch, type GatewayModelGroupPatch } from "@openwork/types/den/gateway"
import { GATEWAY_CUSTOM_PROVIDER_ID, gatewayCustomModelSchema, isGatewayCustomProviderId, type GatewayCustomProviderSettings } from "@openwork/types/den/gateway-custom-providers"
import { z } from "zod"
import { recheckAuditEntitlement } from "../../audit/capture.js"
import { loadProviderAudit, providerAuditMutation, providerRequestAuditContext, recordProviderAttempt } from "../../audit/provider.js"
import { env } from "../../env.js"
import { gatewayManagementUnavailable } from "../../gateway-deployment.js"
import { checkCustomBaseUrl, customCatalogProvider, customProviderConfig, readCustomProviderSettings, sameCustomOrigin } from "../../llm/gateway-custom-provider.js"
import { GatewayWriteError, gatewayCatalog, modelIdKey, resolveGatewayCatalog, trustedProviderCatalog, validateGatewaySettings, writeGatewayGrant, writeGatewayGroup, writeGatewayModels, writeGatewaySet, type GatewayProvider, type GatewayTx } from "../../llm/gateway-matrix.js"
import { gatewayProviderSettingsSchema, patchGatewayProvider, removeGatewayAccessGrant, removeGatewayCredentialSet, removeGatewayModelGroup, removeGatewayProvider } from "../../llm/gateway-provider-writes.js"
import { gatewayModelConfigurationError, publicProviderSettings } from "../../llm/inference-provider-config.js"
import { revokeUpstreamCredentials } from "../../llm/inference-provider-lifecycle.js"
import { readLiteLlmSettings } from "../../llm/litellm-settings.js"
import type { ModelsDevProvider } from "../../llm/models-dev.js"
import { resolvePermissionsForMember } from "../../permissions/resolve.js"
import { defineConfigArea, type ConfigApplyOp, type ConfigApplyResult, type ConfigAreaContext, type ConfigItem, type ResolvedConfigItem } from "../area.js"
import { ConfigApplyError, ConfigStepLog, applyWithSteps, configItemError, opTouched, secretEffects, touches } from "./route-support.js"

const AREA = "ai-gateway.providers" as const
const MANAGE = "gateway_providers.manage" as const

// ---------------------------------------------------------------------------
// Spec

const idSchema = z.string().min(1).max(100)
const nameSchema = z.string().trim().min(1).max(255)
const modelIdSchema = z.string().trim().min(1).max(255)
const statusSchema = z.enum(GATEWAY_PROVIDER_STATUSES)

const resolvedRefSchema = configRefSchema.extend({ id: z.string().min(1) }).strict()
const resolvedSecretSchema = z.discriminatedUnion("decision", [
  z.object({ $secret: z.string(), decision: z.literal("keep") }).strict(),
  z.object({ $secret: z.string(), decision: z.literal("value"), value: z.string() }).strict(),
  z.object({ $secret: z.string(), decision: z.literal("unset") }).strict(),
])

/** One schema for the blob form (refs and placeholders) and the resolved form apply receives. */
function providerSpecSchema<Ref extends z.ZodType, Secret extends z.ZodType>(ref: Ref, secret: Secret) {
  const access = z.discriminatedUnion("audience", [
    z.object({ id: idSchema, modelGroup: idSchema, credentialSet: idSchema, audience: z.literal("organization") }).strict(),
    z.object({ id: idSchema, modelGroup: idSchema, credentialSet: idSchema, audience: z.literal("team"), team: ref }).strict(),
    z.object({ id: idSchema, modelGroup: idSchema, credentialSet: idSchema, audience: z.literal("member"), member: ref }).strict(),
  ])
  return z.object({
    /** Catalog provider id (`openai`, `anthropic`, …), `custom` or `litellm`. Immutable. */
    providerId: nameSchema,
    status: statusSchema,
    /** Documented non-secret destination settings. Immutable for catalog providers. */
    settings: gatewayProviderSettingsSchema,
    /** Custom OpenAI-compatible providers only: their own model list (address is settings.upstreamBaseUrl). */
    custom: z.object({ models: z.array(gatewayCustomModelSchema).min(1).max(500) }).strict().optional(),
    /** LiteLLM providers only, informational: they are synced from the proxy and can't be applied. */
    litellm: z.object({ mode: z.enum(["org", "member"]), keySource: z.enum(["personal", "issued"]).nullable(), issueStrategy: z.enum(["per_team", "mirror"]).nullable(), mirrorFallback: z.enum(["per_team", "error"]).nullable() }).strict().optional(),
    /** Provider universe policy: [] follows every supported catalog model. */
    modelIds: z.array(modelIdSchema).max(500),
    /** Ordered pins (catalog model ids). */
    pinnedModelIds: z.array(modelIdSchema).max(500),
    /**
     * The provider's stored models. Derived from the catalog and `modelIds` on
     * apply; listed so the blob is readable and so model row ids carry over.
     */
    models: z.array(z.object({ id: idSchema, modelId: modelIdSchema, name: z.string().max(255) }).strict()).max(5000),
    modelGroups: z.array(z.object({ id: idSchema, name: nameSchema, description: z.string().max(10000).nullable(), status: statusSchema, models: z.array(modelIdSchema).max(500) }).strict()).max(500),
    credentialSets: z.array(z.object({
      id: idSchema,
      name: nameSchema,
      credentialMode: z.enum(GATEWAY_PROVIDER_CREDENTIAL_MODES),
      status: statusSchema,
      /** Kind of the shared organization credential (org sets). */
      credentialKind: z.enum(GATEWAY_PROVIDER_CREDENTIAL_KINDS).nullable(),
      /** The shared organization credential (org sets only). Members' own credentials never travel. */
      credential: secret.optional(),
      oauthClientId: z.string().max(255).nullable(),
      oauthClientSecret: secret,
      oauthTenantId: z.string().max(64).nullable(),
      awsSso: gatewayAwsSsoSettingsSchema.nullable(),
    }).strict()).max(500),
    access: z.array(access).max(5000),
  }).strict()
}

const exportSpecSchema = providerSpecSchema(configRefSchema, configSecretSchema)
const resolvedSpecSchema = providerSpecSchema(resolvedRefSchema, resolvedSecretSchema)
type ExportSpec = z.infer<typeof exportSpecSchema>
type ResolvedSpec = z.infer<typeof resolvedSpecSchema>
type ResolvedSet = ResolvedSpec["credentialSets"][number]
type ResolvedSecret = z.infer<typeof resolvedSecretSchema>

function secretPath(providerId: string, setId: string, field: "credential" | "oauthClientSecret") {
  return `${AREA}/${providerId}/credentialSets[${setId}].${field}`
}

// ---------------------------------------------------------------------------
// Export

function exportSettings(settings: Record<string, unknown>): ExportSpec["settings"] {
  const strings = Object.fromEntries(Object.entries(publicProviderSettings(settings)).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  const parsed = gatewayProviderSettingsSchema.safeParse(strings)
  return parsed.success ? parsed.data : {}
}

async function exportItems(ctx: ConfigAreaContext): Promise<ConfigItem[]> {
  return readProviders(ctx, null)
}

/** The providers (all, or just `ids`), each with its children read for those providers only. */
async function readProviders(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const database = ctx.db
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const wanted = ids?.flatMap((id) => typedId("inferenceProvider", id) ?? []) ?? null
  if (wanted && wanted.length === 0) return []
  const providers = await database.select().from(GatewayProviderTable).where(and(eq(GatewayProviderTable.organization_id, organizationId), wanted ? inArray(GatewayProviderTable.id, wanted) : undefined))
  if (!providers.length) return []
  const providerIds = providers.map((provider) => provider.id)
  const [models, groups, sets, credentials, grants] = await Promise.all([
    database.select().from(GatewayProviderModelTable).where(inArray(GatewayProviderModelTable.gateway_provider_id, providerIds)),
    database.select().from(GatewayModelGroupTable).where(inArray(GatewayModelGroupTable.gateway_provider_id, providerIds)),
    database.select().from(GatewayCredentialSetTable).where(inArray(GatewayCredentialSetTable.gateway_provider_id, providerIds)),
    // Only the organization's shared credential; never a member's own.
    database.select({ setId: GatewayProviderCredentialTable.credential_set_id, kind: GatewayProviderCredentialTable.kind, status: GatewayProviderCredentialTable.status })
      .from(GatewayProviderCredentialTable)
      .where(and(inArray(GatewayProviderCredentialTable.gateway_provider_id, providerIds), eq(GatewayProviderCredentialTable.organization_id, organizationId), eq(GatewayProviderCredentialTable.subject, "org"), isNull(GatewayProviderCredentialTable.org_membership_id))),
    database.select().from(GatewayProviderAccessTable).where(inArray(GatewayProviderAccessTable.gateway_provider_id, providerIds)),
  ])
  const links = groups.length ? await database.select().from(GatewayModelGroupModelTable).where(inArray(GatewayModelGroupModelTable.model_group_id, groups.map((group) => group.id))) : []
  const teamIds = [...new Set(grants.flatMap((grant) => grant.team_id ? [grant.team_id] : []))]
  const memberIds = [...new Set(grants.flatMap((grant) => grant.org_membership_id ? [grant.org_membership_id] : []))]
  const teams = teamIds.length ? await database.select({ id: TeamTable.id, name: TeamTable.name }).from(TeamTable).where(inArray(TeamTable.id, teamIds)) : []
  const people = memberIds.length ? await database.select({ id: MemberTable.id, email: AuthUserTable.email, name: AuthUserTable.name }).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId)).where(inArray(MemberTable.id, memberIds)) : []
  const modelById = new Map(models.map((model) => [model.id, model]))

  return providers.map((provider): ConfigItem => {
    const ownModels = models.filter((model) => model.gateway_provider_id === provider.id)
    const ownSets = sets.filter((set) => set.gateway_provider_id === provider.id)
    const custom = isGatewayCustomProviderId(provider.provider_id) ? readCustomProviderSettings(provider.settings) : null
    const litellm = isLiteLlmProviderId(provider.provider_id) ? readLiteLlmSettings(provider.settings) : null
    const spec: ExportSpec = {
      providerId: provider.provider_id,
      status: provider.status,
      settings: exportSettings(provider.settings),
      ...(custom ? { custom: { models: custom.catalog } } : {}),
      ...(litellm ? { litellm: { mode: litellm.mode, keySource: litellm.mode === "member" ? litellm.keySource : null, issueStrategy: litellm.mode === "member" && litellm.keySource === "issued" ? litellm.issueStrategy : null, mirrorFallback: litellm.mode === "member" && litellm.keySource === "issued" ? litellm.mirrorFallback : null } } : {}),
      modelIds: [...provider.model_ids],
      pinnedModelIds: [...(provider.pinned_model_ids ?? [])],
      models: ownModels.map((model) => ({ id: model.id, modelId: model.model_id, name: model.name })),
      modelGroups: groups.filter((group) => group.gateway_provider_id === provider.id).map((group) => ({
        id: group.id, name: group.name, description: group.description, status: group.status,
        models: links.filter((link) => link.model_group_id === group.id).flatMap((link) => modelById.get(link.gateway_provider_model_id)?.model_id ?? []),
      })),
      credentialSets: ownSets.map((set) => {
        const credential = credentials.find((row) => row.setId === set.id)
        return {
          id: set.id, name: set.name, credentialMode: set.credential_mode, status: set.status,
          credentialKind: set.credential_mode === "org" ? credential?.kind ?? null : null,
          ...(set.credential_mode === "org" ? { credential: { $secret: secretPath(provider.id, set.id, "credential"), set: credential?.status === "active" } } : {}),
          oauthClientId: set.oauth_client_id,
          oauthClientSecret: { $secret: secretPath(provider.id, set.id, "oauthClientSecret"), set: Boolean(set.oauth_client_secret) },
          oauthTenantId: set.oauth_tenant_id,
          awsSso: set.aws_sso ?? null,
        }
      }),
      access: grants.filter((grant) => grant.gateway_provider_id === provider.id).flatMap((grant): ExportSpec["access"] => {
        const base = { id: grant.id, modelGroup: grant.model_group_id, credentialSet: grant.credential_set_id }
        if (grant.org_membership_id) {
          const person = people.find((entry) => entry.id === grant.org_membership_id)
          // A grant to someone without a sign-in email can't be carried by email.
          return person?.email ? [{ ...base, audience: "member", member: { $ref: `people/${person.email.toLowerCase()}`, ...(person.name ? { name: person.name } : {}) } }] : []
        }
        if (grant.team_id) {
          const team = teams.find((entry) => entry.id === grant.team_id)
          return [{ ...base, audience: "team", team: { $ref: `members.teams/${grant.team_id}`, ...(team ? { name: team.name } : {}) } }]
        }
        return [{ ...base, audience: "organization" }]
      }),
    }
    return { id: provider.id, key: null, name: provider.name, spec }
  })
}

// ---------------------------------------------------------------------------
// Matching helpers

function specRecord(item: ConfigItem): Record<string, unknown> {
  return item.spec
}
function specString(item: ConfigItem, key: string): string | null {
  const value = specRecord(item)[key]
  return typeof value === "string" ? value : null
}
function specBaseUrl(item: ConfigItem): string | null {
  const settings = specRecord(item).settings
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null
  const value: unknown = Reflect.get(settings, "upstreamBaseUrl")
  return typeof value === "string" ? value.trim().replace(/\/+$/, "").toLowerCase() : null
}
function specModelIds(item: ConfigItem): Set<string> {
  const models = specRecord(item).models
  const ids = new Set<string>()
  if (Array.isArray(models)) for (const model of models) {
    const value: unknown = typeof model === "object" && model !== null ? Reflect.get(model, "modelId") : null
    if (typeof value === "string") ids.add(modelIdKey(value))
  }
  return ids
}
function nameTokens(name: string): Set<string> {
  return new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
}
function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size && !b.size) return 0
  let shared = 0
  for (const value of a) if (b.has(value)) shared += 1
  return shared / (a.size + b.size - shared)
}

function similarity(blob: ConfigItem, target: ConfigItem): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0
  const provider = specString(blob, "providerId")
  if (provider && provider === specString(target, "providerId")) {
    score += 0.4
    reasons.push(`same provider (${provider})`)
    const blobUrl = specBaseUrl(blob)
    if (blobUrl === specBaseUrl(target)) {
      score += 0.2
      reasons.push(blobUrl ? "same upstream address" : "both use the provider's default address")
    }
    const blobModels = specModelIds(blob)
    const targetModels = specModelIds(target)
    if (blobModels.size || targetModels.size) {
      const overlap = jaccard(blobModels, targetModels)
      score += 0.25 * overlap
      const shared = [...blobModels].filter((id) => targetModels.has(id)).length
      if (shared) reasons.push(`${shared}/${Math.max(blobModels.size, targetModels.size)} models equal`)
    }
  }
  const names = jaccard(nameTokens(blob.name), nameTokens(target.name))
  score += (provider && provider === specString(target, "providerId") ? 0.15 : 0.2) * names
  if (blob.name.trim().toLowerCase() === target.name.trim().toLowerCase()) reasons.push("same name")
  return { score: Math.min(1, Math.round(score * 1000) / 1000), reasons }
}

// ---------------------------------------------------------------------------
// Apply

type Actor = { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; userId: string }

function actorOf(ctx: ConfigAreaContext): Actor {
  return { organizationId: normalizeDenTypeId("organization", ctx.organizationId), memberId: normalizeDenTypeId("member", ctx.actor.memberId), userId: ctx.actor.userId }
}

function failure(message: string, field?: string): Error {
  return new ConfigApplyError("invalid_spec", `${AREA}: ${message}`, 400, field)
}

/** A blob id usable as a new row id: well-formed for the table and not taken on this instance. */
function typedId<TName extends DenTypeIdName>(name: TName, value: string | undefined): DenTypeId<TName> | null {
  if (!value) return null
  try { return normalizeDenTypeId(name, value) } catch { return null }
}

/**
 * Runs one provider write the way the routes do: audit capture for the step,
 * the caller's member row locked and Manage Gateway providers re-checked inside
 * the transaction, then the mutation inside `providerAuditMutation`.
 */
async function providerWrite<T>(ctx: ConfigAreaContext, providerId: DenTypeId<"inferenceProvider">, step: "create" | "update" | "delete", mutate: (tx: GatewayTx) => Promise<T>, options: { lockOrganization?: boolean } = {}): Promise<T> {
  const actor = actorOf(ctx)
  const enabled = "auditCaptureEnabled" in env && env.auditCaptureEnabled === true
  const capture = enabled
    ? await loadProviderAudit(ctx.db, true, providerRequestAuditContext({ organizationId: actor.organizationId, memberId: actor.memberId, userId: actor.userId, providerId, workflowStep: step, headers: new Headers() }), step)
    : null
  try {
    return await ctx.db.transaction(async (tx) => {
      if (capture) await recheckAuditEntitlement(tx, actor.organizationId)
      if (options.lockOrganization) await lockUsageOrganization(tx, actor.organizationId)
      const [member] = await tx.select({ id: MemberTable.id, userId: MemberTable.userId }).from(MemberTable)
        .where(and(eq(MemberTable.id, actor.memberId), eq(MemberTable.organizationId, actor.organizationId), isNull(MemberTable.removedAt))).for("update")
      if (!member?.userId) throw new GatewayWriteError(403, "forbidden")
      const permissions = await resolvePermissionsForMember({ organizationId: actor.organizationId, memberId: actor.memberId, database: tx })
      if (!permissions.has(MANAGE)) throw new GatewayWriteError(403, "forbidden", "Manage Gateway providers is required to apply AI provider changes.")
      return providerAuditMutation(tx, capture, () => mutate(tx))
    })
  } catch (error) {
    await recordProviderAttempt(ctx.db, capture, error instanceof GatewayWriteError ? error.status : 500)
    throw error
  }
}

async function lockProvider(tx: GatewayTx, actor: Actor, id: DenTypeId<"inferenceProvider">): Promise<GatewayProvider> {
  const [provider] = await tx.select().from(GatewayProviderTable).where(and(eq(GatewayProviderTable.id, id), eq(GatewayProviderTable.organization_id, actor.organizationId))).for("update")
  if (!provider) throw new GatewayWriteError(404, "inference_provider_not_found")
  return provider
}

/** The source ids of `wanted` that are well-formed and free for new rows of each table. */
async function freeIds(tx: GatewayTx, wanted: { models: string[]; groups: string[]; sets: string[]; grants: string[] }) {
  const models = wanted.models.flatMap((id) => typedId("inferenceProviderModel", id) ?? [])
  const groups = wanted.groups.flatMap((id) => typedId("gatewayModelGroup", id) ?? [])
  const sets = wanted.sets.flatMap((id) => typedId("gatewayCredentialSet", id) ?? [])
  const grants = wanted.grants.flatMap((id) => typedId("inferenceProviderAccess", id) ?? [])
  const [takenModels, takenGroups, takenSets, takenGrants] = await Promise.all([
    models.length ? tx.select({ id: GatewayProviderModelTable.id }).from(GatewayProviderModelTable).where(inArray(GatewayProviderModelTable.id, models)) : [],
    groups.length ? tx.select({ id: GatewayModelGroupTable.id }).from(GatewayModelGroupTable).where(inArray(GatewayModelGroupTable.id, groups)) : [],
    sets.length ? tx.select({ id: GatewayCredentialSetTable.id }).from(GatewayCredentialSetTable).where(inArray(GatewayCredentialSetTable.id, sets)) : [],
    grants.length ? tx.select({ id: GatewayProviderAccessTable.id }).from(GatewayProviderAccessTable).where(inArray(GatewayProviderAccessTable.id, grants)) : [],
  ])
  const free = <T extends string>(ids: T[], taken: Array<{ id: T }>) => new Set(ids.filter((id) => !taken.some((row) => row.id === id)))
  return { models: free(models, takenModels), groups: free(groups, takenGroups), sets: free(sets, takenSets), grants: free(grants, takenGrants) }
}

/** modelIdKey(modelId) → reusable source model row id, for models this write may insert. */
async function modelCreateIds(tx: GatewayTx, spec: ResolvedSpec) {
  const free = await freeIds(tx, { models: spec.models.map((model) => model.id), groups: [], sets: [], grants: [] })
  const ids = new Map<string, DenTypeId<"inferenceProviderModel">>()
  for (const model of spec.models) {
    const id = typedId("inferenceProviderModel", model.id)
    if (id && free.models.has(id)) ids.set(modelIdKey(model.modelId), id)
  }
  return ids
}

/** Models a group or pin may use: within the universe and supported by the provider's SDK (as writeGatewayGroup checks). */
async function configuredModels(tx: GatewayTx, provider: GatewayProvider) {
  const rows = await tx.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id))
  return rows.filter((row) => (!provider.model_ids.length || provider.model_ids.includes(row.model_id)) && !gatewayModelConfigurationError(provider.provider_config, [row.model_config]))
}

async function writePins(tx: GatewayTx, provider: GatewayProvider, pins: string[], warnings: string[]): Promise<boolean> {
  const configured = await configuredModels(tx, provider)
  const kept = [...new Set(pins)].filter((id) => configured.some((model) => model.model_id === id))
  if (kept.length !== pins.length) warnings.push(`${provider.name}: ${pins.length - kept.length} pinned model(s) are not configured on this server and were not pinned.`)
  if (isDeepStrictEqual(kept, provider.pinned_model_ids ?? [])) return false
  await tx.update(GatewayProviderTable).set({ pinned_model_ids: kept }).where(eq(GatewayProviderTable.id, provider.id))
  return true
}

function credentialInput(set: ResolvedSet, existing: boolean, warnings: string[]): Pick<GatewayCredentialSetPatch, "credential" | "oauthClientSecret"> & { awaitKey: boolean } {
  const secret: ResolvedSecret | undefined = set.credential
  let credential: GatewayCredentialSetPatch["credential"]
  let awaitKey = false
  if (set.credentialMode === "org") {
    if (secret?.decision === "value") credential = { kind: set.credentialKind ?? "api_key", secret: secret.value }
    else if (!existing) awaitKey = true
    else if (secret?.decision === "unset") warnings.push(`Credential set "${set.name}": its stored key was kept; enter a new key in AI Gateway to replace it.`)
  }
  const client = set.oauthClientSecret
  const oauthClientSecret = client.decision === "value" ? client.value : client.decision === "unset" ? "" : undefined
  return { credential, oauthClientSecret, awaitKey }
}

/** Which parts of a provider an apply writes. A create writes everything. */
type MatrixScope = { groups: boolean; sets: boolean; access: boolean; touched: ConfigFieldChange[] | null }

/** Writes done inside the provider transaction; `current` is the one running (for a failure report). */
type TxSteps = { done: ConfigApplyStep[]; current: ConfigApplyStep | null }

async function txStep<T>(steps: TxSteps, step: ConfigApplyStep, write: () => Promise<T>): Promise<T> {
  steps.current = step
  const result = await write()
  steps.done.push(step)
  steps.current = null
  return result
}

/**
 * Whether the plan changes this set element (`modelGroups[id=<label>]`: the
 * plan compares groups and sets by `childLabels`). A create (no `touched`) writes all.
 */
function elementTouched(scope: MatrixScope, array: string, label: string): boolean {
  return scope.touched === null || touches(scope.touched, `${array}[id=${label}]`)
}

/**
 * Makes the provider's groups, credential sets and grants equal the spec, for
 * the parts in `scope` only. Existing children match by id, then by name
 * (groups and sets) or by (group, set, audience) (grants). A child matched by
 * id is written only when the plan changes it, and then only its changed
 * fields; unmatched existing children are removed. Grants are added and
 * removed one by one, never rewritten.
 */
async function applyMatrix(tx: GatewayTx, provider: GatewayProvider, spec: ResolvedSpec, trusted: ModelsDevProvider | null, actor: Actor, warnings: string[], scope: MatrixScope, steps: TxSteps) {
  const revoked: Awaited<ReturnType<typeof removeGatewayCredentialSet>> = []
  if (!scope.groups && !scope.sets && !scope.access) return revoked
  const existingGroups = await tx.select().from(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.gateway_provider_id, provider.id))
  const existingSets = await tx.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.gateway_provider_id, provider.id))
  const existingGrants = await tx.select().from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id))
  const free = await freeIds(tx, { models: [], groups: spec.modelGroups.map((group) => group.id), sets: spec.credentialSets.map((set) => set.id), grants: spec.access.map((grant) => grant.id) })

  const groupLabels = childLabels(spec.modelGroups)
  const setLabels = childLabels(spec.credentialSets)
  const groupIds = new Map<string, { id: DenTypeId<"gatewayModelGroup">; existing: boolean; byId: boolean }>()
  const claimedGroups = new Set<string>()
  for (const group of spec.modelGroups) {
    if (groupIds.has(group.id)) throw failure(`model group id ${group.id} appears twice in "${provider.name}".`, "modelGroups")
    const byId = existingGroups.find((row) => row.id === group.id && !claimedGroups.has(row.id))
    const match = byId
      ?? existingGroups.find((row) => row.name === group.name && !claimedGroups.has(row.id) && !spec.modelGroups.some((other) => other.id === row.id))
    if (match) claimedGroups.add(match.id)
    const reusable = typedId("gatewayModelGroup", group.id)
    groupIds.set(group.id, match ? { id: match.id, existing: true, byId: Boolean(byId) } : { id: reusable && free.groups.has(reusable) ? reusable : createDenTypeId("gatewayModelGroup"), existing: false, byId: false })
  }
  const setIds = new Map<string, { id: DenTypeId<"gatewayCredentialSet">; existing: boolean; byId: boolean }>()
  const claimedSets = new Set<string>()
  for (const set of spec.credentialSets) {
    if (setIds.has(set.id)) throw failure(`credential set id ${set.id} appears twice in "${provider.name}".`, "credentialSets")
    const byId = existingSets.find((row) => row.id === set.id && !claimedSets.has(row.id))
    const match = byId
      ?? existingSets.find((row) => row.name === set.name && !claimedSets.has(row.id) && !spec.credentialSets.some((other) => other.id === row.id))
    if (match) claimedSets.add(match.id)
    const reusable = typedId("gatewayCredentialSet", set.id)
    setIds.set(set.id, match ? { id: match.id, existing: true, byId: Boolean(byId) } : { id: reusable && free.sets.has(reusable) ? reusable : createDenTypeId("gatewayCredentialSet"), existing: false, byId: false })
  }
  const groupName = (id: string) => spec.modelGroups.find((group) => groupIds.get(group.id)?.id === id)?.name ?? existingGroups.find((row) => row.id === id)?.name ?? id
  const setName = (id: string) => spec.credentialSets.find((set) => setIds.get(set.id)?.id === id)?.name ?? existingSets.find((row) => row.id === id)?.name ?? id
  const grantDetail = (groupId: string, setId: string, audience: string) => `${groupName(groupId)} / ${setName(setId)} / ${audience}`

  const desiredGrants = scope.access ? spec.access.map((grant) => {
    const group = groupIds.get(grant.modelGroup)
    const set = setIds.get(grant.credentialSet)
    if (!group || !set) throw failure(`an access grant of "${provider.name}" names a model group or credential set that is not in the provider.`, "access")
    const audience: GatewayAccessGrantWrite["audience"] = grant.audience === "team" ? { type: "team", teamId: normalizeDenTypeId("team", grant.team.id) }
      : grant.audience === "member" ? { type: "member", memberId: normalizeDenTypeId("member", grant.member.id) }
      : { type: "organization" }
    const label = grant.audience === "team" ? `team ${grant.team.name ?? grant.team.id}` : grant.audience === "member" ? grant.member.$ref.replace(/^people\//, "") : "everyone"
    return { sourceId: grant.id, write: { modelGroupId: group.id, credentialSetId: set.id, audience }, key: `${group.id}|${set.id}|${gatewayAudienceKey(audience)}`, label }
  }) : []
  const keptGrants = new Set<string>()
  if (scope.access) {
    for (const row of existingGrants) {
      const key = `${row.model_group_id}|${row.credential_set_id}|${row.audience_key}`
      if (desiredGrants.some((grant) => grant.key === key) && !keptGrants.has(key)) keptGrants.add(key)
      else await txStep(steps, { action: "remove", target: "access", detail: grantDetail(row.model_group_id, row.credential_set_id, row.audience_key) }, () => removeGatewayAccessGrant(tx, provider, row.id))
    }
  }

  if (scope.groups) {
    const configured = await configuredModels(tx, provider)
    const links = existingGroups.length ? await tx.select().from(GatewayModelGroupModelTable).where(inArray(GatewayModelGroupModelTable.model_group_id, existingGroups.map((row) => row.id))) : []
    for (const group of spec.modelGroups) {
      const target = groupIds.get(group.id)
      if (!target) continue
      if (target.byId && !elementTouched(scope, "modelGroups", groupLabels.get(group.id) ?? group.id)) continue
      const modelIds = [...new Set(group.models)].filter((id) => configured.some((model) => model.model_id === id))
      if (modelIds.length !== new Set(group.models).size) warnings.push(`Model group "${group.name}": ${new Set(group.models).size - modelIds.length} model(s) are not configured on this server and were left out.`)
      if (!target.existing) {
        await txStep(steps, { action: "create", target: `modelGroups[${group.name}]` }, () => writeGatewayGroup(tx, provider, { name: group.name, description: group.description, status: group.status, modelIds }, undefined, { createId: target.id }))
        continue
      }
      const row = existingGroups.find((entry) => entry.id === target.id)
      const linked = new Set(links.filter((link) => link.model_group_id === target.id).flatMap((link) => configured.find((model) => model.id === link.gateway_provider_model_id)?.model_id ?? []))
      const input: GatewayModelGroupPatch = {
        ...(row?.name !== group.name ? { name: group.name } : {}),
        ...(row?.description !== group.description ? { description: group.description } : {}),
        ...(row?.status !== group.status ? { status: group.status } : {}),
        ...(linked.size !== modelIds.length || modelIds.some((id) => !linked.has(id)) ? { modelIds } : {}),
      }
      const fields = Object.keys(input)
      if (fields.length === 0) continue
      await txStep(steps, { action: "update", target: `modelGroups[${group.name}]`, detail: fields.join(", ") }, () => writeGatewayGroup(tx, provider, input, target.id))
    }
    for (const row of existingGroups) {
      if (!claimedGroups.has(row.id)) await txStep(steps, { action: "delete", target: `modelGroups[${row.name}]` }, () => removeGatewayModelGroup(tx, provider, row.id))
    }
  }

  if (scope.sets) {
    // Sets are checked against the trusted catalog's credential env names, as the set routes do.
    const setProvider: GatewayProvider = trusted ? { ...provider, provider_config: { ...provider.provider_config, env: trusted.env } } : provider
    for (const set of spec.credentialSets) {
      const target = setIds.get(set.id)
      if (!target) continue
      if (target.byId && !elementTouched(scope, "credentialSets", setLabels.get(set.id) ?? set.id)) continue
      const { awaitKey, ...secrets } = credentialInput(set, target.existing, warnings)
      if (!target.existing) {
        const input: GatewayCredentialSetPatch = {
          name: set.name, credentialMode: set.credentialMode, status: set.status,
          oauthClientId: set.oauthClientId ?? "", oauthTenantId: set.oauthTenantId ?? "", awsSso: set.awsSso,
          ...(secrets.credential ? { credential: secrets.credential } : {}),
          ...(secrets.oauthClientSecret !== undefined ? { oauthClientSecret: secrets.oauthClientSecret } : {}),
        }
        await txStep(steps, { action: "create", target: `credentialSets[${set.name}]` }, () => writeGatewaySet(tx, setProvider, input, { createdByOrgMembershipId: actor.memberId }, { createId: target.id, awaitOrganizationKey: awaitKey }))
        if (awaitKey) warnings.push(`Credential set "${set.name}" has no key yet: add it in AI Gateway before people can use "${provider.name}".`)
        continue
      }
      const row = existingSets.find((entry) => entry.id === target.id)
      const input: GatewayCredentialSetPatch = {
        ...(row?.name !== set.name ? { name: set.name } : {}),
        ...(row?.credential_mode !== set.credentialMode ? { credentialMode: set.credentialMode } : {}),
        ...(row?.status !== set.status ? { status: set.status } : {}),
        ...((row?.oauth_client_id ?? null) !== (set.oauthClientId || null) ? { oauthClientId: set.oauthClientId ?? "" } : {}),
        ...((row?.oauth_tenant_id ?? null) !== (set.oauthTenantId?.trim().toLowerCase() || null) ? { oauthTenantId: set.oauthTenantId ?? "" } : {}),
        ...(!isDeepStrictEqual(row?.aws_sso ?? null, set.awsSso ?? null) ? { awsSso: set.awsSso } : {}),
        ...(secrets.credential ? { credential: secrets.credential } : {}),
        // "unset" of a secret that is not stored writes nothing.
        ...(secrets.oauthClientSecret !== undefined && (secrets.oauthClientSecret !== "" || row?.oauth_client_secret) ? { oauthClientSecret: secrets.oauthClientSecret } : {}),
      }
      const fields = Object.keys(input)
      if (fields.length === 0) continue
      const result = await txStep(steps, { action: "update", target: `credentialSets[${set.name}]`, detail: fields.join(", ") }, () => writeGatewaySet(tx, setProvider, input, target.id))
      revoked.push(...result.revoked)
    }
    for (const row of existingSets) {
      if (!claimedSets.has(row.id)) revoked.push(...await txStep(steps, { action: "delete", target: `credentialSets[${row.name}]` }, () => removeGatewayCredentialSet(tx, provider, row.id)))
    }
  }

  for (const grant of desiredGrants) {
    if (keptGrants.has(grant.key)) continue
    keptGrants.add(grant.key)
    const reusable = typedId("inferenceProviderAccess", grant.sourceId)
    await txStep(steps, { action: "add", target: "access", detail: `${groupName(grant.write.modelGroupId)} / ${setName(grant.write.credentialSetId)} / ${grant.label}` }, () => writeGatewayGrant(tx, provider, grant.write, undefined, reusable && free.grants.has(reusable) ? { createId: reusable } : {}))
  }
  if (steps.done.length > 0) await tx.update(GatewayProviderTable).set({ updated_at: new Date() }).where(eq(GatewayProviderTable.id, provider.id))
  return revoked
}

/**
 * Runs a provider write and reports its steps. The write is one transaction:
 * if it fails nothing was written, so the error lists no steps done, only the
 * step that failed. Upstream revocation runs after commit, as its own step.
 */
async function runProviderWrite(ctx: ConfigAreaContext, log: ConfigStepLog, id: DenTypeId<"inferenceProvider">, kind: "create" | "update" | "delete", mutate: (tx: GatewayTx, steps: TxSteps) => Promise<Awaited<ReturnType<typeof removeGatewayCredentialSet>>>, options: { lockOrganization?: boolean } = {}) {
  const steps: TxSteps = { done: [], current: null }
  let revoked: Awaited<ReturnType<typeof removeGatewayCredentialSet>>
  try {
    revoked = await providerWrite(ctx, id, kind, (tx) => mutate(tx, steps), options)
  } catch (error) {
    const step = steps.current
    throw configItemError(error, [], step ? { step, field: step.target.split("[")[0] } : {})
  }
  log.add(...steps.done)
  if (revoked.length) {
    await log.run({ action: "delete", target: "credentials", detail: `${revoked.length} credential(s) revoked upstream` }, () => revokeUpstreamCredentials(revoked))
  }
}

function parseResolved(item: ResolvedConfigItem): ResolvedSpec {
  const parsed = resolvedSpecSchema.safeParse(item.spec)
  if (!parsed.success) throw failure(`"${item.name}" is not a valid provider: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`)
  return parsed.data
}

function assertApplicable(ctx: ConfigAreaContext, spec: ResolvedSpec, name: string) {
  if (isLiteLlmProviderId(spec.providerId)) throw failure(`"${name}" is a LiteLLM provider. Its models, groups and keys come from your LiteLLM proxy, so it can't be created or changed from a config blob: add or edit it in AI Gateway, then sync.`)
  if (isGatewayCustomProviderId(spec.providerId)) {
    if (!ctx.features.gatewayCustomProviders) throw failure(`"${name}" is a custom OpenAI-compatible provider, and custom providers are off for this organization.`)
    if (!spec.custom) throw failure(`"${name}" is a custom provider without its model list (custom.models).`)
    if (!spec.settings.upstreamBaseUrl) throw failure(`"${name}" is a custom provider without its API address (settings.upstreamBaseUrl).`)
  }
}

function customBaseUrl(value: string | undefined): string {
  const checked = checkCustomBaseUrl(value ?? "")
  if (!checked.ok) throw new GatewayWriteError(400, "invalid_base_url", checked.message)
  return checked.baseUrl
}

function customSettings(baseUrl: string, spec: ResolvedSpec, discovery: GatewayCustomProviderSettings["discovery"]): Record<string, unknown> {
  const custom: GatewayCustomProviderSettings = { version: 1, catalog: spec.custom?.models ?? [], discovery }
  return { upstreamBaseUrl: baseUrl, custom }
}

async function createProvider(ctx: ConfigAreaContext, log: ConfigStepLog, item: ResolvedConfigItem, spec: ResolvedSpec, preferredId: string | undefined): Promise<Omit<ConfigApplyResult, "steps">> {
  const actor = actorOf(ctx)
  const id = typedId("inferenceProvider", preferredId) ?? createDenTypeId("inferenceProvider")
  const warnings: string[] = []
  const now = new Date()
  const base = { id, organization_id: actor.organizationId, created_by_org_membership_id: actor.memberId, name: item.name, pinned_model_ids: [], credential_mode: "org" as const, oauth_client_id: null, oauth_client_secret: null, status: spec.status, created_at: now, updated_at: now }
  let provider: GatewayProvider
  let catalog: ModelsDevProvider
  let models: ReturnType<typeof resolveGatewayCatalog>["models"]
  if (isGatewayCustomProviderId(spec.providerId)) {
    const baseUrl = customBaseUrl(spec.settings.upstreamBaseUrl)
    provider = { ...base, provider_id: GATEWAY_CUSTOM_PROVIDER_ID, model_ids: [...new Set(spec.modelIds)], provider_config: customProviderConfig(item.name), settings: customSettings(baseUrl, spec, { status: "unavailable", lastFetchedAt: null, listedModelIds: [] }) }
    validateGatewaySettings(provider.provider_config, { upstreamBaseUrl: baseUrl })
    const custom = customCatalogProvider(provider)
    if (!custom) throw new GatewayWriteError(400, "invalid_request", "Check the custom provider's model settings.")
    catalog = custom
    models = resolveGatewayCatalog(custom, provider.model_ids, provider.provider_config).models
  } else {
    let resolved: Awaited<ReturnType<typeof gatewayCatalog>>
    try { resolved = await gatewayCatalog(spec.providerId, spec.modelIds) } catch (error) {
      if (error instanceof GatewayWriteError && error.code === "provider_not_found") throw failure(`"${item.name}" uses provider "${spec.providerId}", which this server's model catalog doesn't have.`, "providerId")
      throw error
    }
    validateGatewaySettings(resolved.config, spec.settings)
    provider = { ...base, provider_id: resolved.catalog.id, model_ids: [...new Set(spec.modelIds)], provider_config: resolved.config, settings: spec.settings }
    catalog = resolved.catalog
    models = resolved.models
  }
  const all: MatrixScope = { groups: true, sets: true, access: true, touched: null }
  await runProviderWrite(ctx, log, id, "create", async (tx, steps) => {
    await txStep(steps, { action: "create", target: "provider", detail: item.name }, async () => {
      await tx.insert(GatewayProviderTable).values(provider)
      await writeGatewayModels(tx, provider, models, { createIds: await modelCreateIds(tx, spec) })
    })
    if (spec.pinnedModelIds.length) await txStep(steps, { action: "set", target: "pinnedModelIds", detail: spec.pinnedModelIds.join(", ") }, () => writePins(tx, provider, spec.pinnedModelIds, warnings))
    return applyMatrix(tx, provider, spec, catalog, actor, warnings, all, steps)
  })
  return { localId: id, warnings }
}

/**
 * Update: only the parts the plan changes are written. Provider fields (name,
 * status, settings, model policy) go through patchGatewayProvider with just the
 * changed fields; a custom provider's settings row is rewritten as one row
 * when any of them changes (its address, catalog and policy are validated together).
 */
async function updateProvider(ctx: ConfigAreaContext, log: ConfigStepLog, op: Extract<ConfigApplyOp, { kind: "update" }>, spec: ResolvedSpec): Promise<Omit<ConfigApplyResult, "steps">> {
  const actor = actorOf(ctx)
  const item = op.item
  const id = normalizeDenTypeId("inferenceProvider", op.targetId)
  const warnings: string[] = []
  const touched = opTouched(op)
  const nameChanged = touches(touched, "name")
  const statusChanged = touches(touched, "status")
  const settingsChanged = touches(touched, "settings")
  const modelsChanged = touches(touched, "modelIds", "models", "custom")
  const providerFieldsChanged = nameChanged || statusChanged || settingsChanged || modelsChanged
  const scope: MatrixScope = { groups: touches(touched, "modelGroups"), sets: touches(touched, "credentialSets"), access: touches(touched, "access"), touched }
  const [before] = await ctx.db.select().from(GatewayProviderTable).where(and(eq(GatewayProviderTable.id, id), eq(GatewayProviderTable.organization_id, actor.organizationId)))
  if (!before) throw new GatewayWriteError(404, "inference_provider_not_found")
  if (before.provider_id !== spec.providerId) throw failure(`"${item.name}" can't change from provider "${before.provider_id}" to "${spec.providerId}". Create a separate provider instead.`, "providerId")
  // Catalog I/O happens before any lock, as in the routes.
  const trusted = isGatewayCustomProviderId(before.provider_id) ? null : await trustedProviderCatalog(before)
  await runProviderWrite(ctx, log, id, "update", async (tx, steps) => {
    let provider = await lockProvider(tx, actor, id)
    let catalog: ModelsDevProvider | null = trusted
    if (isGatewayCustomProviderId(provider.provider_id)) {
      const existing = provider
      const current = readCustomProviderSettings(existing.settings)
      const currentUrl = typeof existing.settings.upstreamBaseUrl === "string" ? existing.settings.upstreamBaseUrl : null
      if (!current || !currentUrl) throw new GatewayWriteError(409, "custom_settings_invalid", "This provider's saved settings can't be read. Remove it and add it again.")
      const baseUrl = customBaseUrl(spec.settings.upstreamBaseUrl)
      // A saved key is never sent to a host it was not saved for.
      if (!sameCustomOrigin(baseUrl, currentUrl) && spec.credentialSets.some((set) => set.credentialMode === "org" && set.credential?.decision !== "value")) {
        throw failure(`"${item.name}" moves to another host; enter its API key again for that address.`, "settings.upstreamBaseUrl")
      }
      const modelIds = new Set((spec.custom?.models ?? []).map((model) => model.id))
      const next: GatewayProvider = { ...existing, name: item.name, provider_config: customProviderConfig(item.name), settings: { ...existing.settings, ...customSettings(baseUrl, spec, current.discovery) }, model_ids: [...new Set(spec.modelIds)], pinned_model_ids: (existing.pinned_model_ids ?? []).filter((pin) => modelIds.has(pin)), status: spec.status, updated_at: new Date() }
      validateGatewaySettings(next.provider_config, { upstreamBaseUrl: baseUrl })
      catalog = customCatalogProvider(next)
      if (!catalog) throw new GatewayWriteError(400, "invalid_request", "Check the custom provider's model settings.")
      if (providerFieldsChanged) {
        const custom = catalog
        await txStep(steps, { action: "update", target: "provider", detail: changedFieldList(touched, ["name", "status", "settings", "modelIds", "custom", "models"]) }, async () => {
          if (spec.status === "disabled" && existing.status === "active") await tx.delete(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.gateway_provider_id, existing.id))
          await tx.update(GatewayProviderTable).set({ name: next.name, provider_config: next.provider_config, settings: next.settings, model_ids: next.model_ids, pinned_model_ids: next.pinned_model_ids, status: next.status, updated_at: next.updated_at }).where(eq(GatewayProviderTable.id, next.id))
          await writeGatewayModels(tx, next, resolveGatewayCatalog(custom, next.model_ids, next.provider_config, false).models, { createIds: await modelCreateIds(tx, spec) })
        })
        provider = next
      }
    } else if (providerFieldsChanged) {
      if (settingsChanged) {
        const persisted = publicProviderSettings(provider.settings)
        const removed = Object.keys(persisted).filter((key) => !Object.hasOwn(spec.settings, key))
        if (removed.length) throw new GatewayWriteError(409, "provider_destination_immutable", "Create a separate provider to change the upstream account or destination. Existing credentials cannot be relocated.")
      }
      const existing = provider
      const createModelIds = modelsChanged ? await modelCreateIds(tx, spec) : undefined
      provider = await txStep(steps, { action: "update", target: "provider", detail: changedFieldList(touched, ["name", "status", "settings", "modelIds", "models"]) }, () => patchGatewayProvider(tx, existing, trusted, {
        ...(nameChanged ? { name: item.name } : {}),
        ...(statusChanged ? { status: spec.status } : {}),
        ...(settingsChanged ? { settings: spec.settings } : {}),
        ...(modelsChanged ? { modelIds: spec.modelIds } : {}),
      }, { ...(createModelIds ? { createModelIds } : {}), syncModels: modelsChanged }))
    }
    if (touches(touched, "pinnedModelIds")) {
      const current = provider
      await txStep(steps, { action: "set", target: "pinnedModelIds", detail: spec.pinnedModelIds.join(", ") || "none" }, () => writePins(tx, current, spec.pinnedModelIds, warnings))
    }
    return applyMatrix(tx, provider, spec, catalog, actor, warnings, scope, steps)
  })
  return { localId: id, warnings }
}

function changedFieldList(changes: readonly ConfigFieldChange[], fields: readonly string[]): string | undefined {
  const hit = fields.filter((field) => touches(changes, field))
  return hit.length ? hit.join(", ") : undefined
}

async function deleteProvider(ctx: ConfigAreaContext, log: ConfigStepLog, targetId: string, name: string): Promise<Omit<ConfigApplyResult, "steps">> {
  const actor = actorOf(ctx)
  const id = normalizeDenTypeId("inferenceProvider", targetId)
  await runProviderWrite(ctx, log, id, "delete", async (tx, steps) => {
    const provider = await lockProvider(tx, actor, id)
    // No usage-limit choice: a provider with active usage limits is refused with their list.
    return txStep(steps, { action: "delete", target: "provider", detail: name }, () => removeGatewayProvider(tx, provider, { organizationId: actor.organizationId, memberId: actor.memberId }, undefined))
  }, { lockOrganization: true })
  return { localId: id }
}

/** The credential set (from a spec) with this id. */
function specSet(spec: ConfigItem["spec"], id: string): Record<string, unknown> | null {
  const sets = spec.credentialSets
  if (!Array.isArray(sets)) return null
  for (const set of sets) if (isPlainRecord(set) && set.id === id) return set
  return null
}

/** A credential set by the label the plan names it with (`childLabels`), else by id. */
function specSetByLabel(spec: Record<string, unknown>, label: string): Record<string, unknown> | null {
  const labels = childLabels(spec.credentialSets)
  const id = [...labels].find(([, entry]) => entry === label)?.[0] ?? label
  return specSet(spec, id)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Plain-language effects a restore can't undo (credential deletion, sign-in revocation, overwritten keys). */
function irreversible(op: ConfigApplyOp): string[] {
  if (op.kind === "delete") {
    const out = [`The stored keys of "${op.previous.name}" and members' sign-ins to it are deleted (and revoked upstream); keys must be re-entered after a restore.`]
    if (op.previous.spec.providerId === "litellm") out.push(`Keys OpenWork created in LiteLLM for "${op.previous.name}" are deleted there.`)
    return out
  }
  if (op.kind !== "update") return []
  const out: string[] = []
  for (const change of op.changes) {
    const match = /^credentialSets\[id=([^\]]+)\](?:\.(.+))?$/.exec(change.path)
    if (!match) continue
    const [, label, field] = match
    const previous = label ? specSetByLabel(op.previous.spec, label) : null
    const name = typeof previous?.name === "string" ? previous.name : label
    if (!field && change.to === undefined && previous) out.push(`Credential set "${name}": its stored key and members' sign-ins are deleted (and revoked upstream).`)
    if (field && previous && ["credentialMode", "oauthClientId", "oauthTenantId", "awsSso"].some((key) => field === key || field.startsWith(`${key}.`))) {
      out.push(`Members' sign-ins through credential set "${name}" are revoked; they sign in again.`)
    }
    if (field === "status" && change.to === "disabled") out.push(`Credential set "${name}" is disabled: members' sign-ins through it are revoked.`)
  }
  const sets = Array.isArray(op.item.spec.credentialSets) ? op.item.spec.credentialSets : []
  for (const set of sets) {
    if (!isPlainRecord(set) || typeof set.id !== "string") continue
    const previous = specSet(op.previous.spec, set.id)
    if (!previous) continue
    const name = typeof set.name === "string" ? set.name : set.id
    out.push(...secretEffects(set.credential, `key of credential set "${name}"`, previous.credential))
    out.push(...secretEffects(set.oauthClientSecret, `OAuth client secret of credential set "${name}"`, previous.oauthClientSecret))
  }
  return [...new Set(out)]
}

// ---------------------------------------------------------------------------
// Comparing across organizations

/**
 * Model groups and credential sets keep their row ids in the blob (a move to
 * another instance reuses them, so Gateway aliases survive), but on the same
 * instance an import gives them new ids. Compared, they are told apart by
 * name instead (name and id when two share a name), and access grants name
 * them by that label: a re-import into another organization then matches
 * them, as the apply does (by id, then by name).
 */
export function childLabels(rows: unknown): Map<string, string> {
  const entries = Array.isArray(rows) ? rows.flatMap((row) => isPlainRecord(row) && typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : []) : []
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1)
  return new Map(entries.map((entry) => [entry.id, (counts.get(entry.name) ?? 0) > 1 ? `${entry.name}#${entry.id}` : entry.name]))
}

function comparableSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const groups = childLabels(spec.modelGroups)
  const sets = childLabels(spec.credentialSets)
  const relabel = (rows: unknown, labels: Map<string, string>) => Array.isArray(rows)
    ? rows.map((row) => (isPlainRecord(row) && typeof row.id === "string" ? { ...row, id: labels.get(row.id) ?? row.id } : row))
    : rows
  const out: Record<string, unknown> = { ...spec }
  if (Array.isArray(spec.models)) out.models = spec.models.map((model) => (isPlainRecord(model) ? Object.fromEntries(Object.entries(model).filter(([key]) => key !== "id")) : model))
  if (spec.modelGroups !== undefined) out.modelGroups = relabel(spec.modelGroups, groups)
  if (spec.credentialSets !== undefined) out.credentialSets = relabel(spec.credentialSets, sets)
  if (Array.isArray(spec.access)) {
    out.access = spec.access.map((grant) => {
      if (!isPlainRecord(grant)) return grant
      const { id: _id, ...rest } = grant
      return {
        ...rest,
        ...(typeof grant.modelGroup === "string" ? { modelGroup: groups.get(grant.modelGroup) ?? grant.modelGroup } : {}),
        ...(typeof grant.credentialSet === "string" ? { credentialSet: sets.get(grant.credentialSet) ?? grant.credentialSet } : {}),
      }
    })
  }
  return out
}

function upstreamBaseUrlOf(spec: Record<string, unknown>): string | null {
  const settings = spec.settings
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null
  const value = Object.getOwnPropertyDescriptor(settings, "upstreamBaseUrl")?.value
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export const aiGatewayProvidersArea = defineConfigArea({
  key: AREA,
  label: "AI Providers",
  path: ["AI Gateway", "AI Providers"],
  idPrefix: denTypeIdPrefixes.inferenceProvider,
  specVersion: 1,
  specSchema: exportSpecSchema,
  dependsOn: ["members.teams", "members.people"],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "gateway_providers.view",
  managePermission: MANAGE,
  tables: ["gateway_providers", "gateway_provider_models", "gateway_model_groups", "gateway_model_group_models", "gateway_credential_sets", "gateway_provider_access"],
  naturalKeys: [{
    label: "provider and upstream address",
    get: (item) => {
      const provider = specString(item, "providerId")
      return provider ? `${provider}|${specBaseUrl(item) ?? "default"}` : null
    },
  }],
  similarity,
  secretFields: ["credentialSets[].credential", "credentialSets[].oauthClientSecret"],
  orderedArrays: ["pinnedModelIds", "custom.models"],
  arrayKeys: { models: "modelId", "custom.models": "id" },
  comparableSpec,
  // Catalog reads (models.dev), Google/AWS token revocation and LiteLLM key
  // deletion happen around the writes, so the engine must not wrap apply in its own transaction.
  transactional: false,
  externalEffects: true,
  irreversible,
  // The apply's own rule, earlier: a saved key is never sent to a host it was not saved for.
  async preflight(_ctx, op, info) {
    if (op.kind !== "update" || typeof op.item.spec.providerId !== "string" || !isGatewayCustomProviderId(op.item.spec.providerId)) return null
    const before = upstreamBaseUrlOf(op.previous.spec)
    const after = upstreamBaseUrlOf(op.item.spec)
    if (!before || !after || sameCustomOrigin(before, after)) return null
    const kept = info.secrets.filter((secret) => /^credentialSets\[[^\]]*\]\.credential$/.test(secret.field) && secret.decision === "keep")
    if (kept.length === 0) return null
    return { block: `"${op.item.name}" moves to another host: enter its API key again for that address instead of keeping the saved one.` }
  },
  exportItems,
  readItems: readProviders,
  async apply(ctx, op) {
    return applyWithSteps(async (log) => {
      const unavailable = gatewayManagementUnavailable()
      if (unavailable) throw new ConfigApplyError("gateway_unavailable", `${AREA}: ${unavailable.message}`, 409)
      if (op.kind === "delete") return deleteProvider(ctx, log, op.targetId, op.previous.name)
      const spec = parseResolved(op.item)
      assertApplicable(ctx, spec, op.item.name)
      return op.kind === "create" ? createProvider(ctx, log, op.item, spec, op.preferredId) : updateProvider(ctx, log, op, spec)
    })
  },
})
