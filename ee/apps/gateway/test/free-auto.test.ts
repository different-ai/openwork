import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { INFERENCE_FREE_MODEL_ID, INFERENCE_USAGE_CONVERSION_FACTOR, freeInferenceWindow, managedModelCatalog, readFreeInferenceConfig } from "@openwork/types/den/inference"
import { DESKTOP_FREE_RESPONSES_PATH, MEMBER_FREE_RESPONSES_PATH, DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH, MEMBER_FREE_CHAT_PATH, MEMBER_FREE_MODELS_PATH,
  MEMBER_FREE_STATUS_PATH, DESKTOP_FREE_MODEL_ID, desktopFreeProofMessage, desktopFreeReleaseTagMessage, desktopFreeSessionPowMessage, leadingZeroBits, type DesktopFreeProofClaims } from "@openwork/free-auto"
import { readAutoConfig, untaggedAutoEnabled, FREE_OPENAI_CHAT_URL, FREE_OPENAI_RESPONSES_URL } from "../src/free/shared/config.js"
import { freeUsageAmount, rampedDeviceAmount } from "@openwork/free-auto/accounting"
import { verifyDesktopFreeProof } from "../src/free/guest/proof.js"
import { deriveReleaseSecret, releaseTag, sha256Hex as desktopFreeHash } from "@openwork/free-auto/node"
import { createAnonymousIdentities, issueAnonymousToken, verifyAnonymousToken, canonicalizeAnonymousAddress } from "../src/free/guest/identity.js"
import { prepareFreeRequest, readFreeRequest } from "../src/free/shared/request.js"
import { FreeResponseReceipt, meterFreeResponse } from "../src/free/shared/meter.js"
import type { FreePrincipal, MemberPrincipal } from "../src/free/shared/principal.js"
import { freeInferenceDigest as freeIdentityHash } from "@openwork-ee/utils/free-inference-digest"
import type { FreeAllowanceStore, FreeUsageReceipt } from "../src/free/shared/allowance.js"

process.env.OPENWORK_DEV_MODE = "1"
process.env.DEN_DB_ENCRYPTION_KEY = "test-only-free-auto-encryption-key-000000000000"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/free_auto_test_unused"
const { registerAnonymousInferenceRoutes } = await import("../src/free/guest/routes.js")
const { createFreeMemberHandler } = await import("../src/free/member/handler.js")
const { registerProxyRoutes } = await import("../src/proxy.js")
const { validFreeReceipt } = await import("../src/free/shared/allowance.js")

const releaseKey = "test-only-release-master-key-2222222222222222222"
const previousReleaseKey = "test-only-previous-master-key-33333333333333333"
const config = readAutoConfig({ INFERENCE_FREE_ENABLED: "true", ANONYMOUS_INFERENCE_ENABLED: "true",
  INFERENCE_FREE_OPENAI_API_KEY: "sk-fixture-dedicated-free-key", ANONYMOUS_TOKEN_SECRET: "test-only-token-secret-00000000000000000000",
  ANONYMOUS_ACCOUNTING_IDENTITY_KEY: "test-only-accounting-key-1111111111111111111", DESKTOP_FREE_RELEASE_KEY: releaseKey, ANONYMOUS_SESSION_POW_BITS: "8", ANONYMOUS_SESSION_POW_ROUNDS: "2" })
