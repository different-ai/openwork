import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { randomUUID } from "node:crypto"
import { createDenDb } from "@openwork-ee/den-db"
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { AuditEventTable, AuditOperationTable, AuditPolicyTable, AuditUsageFactTable, GatewayCredentialSetTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderOauthStateTable, GatewayProviderTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { AUDIT_CORRELATION_HEADER } from "@openwork/types/den/audit"
import { bindProviderGrantAuditTarget, loadProviderAudit, providerAuditMutation, providerRequestAuditContext, providerSystemAuditContext, recordProviderAttempt } from "../src/audit/provider.js"
import { setAuditCaptureState, type AuditCategory, type AuditContext, type AuditTx } from "@openwork-ee/den-db/audit-log"
import { readAuditEntitlement } from "../src/audit/capture.js"
import type { GatewayAccessGrantWrite } from "@openwork/types/den/gateway"

const url = process.env.DEN_AUDIT_TEST_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !/^\/audit_logs_test(?:_[a-z0-9_]+)?$/.test(parsed.pathname)) throw new Error("Only an explicitly owned disposable loopback audit_logs_test database is allowed; connection withheld.")
}
let instance: ReturnType<typeof createDenDb> | undefined
let matrix: typeof import("../src/llm/gateway-matrix.js")
let globalDb: typeof import("../src/db.js") | undefined
const queries: string[] = []
let onQuery: ((query: string, params: unknown[]) => void) | undefined
before(async () => {
  if (!url) return
  process.env.DATABASE_URL = url
  process.env.DB_MODE = "mysql"
  process.env.NODE_ENV = "test"
  process.env.OPENWORK_DEV_MODE = "1"
  process.env.DEN_DB_ENCRYPTION_KEY = "audit-provider-disposable-test-key-1234567890123456"
  process.env.BETTER_AUTH_SECRET = "audit-provider-disposable-auth-key-1234567890123456"
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"
  process.env.DEN_BASE_URL = "http://127.0.0.1:8790"
  instance = createDenDb({ databaseUrl: url, mode: "mysql", logger: { logQuery(query, params) { queries.push(query); onQuery?.(query, params) } } })
  matrix = await import("../src/llm/gateway-matrix.js")
  globalDb = await import("../src/db.js")
})
after(async () => {
  if (instance && "end" in instance.client) await instance.client.end()
  if (globalDb && "end" in globalDb.client) await globalDb.client.end()
})
const dbTest = (name: string, run: () => Promise<void>) => test(name, { skip: !url }, run)
function database() { assert.ok(instance); return instance.db }
function barrier() {
  let resolve = () => {}
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}
async function within<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000) })])
  } finally { clearTimeout(timer) }
}

async function fixture(categories: AuditCategory[] = ["change", "request", "security", "execution"]) {
  const db = database()
  const org = createDenTypeId("organization")
  const member = createDenTypeId("member")
  const user = createDenTypeId("user")
  const providerId = createDenTypeId("inferenceProvider")
  const setId = createDenTypeId("gatewayCredentialSet")
  const credentialId = createDenTypeId("inferenceProviderCredential")
  await db.insert(OrganizationTable).values({ id: org, name: "Synthetic capture", slug: `synthetic-${org}`, metadata: { plan: { tier: "enterprise", source: "manual" } } })
  await db.insert(AuditPolicyTable).values({ organization_id: org, source: "operator", enabled: true, categories, allowance: 100, excess_mode: "keep_all", revision: 1, effective_at: new Date("2026-01-01T00:00:00Z"), attachment_window_seconds: 300 })
  await db.insert(GatewayProviderTable).values({ id: providerId, organization_id: org, created_by_org_membership_id: member, provider_id: "synthetic", name: "Before", provider_config: { id: "synthetic", npm: "@ai-sdk/openai", env: ["SYNTHETIC_API_KEY"] }, settings: {} })
  await db.insert(GatewayCredentialSetTable).values({ id: setId, gateway_provider_id: providerId, name: "Shared", credential_mode: "org" })
  await db.insert(GatewayProviderCredentialTable).values({ id: credentialId, gateway_provider_id: providerId, credential_set_id: setId, organization_id: org, subject: "org", kind: "api_key", secret: "synthetic-sensitive-first" })
  const correlationId = randomUUID()
  const context = (workflowStep = "update", routeParams: { groupId?: string; credentialSetId?: string; grantId?: string } = {}) => providerRequestAuditContext({ organizationId: org, memberId: member, userId: user, credentialId: "synthetic-api-key-id", providerId, workflowStep, routeParams, headers: new Headers({ [AUDIT_CORRELATION_HEADER]: correlationId, "x-request-id": "untrusted-id" }) })
  const current = async () => (await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, providerId)))[0]
  const mutate = async <T>(step: string, fn: (tx: AuditTx, provider: NonNullable<Awaited<ReturnType<typeof current>>>) => Promise<T>, ctx: AuditContext = context(step), grantTarget?: GatewayAccessGrantWrite) => {
    const capture = await loadProviderAudit(db, true, ctx, step)
    if (grantTarget) bindProviderGrantAuditTarget(capture, grantTarget)
    return db.transaction(async (tx) => {
      const [provider] = await tx.select().from(GatewayProviderTable).where(and(eq(GatewayProviderTable.id, providerId), eq(GatewayProviderTable.organization_id, org))).for("update")
      assert.ok(provider)
      return providerAuditMutation(tx, capture, () => fn(tx, provider))
    })
  }
  const events = async () => (await db.select().from(AuditEventTable).where(eq(AuditEventTable.org_id, org)).orderBy(AuditEventTable.sequence)).flatMap((row) => row.envelope ? [row.envelope] : [])
  return { db, org, member, user, providerId, setId, credentialId, context, current, mutate, events }
}

