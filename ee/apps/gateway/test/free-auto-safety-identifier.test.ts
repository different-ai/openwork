// Every free Auto request names its end user to OpenAI with `safety_identifier`, taken from the
// authenticated principal and never from the caller, so OpenAI can act on one person instead of
// the whole free key, and the value leads back to that person's usage rows.
import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_RESPONSES_PATH, MEMBER_FREE_CHAT_PATH, MEMBER_FREE_RESPONSES_PATH } from "@openwork/free-auto"
import { INFERENCE_FREE_MODEL_ID } from "@openwork/types/den/inference"
import type { FreeAllowanceStore } from "../src/free/shared/allowance.js"
import type { FreePrincipal, MemberPrincipal } from "../src/free/shared/principal.js"
import type { InferenceKeyRow } from "../src/middleware/inference-auth.js"

// env.ts validates at import; nothing here touches a database.
process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { readAutoConfig } = await import("../src/free/shared/config.js")
const { freeIdentityHash, freePrincipalHash } = await import("../src/free/shared/principal.js")
const { anonymousIpHash } = await import("../src/free/guest/identity.js")
const { registerAnonymousInferenceRoutes } = await import("../src/free/guest/routes.js")
const { createFreeMemberHandler } = await import("../src/free/member/handler.js")

const config = readAutoConfig({
  INFERENCE_FREE_ENABLED: "true",
  ANONYMOUS_INFERENCE_ENABLED: "true",
  INFERENCE_FREE_OPENAI_API_KEY: "sk-fixture",
  ANONYMOUS_ACCOUNTING_IDENTITY_KEY: "fixture-accounting-identity-key-000000",
  ANONYMOUS_TOKEN_SECRET: "fixture-token-secret-00000000000000000",
  DESKTOP_FREE_RELEASE_KEY: "fixture-release-key-000000000000000000",
})
const snapshot = `${config.upstreamModel}-2026-09-22`
const HASH = /^[a-f0-9]{64}$/

/** OpenAI, recording each request body it was sent. */
function openAi() {
  const bodies: Array<Record<string, unknown>> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body: unknown = JSON.parse(String(init?.body))
    assert.ok(typeof body === "object" && body !== null && !Array.isArray(body))
    bodies.push({ ...body })
    const responses = String(input).endsWith("/responses")
    return Response.json(responses
      ? { id: "resp_1", object: "response", model: snapshot, status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 2 } }
      : { id: "chatcmpl_1", object: "chat.completion", model: snapshot, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
  }
  return { bodies, fetch }
}

/** An allowance with room, recording who each request was charged to. */
function allowance(family: FreeAllowanceStore["family"]) {
  const charged: FreePrincipal[] = []
  const store: FreeAllowanceStore = {
    family,
    consumeNonce: async () => "accepted",
    consumeSession: async () => {},
    read: async () => ({ state: "ready", code: null, allowance: null }),
    admit: async () => ({ ok: true, windows: [] }),
    charge: async (input) => { charged.push(input.principal); return true },
  }
  return { charged, store }
}

