import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { AuditLogError, auditOperationBinding } from "@openwork-ee/den-db/audit-log"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { AUDIT_CORRELATION_HEADER } from "@openwork/types/den/audit"
import { diffProviderSnapshots, serializeProvider, serializeProviderCredential, serializeProviderGroup, serializeProviderModel, serializeProviderSet, serializeProviderUniverse, type ProviderAuditSnapshot } from "../src/audit/provider-serializers.js"
import { bindProviderGrantAuditTarget, providerAuditRegistry, providerAuditStep, providerRequestAuditContext, providerSystemAuditContext, type ProviderAuditCapture } from "../src/audit/provider.js"
import type { GatewayAccessGrantWrite } from "@openwork/types/den/gateway"

const now = new Date("2026-01-01T00:00:00.000Z")
const provider = {
  id: createDenTypeId("inferenceProvider"), organization_id: createDenTypeId("organization"), created_by_org_membership_id: createDenTypeId("member"),
  name: "Synthetic provider", provider_id: "synthetic", model_ids: ["model-b", "model-a"], provider_config: { id: "synthetic", npm: "@ai-sdk/openai" }, settings: {},
  credential_mode: "org", status: "active", oauth_client_id: null, oauth_client_secret: "synthetic-sensitive-material", created_at: now, updated_at: now,
} satisfies Parameters<typeof serializeProvider>[0]
const set = { id: createDenTypeId("gatewayCredentialSet"), gateway_provider_id: provider.id, created_by_org_membership_id: provider.created_by_org_membership_id, name: "Synthetic credentials", credential_mode: "org", status: "active", oauth_client_id: "synthetic-client", oauth_client_secret: "synthetic-sensitive-material", created_at: now, updated_at: now } satisfies Parameters<typeof serializeProviderSet>[0]
const credential = { id: createDenTypeId("inferenceProviderCredential"), gateway_provider_id: provider.id, credential_set_id: set.id, organization_id: provider.organization_id, subject: "org", org_membership_id: null, kind: "api_key", secret: "synthetic-sensitive-material", status: "active", expires_at: null, refreshing_until: null, last_refreshed_at: null, scopes: "sensitive-scopes", last_error: "sensitive-error", created_at: now, updated_at: now } satisfies Parameters<typeof serializeProviderCredential>[0]
const model = { id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: provider.id, model_id: "model-a", name: "Synthetic model", model_config: { id: "model-a" }, created_at: now }
const group = { id: createDenTypeId("gatewayModelGroup"), gateway_provider_id: provider.id, name: "Synthetic group", description: null, status: "active", created_at: now, updated_at: now } satisfies Parameters<typeof serializeProviderGroup>[0]
const invalid = (error: unknown) => error instanceof AuditLogError && error.code === "audit_invalid_input"
const oversized = (error: unknown) => error instanceof AuditLogError && error.code === "audit_evidence_too_large"

function providerMap(row = provider): ProviderAuditSnapshot {
  return new Map([[`provider:${row.id}`, { type: "provider", id: row.id, action: "provider", snapshot: serializeProvider(row), related: [] }]])
}

test("allowlists exclude unknown nested settings, credentials and tool content rather than filtering key names", () => {
  const hostile = { arbitrary: "synthetic-sensitive-material", headers: { "x-custom": "synthetic-sensitive-material" }, messages: ["synthetic-sensitive-material"], options: { apiKey: "synthetic-sensitive-material" }, token: "synthetic-sensitive-material" }
  const evidence = [serializeProvider({ ...provider, provider_config: { ...hostile, ...provider.provider_config }, settings: hostile }), serializeProviderModel({ ...model, model_config: { ...hostile, limit: { context: 128000, custom: "synthetic-sensitive-material" }, cost: { input: 2, arbitrary: "synthetic-sensitive-material" } } }), serializeProviderSet(set), serializeProviderCredential(credential)]
  const serialized = JSON.stringify(evidence)
  for (const value of ["synthetic-sensitive-material", "sensitive-scopes", "sensitive-error", "headers", "messages", "apiKey", "oauth_client_secret", "last_error"]) assert.equal(serialized.includes(value), false)
  assert.equal(evidence[2].oauthClientConfigured, true)
  assert.equal(evidence[3].id, credential.id)
})