const now = Date.parse("2026-09-23T12:00:00Z")
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
function nativeResponse(status = "completed") {
  return { id: "resp_fixture", object: "response", status, model: `${config.upstreamModel}-2026-09-22`, output: [
    { id: "fc_fixture", type: "function_call", call_id: "call_fixture", name: "fixture_tool", arguments: "{}", status: "completed" },
    { id: "rs_fixture", type: "reasoning", summary: [], encrypted_content: "fixture-encrypted-state" },
  ], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 } } }
}
type Upstream = { url: string; headers: Headers; body: Record<string, unknown> }
function fakeStore(principals: FreePrincipal[], receipts: Array<FreeUsageReceipt | null>, calls: { session: number; charged: number }): FreeAllowanceStore {
  const nonces = new Set<string>()
  return {
    family: "anonymous",
    async consumeNonce(proof) { const key = `${proof.keyThumbprint}:${proof.nonce}`; if (nonces.has(key)) return "replay"; nonces.add(key); return "accepted" },
    async consumeSession() { calls.session++ },
    async read(principal) { return { state: "ready", code: null, allowance: { limitUsd: principal.kind === "member" ? 5 : 1,
      usedUsd: 0, remainingUsd: principal.kind === "member" ? 5 : 1, resetsAt: freeInferenceWindow().end.toISOString() } } },
    async admit(principal) { principals.push(principal); return { ok: true, windows: [] } },
    async charge({ receipt }) { calls.charged++; receipts.push(receipt); return true },
  }
}
function fixture(overrides: Partial<import("../src/free/guest/routes.js").FreeRouteDependencies> = {}, upstream: (request: Upstream) => Response = () => Response.json(openAiResponse()),
  memberOverrides: Partial<import("../src/free/member/handler.js").FreeMemberDependencies> = {}) {
  const principals: FreePrincipal[] = []
  const receipts: Array<FreeUsageReceipt | null> = []
  const requests: Upstream[] = []
  const calls = { session: 0, charged: 0 }
  const store = fakeStore(principals, receipts, calls)
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }
    assert.equal(init?.redirect, "error")
    requests.push(request)
    return upstream(request)
  }
  const app = new Hono()
  registerAnonymousInferenceRoutes(app, { config, store, now: () => now, clientAddress: () => "127.0.0.1", fetch, ...overrides })
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
  assert.deepEqual([defaults.minimumVersion, defaults.blockedReleases], [null, []], "every desktop version may use Auto unless the server says otherwise")
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
  assert.deepEqual(readAutoConfig({ DESKTOP_FREE_BLOCKED_RELEASES: " v1.2.2, 1.2.1 ,, " }).blockedReleases, ["1.2.2", "1.2.1"])
  assert.equal(readAutoConfig({ DESKTOP_FREE_MIN_VERSION: "v1.2.0" }).minimumVersion, "1.2.0")
  assert.throws(() => readAutoConfig({ DESKTOP_FREE_MIN_VERSION: "latest" }), /DESKTOP_FREE_MIN_VERSION/)
  assert.throws(() => readAutoConfig({ INFERENCE_FREE_ENABLED: "true", INFERENCE_FREE_WEEKLY_BUDGET_USD: "1" }))
  assert.throws(() => readAutoConfig({ INFERENCE_FREE_OPENAI_MODEL: "openai/gpt-6-luna" }))
  assert.throws(() => readFreeInferenceConfig({ INFERENCE_FREE_MODEL_ID: "paid-model" }))
  assert.deepEqual(managedModelCatalog().map((model) => model.modelID), [INFERENCE_FREE_MODEL_ID])
})

test("disabled endpoints do not verify metadata, write accounting, or dispatch", async () => {
  const off = readAutoConfig({})
  const f = fixture({ config: off })
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
  // Machines are not counted per IP: many machines behind one office IP all start sessions.
  const office = fixture()
  for (let index = 0; index < 50; index++) {
    const response = await office.app.fetch(session({ source: signer(`${index.toString(16).padStart(2, "0")}`.padEnd(64, "d")) }))
    assert.equal(response.status, 200, `machine ${index} starts a session`)
  }
  assert.equal(office.calls.session, 50)
})

test("the guest allowance unlocks over the machine's first 30 active minutes and never exceeds the device budget", () => {
  const defaults = readAutoConfig({})
  assert.deepEqual(defaults.installRamp, [{ minutes: 0, amount: 10000000 }, { minutes: 10, amount: 20000000 }, { minutes: 20, amount: 50000000 }, { minutes: 30, amount: 100000000 }])
  assert.equal("ipNewIdentitiesPerDay" in defaults, false, "there is no new-machines-per-IP cap")
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
  assert.equal((await call("/api/v1/responses", { method: "POST", body: prompt, headers: { "content-type": "application/json" } })).status, 400)
  assert.equal(f.requests.length, 1)
})

