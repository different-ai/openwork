import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { INFERENCE_FREE_MODEL_ID, INFERENCE_USAGE_CONVERSION_FACTOR, freeInferenceWindow, managedModelCatalog, readFreeInferenceConfig } from "@openwork/types/den/inference"
import { DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH, MEMBER_FREE_CHAT_PATH, MEMBER_FREE_MODELS_PATH,
  MEMBER_FREE_STATUS_PATH, desktopFreeProofMessage, desktopFreeReleaseTagMessage, desktopFreeSessionPowMessage, leadingZeroBits, type DesktopFreeProofClaims } from "@openwork/free-auto"
import { readAutoConfig, FREE_OPENAI_CHAT_URL } from "../src/free/shared/config.js"
import { freeRequestReservation, freeUsageAmount, rampedDeviceAmount } from "@openwork/free-auto/accounting"
import { verifyDesktopFreeProof } from "../src/free/guest/proof.js"
import { createDesktopFreeReleaseSource } from "../src/free/guest/releases-source.js"
import { desktopFreeVersionError, releaseTagRequired, supportedDesktopReleases, type DesktopRelease } from "@openwork/free-auto"
import { deriveReleaseSecret, releaseTag, sha256Hex as desktopFreeHash } from "@openwork/free-auto/node"
import { createAnonymousIdentities, issueAnonymousToken, verifyAnonymousToken, canonicalizeAnonymousAddress } from "../src/free/guest/identity.js"
import { prepareFreeRequest, readFreeRequest } from "../src/free/shared/request.js"
import { FreeResponseReceipt, meterFreeResponse } from "../src/free/shared/meter.js"
import type { FreePrincipal, MemberPrincipal } from "../src/free/shared/principal.js"
import type { FreeAllowanceStore, FreeUsageReceipt } from "../src/free/shared/allowance.js"

process.env.OPENWORK_DEV_MODE = "1"
process.env.DEN_DB_ENCRYPTION_KEY = "test-only-free-auto-encryption-key-000000000000"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/free_auto_test_unused"
const { registerAnonymousInferenceRoutes } = await import("../src/free/guest/routes.js")
const { createFreeMemberHandler } = await import("../src/free/member/handler.js")
const { registerProxyRoutes } = await import("../src/proxy.js")
const { freeSettlementDecision } = await import("../src/free/shared/allowance.js")

const releaseKey = "test-only-release-master-key-2222222222222222222"
const previousReleaseKey = "test-only-previous-master-key-33333333333333333"
const config = readAutoConfig({ INFERENCE_FREE_ENABLED: "true", ANONYMOUS_INFERENCE_ENABLED: "true",
  INFERENCE_FREE_OPENAI_API_KEY: "sk-fixture-dedicated-free-key", ANONYMOUS_TOKEN_SECRET: "test-only-token-secret-00000000000000000000",
  ANONYMOUS_ACCOUNTING_IDENTITY_KEY: "test-only-accounting-key-1111111111111111111", DESKTOP_FREE_RELEASE_KEY: releaseKey, ANONYMOUS_SESSION_POW_BITS: "8", ANONYMOUS_SESSION_POW_ROUNDS: "2" })
