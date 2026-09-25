import { createHmac, randomBytes } from "node:crypto"
import { AUDIT_WORKFLOW_REGISTRY, AuditLogError, appendAuditEvent, assertAuditPolicyCurrent, canonicalAuditJson, type AuditContext, type AuditDatabase, type AuditEventInput, type AuditPolicy, type AuditTx } from "@openwork-ee/den-db/audit-log"
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { GatewayCredentialSetTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderOauthStateTable, GatewayProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { readEffectiveAuditPolicy, recheckAuditEntitlement } from "./capture.js"
import { AUDIT_CORRELATION_HEADER } from "@openwork/types/den/audit"
import type { GatewayAccessGrantWrite } from "@openwork/types/den/gateway"
import { diffProviderSnapshots, serializeProvider, serializeProviderCredential, serializeProviderGrant, serializeProviderGroup, serializeProviderModel, serializeProviderSet, serializeProviderUniverse, type ProviderAuditResource, type ProviderAuditSnapshot } from "./provider-serializers.js"

export const providerAuditRegistry = {
  kind: "provider.configuration",
  scope: "provider.id",
  grouping: AUDIT_WORKFLOW_REGISTRY["provider.configuration"],
  categories: ["change", "request", "security", "execution"],
  snapshotPolicy: "allowlist_per_resource_reject_oversize",
  emitter: "providerAuditMutation",
  failurePolicy: "rollback_local_mutation_propagate_audit_failure",
  steps: {
    "POST /v1/inference-providers": "create",
    "PATCH /v1/inference-providers/:inferenceProviderId": "update",
    "DELETE /v1/inference-providers/:inferenceProviderId": "delete",
    "POST /v1/inference-providers/:inferenceProviderId/enable-models": "models.enable",
    "POST /v1/inference-providers/:inferenceProviderId/model-groups": "group.create",
    "PATCH /v1/inference-providers/:inferenceProviderId/model-groups/:groupId": "group.update",
    "DELETE /v1/inference-providers/:inferenceProviderId/model-groups/:groupId": "group.delete",
    "POST /v1/inference-providers/:inferenceProviderId/credential-sets": "set.create",
    "PATCH /v1/inference-providers/:inferenceProviderId/credential-sets/:credentialSetId": "set.update",
    "DELETE /v1/inference-providers/:inferenceProviderId/credential-sets/:credentialSetId": "set.delete",
    "POST /v1/inference-providers/:inferenceProviderId/access-grants": "grant.create",
    "PATCH /v1/inference-providers/:inferenceProviderId/access-grants/:grantId": "grant.update",
    "DELETE /v1/inference-providers/:inferenceProviderId/access-grants/:grantId": "grant.delete",
    "DELETE /v1/inference-providers/:inferenceProviderId/access/:grantId": "grant.delete",
  },
  backgroundSteps: ["catalog.refresh"],
  uncovered: {
    googleRevocation: "External Google revocation intent and outcome are not captured; credential changes describe local database state only.",
    memberOAuth: "Member OAuth exchange, disconnection and runtime token refresh are not covered by configuration capture.",
    migration: "Legacy provider migration writes and other services are outside this configuration emitter.",
    reads: "Routine read access is not covered; read-triggered catalog mutations are captured independently as system work.",
  },
} satisfies { kind: string; scope: string; grouping: typeof AUDIT_WORKFLOW_REGISTRY["provider.configuration"]; categories: string[]; snapshotPolicy: string; emitter: string; failurePolicy: string; steps: Record<string, string>; backgroundSteps: string[]; uncovered: Record<string, string> }

export function providerAuditStep(method: string, routePath: string): string | null {
  const entry = Object.entries(providerAuditRegistry.steps).find(([route]) => route === `${method} ${routePath}`)
  return entry?.[1] ?? null
}
export type ProviderAuditCapture = { context: AuditContext; policy: AuditPolicy; step: string }
type ProviderAuditRouteParams = { groupId?: string; credentialSetId?: string; grantId?: string }
function providerWorkflowStepScope(providerId: string, step?: string, params: ProviderAuditRouteParams = {}) {
  const rule = Object.entries(providerAuditRegistry.grouping.steps).find(([key]) => key === step)?.[1]
  if (!rule || rule === "grant-target") return undefined
  if (rule === "provider") return providerId
  const resourceId = rule === "model-groups" ? params.groupId : rule === "credential-sets" ? params.credentialSetId : params.grantId
  if (!resourceId) return undefined
  try {
    const type = rule === "model-groups" ? "gatewayModelGroup" : rule === "credential-sets" ? "gatewayCredentialSet" : "inferenceProviderAccess"
    if (normalizeDenTypeId(type, resourceId) !== resourceId) return undefined
    return `${providerId}/${rule}/${resourceId}`
  } catch { return undefined }
}
export function providerRequestAuditContext(input: {
  organizationId: string
  memberId: string
  userId: string
  credentialId?: string
  providerId: string
  workflowStep?: string
  routeParams?: ProviderAuditRouteParams
  serverRequestId?: string
  headers: Headers
}): AuditContext {
  return {
    organizationId: input.organizationId,
    actor: { type: "user", id: input.userId, memberId: input.memberId, ...(input.credentialId ? { credentialId: input.credentialId } : {}) },
    principalKey: `user:${input.userId}:member:${input.memberId}:credential:${input.credentialId ?? "session"}`,
    origin: "api", originTrust: "authenticated",
    requestId: input.serverRequestId ?? createDenTypeId("request"),
    correlationId: input.headers.get(AUDIT_CORRELATION_HEADER),
    kind: providerAuditRegistry.kind, scope: normalizeDenTypeId("inferenceProvider", input.providerId),
    workflowStep: input.workflowStep,
    workflowStepScope: providerWorkflowStepScope(input.providerId, input.workflowStep, input.routeParams),
  }
}
export function bindProviderGrantAuditTarget(capture: ProviderAuditCapture | null, input: GatewayAccessGrantWrite): void {
  if (!capture) return
  if (capture.step !== "grant.create" || capture.context.kind !== providerAuditRegistry.kind || capture.context.workflowStep !== "grant.create") throw new AuditLogError("audit_invalid_input")
  try {
    const providerId = normalizeDenTypeId("inferenceProvider", capture.context.scope)
    const groupId = normalizeDenTypeId("gatewayModelGroup", input.modelGroupId)
    const setId = normalizeDenTypeId("gatewayCredentialSet", input.credentialSetId)
    const audience = input.audience
    const audienceId = audience.type === "organization" ? normalizeDenTypeId("organization", capture.context.organizationId)
      : audience.type === "member" ? normalizeDenTypeId("member", audience.memberId)
      : audience.type === "team" ? normalizeDenTypeId("team", audience.teamId)
      : null
    if (!audienceId) throw new AuditLogError("audit_invalid_input")
    capture.context = { ...capture.context, workflowStepScope: `${providerId}/grant-target/${groupId}/${setId}/${audience.type}/${audienceId}` }
  } catch { throw new AuditLogError("audit_invalid_input") }
}
export function providerSystemAuditContext(organizationId: string, providerId: string): AuditContext {
  return { organizationId, actor: { type: "system", id: "den-api.catalog-refresh" }, principalKey: "system:den-api.catalog-refresh", origin: "api", originTrust: "authenticated", requestId: createDenTypeId("request"), kind: providerAuditRegistry.kind, scope: providerId }
}
export async function loadProviderAudit(database: AuditDatabase, enabled: boolean, context: AuditContext, step: string): Promise<ProviderAuditCapture | null> {
  if (!enabled) return null
  if (![...Object.values(providerAuditRegistry.steps), ...providerAuditRegistry.backgroundSteps].includes(step)) throw new Error("audit_provider_step_invalid")
  const policy = await readEffectiveAuditPolicy(database, context.organizationId, enabled)
  if (!policy?.enabled || !policy.categories.some((category) => providerAuditRegistry.categories.includes(category))) return null
  return { context, policy, step }
}

async function providerSnapshot(tx: AuditTx, context: AuditContext, comparisonKey: Buffer): Promise<ProviderAuditSnapshot> {
  const id = normalizeDenTypeId("inferenceProvider", context.scope)
  const organizationId = normalizeDenTypeId("organization", context.organizationId)
  const result: ProviderAuditSnapshot = new Map()
  const [provider] = await tx.select().from(GatewayProviderTable).where(and(eq(GatewayProviderTable.id, id), eq(GatewayProviderTable.organization_id, organizationId))).for("update")
  if (!provider) return result
  const add = (entry: ProviderAuditResource) => { result.set(`${entry.type}:${entry.id}`, entry) }
  const related = (type: string, id: string): AuditEventInput["resources"][number] => ({ type, id, relationship: "related" })
  const revision = (value: string | null) => createHmac("sha256", new Uint8Array(comparisonKey)).update(JSON.stringify(value)).digest("hex")
  const universe = related("provider_model_universe", id)
  add({ type: "provider", id, action: "provider", snapshot: serializeProvider(provider), related: [] })
  add({ type: "provider_model_universe", id, action: "provider.universe", snapshot: serializeProviderUniverse(provider), related: [] })
  const sets = await tx.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.gateway_provider_id, id)).for("update")
  for (const set of sets) add({ type: "provider_credential_set", id: set.id, action: "provider.credential_set", snapshot: serializeProviderSet(set), related: [], materialRevision: revision(set.oauth_client_secret) })
  const groups = await tx.select().from(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.gateway_provider_id, id)).for("update")
  const models = await tx.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, id)).for("update")
  const links = groups.length ? await tx.select().from(GatewayModelGroupModelTable).where(inArray(GatewayModelGroupModelTable.model_group_id, groups.map((group) => group.id))).for("update") : []
  for (const group of groups) add({ type: "provider_model_group", id: group.id, action: "provider.group", snapshot: serializeProviderGroup(group, links.filter((link) => link.model_group_id === group.id).map((link) => link.gateway_provider_model_id)), related: [universe] })
  for (const model of models) add({ type: "provider_model", id: model.id, action: "provider.model", snapshot: serializeProviderModel(model), configurationRevision: revision(canonicalAuditJson(model.model_config)), related: [universe, ...links.filter((link) => link.gateway_provider_model_id === model.id).map((link) => related("provider_model_group", link.model_group_id))] })
  const grants = await tx.select().from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, id)).for("update")
  // Fence states before credentials, using the indexed set prefix. A provider-only
  // predicate has no index and a locking table scan would block other tenants.
  if (sets.length) await tx.select({ id: GatewayProviderOauthStateTable.id })
    .from(GatewayProviderOauthStateTable, { forceIndex: "gateway_provider_oauth_states_set_member" })
    .where(and(eq(GatewayProviderOauthStateTable.gateway_provider_id, id), inArray(GatewayProviderOauthStateTable.credential_set_id, sets.map((set) => set.id))))
    .orderBy(GatewayProviderOauthStateTable.credential_set_id, GatewayProviderOauthStateTable.id).for("update")
  const credentials = await tx.select().from(GatewayProviderCredentialTable).where(and(eq(GatewayProviderCredentialTable.gateway_provider_id, id), eq(GatewayProviderCredentialTable.organization_id, organizationId))).for("update")
  for (const credential of credentials) add({ type: "provider_credential", id: credential.id, action: "provider.credential", snapshot: serializeProviderCredential(credential), related: [related("provider_credential_set", credential.credential_set_id), ...(credential.org_membership_id ? [related("member", credential.org_membership_id)] : [])], materialRevision: revision(credential.secret) })
  for (const grant of grants) add({ type: "provider_access_grant", id: grant.id, action: "provider.access_grant", snapshot: serializeProviderGrant(grant), related: [related("provider_model_group", grant.model_group_id), related("provider_credential_set", grant.credential_set_id), grant.org_membership_id ? related("member", grant.org_membership_id) : grant.team_id ? related("team", grant.team_id) : related("organization", organizationId)] })
  return result
}