dbTest("flag off, absent policy and excluded categories do not query matrix snapshots", async () => {
  const f = await fixture()
  queries.length = 0
  assert.equal(await loadProviderAudit(f.db, false, f.context(), "update"), null)
  await f.db.transaction((tx) => providerAuditMutation(tx, null, async () => 1))
  assert.equal(queries.some((sql) => /select|insert|update/i.test(sql)), false)
  const absentOrg = createDenTypeId("organization")
  await f.db.insert(OrganizationTable).values({ id: absentOrg, name: "Synthetic absent", slug: `synthetic-${absentOrg}`, metadata: { plan: { tier: "enterprise" } } })
  const absent = { ...f.context(), organizationId: absentOrg }
  assert.equal(await loadProviderAudit(f.db, true, absent, "update"), null)
  await f.db.update(AuditPolicyTable).set({ categories: ["request"] }).where(eq(AuditPolicyTable.organization_id, f.org))
  const capture = await loadProviderAudit(f.db, true, f.context(), "update")
  queries.length = 0
  await f.db.transaction((tx) => providerAuditMutation(tx, capture, async () => 1))
  assert.equal(queries.some((sql) => /gateway_/.test(sql)), false)
  assert.equal((await f.events()).length, 1)
})

dbTest("separate actors create concurrently without a before-provider SELECT or missing-PK gap probe", async () => {
  const f = await fixture()
  const actors = Array.from({ length: 2 }, () => {
    const queries: string[] = []
    return { userId: createDenTypeId("user"), memberId: createDenTypeId("member"), providerId: createDenTypeId("inferenceProvider"), queries }
  })
  await f.db.insert(MemberTable).values(actors.map((actor) => ({ id: actor.memberId, organizationId: f.org, userId: actor.userId, role: "admin" })))
  const captures = await Promise.all(actors.map((actor) => loadProviderAudit(f.db, true, providerRequestAuditContext({ organizationId: f.org, ...actor, workflowStep: "create", headers: new Headers({ [AUDIT_CORRELATION_HEADER]: randomUUID() }) }), "create")))
  assert.ok(captures.every((capture) => capture?.policy.categories.includes("change")))
  const ready = barrier()
  let arrived = 0
  onQuery = (query, params) => {
    for (const actor of actors) if (params.includes(actor.providerId)) actor.queries.push(query)
  }
  try {
    const results = await Promise.allSettled(actors.map((actor, index) => f.db.transaction(async (tx) => {
      const [member] = await tx.select().from(MemberTable).where(eq(MemberTable.id, actor.memberId)).for("update")
      assert.equal(member.userId, actor.userId)
      await providerAuditMutation(tx, captures[index], async () => {
        if (++arrived === actors.length) ready.resolve()
        await within(ready.promise, "both independently fenced create mutations reaching INSERT")
        await tx.insert(GatewayProviderTable).values({ id: actor.providerId, organization_id: f.org, created_by_org_membership_id: actor.memberId, provider_id: "synthetic", name: `Concurrent create ${index}`, provider_config: { id: "synthetic", npm: "@ai-sdk/openai" }, settings: {} })
      })
    })))
    for (const result of results) if (result.status === "rejected") throw result.reason
    assert.equal(arrived, 2)
    for (const actor of actors) {
      const insert = actor.queries.findIndex((query) => /^insert into `gateway_providers`/i.test(query))
      assert.ok(insert >= 0)
      const readsProvider = (query: string) => /^select\b/i.test(query) && /from `gateway_providers`/i.test(query)
      assert.equal(actor.queries.slice(0, insert).some(readsProvider), false, "create must not snapshot an absent provider before inserting it")
      assert.ok(actor.queries.slice(insert + 1).some((query) => readsProvider(query) && /for update/i.test(query)), "capture must still read the inserted provider under lock for its after snapshot")
    }
  } finally { onQuery = undefined; ready.resolve() }
  assert.equal((await f.db.select().from(GatewayProviderTable).where(inArray(GatewayProviderTable.id, actors.map((actor) => actor.providerId)))).length, 2)
  const created = (await f.events()).filter((event) => event.action === "provider.created")
  assert.equal(created.length, 2)
  assert.equal(new Set(created.map((event) => event.operationId)).size, 2)
  for (const actor of actors) {
    const event = created.find((event) => event.operation.scope === actor.providerId)
    assert.equal(event?.actor.id, actor.userId)
    assert.equal(event?.actor.memberId, actor.memberId)
    assert.equal(event?.changes?.before, null)
    assert.equal(event?.changes?.after?.id, actor.providerId)
  }
})