const day = 86400000
const now = Date.parse("2026-09-23T12:00:00Z")
/** Newest first: 1.2.3 (today), 1.2.2 (2 days), 1.2.1 (5 days), 1.2.0 (10 days, within 14-day floor), 1.1.9 (30 days, out). */
const releases: DesktopRelease[] = [["1.2.3", 0], ["1.2.2", 2], ["1.2.1", 5], ["1.2.0", 10], ["1.1.9", 30]].map(([version, age]) => ({ version: String(version), publishedAt: now - Number(age) * day }))
const machineId = "c".repeat(64)
function signer(machine = machineId) {
  const keys = generateKeyPairSync("ed25519")
  const der = keys.publicKey.export({ format: "der", type: "spki" })
  const binding = { keyThumbprint: desktopFreeHash(Uint8Array.from(der)), machineId: machine, appVersion: "1.2.3", platform: "darwin", arch: "arm64" } satisfies import("../src/free/guest/proof.js").DesktopFreeBinding
  return { keys, publicKey: der.toString("base64"), binding }
}
const device = signer()
const guest = (source = device) => issueAnonymousToken(createAnonymousIdentities(source.binding, "127.0.0.1", config), source.binding, config).token
const memberKey = "ow_inf_fixture-member-key"
const keyRow = { id: createDenTypeId("inferenceKey"), organization_id: createDenTypeId("organization"), org_membership_id: createDenTypeId("member") }
const member: MemberPrincipal = { kind: "member", id: createDenTypeId("user"), inferenceKeyId: keyRow.id, memberId: keyRow.org_membership_id, organizationId: keyRow.organization_id }
const prompt = JSON.stringify({ model: INFERENCE_FREE_MODEL_ID, messages: [{ role: "user", content: "hello" }] })
type SignedOptions = { version?: string; source?: typeof device; proofVersion?: 2 | 3; secret?: Uint8Array | null; tagVersion?: string; nonce?: string }
function solvePow(machineId: string, nonce: string, bits: number, rounds = 2) {
  return Array.from({ length: rounds }, (_, round) => {
    for (let counter = 0; ; counter++) {
      const pow = counter.toString(36)
      if (leadingZeroBits(Uint8Array.from(createHash("sha256").update(desktopFreeSessionPowMessage({ machineId, nonce, round, pow })).digest())) >= bits) return pow
    }
  }).join(".")
}
/** A session mint request whose body carries the proof-of-work for its own nonce. */
function session(options: SignedOptions & { bits?: number; pow?: string } = {}) {
  const source = options.source ?? device
  const nonce = options.nonce ?? randomUUID()
  const pow = options.pow ?? solvePow(source.binding.machineId, nonce, options.bits ?? 8)
  return signed(DESKTOP_FREE_SESSION_PATH, "", JSON.stringify({ pow }), { ...options, nonce })
}
function signed(path: string, authorization = "", body?: string, options: SignedOptions = {}) {
  const source = options.source ?? device
  const method = body === undefined ? "GET" : "POST"
  const appVersion = options.version ?? "1.2.3"
  const base = { publicKey: source.publicKey, machineId: source.binding.machineId, appVersion,
    platform: "darwin" as const, arch: "arm64" as const, timestamp: now, nonce: options.nonce ?? randomUUID() }
  const request = { method, path, bodyHash: desktopFreeHash(body ?? ""), authorizationHash: desktopFreeHash(authorization) }
  // Default: a v3 proof tagged by the secret the build of `appVersion` would carry.
  const secret = options.secret === undefined ? deriveReleaseSecret(releaseKey, options.tagVersion ?? appVersion) : options.secret
  const claims: DesktopFreeProofClaims = options.proofVersion === 2 || secret === null ? { version: 2, ...base }
    : { version: 3, ...base, releaseTag: releaseTag(secret, { ...base, ...request }) }
  const message = desktopFreeProofMessage({ ...claims, ...request })
  const proof = Buffer.from(JSON.stringify({ ...claims, signature: sign(null, Uint8Array.from(Buffer.from(message)), source.keys.privateKey).toString("base64url") })).toString("base64url")
  return new Request(`https://free.test${path}`, { method, body, headers: { "x-openwork-desktop-proof": proof,
    ...(authorization ? { authorization } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } })
}
function openAiResponse(id = "chatcmpl-1") {
  return { id, object: "chat.completion", model: `${config.upstreamModel}-2026-08-01`, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, completion_tokens_details: { reasoning_tokens: 0 } } }
}
const expectedAmount = freeUsageAmount(config, 10, 2)
type Upstream = { url: string; headers: Headers; body: Record<string, unknown> }
function fakeStore(principals: FreePrincipal[], receipts: Array<FreeUsageReceipt | null>, calls: { session: number; cancelled: number; released: number }): FreeAllowanceStore {
  const nonces = new Set<string>()
  return {
    family: "anonymous",
    async consumeNonce(proof) { const key = `${proof.keyThumbprint}:${proof.nonce}`; if (nonces.has(key)) return "replay"; nonces.add(key); return "accepted" },
    async consumeSession() { calls.session++; return "accepted" as const },
    async read(principal) { return { state: "ready", code: null, allowance: { limitUsd: principal.kind === "member" ? 5 : 1,
      usedUsd: 0, reservedUsd: 0, remainingUsd: principal.kind === "member" ? 5 : 1, resetsAt: freeInferenceWindow().end.toISOString() } } },
    async reserve(principal, _ip, requestId, deadlineAt) { principals.push(principal); return { ok: true, requestId, deadlineAt } },
    async dispatch() { return true },
    async cancelUndispatched() { calls.cancelled++; return true },
    async release() { calls.released++; return true },
    async settle(_id, receipt) { receipts.push(receipt); return true },
  }
}
function fixture(overrides: Partial<import("../src/free/guest/routes.js").FreeRouteDependencies> = {}, upstream: (request: Upstream) => Response = () => Response.json(openAiResponse()),
  memberOverrides: Partial<import("../src/free/member/handler.js").FreeMemberDependencies> = {}) {
  const principals: FreePrincipal[] = []
  const receipts: Array<FreeUsageReceipt | null> = []
  const requests: Upstream[] = []
  const calls = { session: 0, cancelled: 0, released: 0 }
  const store = fakeStore(principals, receipts, calls)
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }
    assert.equal(init?.redirect, "error")
    requests.push(request)
    return upstream(request)
  }
  const app = new Hono()
  registerAnonymousInferenceRoutes(app, { config, store, releases: async () => releases, now: () => now, clientAddress: () => "127.0.0.1", fetch, ...overrides })
  const memberApp = new Hono()
  const handler = createFreeMemberHandler({ config, store: { ...store, family: "member" }, fetch, findMember: async (key) => key.id === keyRow.id ? member : null,
    defaultPinned: async () => true, ...memberOverrides })
  memberApp.all("/api/v1/*", (c) => handler(c, { ...keyRow, key_hash: "", key_prefix: null, name: null, encrypted_key: null, status: "active", revoked_at: null, created_at: new Date(), updated_at: new Date() }))
  return { app, memberApp, principals, receipts, requests, calls, store }
}

