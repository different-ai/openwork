import assert from "node:assert/strict"
import { test } from "node:test"
import type { ProviderCheck } from "@openwork/types/den/diagnostics"

process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-diagnostics-runtime-test-key-0000"
process.env.BETTER_AUTH_SECRET ??= "synthetic-diagnostics-runtime-test-secret-00"
process.env.DEN_BASE_URL ??= "https://console.example.test"
const { createDiagnosticsRuntime, DIAGNOSTICS_CACHE_TTL_MS } = await import("../src/diagnostics/runtime.js")
type Deps = Parameters<typeof createDiagnosticsRuntime>[0]
type Targets = Awaited<ReturnType<Deps["loadConnectors"]>>

function row(input: Partial<ProviderCheck>): ProviderCheck {
  return {
    id: "ipr_a:gcs_a", source: "gateway", providerId: "openai", name: "OpenAI", credentialName: null, state: "not_checked", reason: "not_checked_yet",
    httpStatus: null, durationMs: null, checkedAt: null, lastSuccessAt: null, models: { configured: 2, served: null, missing: [] }, members: null, ...input,
  }
}

function harness(options: { targets?: Targets } = {}) {
  let now = Date.parse("2026-10-20T12:00:00.000Z")
  let version = "v1"
  const admitted: string[] = []
  const blocked = new Map<string, number>()
  const live: boolean[] = []
  const slackChecks: string[] = []
  const googleChecks: string[] = []
  const runtime = createDiagnosticsRuntime({
    now: () => now,
    async admit(key) {
      const until = blocked.get(key)
      if (until !== undefined && until > now) return Math.ceil((until - now) / 1000)
      blocked.set(key, now + 30_000)
      admitted.push(key)
      return null
    },
    async evaluateProviders(_organizationId, isLive, previousSuccess) {
      live.push(isLive)
      const checkedAt = new Date(now).toISOString()
      return [
        { probed: true, version, check: isLive
          ? row({ state: "ready", reason: "models_listed", httpStatus: 200, checkedAt, lastSuccessAt: checkedAt, models: { configured: 2, served: 5, missing: [] } })
          : row({ lastSuccessAt: previousSuccess.get("ipr_a:gcs_a") ?? null }) },
        { probed: false, version: "m", check: row({ id: "ipr_b:gcs_b", source: "legacy", state: "member_credentials", reason: "member_sign_in", members: { connected: 1, needsAttention: 0 } }) },
      ]
    },
    async loadConnectors() {
      return options.targets ?? { slack: [], google: [] }
    },
    async checkSlack(connectionId) {
      slackChecks.push(connectionId)
      return { result: "accepted", version: "token-1" }
    },
    async checkGoogle(_organizationId, memberId, target) {
      googleChecks.push(`${memberId}:${target.id}`)
      return memberId === "om_signed_in" ? [{ id: "gmail", name: "Gmail API", service: "gmail.googleapis.com", features: [], status: "enabled", enableUrl: null, detail: null }] : null
    },
  })
  return {
    runtime, admitted, live, slackChecks, googleChecks,
    advance(ms: number) { now += ms },
    setVersion(next: string) { version = next },
  }
}

const everything = () => true

test("a read returns stored facts at once, starts one background check, then serves the cached live result", async () => {
  const h = harness()
  const first = await h.runtime.providers("org_1", { include: everything, refresh: true })
  assert.equal(first.items[0].state, "not_checked")
  assert.equal(first.checking, true, "the read does not wait for the live check")
  assert.equal(first.checkedAt, null)
  await h.runtime.settle()
  const second = await h.runtime.providers("org_1", { include: everything, refresh: true })
  assert.deepEqual([second.items[0].state, second.items[0].models], ["ready", { configured: 2, served: 5, missing: [] }])
  assert.equal(second.checking, false)
  assert.ok(second.checkedAt)
  assert.equal(second.items[1].state, "member_credentials", "rows without a live check always come from stored facts")
  assert.deepEqual(h.admitted, ["diagnostics:providers:org_1"])
  assert.deepEqual(h.live.filter(Boolean).length, 1)

  const legacyOnly = await h.runtime.providers("org_1", { include: (check) => check.source === "legacy", refresh: false })
  assert.deepEqual(legacyOnly.items.map((item) => item.id), ["ipr_b:gcs_b"], "rows are filtered per caller")
})

test("a changed credential or an expired result is not reused, and refreshes are rate limited", async () => {
  const h = harness()
  await h.runtime.providers("org_1", { include: everything, refresh: true })
  await h.runtime.settle()
  h.setVersion("v2")
  const changed = await h.runtime.providers("org_1", { include: everything, refresh: true })
  assert.equal(changed.items[0].state, "not_checked", "a cached result for another credential version is dropped")
  assert.equal(changed.items[0].lastSuccessAt !== null, true, "last success survives")
  assert.equal(changed.checking, false, "the second refresh inside 30 s was not admitted")
  assert.equal(typeof await h.runtime.checkProviders("org_1"), "number", "POST check reports Retry-After")
  h.advance(31_000)
  assert.equal(await h.runtime.checkProviders("org_1"), "started")
  assert.equal(await h.runtime.checkProviders("org_1"), "running", "a running check is shared, not rate limited")
  await h.runtime.settle()
  assert.equal((await h.runtime.providers("org_1", { include: everything, refresh: false })).items[0].state, "ready")
  h.advance(DIAGNOSTICS_CACHE_TTL_MS + 1)
  const expired = await h.runtime.providers("org_1", { include: everything, refresh: false })
  assert.equal(expired.items[0].state, "not_checked")
  assert.equal(expired.checkedAt, null)
})

test("connectors: Slack results are shared per organization, Google results are per member", async () => {
  const h = harness({ targets: {
    slack: [{
      id: "slack:emc_1", name: "Slack", connectionId: "emc_1", version: "token-1", needsLiveCheck: true,
      runnerAvailable: true, enabled: true, hasBotToken: true, lastEventAt: null, completed24h: 2,
    }],
    google: [{ id: "google:emc_2", name: "Google Workspace", credentialProviderId: "emc_2", features: ["gmailRead"], apis: [{ id: "gmail", name: "Gmail API" }] }],
  } })
  const first = await h.runtime.connectors("org_1", "om_signed_in", { refresh: true })
  assert.deepEqual(first.items.map((item) => item.reason), ["not_checked_yet", "not_checked_yet"])
  assert.equal(first.checking, true)
  await h.runtime.settle()
  const mine = await h.runtime.connectors("org_1", "om_signed_in", { refresh: true })
  assert.deepEqual(mine.items.map((item) => [item.state, item.reason]), [["ready", "slack_token_accepted"], ["ready", "google_apis_enabled"]])
  const theirs = await h.runtime.connectors("org_1", "om_other", { refresh: true })
  assert.equal(theirs.items[0].state, "ready", "Slack is an organization check")
  assert.equal(theirs.items[1].reason, "not_checked_yet", "another member's Google check is never shown")
  await h.runtime.settle()
  assert.equal((await h.runtime.connectors("org_1", "om_other", { refresh: false })).items[1].reason, "google_sign_in_required")
  assert.deepEqual(h.googleChecks, ["om_signed_in:google:emc_2", "om_other:google:emc_2"])
  assert.equal(await h.runtime.checkConnectors("org_1", "om_other") !== "started", true, "rate limited per member")
})