dbTest("grouped Save changes provider, universe, models, group, set, credential and grants in one operation", async () => {
  const f = await fixture()
  await f.mutate("update", async (tx, provider) => {
    await tx.update(GatewayProviderTable).set({ name: "After", model_ids: ["model-a"] }).where(eq(GatewayProviderTable.id, provider.id))
    await matrix.writeGatewayModels(tx, provider, [{ id: "model-a", name: "Model A", config: { id: "model-a", limit: { context: 128000 } } }])
  })
  const groupId = await f.mutate("group.create", (tx, provider) => matrix.writeGatewayGroup(tx, provider, { name: "Models", modelIds: ["model-a"] }))
  await f.mutate("set.update", (tx, provider) => matrix.writeGatewaySet(tx, provider, { name: "Renamed credentials", credential: { kind: "api_key", secret: "synthetic-sensitive-replacement" } }, f.setId), f.context("set.update", { credentialSetId: f.setId }))
  const grantTarget: GatewayAccessGrantWrite = { modelGroupId: groupId, credentialSetId: f.setId, audience: { type: "organization" } }
  const grantId = await f.mutate("grant.create", (tx, provider) => matrix.writeGatewayGrant(tx, provider, grantTarget), f.context("grant.create"), grantTarget)
  await f.mutate("grant.delete", (tx) => tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, grantId)), f.context("grant.delete", { grantId }))
  const events = await f.events()
  assert.equal(new Set(events.map((event) => event.operationId)).size, 1)
  assert.equal(new Set(events.filter((event) => event.category === "request").map((event) => event.requestId)).size, 5)
  const actions = events.map((event) => event.action)
  for (const action of ["provider.updated", "provider.universe.updated", "provider.model.created", "provider.group.created", "provider.credential_set.updated", "provider.credential.updated", "provider.access_grant.created", "provider.access_grant.deleted"]) assert.ok(actions.includes(action), action)
  const [model] = await f.db.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, f.providerId))
  assert.equal(events.find((event) => event.action === "provider.model.created")?.resources.find((resource) => resource.relationship === "target")?.id, model.id)
  assert.ok(events.find((event) => event.action === "provider.model.created")?.resources.some((resource) => resource.type === "provider_model_universe" && resource.id === f.providerId))
  const rotation = events.find((event) => event.action === "provider.credential.updated")
  assert.ok(rotation?.changes?.changedFields.includes("credentialMaterial"))
  assert.equal(JSON.stringify(events).includes("synthetic-sensitive"), false)
  assert.ok(events.every((event) => event.actor.id === f.user && event.actor.credentialId === "synthetic-api-key-id" && event.requestId !== "untrusted-id"))
  assert.equal((await f.db.select().from(AuditUsageFactTable).where(eq(AuditUsageFactTable.organization_id, f.org))).length, 1)
})