test("free Auto stays off without the dedicated OpenAI key or release key and never reads OpenRouter settings", () => {
  const defaults = readAutoConfig({})
  assert.equal(defaults.memberEnabled, false)
  assert.equal(defaults.anonymousEnabled, false)
  assert.equal(defaults.member.weeklyBudgetUsd, 5)
  assert.equal(defaults.deviceWeeklyAmount / INFERENCE_USAGE_CONVERSION_FACTOR, 1)
  assert.deepEqual([defaults.supportedReleaseCount, defaults.supportedReleaseMinDays, defaults.blockedReleases, defaults.firstReleaseTagVersion], [3, 14, [], null])
  const withoutKey = readAutoConfig({ INFERENCE_FREE_ENABLED: "true", ANONYMOUS_INFERENCE_ENABLED: "true", ANONYMOUS_TOKEN_SECRET: "t".repeat(40),
    ANONYMOUS_ACCOUNTING_IDENTITY_KEY: "a".repeat(40), ANONYMOUS_OPENROUTER_API_KEY: "legacy", INFERENCE_FREE_UPSTREAM_API_KEY: "legacy" })
  assert.equal(withoutKey.memberEnabled, false)
  assert.equal(withoutKey.anonymousEnabled, false)
  const withoutReleaseKey = readAutoConfig({ INFERENCE_FREE_ENABLED: "true", ANONYMOUS_INFERENCE_ENABLED: "true", INFERENCE_FREE_OPENAI_API_KEY: "sk-x",
    ANONYMOUS_TOKEN_SECRET: "t".repeat(40), ANONYMOUS_ACCOUNTING_IDENTITY_KEY: "a".repeat(40) })
  assert.equal(withoutReleaseKey.memberEnabled, true, "members do not depend on the desktop release key")
  assert.equal(withoutReleaseKey.anonymousEnabled, false, "guests do")
  assert.equal(config.memberEnabled, true)
  assert.equal(config.anonymousEnabled, true)
  // The dev secret is only read in developer mode, and every secret must differ.
  assert.equal(readAutoConfig({ DESKTOP_FREE_DEV_RELEASE_SECRET: "d".repeat(40) }).devReleaseSecret, "")
  assert.equal(readAutoConfig({ OPENWORK_DEV_MODE: "1", DESKTOP_FREE_DEV_RELEASE_SECRET: "d".repeat(40) }).devReleaseSecret, "d".repeat(40))
  assert.throws(() => readAutoConfig({ DESKTOP_FREE_RELEASE_KEY: "s".repeat(40), ANONYMOUS_TOKEN_SECRET: "s".repeat(40) }))
  assert.throws(() => readAutoConfig({ DESKTOP_FREE_FIRST_RELEASE_TAG_VERSION: "v1.2.3" }))
  assert.deepEqual(readAutoConfig({ DESKTOP_FREE_BLOCKED_RELEASES: " v1.2.2, 1.2.1 ,, " }).blockedReleases, ["1.2.2", "1.2.1"])
  assert.throws(() => readAutoConfig({ INFERENCE_FREE_ENABLED: "true", INFERENCE_FREE_WEEKLY_BUDGET_USD: "1" }))
  assert.throws(() => readAutoConfig({ INFERENCE_FREE_OPENAI_MODEL: "openai/gpt-5.6-luna" }))
  assert.throws(() => readFreeInferenceConfig({ INFERENCE_FREE_MODEL_ID: "paid-model" }))
  assert.deepEqual(managedModelCatalog().map((model) => model.modelID), [INFERENCE_FREE_MODEL_ID])
})

test("disabled endpoints do not verify metadata, write accounting, or dispatch", async () => {
  const off = readAutoConfig({})
  const f = fixture({ config: off, releases: async () => { throw new Error("must not call") } })
  const handler = createFreeMemberHandler({ config: off, store: f.store, fetch: async () => { throw new Error("must not call") }, findMember: async () => member, defaultPinned: async () => true })
  const memberApp = new Hono().all("/api/v1/*", (c) => handler(c, { ...keyRow } as never))
  assert.equal((await f.app.fetch(session())).status, 503)
  assert.equal((await memberApp.fetch(new Request(`https://free.test${MEMBER_FREE_CHAT_PATH}`, { method: "POST", body: prompt, headers: { "content-type": "application/json" } }))).status, 403)
  assert.equal(f.requests.length, 0)
  assert.equal(f.calls.session, 0)
  assert.equal(f.principals.length, 0)
})

test("proof binds raw body, actual bearer, route, key and machine", () => {
  const token = `Bearer ${guest()}`
  const request = signed(DESKTOP_FREE_CHAT_PATH, token, prompt)
  const input = { header: request.headers.get("x-openwork-desktop-proof"), method: "POST", path: DESKTOP_FREE_CHAT_PATH,
    bodyHash: desktopFreeHash(prompt), authorization: token, now }
  assert.equal(verifyDesktopFreeProof(input)?.machineId, machineId)
  assert.equal(verifyDesktopFreeProof({ ...input, bodyHash: desktopFreeHash(prompt + " ") }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, authorization: "Bearer another" }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, path: DESKTOP_FREE_STATUS_PATH }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, now: Date.now() + 61000 }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, binding: { ...device.binding, machineId: "d".repeat(64) } }), null)
  const unsigned = JSON.parse(Buffer.from(input.header ?? "", "base64url").toString("utf8"))
  for (const machine of ["C".repeat(64), "c".repeat(63), "machine"]) {
    const header = Buffer.from(JSON.stringify({ ...unsigned, machineId: machine })).toString("base64url")
    assert.equal(verifyDesktopFreeProof({ ...input, header }), null)
  }
})

test("the allowance follows the machine: a reinstall with a new key keeps the same identity", () => {
  const reinstall = signer()
  const other = signer("e".repeat(64))
  const first = createAnonymousIdentities(device.binding, "127.0.0.1", config)
  assert.equal(createAnonymousIdentities(reinstall.binding, "127.0.0.1", config).installationHash, first.installationHash)
  assert.notEqual(createAnonymousIdentities(other.binding, "127.0.0.1", config).installationHash, first.installationHash)
})

test("guest token is bound to key, machine and IP; mapped IPv6 cannot rotate IP identity", () => {
  const token = guest()
  assert.equal(verifyAnonymousToken(token, "127.0.0.1", config)?.machineId, machineId)
  assert.equal(verifyAnonymousToken(token, "127.0.0.2", config), null)
  assert.equal(verifyAnonymousToken(token.replace("v3", "v2"), "127.0.0.1", config), null)
  assert.equal(canonicalizeAnonymousAddress("::ffff:127.0.0.1"), "127.0.0.1")
  assert.equal(canonicalizeAnonymousAddress("::ffff:7f00:1"), "127.0.0.1")
})

