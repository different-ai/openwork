import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { test } from "node:test"
import { Hono } from "hono"
import {
  DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_MODELS_PATH,
  DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH, desktopFreeProofMessage,
  type DesktopFreeAccessStatus, type DesktopFreeProofClaims,
} from "@openwork/types/desktop-free-access"
import { managedModelCatalog } from "@openwork/types/den/inference"
import { desktopFreeHash, verifyDesktopFreeProof } from "../src/desktop-free-proof.js"
import { createDesktopFreeVersionSource, desktopFreeVersionError, DESKTOP_FREE_RELEASE_URL } from "../src/desktop-free-version.js"

// Ephemeral fixtures only. No database, metadata host, provider, or billing IO.
process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890"
delete process.env.ANONYMOUS_INFERENCE_ENABLED
process.env.ANONYMOUS_TOKEN_SECRET = "test-only-guest-token-secret-000000000000000000"
process.env.ANONYMOUS_ACCOUNTING_IDENTITY_KEY = "test-only-accounting-identity-11111111111111111"
process.env.ANONYMOUS_OPENROUTER_API_KEY = "test-only-provider-key"
process.env.ANONYMOUS_OPENROUTER_PROVIDER = "test-provider"
process.env.ANONYMOUS_OPENROUTER_BYOK_ONLY_VERIFIED = "true"
const { env } = await import("../src/env.js")
const { registerAnonymousInferenceRoutes } = await import("../src/anonymous.js")
const { issueAnonymousToken, createAnonymousIdentities, verifyAnonymousToken } = await import("../src/anonymous-identity.js")
const { checkDesktopFreeRequest, requireMemberFreeDesktop } = await import("../src/desktop-free-access.js")

const keys = generateKeyPairSync("ed25519")
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64")
const address = "127.0.0.1"
const installationId = randomUUID()
const body = JSON.stringify({ model: DESKTOP_FREE_MODEL_ID, messages: [{ role: "user", content: "hello" }] })

function signed(path: string, options: { body?: string; authorization?: string; version?: string; nonce?: string; timestamp?: number; guest?: string } = {}) {
  const method = options.body === undefined ? "GET" : "POST"
  const proof: DesktopFreeProofClaims = {
    version: 1, publicKey, appVersion: options.version ?? "1.2.3", platform: "darwin", arch: "arm64",
    timestamp: options.timestamp ?? Date.now(), nonce: options.nonce ?? randomUUID(),
  }
  const message = desktopFreeProofMessage({ ...proof, method, path, bodyHash: desktopFreeHash(options.body ?? ""), authorizationHash: desktopFreeHash(options.authorization ?? "") })
  const header = Buffer.from(JSON.stringify({ ...proof, signature: sign(null, Buffer.from(message), keys.privateKey).toString("base64url") })).toString("base64url")
  return new Request(`https://inference.test${path}`, {
    method, body: options.body,
    headers: {
      "x-openwork-desktop-proof": header,
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.guest ? { "x-openwork-desktop-token": options.guest } : {}),
    },
  })
}

function guest(version = "1.2.3") {
  const keyThumbprint = desktopFreeHash(Buffer.from(publicKey, "base64"))
  return issueAnonymousToken(createAnonymousIdentities({ keyThumbprint }, address), {
    keyThumbprint, appVersion: version, platform: "darwin", arch: "arm64",
  }).token
}

function gateSource(floor: () => string | null = () => "1.2.3") {
  const nonces = new Set<string>()
  return {
    latestVersion: async () => floor(),
    consumeNonce: async (proof: { keyThumbprint: string; nonce: string }) => {
      const key = `${proof.keyThumbprint}:${proof.nonce.toLowerCase()}`
      if (nonces.has(key)) return "replay" as const
      nonces.add(key)
      return "accepted" as const
    },
    clientAddress: () => address,
  }
}

test("canonical contract uses raw bytes and actual authorization, without Node code in the shared helper", () => {
  const input: DesktopFreeProofClaims = { version: 1, publicKey: "key", appVersion: "1.2.3", platform: "darwin", arch: "arm64", timestamp: 123, nonce: "nonce" }
  assert.equal(desktopFreeProofMessage({ ...input, method: "post", path: "/a?b=1", bodyHash: "raw", authorizationHash: "auth" }), '[1,"POST","/a?b=1","raw","auth","key","1.2.3","darwin","arm64",123,"nonce"]')
})