function post(path: string, body: Record<string, unknown>) {
  return new Request(`http://gateway.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
}
const chat = { model: INFERENCE_FREE_MODEL_ID, messages: [{ role: "user", content: "hello" }] }
const responses = { model: INFERENCE_FREE_MODEL_ID, input: "hello" }

function guestApp(address: string) {
  const upstream = openAi()
  const { charged, store } = allowance("anonymous")
  const app = new Hono()
  registerAnonymousInferenceRoutes(app, { config, store, fetch: upstream.fetch, clientAddress: () => address })
  return { app, upstream, charged }
}

function memberApp(principal: MemberPrincipal) {
  const upstream = openAi()
  const { charged, store } = allowance("member")
  const key: InferenceKeyRow = { id: principal.inferenceKeyId, organization_id: principal.organizationId, org_membership_id: principal.memberId,
    name: null, key_hash: "fixture", key_prefix: null, encrypted_key: null, status: "active", revoked_at: null,
    created_at: new Date(0), updated_at: new Date(0) }
  const handler = createFreeMemberHandler({ config, store, fetch: upstream.fetch, findMember: async () => principal, defaultPinned: async () => false })
  const app = new Hono()
  app.all("*", (c) => handler(c, key))
  return { app, upstream, charged }
}
function member(userId: string): MemberPrincipal {
  return { kind: "member", id: userId, inferenceKeyId: createDenTypeId("inferenceKey"), memberId: createDenTypeId("member"), organizationId: createDenTypeId("organization") }
}

for (const [protocol, path, body] of [["Chat Completions", DESKTOP_FREE_CHAT_PATH, chat], ["Responses", DESKTOP_FREE_RESPONSES_PATH, responses]] as const) {
  test(`a signed-out ${protocol} request names its sender to OpenAI`, async () => {
    const { app, upstream, charged } = guestApp("203.0.113.7")
    const response = await app.request(post(path, body))
    assert.equal(response.status, 200)
    await response.text()

    const sent = upstream.bodies[0]
    assert.ok(sent)
    const expected = freePrincipalHash({ kind: "installation", id: freeIdentityHash("open-ip", anonymousIpHash("203.0.113.7", config)), deviceless: true })
    assert.equal(sent.safety_identifier, expected)
    assert.match(expected, HASH)
    // Nothing about the address itself leaves the Gateway.
    assert.equal(JSON.stringify(sent).includes("203.0.113.7"), false)
    // The identifier is the principal_hash on the usage row, so a flagged value leads to its requests.
    assert.equal(charged.length, 1)
    assert.equal(freePrincipalHash(charged[0]!), sent.safety_identifier)
  })
}

test("two signed-out senders get different identifiers and one sender keeps the same one", async () => {
  const first = guestApp("203.0.113.7")
  const second = guestApp("198.51.100.9")
  await (await first.app.request(post(DESKTOP_FREE_CHAT_PATH, chat))).text()
  await (await first.app.request(post(DESKTOP_FREE_CHAT_PATH, chat))).text()
  await (await second.app.request(post(DESKTOP_FREE_CHAT_PATH, chat))).text()
  assert.equal(first.upstream.bodies[0]?.safety_identifier, first.upstream.bodies[1]?.safety_identifier)
  assert.notEqual(first.upstream.bodies[0]?.safety_identifier, second.upstream.bodies[0]?.safety_identifier)
})

for (const [protocol, path, body] of [["Chat Completions", MEMBER_FREE_CHAT_PATH, chat], ["Responses", MEMBER_FREE_RESPONSES_PATH, responses]] as const) {
  test(`a signed-in ${protocol} request names the person, not the organization or the key`, async () => {
    const person = member("user_fixture_one")
    const { app, upstream, charged } = memberApp(person)
    const response = await app.request(post(path, body))
    assert.equal(response.status, 200)
    await response.text()

    const sent = upstream.bodies[0]
    assert.ok(sent)
    assert.equal(sent.safety_identifier, freePrincipalHash(person))
    assert.match(String(sent.safety_identifier), HASH)
    for (const internal of [person.id, person.memberId, person.organizationId, person.inferenceKeyId]) {
      assert.equal(JSON.stringify(sent).includes(internal), false)
    }
    assert.equal(freePrincipalHash(charged[0]!), sent.safety_identifier)

    // The same person in another organization is still one end user to OpenAI.
    const elsewhere = memberApp(member("user_fixture_one"))
    await (await elsewhere.app.request(post(path, body))).text()
    assert.equal(elsewhere.upstream.bodies[0]?.safety_identifier, sent.safety_identifier)
    const someoneElse = memberApp(member("user_fixture_two"))
    await (await someoneElse.app.request(post(path, body))).text()
    assert.notEqual(someoneElse.upstream.bodies[0]?.safety_identifier, sent.safety_identifier)
  })
}

for (const [protocol, path, body] of [["Chat Completions", DESKTOP_FREE_CHAT_PATH, chat], ["Responses", DESKTOP_FREE_RESPONSES_PATH, responses]] as const) {
  test(`a ${protocol} caller cannot choose the identity OpenAI sees`, async () => {
    const honest = guestApp("203.0.113.7")
    await (await honest.app.request(post(path, body))).text()
    const spoofing = guestApp("203.0.113.7")
    const response = await spoofing.app.request(post(path, { ...body, safety_identifier: "someone-else", user: "someone-else" }))
    assert.equal(response.status, 200)
    await response.text()

    const sent = spoofing.upstream.bodies[0]
    assert.ok(sent)
    assert.equal(sent.safety_identifier, honest.upstream.bodies[0]?.safety_identifier)
    assert.equal("user" in sent, false)
    assert.equal(JSON.stringify(sent).includes("someone-else"), false)
  })
}
