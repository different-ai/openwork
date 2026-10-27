import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { normalizeDesktopConfig } from "@openwork/types/den/desktop-policies"
import { providerInventoryReadiness, providerInventoryRevision } from "../src/llm/provider-inventory-revision.js"
import { providerInventoryEvents, type InventoryWatchClock } from "../src/llm/provider-inventory-watch.js"

async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve() }
class Clock implements InventoryWatchClock {
  time = 1_000
  timers = new Set<{ at: number; callback: () => void }>()
  now = () => this.time
  schedule = (callback: () => void, ms: number) => {
    const timer = { at: this.time + ms, callback }
    this.timers.add(timer)
    return () => { this.timers.delete(timer) }
  }
  async advance(ms: number) {
    const end = this.time + ms
    for (;;) {
      const next = [...this.timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      this.time = next.at
      this.timers.delete(next)
      next.callback()
      await flush()
    }
    this.time = end
    await flush()
  }
}
function snapshot() {
  return {
    organizationId: "org-example", memberId: "member-example", gatewayBaseUrl: "https://gateway.example.test",
    rows: {
      providers: [{ id: "provider", name: "Example", status: "active", model_ids: [], provider_config: { npm: "@ai-sdk/openai", options: { a: 1, b: 2 } } }],
      models: [{ id: "model", name: "Example model", model_config: { limit: { context: 100_000 }, cost: { input: 1 } } }],
      groups: [{ id: "group", status: "active", name: "Models" }],
      links: [{ id: "link", model_group_id: "group", gateway_provider_model_id: "model" }],
      sets: [{ id: "set", status: "active", name: "Credentials", credential_mode: "org", oauth_client_secret: "private-client" }],
      grants: [{ id: "grant", model_group_id: "group", credential_set_id: "set", team_id: "team" }],
      credentials: [{ id: "credential", status: "active", secret: "private-upstream", last_error: null }],
      teams: [{ id: "team" }], keys: [{ id: "key", encrypted_key: "private-gateway", key_hash: "digest", status: "active" }],
      readiness: [{ id: "credential", expired: false, clientExpired: false }],
    },
  }
}
const revision = (input = snapshot()) => providerInventoryRevision(input, "test-only-mac-secret")

test("inventory revision is deterministic, member/org scoped, and opaque", () => {
  const input = snapshot()
  const baseline = revision(input)
  assert.match(baseline, /^[a-f0-9]{64}$/)
  assert.equal(revision(structuredClone(input)), baseline)
  input.rows.providers[0].provider_config.options = { b: 2, a: 1 }
  assert.equal(revision(input), baseline)
  input.memberId = "another-member"
  assert.notEqual(revision(input), baseline)
  input.memberId = "member-example"
  input.organizationId = "another-org"
  assert.notEqual(revision(input), baseline)
  assert.notEqual(providerInventoryRevision(snapshot(), "different-secret"), baseline)
  assert.ok(!baseline.includes("private"))
})

test("row order is irrelevant but model config array order remains meaningful", () => {
  const base = { organizationId: "org", memberId: "member", gatewayBaseUrl: "url", rows: { models: [{ id: "a", config: { options: [1, 2] } }, { id: "b" }] } }
  const hash = providerInventoryRevision(base, "secret")
  base.rows.models.reverse()
  assert.equal(providerInventoryRevision(base, "secret"), hash)
  base.rows.models[1].config?.options.reverse()
  assert.notEqual(providerInventoryRevision(base, "secret"), hash)
})

test("every dependency table's insert/delete/config-only change invalidates without provider touches", () => {
  const baseline = revision()
  for (const [name, rows] of Object.entries(snapshot().rows)) {
    const original = snapshot()
    const removed = { ...original, rows: { ...original.rows, [name]: [] } }
    assert.notEqual(providerInventoryRevision(removed, "test-only-mac-secret"), baseline, `${name} deletion`)
    const changed = { ...original, rows: { ...original.rows, [name]: rows.map((row) => ({ ...row, name: "changed-without-a-timestamp" })) } }
    assert.notEqual(providerInventoryRevision(changed, "test-only-mac-secret"), baseline, `${name} config change`)
    const added = { ...original, rows: { ...original.rows, [name]: [...rows, { id: "new-row" }] } }
    assert.notEqual(providerInventoryRevision(added, "test-only-mac-secret"), baseline, `${name} insertion`)
  }
})

test("team membership, model metadata, gateway key rotation/revocation and credential readiness change revisions", () => {
  const baseline = revision()
  const team = snapshot(); team.rows.teams[0].id = "other-team"
  assert.notEqual(revision(team), baseline)
  const config = snapshot(); config.rows.models[0].model_config.limit.context = 200_000
  assert.notEqual(revision(config), baseline)
  const key = snapshot(); key.rows.keys[0].encrypted_key = "rotated-key"
  assert.notEqual(revision(key), baseline)
  key.rows.keys[0].status = "revoked"
  assert.notEqual(revision(key), baseline)
  const credentials = snapshot(); credentials.rows.credentials[0].status = "revoked"
  assert.notEqual(revision(credentials), baseline)
  const readiness = snapshot(); readiness.rows.readiness[0].expired = true
  assert.notEqual(revision(readiness), baseline)
})

test("credential expiry changes the revision without a DB mutation or a clock-valued revision", () => {
  const id = createDenTypeId("inferenceProviderCredential")
  const credentials: Parameters<typeof providerInventoryReadiness>[0] = [{ id, kind: "api_key", secret: "example-test-key", expires_at: new Date(10_000) }]
  const before = providerInventoryReadiness(credentials, 9_000)
  assert.deepEqual(providerInventoryReadiness(credentials, 9_999), before)
  assert.notDeepEqual(providerInventoryReadiness(credentials, 10_000), before)
  const aws: Parameters<typeof providerInventoryReadiness>[0] = [{ id, kind: "aws_sso", expires_at: new Date(100_000), secret: JSON.stringify({
    accessToken: "test-token", refreshToken: "test-refresh", clientId: "test-client", clientSecret: "test-secret", clientSecretExpiresAt: 10,
    sso: { startUrl: "https://example.awsapps.com/start", region: "us-east-1", accountId: "123456789012", roleName: "Example" },
    identity: { arn: "arn:aws:sts::123456789012:assumed-role/Example/test", userName: null, authorizationRevision: "r".repeat(43) },
  }) }]
  assert.equal(providerInventoryReadiness(aws, 9_999)[0].clientExpired, false)
  assert.equal(providerInventoryReadiness(aws, 10_000)[0].clientExpired, true)
})

function watchFixture() {
  const clock = new Clock()
  const controller = new AbortController()
  let current = "revision-one"
  let reads = 0
  let fail = false
  let hang = false
  let released = 0
  const input = {
    request: new Request("https://den.example.test/v1/inference-providers/inventory/events", { signal: controller.signal }),
    expiresAt: 61_000, clock,
    read: async () => {
      reads++
      if (fail) throw new Error("session/member/feature revoked or database unavailable")
      if (hang) return new Promise<string>(() => {})
      return current
    },
    onClose: () => { released++ },
  }
  return { clock, controller, input, setRevision(value: string) { current = value }, fail() { fail = true }, hang() { hang = true }, reads: () => reads, released: () => released }
}
const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value)