test("session rejects authenticated downgrade, extra body fields and replay", async () => {
  const f = fixture()
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_SESSION_PATH, `Bearer ${memberKey}`, "{}"))).status, 401)
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_SESSION_PATH, "", JSON.stringify({ installationId: randomUUID() })))).status, 400)
  const request = session()
  const response = await f.app.fetch(request.clone())
  assert.equal(response.status, 200)
  assert.ok(verifyAnonymousToken((await response.json()).token, "127.0.0.1", config))
  assert.equal((await f.app.fetch(request)).status, 401)
  assert.equal(f.calls.session, 1)
})

test("minting a guest session costs a proof of work bound to the proof's own nonce", async () => {
  const f = fixture()
  const missing = await f.app.fetch(signed(DESKTOP_FREE_SESSION_PATH, "", "{}"))
  assert.equal(missing.status, 400)
  assert.deepEqual(await missing.json(), { error: { code: "session_pow_required", bits: 8, rounds: 2, message: "A proof of work is required to start a guest session." } })
  assert.equal((await f.app.fetch(session({ pow: "not-enough-zeros" }))).status, 400)
  // Every round must be solved, and a round's solution only counts for its own round.
  const halfNonce = randomUUID(), swappedNonce = randomUUID()
  const [one] = solvePow(machineId, halfNonce, 8).split(".")
  assert.equal((await f.app.fetch(session({ nonce: halfNonce, pow: one }))).status, 400)
  const [first, second] = solvePow(machineId, swappedNonce, 8).split(".")
  assert.equal((await f.app.fetch(session({ nonce: swappedNonce, pow: `${second}.${first}` }))).status, 400)
  // Work done for one nonce does not pay for another.
  const nonce = randomUUID()
  const pow = solvePow(machineId, nonce, 8)
  assert.equal((await f.app.fetch(session({ nonce: randomUUID(), pow }))).status, 400)
  assert.equal((await f.app.fetch(session({ nonce, pow }))).status, 200)
  assert.equal(f.calls.session, 1)
  const free = fixture({ config: { ...config, sessionPowBits: 0 } })
  assert.equal((await free.app.fetch(signed(DESKTOP_FREE_SESSION_PATH, "", "{}"))).status, 200)
  const base = fixture()
  const capped = fixture({ store: { ...base.store, consumeSession: async () => "new_identity_capped" as const } })
  const response = await capped.app.fetch(session())
  assert.equal(response.status, 429)
  assert.equal((await response.json()).error.code, "anonymous_new_identity_capped")
})

test("the guest allowance unlocks over the machine's first 30 active minutes and never exceeds the device budget", () => {
  const defaults = readAutoConfig({})
  assert.deepEqual(defaults.installRamp, [{ minutes: 0, amount: 10000000 }, { minutes: 10, amount: 20000000 }, { minutes: 20, amount: 50000000 }, { minutes: 30, amount: 100000000 }])
  assert.equal(defaults.ipNewIdentitiesPerDay, 5)
  assert.deepEqual([defaults.sessionPowBits, defaults.sessionPowRounds, defaults.activityMaxGapMs], [19, 8, 180000])
  const minute = 60000
  assert.equal(rampedDeviceAmount(defaults, 0) / INFERENCE_USAGE_CONVERSION_FACTOR, 0.1)
  assert.equal(rampedDeviceAmount(defaults, 10 * minute - 1) / INFERENCE_USAGE_CONVERSION_FACTOR, 0.1)
  assert.equal(rampedDeviceAmount(defaults, 10 * minute) / INFERENCE_USAGE_CONVERSION_FACTOR, 0.2)
  assert.equal(rampedDeviceAmount(defaults, 25 * minute) / INFERENCE_USAGE_CONVERSION_FACTOR, 0.5)
  assert.equal(rampedDeviceAmount(defaults, 30 * minute) / INFERENCE_USAGE_CONVERSION_FACTOR, 1)
  assert.equal(rampedDeviceAmount(defaults, 7 * 24 * 60 * minute) / INFERENCE_USAGE_CONVERSION_FACTOR, 1)
  const custom = readAutoConfig({ ANONYMOUS_INSTALL_RAMP: "0:50000,10:250000,120:5000000", ANONYMOUS_INSTALL_WEEKLY_MICRO_USD: "2000000" })
  assert.equal(rampedDeviceAmount(custom, 15 * minute) / INFERENCE_USAGE_CONVERSION_FACTOR, 0.25)
  assert.equal(rampedDeviceAmount(custom, 180 * minute) / INFERENCE_USAGE_CONVERSION_FACTOR, 2, "a ramp step above the device budget is clamped to it")
  for (const ramp of ["1:100000", "0:100000,0:200000", "0:200000,1:100000", "0:x", ""]) {
    if (ramp === "") continue
    assert.throws(() => readAutoConfig({ ANONYMOUS_INSTALL_RAMP: ramp }), ramp)
  }
})

test("a guest token cannot be used with another machine's proof", async () => {
  const f = fixture()
  const stranger = signer("f".repeat(64))
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt, { source: stranger }))).status, 401)
  assert.equal(f.requests.length, 0)
})