test("strict Ed25519 proof rejects stolen bearer, body/auth/path tamper, bad fields, and skew", () => {
  const request = signed(DESKTOP_FREE_CHAT_PATH, { body, authorization: "Bearer member-key" })
  const input = { header: request.headers.get("x-openwork-desktop-proof"), method: "POST", path: DESKTOP_FREE_CHAT_PATH, bodyHash: desktopFreeHash(body), authorization: "Bearer member-key" }
  const valid = verifyDesktopFreeProof(input)
  assert.ok(valid)
  assert.equal(verifyDesktopFreeProof({ ...input, header: null }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, bodyHash: desktopFreeHash(body + " ") }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, authorization: "Bearer stolen-key" }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, path: DESKTOP_FREE_SESSION_PATH }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, now: valid.timestamp + 60_001 }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, now: valid.timestamp - 60_001 }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, header: "A".repeat(2049) }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, binding: { ...valid, keyThumbprint: "0".repeat(64) } }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, binding: { ...valid, appVersion: "1.2.4" } }), null)
  assert.equal(verifyDesktopFreeProof({ ...input, binding: { ...valid, arch: "x64" } }), null)
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const proof = { version: valid.version, publicKey, appVersion: valid.appVersion, platform: valid.platform, arch: valid.arch, timestamp: valid.timestamp, nonce: valid.nonce, signature: "A".repeat(86) }
  for (const changed of [proof, { ...proof, extra: true }, { ...proof, version: 2 }, { ...proof, platform: "browser" }, { ...proof, nonce: "invalid" }, { ...proof, timestamp: 1.1 }]) {
    assert.equal(verifyDesktopFreeProof({ ...input, header: encoded(changed) }), null)
  }
  const other = generateKeyPairSync("ed25519")
  const stolen = { ...proof, signature: sign(null, Buffer.from(desktopFreeProofMessage({ ...valid, method: "POST", path: DESKTOP_FREE_CHAT_PATH, bodyHash: input.bodyHash, authorizationHash: desktopFreeHash(input.authorization) })), other.privateKey).toString("base64url") }
  assert.equal(verifyDesktopFreeProof({ ...input, header: encoded(stolen) }), null)
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  assert.equal(verifyDesktopFreeProof({ ...input, header: encoded({ ...proof, publicKey: ec.publicKey.export({ format: "der", type: "spki" }).toString("base64") }) }), null)
})

test("strict latest-stable floor accepts newer cores, rejects prerelease of the floor and unknown metadata", () => {
  for (const current of ["1.2.3", "1.2.3+build", "1.2.4-alpha", "1.3.0-alpha", "2.0.0", "10.0.0"]) assert.equal(desktopFreeVersionError(current, "1.2.3"), null)
  for (const current of ["1.2.2", "1.2.3-alpha", "1.2.3-alpha.1", "0.0.0", "0.0.0-dev", "", "dev", "v1.2.3", "1.02.3", "1.2.4-01", "1.2.3\n"]) {
    assert.equal(desktopFreeVersionError(current, "1.2.3")?.code, "desktop_update_required")
  }
  for (const floor of [null, "0.0.0", "1.2.3-alpha", "garbage", "1.02.3"]) {
    assert.equal(desktopFreeVersionError("1.2.3", floor)?.code, "desktop_version_unavailable")
  }
})

type ReleasePayload = { tag_name: string; draft: boolean; prerelease: boolean; published_at: string | null }
const publishedRelease: ReleasePayload = { tag_name: "v1.2.3", draft: false, prerelease: false, published_at: "2026-09-08T00:00:00Z" }

test("official published latest release is cached for at most five minutes; failures close admission", async () => {
  let now = 0
  let calls = 0
  let failing = false
  const source = createDesktopFreeVersionSource({ url: DESKTOP_FREE_RELEASE_URL, now: () => now, fetch: async (url, init) => {
    calls++
    assert.equal(String(url), "https://api.github.com/repos/different-ai/openwork/releases/latest")
    assert.equal(init?.redirect, "error")
    assert.equal(new Headers(init?.headers).get("user-agent"), "OpenWork-Desktop-Free-Access")
    assert.equal(new Headers(init?.headers).get("authorization"), null)
    assert.ok(init?.signal)
    if (failing) throw new Error("offline")
    return Response.json(publishedRelease)
  } })
  assert.deepEqual(await Promise.all([source(), source()]), ["1.2.3", "1.2.3"])
  assert.equal(calls, 1)
  failing = true
  now = 299_999
  assert.equal(await source(), "1.2.3")
  now = 300_000
  assert.equal(await source(), null)
  now += 300_000
  assert.equal(await source(), null)
  for (const status of [302, 304, 403, 429, 500]) {
    const failed = createDesktopFreeVersionSource({ url: DESKTOP_FREE_RELEASE_URL, fetch: async () => new Response(null, { status }) })
    assert.equal(await failed(), null)
    assert.equal(desktopFreeVersionError("1.2.2", await failed())?.code, "desktop_version_unavailable")
  }
  assert.equal(await createDesktopFreeVersionSource({ url: DESKTOP_FREE_RELEASE_URL, fetch: async () => Response.json({ ...publishedRelease, assets: "a".repeat(262_144) }) })(), null)
  assert.equal(await createDesktopFreeVersionSource({ url: "http://metadata.test", fetch: async () => { throw new Error("must not fetch HTTP") } })(), null)
})