test("SSE sends exact initial/change frames, checks every two seconds, and does not repeat unchanged revisions", async () => {
  const f = watchFixture()
  const response = await providerInventoryEvents(f.input)
  assert.equal(response.headers.get("content-type"), "text/event-stream")
  assert.equal(response.headers.get("cache-control"), "no-store")
  const reader = response.body!.getReader()
  assert.equal(decode((await reader.read()).value), 'event: inventory.changed\ndata: {"revision":"revision-one"}\n\n')
  let delivered = false
  const next = reader.read().then((value) => { delivered = true; return value })
  await f.clock.advance(2_000)
  assert.equal(f.reads(), 2)
  assert.equal(delivered, false)
  f.setRevision("revision-two")
  await f.clock.advance(2_000)
  assert.equal(decode((await next).value), 'event: inventory.changed\ndata: {"revision":"revision-two"}\n\n')
  await reader.cancel()
  assert.equal(f.released(), 1)
  assert.equal(f.clock.timers.size, 0)
})

test("unchanged streams send heartbeat comments without revision events", async () => {
  const f = watchFixture()
  const reader = (await providerInventoryEvents(f.input)).body!.getReader()
  await reader.read()
  const heartbeat = reader.read()
  await f.clock.advance(16_000)
  assert.equal(decode((await heartbeat).value), ": heartbeat\n\n")
  assert.equal(f.reads(), 9)
  await reader.cancel()
})