test("the proxy sends Auto to free Auto for every organization and keeps other models on paid Models", async () => {
  const routeFor = (metadata: Record<string, unknown>) => {
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
    const call = (path: string, body?: string) => app.fetch(new Request(`https://gateway.test${path}`, { method: body === undefined ? "GET" : "POST", body,
      headers: { authorization: `Bearer ${memberKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) } }))
    return { served, call }
  }
  for (const metadata of [{}, { inference: { enabled: false } }, { inference: { enabled: true, tier: "tier1" } }]) {
    const route = routeFor(metadata)
    assert.equal((await route.call(MEMBER_FREE_CHAT_PATH, prompt)).status, 200, JSON.stringify(metadata))
    assert.equal((await route.call(MEMBER_FREE_RESPONSES_PATH, JSON.stringify({ model: INFERENCE_FREE_MODEL_ID, input: "hello" }))).status, 200)
    assert.deepEqual(route.served, ["free", "free"], JSON.stringify(metadata))
  }
  const paying = routeFor({ inference: { enabled: true, tier: "tier1" } })
  assert.equal((await paying.call(MEMBER_FREE_STATUS_PATH)).status, 200, "a paying organization's members can check their free Auto allowance")
  const paid = await paying.call(MEMBER_FREE_CHAT_PATH, JSON.stringify({ model: "openai/gpt-6-sol", messages: [{ role: "user", content: "hello" }] }))
  assert.notEqual(paid.status, 200)
  assert.deepEqual(paying.served, ["free"], "other models stay on paid Models")
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

test("the version the desktop reports passes unless the server blocks it or sets a minimum; unsupported models deny before admission", async () => {
  const f = fixture()
  // A token issued to one build cannot be used with another build's proof.
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt, { version: "1.2.2" }))).status, 401)
  for (const version of ["1.1.9", "1.2.4-alpha.3244+4d3cfbd", "1.2.3-alpha.9+abc1234"]) {
    const build = guestFor(version)
    const status = await (await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${build.token}`, undefined, { version, source: build.source }))).json()
    assert.equal(status.state, "ready", `${version} is not asked to update by default`)
    assert.equal(status.minimumVersion, version, "desktops that expect a minimum get their own version")
  }
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt.replace(INFERENCE_FREE_MODEL_ID, "paid-model")))).status, 400)
  assert.equal(f.principals.length, 0)
  assert.equal(f.requests.length, 0)
  const floor = fixture({ config: { ...config, minimumVersion: "1.2.0" } })
  const old = guestFor("1.1.9")
  const response = await floor.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${old.token}`, prompt, { version: "1.1.9", source: old.source }))
  assert.equal(response.status, 426)
  assert.deepEqual(await response.json(), { error: { code: "desktop_update_required", currentVersion: "1.1.9", minimumVersion: "1.2.0", message: "Update OpenWork Desktop to 1.2.0 or newer to use Auto." } })
  assert.equal((await floor.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`))).status, 200)
  const blocked = fixture({ config: { ...config, blockedReleases: ["1.2.3", "1.2.4-alpha.3244"] } })
  assert.equal((await blocked.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))).status, 426, "a yanked release is refused at once")
  const alpha = guestFor("1.2.4-alpha.3244+4d3cfbd")
  assert.equal((await (await blocked.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${alpha.token}`, undefined, { version: "1.2.4-alpha.3244+4d3cfbd", source: alpha.source }))).json()).state, "update_required", "blocking ignores build metadata")
  const untagged = guestFor("1.2.4-alpha.1+abc")
  const untaggedOff = fixture({ config: { ...config, untaggedGlobalDailyAmount: 0 } })
  assert.equal((await (await untaggedOff.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${untagged.token}`, undefined, { version: "1.2.4-alpha.1+abc", source: untagged.source, proofVersion: 2 }))).json()).code, "desktop_build_unverified")
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