test("release parser requires a stable tag and explicit published non-draft non-prerelease fields", async () => {
  for (const tag_name of ["v1.2.3", "1.2.3", "v1.2.3+build.1"]) {
    assert.equal(await createDesktopFreeVersionSource({ url: DESKTOP_FREE_RELEASE_URL, fetch: async () => Response.json({ ...publishedRelease, tag_name }) })(), tag_name.replace(/^v/, ""))
  }
  const invalid: unknown[] = [
    { ...publishedRelease, tag_name: "v1.2.4-alpha" },
    { ...publishedRelease, tag_name: "v0.0.0" },
    { ...publishedRelease, tag_name: "v1.02.3" },
    { ...publishedRelease, tag_name: "v1.2.3\n" },
    { ...publishedRelease, tag_name: "vv1.2.3" },
    { ...publishedRelease, tag_name: undefined },
    { ...publishedRelease, draft: true },
    { ...publishedRelease, draft: undefined },
    { ...publishedRelease, draft: "false" },
    { ...publishedRelease, prerelease: true },
    { ...publishedRelease, prerelease: undefined },
    { ...publishedRelease, published_at: null },
    { ...publishedRelease, published_at: "invalid" },
    { ...publishedRelease, published_at: undefined },
    { latestAppVersion: "1.2.3", minAppVersion: "0.1.0" },
    { tag_name: "v1.2.4-alpha", latestAppVersion: "1.2.3" },
  ]
  for (const value of invalid) {
    assert.equal(await createDesktopFreeVersionSource({ url: DESKTOP_FREE_RELEASE_URL, fetch: async () => Response.json(value) })(), null)
  }
})

test("explicit custom Den URL is operator policy authority, never an automatic release-source fallback", async () => {
  const url = "https://metadata.test/v1/app-version"
  assert.equal(await createDesktopFreeVersionSource({ url, fetch: async () => Response.json({ latestAppVersion: "1.2.3", minAppVersion: "0.1.0" }) })(), "1.2.3")
  assert.equal(await createDesktopFreeVersionSource({ url, fetch: async () => Response.json(publishedRelease) })(), "1.2.3")
  for (const value of [
    { minAppVersion: "1.2.3" }, { latestAppVersion: "0.0.0" }, { latestAppVersion: "1.2.4-alpha" },
    { ...publishedRelease, draft: true, latestAppVersion: "1.2.3" },
  ]) assert.equal(await createDesktopFreeVersionSource({ url, fetch: async () => Response.json(value) })(), null)
})

test("bound guest rejects old token format and cannot replay a signed request", async () => {
  const token = guest()
  assert.ok(token.startsWith("ow_guest_v2."))
  const claims = verifyAnonymousToken(token, address)
  assert.ok(claims)
  assert.equal(verifyAnonymousToken(token.replace("ow_guest_v2.", "ow_guest_v1."), address), null)
  assert.equal(verifyAnonymousToken(token, "127.0.0.2"), null)
  const inconsistent = issueAnonymousToken({ ...claims, installationHash: "0".repeat(64) }, claims).token
  assert.equal(verifyAnonymousToken(inconsistent, address), null)
  const request = signed(DESKTOP_FREE_MODELS_PATH, { authorization: `Bearer ${token}` })
  const source = gateSource()
  assert.ok("proof" in await checkDesktopFreeRequest(request, desktopFreeHash(""), claims, source))
  const replay = await checkDesktopFreeRequest(request, desktopFreeHash(""), claims, source)
  assert.ok("error" in replay && replay.error)
  assert.equal(replay.error.status, 401)
  assert.equal((await replay.error.json()).error.code, "desktop_proof_replayed")
})