test("guest chat calls OpenAI directly with the dedicated key and no routing fields", async () => {
  const f = fixture()
  const response = await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))
  assert.equal(response.status, 200)
  const value = await response.json()
  assert.equal(value.model, INFERENCE_FREE_MODEL_ID)
  assert.deepEqual(Object.keys(value.usage).sort(), ["completion_tokens", "prompt_tokens", "total_tokens"])
  assert.equal(f.requests.length, 1)
  const [upstream] = f.requests
  assert.equal(upstream.url, FREE_OPENAI_CHAT_URL)
  assert.equal(upstream.headers.get("authorization"), "Bearer sk-fixture-dedicated-free-key")
  assert.equal(upstream.headers.get("x-openwork-desktop-proof"), null)
  assert.equal(upstream.body.model, config.upstreamModel)
  assert.equal(upstream.body.store, false)
  assert.equal(upstream.body.reasoning_effort, "none")
  for (const field of ["provider", "usage", "reasoning", "max_tokens"]) assert.equal(upstream.body[field], undefined, field)
  assert.deepEqual(f.principals.map((principal) => principal.kind), ["installation"])
  assert.deepEqual(f.receipts.map((receipt) => receipt?.amount), [expectedAmount])
  const status = await (await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`))).json()
  assert.equal(status.allowance.limitUsd, 1)
  assert.deepEqual(status.catalog.map((item: { modelID: string }) => item.modelID), [INFERENCE_FREE_MODEL_ID])
})

test("members use the regular OpenWork Models routes: Auto only, member allowance, same OpenAI key", async () => {
  const f = fixture()
  const call = (path: string, init: RequestInit = {}) => f.memberApp.fetch(new Request(`https://free.test${path}`, init))
  const chat = await call(MEMBER_FREE_CHAT_PATH, { method: "POST", body: prompt, headers: { "content-type": "application/json" } })
  assert.equal(chat.status, 200)
  assert.equal((await chat.json()).model, INFERENCE_FREE_MODEL_ID)
  assert.deepEqual(f.principals, [member])
  assert.equal(f.requests[0].url, FREE_OPENAI_CHAT_URL)
  assert.equal(f.requests[0].headers.get("authorization"), "Bearer sk-fixture-dedicated-free-key")
  assert.deepEqual((await (await call(MEMBER_FREE_MODELS_PATH)).json()).data.map((model: { id: string }) => model.id), [INFERENCE_FREE_MODEL_ID])
  assert.equal((await (await call(MEMBER_FREE_STATUS_PATH)).json()).allowance.limitUsd, 5)
  const paid = await call(MEMBER_FREE_CHAT_PATH, { method: "POST", body: prompt.replace(INFERENCE_FREE_MODEL_ID, "anthropic/claude-sonnet-4"), headers: { "content-type": "application/json" } })
  assert.equal(paid.status, 400)
  assert.equal((await call("/api/v1/responses", { method: "POST", body: prompt, headers: { "content-type": "application/json" } })).status, 404)
  assert.equal(f.requests.length, 1)
})

test("the proxy sends unsubscribed organizations to free Auto and keeps subscribed ones on paid Models", async () => {
  for (const [metadata, free] of [[{}, true], [{ inference: { enabled: false } }, true], [{ inference: { enabled: true, tier: "tier1" } }, false]] as const) {
    const served: string[] = []
    const app = new Hono()
    registerProxyRoutes(app, {
      async findActiveInferenceKey() { return { id: keyRow.id, organization_id: keyRow.organization_id, org_membership_id: keyRow.org_membership_id } as never },
      async assertOrganizationManagedModelsAllowed() {},
      async getOpenRouterProviderKey() { return null },
      async ensureUsableBuckets() { return { ok: true, admittedAt: new Date(), bucketIds: {}, bucketLimits: {} } as never },
      async fetch() { throw new Error("paid upstream must not be reached") },
      async loadOrganization(id) { return { id, metadata } },
      async insertRequestLog() {},
      async freeMember(c) { served.push("free"); return c.json({ ok: true }) },
    })
    const response = await app.fetch(new Request(`https://gateway.test${MEMBER_FREE_CHAT_PATH}`, { method: "POST", body: prompt,
      headers: { authorization: `Bearer ${memberKey}`, "content-type": "application/json" } }))
    assert.deepEqual(served, free ? ["free"] : [], JSON.stringify(metadata))
    if (!free) assert.notEqual(response.status, 200)
  }
})

test("a member key never reaches the guest routes and a guest token never reaches the member handler", async () => {
  const f = fixture()
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${memberKey}`, prompt))).status, 401)
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_MODELS_PATH, `Bearer ${memberKey}`))).status, 401)
  const handler = createFreeMemberHandler({ config, store: f.store, fetch: async () => { throw new Error("must not call") }, findMember: async () => null, defaultPinned: async () => true })
  const response = await new Hono().all("/api/v1/*", (c) => handler(c, { ...keyRow } as never)).fetch(new Request(`https://free.test${MEMBER_FREE_CHAT_PATH}`,
    { method: "POST", body: prompt, headers: { "content-type": "application/json", authorization: `Bearer ${guest()}` } }))
  assert.equal(response.status, 403)
  assert.equal(f.requests.length, 0)
  assert.equal(f.principals.length, 0)
})

function guestFor(version: string) {
  const source = signer()
  const binding = { ...source.binding, appVersion: version }
  return { source, token: issueAnonymousToken(createAnonymousIdentities(binding, "127.0.0.1", config), binding, config).token }
}