test("switched-off guest Auto says free_disabled, not unavailable, on every guest route and touches nothing", async () => {
  const f = fixture({ config: { ...config, anonymousEnabled: false } })
  for (const request of [signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`), signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt)]) {
    const response = await f.app.fetch(request)
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error.code, "free_disabled")
  }
  assert.equal(f.requests.length, 0)
})

test("an untagged (v2) proof, like a build from source, uses Auto on the per-IP untagged budget", async () => {
  const f = fixture()
  const status = await (await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`, undefined, { proofVersion: 2 }))).json()
  assert.deepEqual([status.state, status.code], ["ready", null])
  const minted = await f.app.fetch(session({ proofVersion: 2 }))
  assert.equal(minted.status, 200, "an untagged build can start a guest session")
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt, { proofVersion: 2 }))).status, 200)
  const ipHash = createAnonymousIdentities(device.binding, "127.0.0.1", config).ipHash
  assert.deepEqual(f.principals.at(-1), { kind: "installation", id: createAnonymousIdentities(device.binding, "127.0.0.1", config).installationHash, untaggedIpHash: ipHash })
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))).status, 200)
  assert.equal(f.principals.at(-1)?.kind === "installation" && f.principals.at(-1)?.untaggedIpHash, undefined, "a tagged proof is not held to the IP budget")
  const blocked = fixture({ config: { ...config, blockedReleases: ["1.2.3"] } })
  assert.equal((await blocked.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt, { proofVersion: 2 }))).status, 426, "blocked versions still apply")
  const defaults = readAutoConfig({})
  assert.deepEqual([defaults.untaggedIpDailyAmount, defaults.untaggedGlobalDailyAmount], [0.2 * INFERENCE_USAGE_CONVERSION_FACTOR, 10 * INFERENCE_USAGE_CONVERSION_FACTOR], "$0.20 per IP a day, $10 for all untagged builds a day")
  assert.equal(untaggedAutoEnabled(defaults), true)
  assert.equal(untaggedAutoEnabled(readAutoConfig({ ANONYMOUS_UNTAGGED_IP_DAILY_MICRO_USD: "0" })), false, "either budget at 0 turns untagged builds off")
  assert.equal(untaggedAutoEnabled(readAutoConfig({ ANONYMOUS_UNTAGGED_GLOBAL_DAILY_MICRO_USD: "0" })), false)
  assert.throws(() => readAutoConfig({ ANONYMOUS_UNTAGGED_IP_DAILY_MICRO_USD: "-1" }))
})

test("like OpenCode Zen, any client with no proof and no key (or the key \"public\") gets Auto, limited by its IP", async () => {
  const f = fixture()
  const open = (path: string, headers: Record<string, string> = {}, body?: string) => new Request(`https://free.test${path}`, {
    method: body === undefined ? "GET" : "POST", body, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) } })
  const status = await (await f.app.fetch(open(DESKTOP_FREE_STATUS_PATH, { authorization: "Bearer public" }))).json()
  assert.deepEqual([status.state, status.code, status.currentVersion, status.minimumVersion], ["ready", null, "", null])
  const models = await (await f.app.fetch(open(DESKTOP_FREE_MODELS_PATH, { authorization: "Bearer public" }))).json()
  assert.deepEqual(models.data.map((model: { id: string }) => model.id), [DESKTOP_FREE_MODEL_ID])
  for (const headers of [{ authorization: "Bearer public" }, {}]) {
    assert.equal((await f.app.fetch(open(DESKTOP_FREE_CHAT_PATH, headers, prompt))).status, 200)
  }
  const ipHash = createAnonymousIdentities(device.binding, "127.0.0.1", config).ipHash
  assert.deepEqual(f.principals.at(-1), { kind: "installation", id: freeIdentityHash("open-ip", ipHash), untaggedIpHash: ipHash, deviceless: true },
    "an open request is charged to its IP, not a machine")
  assert.equal(f.requests.length, 2)
  assert.equal(f.calls.session, 0, "no guest session is needed")
  // Anything that is not the open key is still a desktop request and needs its proof.
  assert.equal((await f.app.fetch(open(DESKTOP_FREE_CHAT_PATH, { authorization: "Bearer sk-someone-elses-key" }, prompt))).status, 401)
  assert.equal((await f.app.fetch(open(DESKTOP_FREE_CHAT_PATH, { authorization: "Bearer public", "x-api-key": "public" }, prompt))).status, 401)
  assert.equal((await f.app.fetch(open(DESKTOP_FREE_CHAT_PATH, { authorization: "Bearer public" }, prompt.replace(INFERENCE_FREE_MODEL_ID, "paid-model")))).status, 400, "only the free model")
  const off = fixture({ config: { ...config, untaggedIpDailyAmount: 0 } })
  const refused = await off.app.fetch(open(DESKTOP_FREE_CHAT_PATH, { authorization: "Bearer public" }, prompt))
  assert.deepEqual([refused.status, (await refused.json()).error.code], [503, "desktop_build_unverified"], "with the untagged budgets off, open clients hear Auto is unavailable to them")
  assert.equal((await (await off.app.fetch(open(DESKTOP_FREE_STATUS_PATH, {}))).json()).code, "desktop_build_unverified")
  const disabled = fixture({ config: { ...config, anonymousEnabled: false } })
  assert.equal((await (await disabled.app.fetch(open(DESKTOP_FREE_CHAT_PATH, {}, prompt))).json()).error.code, "free_disabled")
  assert.equal(off.requests.length + disabled.requests.length, 0)
})