dbTest("non-allowlisted catalog metadata changes retain a marker without leaking content or comparison hashes", async () => {
  const f = await fixture()
  const write = (value: string) => f.mutate("catalog.refresh", (tx, provider) => matrix.writeGatewayModels(tx, provider, [{ id: "model-a", name: "Model A", config: { id: "model-a", options: { arbitraryPrivateExtension: value } } }]))
  await write("synthetic-private-first")
  await write("synthetic-private-second")
  const changes = (await f.events()).filter((event) => event.action === "provider.model.updated")
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0].changes?.changedFields, ["configuration"])
  assert.deepEqual(changes[0].changes?.before, changes[0].changes?.after)
  assert.equal(JSON.stringify(changes).includes("synthetic-private"), false)
  const count = (await f.events()).length
  await write("synthetic-private-second")
  assert.equal((await f.events()).length, count)
})

dbTest("stored attachment window prevents an expired correlation collecting later provider requests", async () => {
  const f = await fixture()
  await f.mutate("update", (tx) => tx.update(GatewayProviderTable).set({ name: "First" }).where(eq(GatewayProviderTable.id, f.providerId)))
  const [first] = await f.db.select().from(AuditOperationTable).where(eq(AuditOperationTable.organization_id, f.org))
  assert.equal(first.attachment_expires_at.getTime() - first.first_recorded_at.getTime(), 300000)
  await f.db.update(AuditOperationTable).set({ attachment_expires_at: new Date("2026-01-01T00:00:00Z") }).where(eq(AuditOperationTable.id, first.id))
  await f.mutate("update", (tx) => tx.update(GatewayProviderTable).set({ name: "Second" }).where(eq(GatewayProviderTable.id, f.providerId)))
  const events = await f.events()
  assert.equal(new Set(events.map((event) => event.operationId)).size, 2)
  assert.equal(events.at(-1)?.operationId, events.at(-2)?.operationId)
})

dbTest("identical group/set writes and timestamps produce only request records", async () => {
  const f = await fixture()
  const groupId = await f.mutate("group.create", (tx, provider) => matrix.writeGatewayGroup(tx, provider, { name: "Empty group", modelIds: [] }))
  const count = (await f.events()).filter((event) => event.category === "change").length
  await f.mutate("group.update", (tx, provider) => matrix.writeGatewayGroup(tx, provider, { name: "Empty group", modelIds: [] }, groupId))
  await f.mutate("set.update", (tx, provider) => matrix.writeGatewaySet(tx, provider, { name: "Shared", credential: { kind: "api_key", secret: "synthetic-sensitive-first" } }, f.setId))
  assert.equal((await f.events()).filter((event) => event.category === "change").length, count)
  assert.equal((await f.events()).filter((event) => event.category === "request").length, 3)
})

dbTest("local failure rolls back mutation and changes; failure and denial survive outside rollback", async () => {
  const f = await fixture()
  const context = f.context()
  await assert.rejects(f.mutate("update", async (tx) => {
    await tx.update(GatewayProviderTable).set({ name: "Must roll back" }).where(eq(GatewayProviderTable.id, f.providerId))
    throw new Error("synthetic-sensitive-exception")
  }, context), /synthetic-sensitive-exception/)
  assert.equal((await f.current()).name, "Before")
  assert.equal((await f.events()).length, 0)
  const capture = await loadProviderAudit(f.db, true, context, "update")
  await recordProviderAttempt(f.db, capture, 500)
  await recordProviderAttempt(f.db, capture, 403)
  const events = await f.events()
  assert.deepEqual(events.map((event) => event.outcome), ["failed", "denied"])
  assert.equal(events[0].operationId, events[1].operationId)
  assert.equal(events[1].category, "security")
  assert.equal(JSON.stringify(events).includes("synthetic-sensitive-exception"), false)
})

dbTest("required audit INSERT failure rolls back provider change rather than returning a warning", async () => {
  const f = await fixture()
  await f.db.insert(AuditEventTable).values({ id: createDenTypeId("auditEvent"), org_id: f.org, action: "synthetic.sequence_conflict", sequence: 1 })
  await assert.rejects(f.mutate("update", (tx) => tx.update(GatewayProviderTable).set({ name: "Must roll back" }).where(eq(GatewayProviderTable.id, f.providerId))))
  assert.equal((await f.current()).name, "Before")
  assert.equal((await f.events()).length, 0)
  assert.equal((await f.db.select().from(AuditOperationTable).where(eq(AuditOperationTable.organization_id, f.org))).length, 0)
})