test("only supported releases pass: version outside the window, unsupported model and unknown list deny before reservation", async () => {
  const f = fixture()
  // A token issued to one build cannot be used with another build's proof.
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt, { version: "1.2.2" }))).status, 401)
  const old = guestFor("1.1.9")
  const response = await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${old.token}`, prompt, { version: "1.1.9", source: old.source }))
  assert.equal(response.status, 426)
  assert.deepEqual(await response.json(), { error: { code: "desktop_update_required", currentVersion: "1.1.9", minimumVersion: "1.2.0", message: "Update OpenWork Desktop to 1.2.0 or newer to use Auto." } })
  const floored = guestFor("1.2.0")
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${floored.token}`, undefined, { version: "1.2.0", source: floored.source }))).status, 200, "10 days old is inside the 14-day floor")
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt.replace(INFERENCE_FREE_MODEL_ID, "paid-model")))).status, 400)
  assert.equal(f.principals.length, 0)
  assert.equal(f.requests.length, 0)
  const unavailable = fixture({ releases: async () => null })
  assert.equal((await unavailable.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))).status, 503)
  const blocked = fixture({ config: { ...config, blockedReleases: ["1.2.3"] } })
  assert.equal((await blocked.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))).status, 426, "a yanked release is refused at once")
})

test("the release tag must come from the secret of the claimed version, the previous master key overlaps, dev secrets only count in dev mode", async () => {
  const f = fixture()
  const ok = await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`))
  assert.equal(ok.status, 200)
  // A secret lifted from the 1.2.2 build presented as the 1.2.3 build.
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`, undefined, { tagVersion: "1.2.2" }))).status, 401)
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`, undefined, { secret: new TextEncoder().encode("not-our-key-at-all-0000000000000000") }))).status, 401)
  const rotated = fixture({ config: { ...config, releaseKey: "test-only-rotated-master-key-444444444444444444", releaseKeyPrevious: releaseKey } })
  assert.equal((await rotated.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`))).status, 200, "builds from the previous key keep working during the overlap")
  const retired = fixture({ config: { ...config, releaseKey: "test-only-rotated-master-key-444444444444444444" } })
  assert.equal((await retired.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`))).status, 401, "after the overlap they do not")
  const devSecret = new TextEncoder().encode("test-only-dev-release-secret-5555555555555555")
  const dev = fixture({ config: { ...config, devReleaseSecret: "test-only-dev-release-secret-5555555555555555" } })
  const devGuest = guestFor("0.0.0-dev")
  assert.equal((await dev.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${devGuest.token}`, undefined, { version: "0.0.0-dev", source: devGuest.source, secret: devSecret }))).status, 200, "a dev build skips the window")
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${devGuest.token}`, undefined, { version: "0.0.0-dev", source: devGuest.source, secret: devSecret }))).status, 401, "but only when the gateway is in dev mode")
})

test("v2 proofs are accepted until every supported release carries a tag, then refused with the update wall", async () => {
  const before = fixture()
  assert.equal((await before.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`, undefined, { proofVersion: 2 }))).status, 200)
  const cutover = fixture({ config: { ...config, firstReleaseTagVersion: "1.2.0" } })
  const response = await cutover.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt, { proofVersion: 2 }))
  assert.equal(response.status, 426)
  assert.equal((await response.json()).error.code, "desktop_update_required")
  assert.equal((await cutover.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`))).status, 200)
  assert.equal(releaseTagRequired(["1.2.3", "1.2.0"], "1.2.1"), false)
  assert.equal(releaseTagRequired(["1.2.3", "1.2.1"], "1.2.1"), true)
  assert.equal(releaseTagRequired(["1.2.3"], null), false)
})

test("policy flip before dispatch cancels admission without an upstream call", async () => {
  const base = fixture()
  const f = fixture({ store: { ...base.store, dispatch: async () => false } })
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))).status, 403)
  assert.equal(f.requests.length, 0)
})

test("a revoked or rate-limited OpenAI key releases the hold; an uncertain failure retains it", async () => {
  for (const status of [401, 403, 429]) {
    const f = fixture({}, () => Response.json({ error: { message: "no" } }, { status }))
    const response = await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))
    assert.equal(response.status, 503)
    assert.equal(f.calls.released, 1)
    assert.deepEqual(f.receipts, [])
  }
  const server = fixture({}, () => Response.json({ error: { message: "no" } }, { status: 500 }))
  assert.equal((await server.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))).status, 502)
  assert.deepEqual(server.receipts, [null])
  const transport = fixture({ fetch: async () => { throw new Error("uncertain transport") } })
  assert.equal((await transport.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))).status, 502)
  assert.equal(transport.calls.cancelled, 0)
  assert.deepEqual(transport.receipts, [null])
})

test("request validation preserves tools but denies routing, media and expanded schemas", async () => {
  const value = { model: INFERENCE_FREE_MODEL_ID, messages: [{ role: "user", content: "hello" }], stream: true, max_tokens: 64000,
    tools: [{ type: "function", function: { name: "run", parameters: { type: "object" } } }] }
  const body = JSON.parse(prepareFreeRequest(value, config).body)
  assert.deepEqual(body.tools, value.tools)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.max_completion_tokens, config.maxCompletionTokens)
  for (const extra of [{ provider: { allow_fallbacks: true } }, { usage: { include: true } }, { reasoning: { effort: "none" } }, { models: ["x"] }]) {
    assert.throws(() => prepareFreeRequest({ ...value, ...extra }, config), JSON.stringify(extra))
  }
  assert.throws(() => prepareFreeRequest({ ...value, tools: [{ type: "function", function: { name: "run", parameters: { $ref: "remote" } } }] }, config))
  assert.throws(() => prepareFreeRequest({ ...value, messages: [{ role: "user", content: [{ type: "image_url", image_url: "remote" }] }] }, config))
  await assert.rejects(readFreeRequest(new Request("https://free.test", { method: "POST", headers: { "content-type": "application/json" }, body: prompt }), 1, new AbortController().signal))
})

test("cost comes from OpenAI token counts; a dated snapshot of the model is accepted", () => {
  const parser = new FreeResponseReceipt(config)
  parser.accept(openAiResponse())
  assert.equal(parser.complete()?.amount, expectedAmount)
  assert.equal(expectedAmount, Math.ceil((10 * config.inputPrice + 2 * config.outputPrice) * INFERENCE_USAGE_CONVERSION_FACTOR / 1000000))
  assert.throws(() => parser.complete())
  const incomplete = new FreeResponseReceipt(config)
  incomplete.accept({ ...openAiResponse(), choices: [{ index: 0, finish_reason: null }] })
  assert.throws(() => incomplete.complete())
  const missingUsage = new FreeResponseReceipt(config)
  missingUsage.accept({ ...openAiResponse(), usage: {} })
  assert.equal(missingUsage.complete(), null)
  assert.throws(() => new FreeResponseReceipt(config).accept({ ...openAiResponse(), model: "gpt-4o" }))
  assert.throws(() => new FreeResponseReceipt(config).accept({ ...openAiResponse(), model: `${config.upstreamModel}x` }))
})

test("OpenAI SSE settles from the trailing usage chunk before DONE and releases upstream", async () => {
  const events: string[] = []
  const encoder = new TextEncoder()
  const model = `${config.upstreamModel}-2026-08-01`
  const chunks = [
    { id: "chatcmpl-2", model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }], usage: null },
    { id: "chatcmpl-2", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null },
    { id: "chatcmpl-2", model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ]
  const text = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
  const upstream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(text)) }, cancel() { events.push("cancel") } })
  const body = meterFreeResponse(upstream, { config, streaming: true, maxBytes: 10000, signal: new AbortController().signal,
    settle: async (receipt) => { assert.equal(receipt?.amount, expectedAmount); events.push("settle") } })
  const output = await new Response(body).text()
  assert.ok(output.includes("[DONE]"))
  assert.ok(!output.includes(model))
  assert.ok(output.includes(`"model":"${INFERENCE_FREE_MODEL_ID}"`))
  assert.deepEqual(events, ["settle", "cancel"])
})

test("usage followed by error or truncated EOF retains full hold", async () => {
  for (const suffix of ["", 'data: {"error":{"message":"interrupted"}}\n\n']) {
    const receipts: Array<FreeUsageReceipt | null> = []
    const upstream = new Response(`data: ${JSON.stringify(openAiResponse())}\n\n${suffix}`).body!
    const body = meterFreeResponse(upstream, { config, streaming: true, maxBytes: 10000, signal: new AbortController().signal,
      settle: async (receipt) => { receipts.push(receipt) } })
    await assert.rejects(new Response(body).text())
    assert.deepEqual(receipts, [null])
  }
})

test("unknown settlement retains conservative charge; actual overrun triggers safety block", () => {
  const held = { status: "dispatched", reserved_amount: freeRequestReservation(config), model_id: INFERENCE_FREE_MODEL_ID,
    max_input_tokens: config.maxInputTokens, max_output_tokens: config.maxCompletionTokens } satisfies Parameters<typeof freeSettlementDecision>[0]
  assert.deepEqual(freeSettlementDecision(held, null), { amount: held.reserved_amount, status: "retained", unsafe: false })
  assert.equal(freeSettlementDecision(held, { eventId: "event", model: INFERENCE_FREE_MODEL_ID, amount: held.reserved_amount + 1, inputTokens: 1, outputTokens: 1 })?.unsafe, true)
  assert.equal(freeSettlementDecision(held, { eventId: "event", model: "wrong", amount: 1, inputTokens: 1, outputTokens: 1 }), null)
})

test("the support window is the newest releases plus the 14-day floor, minus blocked, never prereleases", () => {
  const window = { count: 3, minDays: 14, blocked: [] as string[] }
  assert.deepEqual(supportedDesktopReleases(releases, window, now), ["1.2.3", "1.2.2", "1.2.1", "1.2.0"])
  assert.deepEqual(supportedDesktopReleases(releases, { ...window, minDays: 0 }, now), ["1.2.3", "1.2.2", "1.2.1"])
  assert.deepEqual(supportedDesktopReleases(releases, { ...window, count: 1, minDays: 3 }, now), ["1.2.3", "1.2.2"])
  assert.deepEqual(supportedDesktopReleases(releases, { ...window, blocked: ["1.2.3"] }, now), ["1.2.2", "1.2.1", "1.2.0"])
  assert.deepEqual(supportedDesktopReleases([...releases, { version: "1.3.0-alpha.1", publishedAt: now }], window, now), ["1.2.3", "1.2.2", "1.2.1", "1.2.0"])
  assert.equal(desktopFreeVersionError("1.2.3-alpha", ["1.2.3"])?.code, "desktop_update_required")
  assert.equal(desktopFreeVersionError("1.2.3", ["1.2.3", "1.2.2"]), null)
  assert.deepEqual(desktopFreeVersionError("1.2.1", ["1.2.3", "1.2.2"]), { code: "desktop_update_required", currentVersion: "1.2.1", minimumVersion: "1.2.2", message: "Update OpenWork Desktop to 1.2.2 or newer to use Auto." })
  assert.equal(desktopFreeVersionError("1.2.3", null)?.code, "desktop_version_unavailable")
  assert.equal(desktopFreeVersionError("1.2.3", [])?.code, "desktop_version_unavailable")
})

test("the release list is cached, served stale through source failures, and malformed sources fail closed", async () => {
  let clock = 0, calls = 0, fail = false
  const github = releases.map((release) => ({ tag_name: `v${release.version}`, draft: false, prerelease: false, published_at: new Date(release.publishedAt).toISOString() }))
  const source = createDesktopFreeReleaseSource({ url: "https://api.github.test/releases", now: () => clock,
    fetch: async () => { calls++; return fail ? new Response("nope", { status: 500 }) : Response.json([...github, { tag_name: "v1.3.0-alpha.1", draft: false, prerelease: true, published_at: "2026-09-23T00:00:00Z" }, { tag_name: "v9.9.9", draft: true, prerelease: false, published_at: "2026-09-23T00:00:00Z" }]) } })
  assert.deepEqual((await source())?.map((release) => release.version), ["1.2.3", "1.2.2", "1.2.1", "1.2.0", "1.1.9"])
  await source()
  assert.equal(calls, 1)
  clock = 300001
  fail = true
  assert.deepEqual((await source())?.map((release) => release.version), ["1.2.3", "1.2.2", "1.2.1", "1.2.0", "1.1.9"], "a failed refresh serves the last good list")
  assert.equal(calls, 2)
  clock = 86400001
  assert.equal(await source(), null, "stale lists expire after a day")
  const custom = createDesktopFreeReleaseSource({ url: "https://metadata.test/releases", fetch: async () => Response.json({ releases: [{ version: "v1.2.3", publishedAt: "2026-09-23T00:00:00Z" }] }) })
  assert.deepEqual(await custom(), [{ version: "1.2.3", publishedAt: Date.parse("2026-09-23T00:00:00Z") }])
  for (const body of [{ latestAppVersion: "1.2.3" }, [{ tag_name: 1 }], "1.2.3", []]) {
    const malformed = createDesktopFreeReleaseSource({ url: "https://metadata.test/releases", fetch: async () => Response.json(body) })
    assert.equal(await malformed(), null, JSON.stringify(body))
  }
})

function memberCall(app: Hono, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://free.test${path}`, init))
}
const memberChat = { method: "POST", body: prompt, headers: { "content-type": "application/json" } }