test("with the untagged budgets off, an untagged (v2) proof says the build can't use Auto, not that it needs an update", async () => {
  const f = fixture({ config: { ...config, untaggedIpDailyAmount: 0 } })
  const response = await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt, { proofVersion: 2 }))
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, "desktop_build_unverified")
  const status = await (await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`, undefined, { proofVersion: 2 }))).json()
  assert.deepEqual([status.state, status.code], ["unavailable", "desktop_build_unverified"])
  assert.equal(f.requests.length, 0)
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`))).status, 200, "a tagged release proof still works")
})

test("a refused admission sends nothing upstream", async () => {
  const base = fixture()
  for (const [code, status] of [["anonymous_limit_exceeded", 429], ["anonymous_capacity_exceeded", 429], ["free_principal_rejected", 403]] as const) {
    const f = fixture({ store: { ...base.store, admit: async () => ({ ok: false, code }) } })
    const response = await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))
    assert.equal(response.status, status)
    assert.equal((await response.json()).error.code, code)
    assert.equal(f.requests.length, 0)
  }
})

test("an OpenAI error charges nothing; a transport failure charges the fixed estimate", async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture({}, () => Response.json({ error: { message: "no" } }, { status }))
    const response = await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))
    assert.equal(response.status, 503)
    assert.equal(f.calls.charged, 0)
  }
  const transport = fixture({ fetch: async () => { throw new Error("uncertain transport") } })
  assert.equal((await transport.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))).status, 502)
  assert.deepEqual(transport.receipts, [null])
})

test("like paid Models, the request is forwarded as sent, with only the model, usage and routing fields adjusted", async () => {
  const value = { model: INFERENCE_FREE_MODEL_ID, messages: [{ role: "user", content: "hello" }], stream: true, max_tokens: 64000,
    tools: [{ type: "function", function: { name: "run", parameters: { type: "object" } } }] }
  const body = JSON.parse(prepareFreeRequest(value, config).body)
  assert.deepEqual(body.tools, value.tools)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.max_completion_tokens, 64000, "the client's own output limit passes through, as on paid Models")
  assert.equal(JSON.parse(prepareFreeRequest({ ...value, max_tokens: undefined }, config).body).max_completion_tokens, undefined)
  for (const extra of [{ provider: { allow_fallbacks: true } }, { usage: { include: true } }, { reasoning: { effort: "none" } }, { models: ["x"] }]) {
    const routed = JSON.parse(prepareFreeRequest({ ...value, ...extra }, config).body)
    assert.equal(Object.keys(extra).some((key) => key in routed), false, `${JSON.stringify(extra)} is an OpenRouter field and is dropped, not refused`)
  }
  const engine = { ...value, prompt_cache_key: "session-1", tool_choice: "auto", reasoning_effort: "low",
    tools: [{ type: "function", function: { name: "openwork-google-workspace_gmail_create_draft_with_uploaded_attachments", description: "x", parameters: { type: "object" }, strict: false } }],
    messages: [{ role: "system", content: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }] }, { role: "user", content: "hello" }] }
  const forwarded = JSON.parse(prepareFreeRequest(engine, config).body)
  assert.deepEqual([forwarded.prompt_cache_key, forwarded.tool_choice, forwarded.reasoning_effort, forwarded.model], ["session-1", "auto", "low", config.upstreamModel])
  assert.deepEqual(forwarded.tools, engine.tools, "tool names and shapes are forwarded as the engine sent them")
  assert.deepEqual(forwarded.messages, engine.messages)
  assert.equal(JSON.parse(prepareFreeRequest(value, config).body).reasoning_effort, "none", "no effort requested: the cheapest")
  for (const refused of [{ ...value, model: "openai/gpt-6-sol" }, { ...value, messages: [] }, { ...value, messages: "hello" }, null]) {
    assert.throws(() => prepareFreeRequest(refused, config), /Auto needs/)
  }
  const large = { ...value, messages: Array.from({ length: 300 }, () => ({ role: "user", content: "x".repeat(1024) })),
    tools: Array.from({ length: 70 }, (_, index) => ({ type: "function", function: { name: `tool_${index}`, description: "x".repeat(10000),
      parameters: { type: "object", properties: { value: { $ref: "#/$defs/value" } }, $defs: { value: { type: "string" } } } } })) }
  assert.deepEqual(JSON.parse(prepareFreeRequest(large, config).body).tools, large.tools)
  assert.deepEqual(JSON.parse(prepareFreeRequest(large, config).body).messages, large.messages)
  const media = [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }] }]
  assert.deepEqual(JSON.parse(prepareFreeRequest({ ...value, messages: media }, config).body).messages, media)
  assert.equal(config.maxBodyBytes, 32 * 1024 * 1024)
  const largeBody = JSON.stringify(large)
  assert.deepEqual((await readFreeRequest(new Request("https://free.test", { method: "POST", headers: { "content-type": "application/json" }, body: largeBody }), config.maxBodyBytes, new AbortController().signal)).value, large)
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