dbTest("concurrent writes snapshot after the actual provider lock, not stale caller state", async () => {
  const f = await fixture()
  await Promise.all(Array.from({ length: 20 }, (_, index) => f.mutate("update", (tx) => tx.update(GatewayProviderTable).set({ name: `Concurrent ${index}` }).where(eq(GatewayProviderTable.id, f.providerId)))))
  const changes = (await f.events()).filter((event) => event.action === "provider.updated")
  assert.equal(changes.length, 20)
  assert.equal(changes[0].changes?.before?.name, "Before")
  for (let index = 1; index < changes.length; index++) assert.equal(changes[index].changes?.before?.name, changes[index - 1].changes?.after?.name)
  assert.equal(changes.at(-1)?.changes?.after?.name, (await f.current()).name)
  assert.equal(new Set(changes.map((event) => event.operationId)).size, 20)
})

dbTest("one root and nineteen real distinct child-resource writes group without late job claims", async () => {
  const f = await fixture()
  const groupIds = Array.from({ length: 19 }, () => createDenTypeId("gatewayModelGroup"))
  await f.db.insert(GatewayModelGroupTable).values(groupIds.map((id) => ({ id, gateway_provider_id: f.providerId, name: "Before" })))
  await f.mutate("update", (tx) => tx.update(GatewayProviderTable).set({ name: "Root Save" }).where(eq(GatewayProviderTable.id, f.providerId)))
  await Promise.all(groupIds.map((id, index) => f.mutate("group.update", (tx, provider) => matrix.writeGatewayGroup(tx, provider, { name: `Group ${index}` }, id), f.context("group.update", { groupId: id }))))
  const events = await f.events()
  assert.equal(events.filter((event) => event.category === "request").length, 20)
  assert.equal(events.filter((event) => event.category === "change").length, 20)
  assert.equal(new Set(events.map((event) => event.operationId)).size, 1)
})

dbTest("snapshot state-before-credential locking does not deadlock concurrent member revocation", async () => {
  const f = await fixture()
  const { revokeInferenceCredentialsForMembers } = await import("../src/llm/inference-provider-lifecycle.js")
  const stateId = createDenTypeId("inferenceProviderOauthState")
  const credentialId = createDenTypeId("inferenceProviderCredential")
  await f.db.insert(MemberTable).values({ id: f.member, organizationId: f.org, userId: f.user, role: "owner" })
  await f.db.insert(GatewayProviderCredentialTable).values({ id: credentialId, gateway_provider_id: f.providerId, credential_set_id: f.setId, organization_id: f.org, org_membership_id: f.member, subject: f.member, kind: "oauth_google", secret: "synthetic-member-material" })
  await f.db.insert(GatewayProviderOauthStateTable).values({ id: stateId, gateway_provider_id: f.providerId, credential_set_id: f.setId, org_membership_id: f.member, state: randomUUID(), code_verifier: "synthetic-verifier", expires_at: new Date(Date.now() + 600000) })
  let signalStateHeld = () => {}
  let releaseRevoker = () => {}
  const stateHeld = new Promise<void>((resolve) => { signalStateHeld = resolve })
  const release = new Promise<void>((resolve) => { releaseRevoker = resolve })
  const revoker = f.db.transaction(async (tx) => {
    await tx.select().from(MemberTable).where(eq(MemberTable.id, f.member)).for("update")
    await tx.delete(GatewayProviderOauthStateTable).where(inArray(GatewayProviderOauthStateTable.org_membership_id, [f.member]))
    signalStateHeld()
    await release
    await revokeInferenceCredentialsForMembers(tx, [f.member])
  })
  await within(Promise.race([stateHeld, revoker]), "member revocation holding its deleted OAuth states")
  let observedStateLock = false
  onQuery = (query) => {
    if (/^select/i.test(query) && query.includes("gateway_provider_oauth_states") && query.includes("for update")) {
      observedStateLock = true
      onQuery = undefined
      releaseRevoker()
    }
  }
  const mutation = f.mutate("set.update", (tx, provider) => matrix.writeGatewaySet(tx, provider, { status: "disabled" }, f.setId))
  try {
    await Promise.all([revoker, mutation])
    assert.equal(observedStateLock, true)
    assert.equal((await f.db.select().from(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.id, credentialId)))[0].status, "revoked")
    assert.equal((await f.db.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.id, stateId))).length, 0)
  } finally { onQuery = undefined; releaseRevoker(); await Promise.allSettled([revoker, mutation]) }
})