test("URL evidence rejects credentials, queries and fragments, including encoded userinfo", () => {
  for (const value of ["https://user:secret@example.test", "https://%75ser:%73ecret@example.test", "https://example.test?key=synthetic-sensitive-material", "https://example.test#synthetic-sensitive-material", "file:///private/key"]) {
    assert.throws(() => serializeProvider({ ...provider, settings: { upstreamBaseUrl: value } }), invalid)
    assert.throws(() => serializeProvider({ ...provider, provider_config: { api: value } }), invalid)
    assert.throws(() => serializeProviderModel({ ...model, model_config: { provider: { api: value } } }), invalid)
  }
})

test("known scalar fields reject objects, getters and recognizable secret values", () => {
  for (const value of [{ token: "secret" }, ["secret"], "Bearer synthetic-sensitive-material", "-----BEGIN PRIVATE KEY-----", "enc:v1:synthetic", `sk-${"x".repeat(30)}`]) {
    assert.throws(() => serializeProvider({ ...provider, settings: { project: value } }), invalid)
  }
  let invoked = false
  const settings = Object.defineProperty({}, "project", { enumerable: true, get() { invoked = true; return "secret" } })
  assert.throws(() => serializeProvider({ ...provider, settings }), invalid)
  assert.equal(invoked, false)
  assert.throws(() => serializeProviderModel({ ...model, model_config: { cost: { input: { value: 1, secret: "secret" } } } }), invalid)
})

test("group descriptions preserve multiline whitespace with JSON escaping and secret rejection", () => {
  const description = "First line\n\tIndented\r\nLast line\r"
  const snapshot = serializeProviderGroup({ ...group, description }, [])
  assert.equal(snapshot.description, description)
  const encoded = JSON.stringify(snapshot)
  assert.ok(encoded.includes("First line\\n\\tIndented\\r\\nLast line\\r"))
  assert.equal(JSON.parse(encoded).description, description)
  for (const value of ["First\nBearer synthetic-secret", "First\r\n-----BEGIN PRIVATE KEY-----", "First\tsk-" + "x".repeat(32), "line\u0000bad", "line\u000bwrong"]) assert.throws(() => serializeProviderGroup({ ...group, description: value }, []), invalid)
  assert.throws(() => serializeProviderGroup({ ...group, description: "\n".repeat(40001) }, []), oversized)
})

test("universe is logical provider ID and order-only changes are not mutations", () => {
  assert.deepEqual(serializeProviderUniverse(provider), { id: provider.id, mode: "selected", modelIds: ["model-a", "model-b"] })
  assert.deepEqual(serializeProviderUniverse({ ...provider, model_ids: [] }), { id: provider.id, mode: "all_supported", modelIds: [] })
  assert.deepEqual(serializeProviderGroup(group, [model.id, model.id]), serializeProviderGroup(group, [model.id]))
  assert.deepEqual(diffProviderSnapshots(provider.id, providerMap(), providerMap({ ...provider, updated_at: new Date() })), [])
})

test("create, update and delete evidence preserves snapshots and changed fields", () => {
  const empty: ProviderAuditSnapshot = new Map()
  const before = providerMap()
  const after = providerMap({ ...provider, name: "Renamed" })
  assert.equal(diffProviderSnapshots(provider.id, empty, before)[0].changes?.before, null)
  assert.equal(diffProviderSnapshots(provider.id, before, empty)[0].changes?.after, null)
  const [event] = diffProviderSnapshots(provider.id, before, after)
  assert.equal(event.action, "provider.updated")
  assert.deepEqual(event.changes?.changedFields, ["name"])
  assert.equal(event.changes?.before?.name, "Synthetic provider")
  assert.equal(event.changes?.after?.name, "Renamed")
})