test("only a sane receipt for the free model is charged as reported", () => {
  const receipt = { eventId: "chatcmpl-1", model: INFERENCE_FREE_MODEL_ID, amount: 5, inputTokens: 1, outputTokens: 1 }
  assert.equal(validFreeReceipt(receipt), true)
  assert.equal(validFreeReceipt({ ...receipt, amount: 1_000_000_000 }), true, "a large real cost is charged in full, never refused")
  assert.equal(validFreeReceipt({ ...receipt, model: "wrong" }), false)
  assert.equal(validFreeReceipt({ ...receipt, eventId: "" }), false)
  assert.equal(validFreeReceipt({ ...receipt, amount: -1 }), false)
  assert.equal(validFreeReceipt(null), false)
})

function memberCall(app: Hono, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://free.test${path}`, init))
}
const memberChat = { method: "POST", body: prompt, headers: { "content-type": "application/json" } }

test("member status carries org Auto pin policy, guests are unpinned by default, and unpinning does not remove the model", async () => {
  const f = fixture({}, undefined, { defaultPinned: async () => false })
  const memberStatus = await memberCall(f.memberApp, MEMBER_FREE_STATUS_PATH)
  assert.equal(memberStatus.status, 200)
  assert.equal((await memberStatus.json()).defaultPinned, false)
  const guestStatus = await f.app.fetch(signed(DESKTOP_FREE_STATUS_PATH, `Bearer ${guest()}`))
  assert.equal((await guestStatus.json()).defaultPinned, false)
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

test("a member over the allowance is refused before a usage log row or upstream call", async () => {
  const rows: Array<Record<string, unknown>> = []
  const usageLog = { insert: async (row: Record<string, unknown>) => { rows.push({ ...row }) }, update: async (row: Record<string, unknown>) => { rows.push({ ...row }); return true } }
  const base = fixture()
  const f = fixture({}, undefined, { usageLog: usageLog as never, store: { ...base.store, family: "member", admit: async () => ({ ok: false, code: "anonymous_limit_exceeded" }) } })
  const response = await memberCall(f.memberApp, MEMBER_FREE_CHAT_PATH, memberChat)
  assert.equal(response.status, 429)
  assert.equal(f.requests.length, 0)
  assert.equal(rows.length, 0)
})

test("member Auto fails closed when the Gateway request log cannot be written, without consuming allowance", async () => {
  const f = fixture({}, undefined, { usageLog: { insert: async () => { throw new Error("accounting offline") } } })
  const response = await memberCall(f.memberApp, MEMBER_FREE_CHAT_PATH, memberChat)
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, "request_log_unavailable")
  assert.equal(f.requests.length, 0, "nothing was sent upstream")
  assert.equal(f.calls.charged, 0, "no allowance was consumed")
  assert.equal((await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))).status, 200, "guests do not depend on organization accounting")
})


test("successful but unreadable OpenAI responses charge the missing-usage estimate", async () => {
  for (const reply of [new Response("billed", { headers: { "content-type": "text/plain" } }), new Response(null, { status: 204 })]) {
    const f = fixture({}, () => reply)
    const result = await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))
    assert.equal(result.status, 502)
    assert.deepEqual(f.receipts, [null])
    assert.doesNotMatch(await result.text(), /No allowance was consumed/)
  }
})

test("a database write failure retains the real receipt until one idempotent settlement succeeds", async () => {
  const base = fixture()
  let attempts = 0
  const seen: unknown[] = []
  const f = fixture({ store: { ...base.store, charge: async (input) => {
    seen.push(input)
    if (++attempts <= 2) throw new Error("database temporarily offline")
    return base.store.charge(input)
  } } })
  const result = await f.app.fetch(signed(DESKTOP_FREE_CHAT_PATH, `Bearer ${guest()}`, prompt))
  assert.equal((await result.json()).model, INFERENCE_FREE_MODEL_ID)
  assert.equal(attempts, 3)
  assert.equal(base.calls.charged, 1)
  assert.ok(seen.every((input) => JSON.stringify(input) === JSON.stringify(seen[0])))
  assert.equal(base.receipts[0]?.amount, expectedAmount)
})