dbTest("an open provider snapshot locks only its indexed credential-set OAuth states, not another tenant's", async () => {
  const f = await fixture()
  const unrelated = await fixture()
  const extraSetId = createDenTypeId("gatewayCredentialSet")
  await f.db.insert(GatewayCredentialSetTable).values({ id: extraSetId, gateway_provider_id: f.providerId, name: "Second owned set", credential_mode: "org" })
  const ownedSetIds = [f.setId, extraSetId]
  const unrelatedStateId = createDenTypeId("inferenceProviderOauthState")
  await f.db.insert(GatewayProviderOauthStateTable).values([
    ...ownedSetIds.map((credential_set_id) => ({ id: createDenTypeId("inferenceProviderOauthState"), gateway_provider_id: f.providerId, credential_set_id, org_membership_id: f.member, state: randomUUID(), code_verifier: "synthetic-owned-verifier", expires_at: new Date(Date.now() + 600000) })),
    { id: unrelatedStateId, gateway_provider_id: unrelated.providerId, credential_set_id: unrelated.setId, org_membership_id: unrelated.member, state: randomUUID(), code_verifier: "synthetic-unrelated-verifier", expires_at: new Date(Date.now() + 600000) },
  ])
  const witnesses: Array<{ query: string; onlyOwnedSets: boolean }> = []
  onQuery = (query, params) => {
    if (/^select\b/i.test(query) && /from `gateway_provider_oauth_states`/i.test(query) && /for update/i.test(query) && params.includes(f.providerId)) {
      witnesses.push({ query, onlyOwnedSets: params.length === ownedSetIds.length + 1 && ownedSetIds.every((id) => params.includes(id)) && !params.includes(unrelated.setId) && !params.includes(unrelated.providerId) })
    }
  }
  const snapshotReady = barrier()
  const releaseSnapshot = barrier()
  let released = false
  let unrelatedLockedWhileSnapshotOpen = false
  let unrelatedWrite: Promise<void> | undefined
  const snapshot = f.mutate("update", async (tx) => {
    snapshotReady.resolve()
    await releaseSnapshot.promise
    await tx.update(GatewayProviderTable).set({ name: "Snapshot completed" }).where(eq(GatewayProviderTable.id, f.providerId))
  })
  try {
    await within(Promise.race([snapshotReady.promise, snapshot]), "provider snapshot acquiring its OAuth state locks")
    assert.equal(witnesses.length, 1)
    unrelatedWrite = unrelated.db.transaction(async (tx) => {
      const [row] = await tx.select({ id: GatewayProviderOauthStateTable.id }).from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.id, unrelatedStateId)).for("update")
      assert.equal(row.id, unrelatedStateId)
      unrelatedLockedWhileSnapshotOpen = !released
      await tx.update(GatewayProviderOauthStateTable).set({ used_at: new Date() }).where(eq(GatewayProviderOauthStateTable.id, unrelatedStateId))
    })
    await within(unrelatedWrite, "unrelated tenant acquiring and updating its state while the snapshot stays open")
    assert.equal(unrelatedLockedWhileSnapshotOpen, true)
  } finally {
    released = true
    releaseSnapshot.resolve()
    await Promise.allSettled(unrelatedWrite ? [snapshot, unrelatedWrite] : [snapshot])
    onQuery = undefined
  }
  await snapshot
  assert.equal(witnesses.length, 2)
  for (const witness of witnesses) {
    assert.match(witness.query, /force index \(`?gateway_provider_oauth_states_set_member`?\)/i)
    assert.match(witness.query, /`credential_set_id` in \(\?, \?\)/i)
    assert.equal(witness.onlyOwnedSets, true)
  }
  const [unrelatedState] = await unrelated.db.select().from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.id, unrelatedStateId))
  assert.ok(unrelatedState.used_at)
  assert.equal((await f.current()).name, "Snapshot completed")
})

dbTest("enable-models preserves universe semantics and no-op retry does not duplicate changes", async () => {
  const f = await fixture()
  const groupId = await f.mutate("group.create", (tx, provider) => matrix.writeGatewayGroup(tx, provider, { name: "Models", modelIds: [] }))
  const catalog = { id: "synthetic", name: "Synthetic", npm: "@ai-sdk/openai", env: [], api: null, doc: null, config: {}, models: [{ id: "model-a", name: "A", config: { id: "model-a" } }] }
  await f.mutate("models.enable", (tx, provider) => matrix.enableGatewayGroupModels(tx, provider, catalog, groupId, ["model-a"]))
  const count = (await f.events()).filter((event) => event.category === "change").length
  await f.mutate("models.enable", (tx, provider) => matrix.enableGatewayGroupModels(tx, provider, catalog, groupId, ["model-a"]))
  assert.equal((await f.events()).filter((event) => event.category === "change").length, count)
  assert.deepEqual((await f.current()).model_ids, [])
})