test("rotation records a marker and stable credential identity, never comparison digests", () => {
  const entry = { type: "provider_credential", id: credential.id, action: "provider.credential", snapshot: serializeProviderCredential(credential), related: [], materialRevision: "private-comparison-before" }
  const before: ProviderAuditSnapshot = new Map([[credential.id, entry]])
  const after: ProviderAuditSnapshot = new Map([[credential.id, { ...entry, materialRevision: "private-comparison-after" }]])
  const [event] = diffProviderSnapshots(provider.id, before, after)
  assert.deepEqual(event.changes?.changedFields, ["credentialMaterial"])
  assert.deepEqual(event.changes?.before, event.changes?.after)
  assert.equal(JSON.stringify(event).includes("private-comparison"), false)
  assert.equal(event.resources[0].id, credential.id)
  assert.deepEqual(diffProviderSnapshots(provider.id, after, after), [])
})

test("per-resource evidence limits reject oversized UTF-8 and references without truncation", () => {
  assert.throws(() => serializeProviderGroup({ ...group, description: "x".repeat(40001) }, []), oversized)
  assert.throws(() => serializeProviderUniverse({ ...provider, model_ids: Array.from({ length: 500 }, (_, index) => `${index}-${"x".repeat(245)}`) }), oversized)
  assert.throws(() => serializeProvider({ ...provider, name: "字".repeat(341) }), oversized)
  const entry = { type: "provider_model", id: model.id, action: "provider.model", snapshot: serializeProviderModel(model), related: Array.from({ length: 256 }, (_, index) => ({ type: "provider_model_group", id: String(index), relationship: "related" as const })) }
  assert.throws(() => diffProviderSnapshots(provider.id, new Map(), new Map([[model.id, entry]])), oversized)
})

test("verified member and credential identity bind operation; UI hint never proves origin or request identity", () => {
  const input = { organizationId: provider.organization_id, providerId: provider.id, workflowStep: "update", userId: createDenTypeId("user"), memberId: provider.created_by_org_membership_id, credentialId: "synthetic-api-credential", headers: new Headers({ [AUDIT_CORRELATION_HEADER]: randomUUID(), "x-request-id": "attacker-id", "x-openwork-origin": "cloud_ui" }) }
  const first = providerRequestAuditContext(input)
  const retry = providerRequestAuditContext(input)
  assert.equal(first.origin, "api")
  assert.equal(first.originTrust, "authenticated")
  assert.notEqual(first.requestId, "attacker-id")
  assert.notEqual(first.requestId, retry.requestId)
  assert.equal(first.actor.id, input.userId)
  assert.equal(first.actor.credentialId, input.credentialId)
  assert.equal(auditOperationBinding(first), auditOperationBinding(retry))
  for (const context of [providerRequestAuditContext({ ...input, credentialId: "other-key" }), providerRequestAuditContext({ ...input, providerId: createDenTypeId("inferenceProvider") }), providerRequestAuditContext({ ...input, userId: createDenTypeId("user") }), providerRequestAuditContext({ ...input, organizationId: createDenTypeId("organization") })]) assert.notEqual(auditOperationBinding(first), auditOperationBinding(context))
  assert.equal(providerRequestAuditContext({ ...input, serverRequestId: "req_server-owned" }).requestId, "req_server-owned")
})

test("adapter derives claims from registered steps and validated route IDs, not caller headers or names", () => {
  const groupId = createDenTypeId("gatewayModelGroup")
  const input = { organizationId: provider.organization_id, providerId: provider.id, userId: createDenTypeId("user"), memberId: provider.created_by_org_membership_id, headers: new Headers({ [AUDIT_CORRELATION_HEADER]: randomUUID(), "x-workflow-step": "update", "x-workflow-scope": provider.id }) }
  const group = providerRequestAuditContext({ ...input, workflowStep: "group.update", routeParams: { groupId } })
  assert.equal(group.workflowStepScope, `${provider.id}/model-groups/${groupId}`)
  const invalid = providerRequestAuditContext({ ...input, workflowStep: "group.update", routeParams: { groupId: "name-not-id" } })
  assert.equal(invalid.workflowStepScope, undefined)
  assert.equal(auditOperationBinding(invalid), auditOperationBinding(invalid, false))
  const headersOnly = providerRequestAuditContext(input)
  assert.equal(headersOnly.workflowStep, undefined)
  assert.equal(auditOperationBinding(headersOnly), auditOperationBinding(headersOnly, false))
  const create = providerRequestAuditContext({ ...input, workflowStep: "group.create", routeParams: { groupId } })
  assert.equal(create.workflowStepScope, provider.id)
  assert.equal(providerAuditRegistry.grouping.maximumStepClaims, 128)
  assert.equal(providerAuditRegistry.grouping.status, "pilot")
  assert.equal(providerAuditRegistry.grouping.charging, "disabled")
})