test("member status carries org Auto pin policy while guests remain pinned and unpinning does not remove the model", async () => {
  const f = fixture({}, undefined, { defaultPinned: async () => false })
  const memberStatus = await memberCall(f.memberApp, MEMBER_FREE_STATUS_PATH)
  assert.equal(memberStatus.status, 200)
  assert.equal((await memberStatus.json()).defaultPinned, false)
  const guestStatus = await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`))
  assert.equal((await guestStatus.json()).defaultPinned, true)
  const catalog = await memberCall(f.memberApp, MEMBER_FREE_MODELS_PATH)
  assert.equal(catalog.status, 200)
  assert.equal((await catalog.json()).data[0].id, INFERENCE_FREE_MODEL_ID)
  assert.equal(f.requests.length, 0)
  assert.equal(f.principals.length, 0)
  const failed = fixture({}, undefined, { defaultPinned: async () => { throw new Error("Policy unavailable") } })
  assert.equal((await memberCall(failed.memberApp, MEMBER_FREE_STATUS_PATH)).status, 503)
})

test("member Auto requests join the organization's usage as OpenWork Models, logged against the member's key; guests are never logged", async () => {
  const rows: Array<Record<string, unknown>> = []
  const usageLog = { insert: async (row: Record<string, unknown>) => { rows.push({ ...row }) }, update: async (row: Record<string, unknown>) => { rows.push({ ...row }); return true } }
  const f = fixture({}, undefined, { usageLog: usageLog as never })
  const memberResponse = await memberCall(f.memberApp, MEMBER_FREE_CHAT_PATH, memberChat)
  assert.equal(memberResponse.status, 200)
  await memberResponse.json()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(rows.length, 2, "one pending insert and one settled update")
  const [pending, settled] = rows
  assert.equal(pending.route, "openwork_free")
  assert.equal(pending.upstream_provider_id, "openai")
  assert.equal(pending.upstream_host, "api.openai.com")
  assert.equal(pending.organization_id, member.organizationId)
  assert.equal(pending.org_membership_id, member.memberId)
  assert.equal(pending.inference_key_id, keyRow.id)
  assert.equal(pending.gateway_provider_id, null)
  assert.equal(pending.upstream_model, INFERENCE_FREE_MODEL_ID)
  assert.equal(settled.outcome, "ok")
  assert.equal(settled.input_tokens, openAiResponse().usage.prompt_tokens)
  assert.equal(settled.output_tokens, openAiResponse().usage.completion_tokens)
  assert.ok(typeof settled.cost_micro_usd === "number" && settled.cost_micro_usd > 0)
  assert.equal(settled.upstream_request_id, "chatcmpl-1", "OpenAI's completion id is the durable usage identity")
  const guestResponse = await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))
  assert.equal(guestResponse.status, 200)
  await guestResponse.json()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(rows.length, 2, "guest requests are never attributed to an organization")
})

test("member Auto fails closed when the Gateway request log cannot be written, without consuming allowance", async () => {
  const f = fixture({}, undefined, { usageLog: { insert: async () => { throw new Error("accounting offline") } } })
  const response = await memberCall(f.memberApp, MEMBER_FREE_CHAT_PATH, memberChat)
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, "request_log_unavailable")
  assert.equal(f.requests.length, 0, "nothing was sent upstream")
  assert.equal(f.calls.cancelled, 1, "the undispatched reservation was released")
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))).status, 200, "guests do not depend on organization accounting")
})