test("the meter cannot finish a successful response when its settlement rejects", async () => {
  const result = meterFreeResponse(Response.json(openAiResponse()).body!, { config, streaming: false, maxBytes: config.maxResponseBytes,
    signal: new AbortController().signal, settle: async () => { throw new Error("accounting unavailable") } })
  await assert.rejects(new Response(result).json(), /accounting unavailable/)
})


test("ordinary OpenAI sampling options and multiple choices preserve the provider's aggregate usage", () => {
  const input = { model: INFERENCE_FREE_MODEL_ID, messages: [{ role: "user", content: "hello" }],
    n: 2, temperature: 0.4, top_p: 0.9, stop: ["end"], max_completion_tokens: 256000 }
  const prepared = prepareFreeRequest(input, config)
  assert.equal(prepared.choices, 2)
  assert.deepEqual(JSON.parse(prepared.body), { ...input, model: config.upstreamModel, stream: false, reasoning_effort: "none", store: false })
  const parser = new FreeResponseReceipt(config, 2)
  const response = openAiResponse()
  parser.accept({ ...response, choices: [response.choices[0], { ...response.choices[0], index: 1 }] })
  assert.equal(parser.complete()?.amount, expectedAmount)
  const incomplete = new FreeResponseReceipt(config, 2)
  incomplete.accept(response)
  assert.throws(() => incomplete.complete(), /Incomplete/)
})

test("native Auto forwards over 128 function tools and stateless continuation items to GPT-6 Luna", async () => {
  const tools = Array.from({ length: 142 }, (_, index) => ({ type: "function", name: `fixture_tool_${index}`, description: "A fixture tool",
    parameters: { type: "object", properties: {}, additionalProperties: false }, strict: false }))
  const input = [{ role: "user", content: "hello" }, { type: "function_call", call_id: "call_fixture", name: "fixture_tool_0", arguments: "{}" },
    { type: "function_call_output", call_id: "call_fixture", output: "ok" }, { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "fixture-encrypted-state" }]
  const body = JSON.stringify({ model: INFERENCE_FREE_MODEL_ID, input, tools, max_output_tokens: 128_000, reasoning: { effort: "none" },
    include: ["reasoning.encrypted_content"], stream: false, store: true })
  const f = fixture({}, () => Response.json(nativeResponse()))
  for (const request of [signed(DESKTOP_FREE_RESPONSES_PATH, `Bearer ${guest()}`, body),
    new Request(`https://free.test${MEMBER_FREE_RESPONSES_PATH}`, { method: "POST", body, headers: { "content-type": "application/json" } })]) {
    const response = await (new URL(request.url).pathname === DESKTOP_FREE_RESPONSES_PATH ? f.app : f.memberApp).fetch(request)
    assert.equal(response.status, 200)
    const value = await response.json()
    assert.equal(value.model, INFERENCE_FREE_MODEL_ID)
    assert.deepEqual(value.output, nativeResponse().output, "native tool calls and encrypted continuation state reach the SDK unchanged")
  }
  assert.equal(config.upstreamModel, "gpt-6-luna")
  assert.deepEqual([config.inputPrice, config.outputPrice], [0.1, 0.5])
  for (const request of f.requests) {
    assert.equal(request.url, FREE_OPENAI_RESPONSES_URL)
    assert.equal(request.headers.get("authorization"), "Bearer sk-fixture-dedicated-free-key")
    assert.deepEqual(request.body.tools, tools)
    assert.deepEqual(request.body.input, input)
    assert.deepEqual(request.body.reasoning, { effort: "none" })
    assert.equal(request.body.store, false)
    assert.equal(request.body.model, "gpt-6-luna")
    assert.equal(request.body.max_output_tokens, 128_000)
    assert.equal(request.body.stream_options, undefined)
  }
  assert.deepEqual(f.receipts.map((receipt) => receipt?.amount), [expectedAmount, expectedAmount])
  assert.deepEqual(f.principals.map((principal) => principal.kind), ["installation", "member"])
})