export async function providerAuditMutation<T>(tx: AuditTx, capture: ProviderAuditCapture | null, mutate: () => Promise<T>): Promise<T> {
  if (!capture) return mutate()
  await recheckAuditEntitlement(tx, capture.context.organizationId)
  const changesEnabled = capture.policy.categories.includes("change")
  const comparisonKey = changesEnabled ? randomBytes(32) : null
  // A create has no before state: probing its absent PK FOR UPDATE would acquire
  // a gap lock and deadlock otherwise independent concurrent provider inserts.
  const before: ProviderAuditSnapshot | null = comparisonKey
    ? capture.step === "create" ? new Map() : await providerSnapshot(tx, capture.context, comparisonKey)
    : null
  const result = await mutate()
  const events = before && comparisonKey ? diffProviderSnapshots(capture.context.scope, before, await providerSnapshot(tx, capture.context, comparisonKey)) : []
  await assertAuditPolicyCurrent(tx, capture.policy)
  for (const event of events) await appendAuditEvent(tx, { ...capture, event })
  if (before && capture.step === "catalog.refresh" && !events.length) return result
  await appendAuditEvent(tx, { ...capture, event: providerAttemptEvent(capture, "succeeded") })
  return result
}
function providerAttemptEvent(capture: ProviderAuditCapture, outcome: AuditEventInput["outcome"], reasonCode?: string): AuditEventInput {
  return {
    action: `provider.configuration.${capture.step}.${outcome === "succeeded" ? "committed" : "attempted"}`,
    category: outcome === "denied" && capture.policy.categories.includes("security") ? "security" : capture.step === "catalog.refresh" ? "execution" : "request",
    outcome, resources: [{ type: "provider", id: capture.context.scope, relationship: "target" }],
    ...(reasonCode ? { reasonCode } : {}),
  }
}
export async function recordProviderAttempt(database: AuditDatabase, capture: ProviderAuditCapture | null, status: number) {
  if (!capture || status < 400) return
  const denied = status === 401 || status === 403
  await database.transaction(async (tx) => {
    await recheckAuditEntitlement(tx, capture.context.organizationId)
    await assertAuditPolicyCurrent(tx, capture.policy)
    await appendAuditEvent(tx, { ...capture, event: providerAttemptEvent(capture, denied ? "denied" : "failed", denied ? "provider_configuration_denied" : status >= 500 ? "provider_configuration_failed" : "provider_configuration_rejected") })
  })
}