test("same verified key with different installation UUIDs consumes the same accounting identity", async () => {
  const app = new Hono()
  const identities: Array<ReturnType<typeof createAnonymousIdentities>> = []
  const unused = async () => { throw new Error("Registration must not reserve, spend, or read usage") }
  registerAnonymousInferenceRoutes(app, {
    clientAddress: () => address, gate: gateSource(),
    consumeSessionIssuance: async (identity) => { identities.push(identity); return { ok: true } },
    reserve: unused, settle: unused, validateDispatch: unused, readAllowance: unused, fetch: unused,
  })
  env.anonymous.enabled = true
  try {
    const firstUuid = randomUUID()
    const secondUuid = randomUUID()
    assert.notEqual(firstUuid, secondUuid)
    for (const installationId of [firstUuid, secondUuid]) {
      const response = await app.fetch(signed(DESKTOP_FREE_SESSION_PATH, { body: JSON.stringify({ installationId }) }))
      assert.equal(response.status, 200)
      const claims = verifyAnonymousToken((await response.json()).token, address)
      assert.ok(claims)
      assert.equal(claims.installationHash, identities[0].installationHash)
    }
    assert.equal(identities.length, 2)
    assert.deepEqual(identities[0], identities[1])
    const otherKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" })
    assert.notEqual(createAnonymousIdentities({ keyThumbprint: desktopFreeHash(otherKey) }, address).installationHash, identities[0].installationHash)
  } finally { env.anonymous.enabled = false }
})