dbTest("oversized required evidence rejects the whole transaction", async () => {
  const f = await fixture()
  const groupId = await f.mutate("group.create", (tx, provider) => matrix.writeGatewayGroup(tx, provider, { name: "Group", modelIds: [] }))
  const count = (await f.events()).length
  await assert.rejects(f.mutate("group.update", (tx) => tx.update(GatewayModelGroupTable).set({ description: "x".repeat(40001) }).where(eq(GatewayModelGroupTable.id, groupId))), /audit_evidence_too_large/)
  assert.equal((await f.db.select().from(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.id, groupId)))[0].description, null)
  assert.equal((await f.events()).length, count)
})

dbTest("fresh plan reads gate provider and system capture without policy or snapshot reads for free/team", async () => {
  const f = await fixture()
  const environment = await import("../src/env.js")
  Object.assign(environment.env, { planGatingEnabled: false, auditSelfHostedEnabled: false })
  for (const tier of ["free", "team"]) {
    await f.db.update(OrganizationTable).set({ metadata: { plan: { tier }, auditLogs: true, source: "operator" } }).where(eq(OrganizationTable.id, f.org))
    queries.length = 0
    for (const context of [f.context(), providerSystemAuditContext(f.org, f.providerId)]) assert.equal(await loadProviderAudit(f.db, true, context, "catalog.refresh"), null)
    assert.equal(queries.some((query) => /audit_policy|gateway_/.test(query)), false)
    assert.ok(queries.some((query) => /organization/.test(query)))
  }
  Object.assign(environment.env, { auditSelfHostedEnabled: true })
  try { assert.ok(await loadProviderAudit(f.db, true, f.context(), "update")) } finally { Object.assign(environment.env, { auditSelfHostedEnabled: false }) }
  await f.db.update(OrganizationTable).set({ metadata: { plan: { tier: "enterprise" } } }).where(eq(OrganizationTable.id, f.org))
  assert.ok(await loadProviderAudit(f.db, true, f.context(), "update"))
  await f.db.update(AuditPolicyTable).set({ categories: ["lifecycle"], revision: 2 }).where(eq(AuditPolicyTable.organization_id, f.org))
  assert.equal(await loadProviderAudit(f.db, true, f.context(), "update"), null)
})

dbTest("entitlement storage read errors propagate rather than masquerading as unentitled capture-off", async () => {
  const f = await fixture()
  const { readAuditUsage } = await import("../src/audit/queries.js")
  onQuery = (query) => { if (/select.*from `organization`/i.test(query)) throw new Error("synthetic-entitlement-unavailable") }
  try {
    await assert.rejects(loadProviderAudit(f.db, true, f.context(), "update"), /synthetic-entitlement-unavailable/)
    await assert.rejects(readAuditUsage({ database: f.db, organizationId: f.org }, true), /synthetic-entitlement-unavailable/)
  } finally { onQuery = undefined }
  assert.equal((await f.events()).length, 0)
})

dbTest("a committed plan downgrade rejects stale capture before snapshot reads or business mutation", async () => {
  const f = await fixture()
  const capture = await loadProviderAudit(f.db, true, f.context(), "update")
  assert.ok(capture)
  const holding = barrier()
  const resume = barrier()
  const downgrade = f.db.transaction(async (tx) => {
    await tx.update(OrganizationTable).set({ metadata: { plan: { tier: "free" } } }).where(eq(OrganizationTable.id, f.org))
    holding.resolve()
    await resume.promise
  })
  await holding.promise
  queries.length = 0
  let mutated = false
  const pending = f.db.transaction((tx) => providerAuditMutation(tx, capture, async () => { mutated = true }))
  const rejected = assert.rejects(pending, /audit_policy_changed/)
  resume.resolve()
  await downgrade
  await rejected
  assert.equal(mutated, false)
  assert.equal(queries.some((query) => /gateway_|audit_state|audit_policy/.test(query)), false)
  assert.equal(await loadProviderAudit(f.db, true, f.context(), "update"), null)
})