test("existing streams fail closed when the authorized inventory reader rejects a check", async () => {
  const f = watchFixture()
  const reader = (await providerInventoryEvents(f.input)).body!.getReader()
  await reader.read()
  f.fail()
  const next = reader.read()
  await f.clock.advance(2_000)
  assert.equal((await next).done, true)
  assert.equal(f.released(), 1)
  assert.equal(f.clock.timers.size, 0)
})

test("hung DB checks time out and close instead of retaining a stream indefinitely", async () => {
  const f = watchFixture()
  const reader = (await providerInventoryEvents(f.input)).body!.getReader()
  await reader.read()
  f.hang()
  const next = reader.read()
  await f.clock.advance(7_000)
  assert.equal((await next).done, true)
  assert.equal(f.released(), 1)
  assert.equal(f.clock.timers.size, 0)
})

test("initial hung checks time out before returning a response", async () => {
  const f = watchFixture()
  f.hang()
  const response = providerInventoryEvents(f.input)
  const rejected = assert.rejects(response, /timed out/)
  await f.clock.advance(5_000)
  await rejected
  assert.equal(f.released(), 1)
  assert.equal(f.clock.timers.size, 0)
})

test("cancelling a hung check tears down timers without waiting for the DB", async () => {
  const f = watchFixture()
  const reader = (await providerInventoryEvents(f.input)).body!.getReader()
  await reader.read()
  f.hang()
  await f.clock.advance(2_000)
  await reader.cancel()
  assert.equal(f.released(), 1)
  assert.equal(f.clock.timers.size, 0)
  await f.clock.advance(10_000)
  assert.equal(f.reads(), 2)
})

test("request abort and body cancellation stop polling and release once", async () => {
  for (const abort of [true, false]) {
    const f = watchFixture()
    const reader = (await providerInventoryEvents(f.input)).body!.getReader()
    await reader.read()
    if (abort) f.controller.abort()
    else await reader.cancel()
    await f.clock.advance(20_000)
    assert.equal(f.reads(), 1)
    assert.equal(f.released(), 1)
    assert.equal(f.clock.timers.size, 0)
  }
})

test("session expires even when a poll is hung", async () => {
  const f = watchFixture()
  const reader = (await providerInventoryEvents({ ...f.input, expiresAt: 4_000 })).body!.getReader()
  await reader.read()
  f.hang()
  const next = reader.read()
  await f.clock.advance(3_000)
  assert.equal((await next).done, true)
  assert.equal(f.clock.timers.size, 0)
})

test("initial failed checks, expired sessions and already-aborted requests never establish streams", async () => {
  const failed = watchFixture(); failed.fail()
  await assert.rejects(providerInventoryEvents(failed.input))
  assert.equal(failed.released(), 1)
  const expired = watchFixture()
  await assert.rejects(providerInventoryEvents({ ...expired.input, expiresAt: expired.clock.now() }))
  const aborted = watchFixture(); aborted.controller.abort()
  await assert.rejects(providerInventoryEvents(aborted.input))
  assert.equal(aborted.clock.timers.size, 0)
})

test("slow consumers have a bounded queue and polling is stopped", async () => {
  const f = watchFixture()
  const response = await providerInventoryEvents(f.input)
  f.setRevision("revision-two")
  await f.clock.advance(2_000)
  assert.equal(f.released(), 1)
  assert.equal(f.clock.timers.size, 0)
  const reader = response.body!.getReader()
  assert.equal((await reader.read()).done, false)
  assert.equal((await reader.read()).done, true)
})

test("desktop config preserves the effective liveProviderSync boolean and missing stays off-compatible", () => {
  assert.equal(normalizeDesktopConfig({ liveProviderSync: true }).liveProviderSync, true)
  assert.equal(normalizeDesktopConfig({ liveProviderSync: false }).liveProviderSync, false)
  assert.equal(normalizeDesktopConfig({}).liveProviderSync, undefined)
  assert.equal(normalizeDesktopConfig({ liveProviderSync: "true" }).liveProviderSync, undefined)
})