test("anonymous session/status/models/generation gate before issuance or reserve; no paid fallback", async () => {
  assert.equal(env.anonymous.enabled, false)
  assert.equal(env.anonymous.installWeeklyMicroUsd, 1_000_000)
  assert.ok(env.anonymous.ipDailyMicroUsd >= 1_000_000)
  env.anonymous.enabled = true
  let floor: string | null = "1.2.3"
  let exhausted = false
  let issuances = 0
  let reservations = 0
  let upstreams = 0
  let settlements = 0
  let statusReads = 0
  const app = new Hono()
  registerAnonymousInferenceRoutes(app, {
    clientAddress: () => address, gate: gateSource(() => floor),
    consumeSessionIssuance: async () => { issuances++; return { ok: true } },
    reserve: async ({ id, deadlineAt }) => {
      reservations++
      return exhausted ? { ok: false, reason: "limit" } : { ok: true, reservationId: id, dispatchDeadline: deadlineAt }
    },
    settle: async (_id, usage) => { settlements++; assert.equal(usage?.costMicroUsd, 1050); return "settled" },
    validateDispatch: async () => true,
    readAllowance: async () => {
      statusReads++
      return { state: exhausted ? "exhausted" : "ready", code: exhausted ? "anonymous_reservation_does_not_fit" : null,
        allowance: { limitUsd: 1, usedUsd: exhausted ? 1 : 0, reservedUsd: 0, remainingUsd: exhausted ? 0 : 1, resetsAt: "2026-09-14T00:00:00.000Z" } }
    },
    fetch: async (_url, init) => {
      upstreams++
      assert.equal(init?.redirect, "error")
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-provider-key")
      assert.equal(new Headers(init?.headers).get("x-openwork-desktop-proof"), null)
      assert.equal(typeof init?.body, "string")
      const forwarded = JSON.parse(String(init?.body))
      assert.equal(forwarded.provider.allow_fallbacks, false)
      assert.equal(forwarded.reasoning.effort, "none")
      return Response.json({ choices: [], usage: { cost: 0.00005, is_byok: true, cost_details: { upstream_inference_cost: 0.001 }, prompt_tokens: 10, completion_tokens: 2 } })
    },
  })
  try {
    const oldSession = await app.fetch(signed(DESKTOP_FREE_SESSION_PATH, { body: JSON.stringify({ installationId }), version: "1.2.2" }))
    assert.equal(oldSession.status, 426)
    assert.deepEqual(Object.keys((await oldSession.json()).error).sort(), ["code", "currentVersion", "message", "minimumVersion"])
    assert.equal(issuances, 0)
    const registration = signed(DESKTOP_FREE_SESSION_PATH, { body: JSON.stringify({ installationId }) })
    const session = await app.fetch(registration.clone())
    assert.equal(session.status, 200)
    const token = (await session.json()).token
    assert.ok(token.startsWith("ow_guest_v2."))
    assert.equal((await app.fetch(registration)).status, 401)
    assert.equal(issuances, 1)
    const authorization = `Bearer ${token}`
    for (const path of [DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH]) {
      assert.equal((await app.fetch(new Request(`https://inference.test${path}`, { method: path === DESKTOP_FREE_CHAT_PATH ? "POST" : "GET", body: path === DESKTOP_FREE_CHAT_PATH ? body : undefined, headers: { authorization, "content-type": "application/json" } }))).status, 401)
    }
    const ready = await app.fetch(signed(DESKTOP_FREE_STATUS_PATH, { authorization }))
    const readyStatus: DesktopFreeAccessStatus = await ready.json()
    assert.equal(readyStatus.state, "ready")
    assert.deepEqual(readyStatus.catalog, managedModelCatalog({ freeModelID: DESKTOP_FREE_MODEL_ID }))
    assert.ok(readyStatus.catalog?.some((model) => model.modelID === "openai/gpt-6-astra"))
    assert.equal(ready.headers.get("cache-control"), "no-store")
    assert.equal(reservations, 0)
    assert.equal(upstreams, 0)
    const models = await app.fetch(signed(DESKTOP_FREE_MODELS_PATH, { authorization }))
    assert.equal(models.status, 200)
    assert.deepEqual((await models.json()).data, [{ id: DESKTOP_FREE_MODEL_ID, object: "model", created: 0, owned_by: "openwork" }])
    assert.equal((await app.fetch(signed(DESKTOP_FREE_CHAT_PATH, { authorization, body: JSON.stringify({ model: "openai/gpt-6-astra", messages: [{ role: "user", content: "hello" }] }) }))).status, 403)
    assert.equal(reservations, 0)
    assert.equal(upstreams, 0)
    floor = "1.2.4"
    const status = await app.fetch(signed(DESKTOP_FREE_STATUS_PATH, { authorization }))
    const state = await status.json()
    assert.equal(state.state, "update_required")
    assert.equal(state.minimumVersion, "1.2.4")
    assert.equal(state.allowance, null)
    for (const path of [DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH]) {
      assert.equal((await app.fetch(signed(path, { authorization, ...(path === DESKTOP_FREE_CHAT_PATH ? { body } : {}) }))).status, 426)
    }
    assert.equal(statusReads, 1)
    floor = null
    const unknown = await app.fetch(signed(DESKTOP_FREE_SESSION_PATH, { body: JSON.stringify({ installationId }) }))
    assert.equal(unknown.status, 503)
    assert.equal((await unknown.json()).error.code, "desktop_version_unavailable")
    assert.equal((await (await app.fetch(signed(DESKTOP_FREE_STATUS_PATH, { authorization }))).json()).state, "unavailable")
    assert.equal((await app.fetch(signed(DESKTOP_FREE_CHAT_PATH, { authorization, body }))).status, 503)
    assert.equal(issuances, 1)
    assert.equal(reservations, 0)
    assert.equal(upstreams, 0)
    floor = "1.2.3"
    exhausted = true
    const denied = await app.fetch(signed(DESKTOP_FREE_CHAT_PATH, { authorization, body }))
    assert.equal(denied.status, 429)
    assert.equal(upstreams, 0)
    assert.equal((await (await app.fetch(signed(DESKTOP_FREE_STATUS_PATH, { authorization }))).json()).state, "exhausted")
    exhausted = false
    assert.equal((await app.fetch(signed(DESKTOP_FREE_CHAT_PATH, { authorization, body: JSON.stringify({ model: "paid-model", messages: [] }) }))).status, 403)
    assert.equal(reservations, 1)
    const generated = await app.fetch(signed(DESKTOP_FREE_CHAT_PATH, { authorization, body }))
    assert.equal(generated.status, 200)
    assert.equal((await generated.json()).usage.cost, undefined)
    assert.equal(reservations, 2)
    assert.equal(upstreams, 1)
    assert.equal(settlements, 1)
  } finally { env.anonymous.enabled = false }
})

test("member-free proof binds actual member Bearer as well as guest key/version, without touching its ledger", async () => {
  let floor = "1.2.3"
  const source = gateSource(() => floor)
  const token = guest()
  const app = new Hono()
  let passed = 0
  app.post("/api/v1/chat/completions", async (c) => {
    const blocked = await requireMemberFreeDesktop(c, desktopFreeHash(await c.req.raw.text()), source)
    if (blocked) return blocked
    passed++
    return c.json({ ok: true })
  })
  const options = { body, authorization: "Bearer member-key", guest: token }
  assert.equal((await app.fetch(signed("/api/v1/chat/completions", options))).status, 200)
  const stolen = signed("/api/v1/chat/completions", options)
  stolen.headers.set("authorization", "Bearer different-member-key")
  assert.equal((await app.fetch(stolen)).status, 401)
  floor = "1.2.4"
  assert.equal((await app.fetch(signed("/api/v1/chat/completions", options))).status, 426)
  assert.equal(passed, 1)
})