dbTest("OFF racing an in-flight captured mutation rolls back mutation; subsequent request sees OFF", async () => {
  const f = await fixture()
  const capture = await loadProviderAudit(f.db, true, f.context(), "update")
  assert.ok(capture)
  const holding = barrier()
  const resume = barrier()
  const pending = f.db.transaction((tx) => providerAuditMutation(tx, capture, async () => {
    await tx.update(GatewayProviderTable).set({ name: "Must roll back" }).where(eq(GatewayProviderTable.id, f.providerId))
    holding.resolve()
    await resume.promise
  }))
  const rejected = assert.rejects(pending, /audit_policy_changed/)
  await holding.promise
  try {
    await within(f.db.transaction(async (tx) => {
      await readAuditEntitlement(tx, f.org, true)
      const context: AuditContext = { organizationId: f.org, actor: { type: "user", id: f.user, memberId: f.member }, principalKey: `user:${f.user}`, origin: "api", originTrust: "authenticated", requestId: createDenTypeId("request"), kind: "audit.policy", scope: f.org }
      await setAuditCaptureState(tx, { context, captureOn: false, expectedRevision: 1 })
    }), "OFF must not acquire provider locks")
  } finally { resume.resolve() }
  await rejected
  assert.equal((await f.current()).name, "Before")
  assert.deepEqual((await f.events()).map((event) => event.action), ["audit.capture.disabled"])
  assert.equal(await loadProviderAudit(f.db, true, f.context(), "update"), null)
  await f.mutate("update", (tx) => tx.update(GatewayProviderTable).set({ name: "After OFF" }).where(eq(GatewayProviderTable.id, f.providerId)))
  assert.equal((await f.current()).name, "After OFF")
  assert.equal((await f.events()).length, 1)
})

dbTest("entitlement fence precedes snapshots and holds plan downgrade until captured transaction commits", async () => {
  const f = await fixture()
  const capture = await loadProviderAudit(f.db, true, f.context(), "update")
  assert.ok(capture)
  const holding = barrier()
  const resume = barrier()
  queries.length = 0
  const pending = f.db.transaction((tx) => providerAuditMutation(tx, capture, async () => {
    await tx.update(GatewayProviderTable).set({ name: "Committed before downgrade" }).where(eq(GatewayProviderTable.id, f.providerId))
    holding.resolve()
    await resume.promise
  }))
  await holding.promise
  const fence = queries.findIndex((query) => /organization.*for share/i.test(query))
  const snapshot = queries.findIndex((query) => /select.*gateway_providers/i.test(query))
  assert.ok(fence >= 0 && snapshot > fence)
  let downgraded = false
  const downgrade = f.db.update(OrganizationTable).set({ metadata: { plan: { tier: "free" } } }).where(eq(OrganizationTable.id, f.org)).then(() => { downgraded = true })
  try { await new Promise((resolve) => setTimeout(resolve, 100)); assert.equal(downgraded, false) } finally { resume.resolve() }
  await pending
  await downgrade
  assert.equal((await f.current()).name, "Committed before downgrade")
  assert.ok((await f.events()).length > 0)
  assert.equal(await loadProviderAudit(f.db, true, f.context(), "update"), null)
})

dbTest("system refresh mutations use independent operation and deletions retain resource evidence", async () => {
  const f = await fixture()
  await f.mutate("update", (tx) => tx.update(GatewayProviderTable).set({ name: "User edit" }).where(eq(GatewayProviderTable.id, f.providerId)))
  await f.mutate("catalog.refresh", (tx, provider) => matrix.writeGatewayModels(tx, provider, [{ id: "model-a", name: "Catalog A", config: { id: "model-a" } }]), providerSystemAuditContext(f.org, f.providerId))
  const groupId = await f.mutate("group.create", (tx, provider) => matrix.writeGatewayGroup(tx, provider, { name: "Models", modelIds: ["model-a"] }))
  await f.mutate("delete", async (tx) => {
    await tx.delete(GatewayModelGroupModelTable).where(eq(GatewayModelGroupModelTable.model_group_id, groupId))
    await tx.delete(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.id, groupId))
    await tx.delete(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, f.providerId))
    await tx.delete(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.id, f.credentialId))
    await tx.delete(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, f.setId))
    await tx.delete(GatewayProviderTable).where(eq(GatewayProviderTable.id, f.providerId))
  })
  const events = await f.events()
  const system = events.find((event) => event.action === "provider.model.created")
  assert.equal(system?.actor.type, "system")
  assert.notEqual(system?.operationId, events[0].operationId)
  for (const action of ["provider.deleted", "provider.universe.deleted", "provider.model.deleted", "provider.group.deleted", "provider.credential_set.deleted", "provider.credential.deleted"]) assert.ok(events.some((event) => event.action === action && event.changes?.before && event.changes.after === null), action)
  assert.equal(events.some((event) => event.action.includes("google")), false)
})