test("native Auto accepts public clients but rejects unapproved models and unmetered Responses features before admission", async () => {
  const body = { model: INFERENCE_FREE_MODEL_ID, input: "hello" }
  const f = fixture({}, () => Response.json(nativeResponse()))
  const call = (payload: unknown) => f.app.fetch(new Request(`https://free.test${DESKTOP_FREE_RESPONSES_PATH}`, {
    method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json", authorization: "Bearer public" },
  }))
  assert.equal((await call(body)).status, 200)
  for (const blocked of [{ background: true }, { previous_response_id: "resp_previous" }, { conversation: "conv_previous" },
    { tools: [{ type: "web_search" }] }, { input: [] }, { model: "paid-model" }]) assert.equal((await call({ ...body, ...blocked })).status, 400)
  assert.equal(f.requests.length, 1)
  assert.equal(f.principals.length, 1)
  const mint = await (await f.app.fetch(session())).json()
  assert.equal(mint.model, INFERENCE_FREE_MODEL_ID)
  assert.throws(() => readFreeInferenceConfig({ INFERENCE_FREE_MODEL_ID: "unapproved-model" }), /Unapproved free model/)
})

test("native SSE forwards tool deltas and settles completed or incomplete usage without a DONE marker", async () => {
  for (const status of ["completed", "incomplete"]) {
    const events = [{ type: "response.created", response: { ...nativeResponse(), status: "in_progress", output: [], usage: null } },
      { type: "response.function_call_arguments.delta", item_id: "fc_fixture", output_index: 0, delta: '{"text":"hé"}' },
      { type: `response.${status}`, response: nativeResponse(status) }]
    const bytes = new TextEncoder().encode(events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""))
    let cancelled = false
    const f = fixture({}, () => new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
    }, cancel() { cancelled = true } }), { headers: { "content-type": "text/event-stream" } }))
    const response = await f.app.fetch(signed(DESKTOP_FREE_RESPONSES_PATH, `Bearer ${guest()}`,
      JSON.stringify({ model: INFERENCE_FREE_MODEL_ID, input: "hello", stream: true })))
    const text = await response.text()
    assert.ok(text.includes("response.function_call_arguments.delta"))
    assert.ok(text.includes("hé"))
    assert.ok(text.includes("fixture-encrypted-state"))
    assert.ok(!text.includes("[DONE]"))
    assert.ok(!text.includes(`${config.upstreamModel}-2026-09-22`))
    assert.equal(cancelled, true)
    assert.deepEqual(f.receipts, [{ amount: expectedAmount, eventId: "resp_fixture", model: INFERENCE_FREE_MODEL_ID, inputTokens: 10, outputTokens: 2 }])
    assert.equal(f.calls.charged, 1)
  }
})

test("native error, mismatched identity, missing usage, truncated stream and cancellation settle once conservatively", async () => {
  const created = { type: "response.created", response: { ...nativeResponse(), status: "in_progress", usage: null } }
  for (const events of [[created], [created, { type: "response.failed", response: { ...nativeResponse(), status: "failed" } }],
    [created, { type: "response.completed", response: { ...nativeResponse(), id: "resp_other" } }]]) {
    const receipts: Array<FreeUsageReceipt | null> = []
    const stream = meterFreeResponse(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")).body!, {
      config, protocol: "responses", streaming: true, maxBytes: 100_000, signal: new AbortController().signal,
      settle: async (receipt) => { receipts.push(receipt) },
    })
    await assert.rejects(new Response(stream).text())
    assert.deepEqual(receipts, [null])
  }
  const receipts: Array<FreeUsageReceipt | null> = []
  const missingUsage = meterFreeResponse(Response.json({ ...nativeResponse(), usage: null }).body!, {
    config, protocol: "responses", streaming: false, maxBytes: 100_000, signal: new AbortController().signal, settle: async (receipt) => { receipts.push(receipt) },
  })
  assert.equal((await new Response(missingUsage).json()).status, "completed")
  assert.deepEqual(receipts, [null])
  const cancelled: Array<FreeUsageReceipt | null> = []
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(created)}\n\n`)) } })
  const reader = meterFreeResponse(source, { config, protocol: "responses", streaming: true, maxBytes: 100_000,
    signal: new AbortController().signal, settle: async (receipt) => { cancelled.push(receipt) } }).getReader()
  await reader.read()
  await reader.cancel()
  assert.deepEqual(cancelled, [null])
})