test("grant binding reads only validated target identities and uses the organization from context", () => {
  const makeCapture = (): ProviderAuditCapture => ({
    context: providerRequestAuditContext({ organizationId: provider.organization_id, providerId: provider.id, userId: createDenTypeId("user"), memberId: provider.created_by_org_membership_id, workflowStep: "grant.create", headers: new Headers({ [AUDIT_CORRELATION_HEADER]: randomUUID(), "x-workflow-step": "client.workflow", "x-workflow-scope": "synthetic-secret" }) }),
    step: "grant.create",
    policy: { organizationId: provider.organization_id, revision: 1, source: "operator", enabled: true, categories: ["change", "request"], allowance: 100, excessMode: "keep_all", effectiveAt: now.toISOString(), captureStartedAt: null, attachmentWindowSeconds: 300 },
  })
  const capture = makeCapture()
  assert.equal(capture.context.workflowStepScope, undefined)
  const target: GatewayAccessGrantWrite = { modelGroupId: group.id, credentialSetId: set.id, audience: { type: "organization" } }
  let sensitiveRead = false
  const hostile = { ...target, audience: { ...target.audience, organizationId: createDenTypeId("organization") } }
  for (const key of ["secret", "stepHash", "workflowStep", "toJSON"]) Object.defineProperty(hostile, key, { enumerable: true, get() { sensitiveRead = true; throw new Error("must not inspect secret content") } })
  Object.defineProperty(hostile.audience, "secret", { enumerable: true, get() { sensitiveRead = true; throw new Error("must not inspect audience secret content") } })
  bindProviderGrantAuditTarget(capture, hostile)
  assert.equal(sensitiveRead, false)
  assert.equal(capture.context.workflowStep, "grant.create")
  assert.equal(capture.context.workflowStepScope, `${provider.id}/grant-target/${group.id}/${set.id}/organization/${provider.organization_id}`)
  const clean = makeCapture()
  bindProviderGrantAuditTarget(clean, target)
  assert.equal(clean.context.workflowStepScope, capture.context.workflowStepScope)
  assert.equal(JSON.stringify(capture.context).includes("synthetic-secret"), false)
  const memberId = createDenTypeId("member")
  const teamId = createDenTypeId("team")
  for (const audience of [{ type: "member", memberId }, { type: "team", teamId }] satisfies GatewayAccessGrantWrite["audience"][]) {
    const selected = makeCapture()
    bindProviderGrantAuditTarget(selected, { ...target, audience })
    assert.equal(selected.context.workflowStepScope, `${provider.id}/grant-target/${group.id}/${set.id}/${audience.type}/${audience.type === "member" ? memberId : teamId}`)
  }
  assert.throws(() => bindProviderGrantAuditTarget(makeCapture(), { ...target, modelGroupId: set.id }), invalid)
  assert.throws(() => bindProviderGrantAuditTarget(makeCapture(), { ...target, audience: { type: "member", memberId: "Bearer synthetic-secret" } }), (error) => invalid(error) && error instanceof Error && !error.message.includes("synthetic-secret"))
  assert.throws(() => bindProviderGrantAuditTarget({ ...makeCapture(), step: "update" }, target), invalid)
  assert.doesNotThrow(() => bindProviderGrantAuditTarget(null, hostile))
  assert.equal(sensitiveRead, false)
})

test("registry permits only server selected configuration steps and system work is independent", () => {
  assert.equal(providerAuditStep("PATCH", "/v1/inference-providers/:inferenceProviderId/model-groups/:groupId"), "group.update")
  assert.equal(providerAuditStep("POST", "/v1/arbitrary-operation"), null)
  assert.ok(providerAuditRegistry.uncovered.googleRevocation.includes("not captured"))
  const first = providerSystemAuditContext(provider.organization_id, provider.id)
  const second = providerSystemAuditContext(provider.organization_id, provider.id)
  assert.equal(first.actor.type, "system")
  assert.notEqual(auditOperationBinding(first), auditOperationBinding(second))
})
