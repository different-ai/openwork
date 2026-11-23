import { fixtureDesktopSigner } from "./fixtures/desktop-signer.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { DESKTOP_FREE_CHAT_PATH, MEMBER_FREE_CHAT_PATH } from "@openwork/free-auto"
import { deriveReleaseSecret } from "@openwork/free-auto/node"
import { INFERENCE_FREE_MODEL_ID } from "@openwork/types/den/inference"
import { DesktopFreeSession } from "../../../../apps/server/src/free-auto/desktop-session.js"
import type { FreeAllowanceStore } from "../src/free/shared/allowance.js"

process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { readAutoConfig } = await import("../src/free/shared/config.js")
const { createFreeMemberHandler } = await import("../src/free/member/handler.js")
const { registerAnonymousInferenceRoutes } = await import("../src/free/guest/routes.js")

test("desktop grant covers guest and member calls, rejects replay and follows the member credential", async t => {
  const config = readAutoConfig({ INFERENCE_FREE_ENABLED: "true", ANONYMOUS_INFERENCE_ENABLED: "true",
    INFERENCE_FREE_OPENAI_API_KEY: "fixture", ANONYMOUS_ACCOUNTING_IDENTITY_KEY: "fixture-accounting-identity-key-000000",
    ANONYMOUS_TOKEN_SECRET: "fixture-token-secret-00000000000000000", DESKTOP_FREE_RELEASE_KEY: "fixture-release-key-000000000000000000" })
  const signer = await fixtureDesktopSigner(t, version => deriveReleaseSecret(config.releaseKey, version))
  const seen = new Set<string>()
  const admittedDesktops: Array<string | undefined> = []
  const store: FreeAllowanceStore = { family: "member", safetyPaused: async () => false, consumeNonce: async proof => {
    if (seen.has(proof.nonce)) return "replay"
    seen.add(proof.nonce)
    return "accepted"
  }, consumeSession: async () => {}, read: async () => ({ state: "ready", allowance: null, code: null }),
    admit: async (principal, _request, _choices, desktopHash) => {
      if (principal.kind === "member") admittedDesktops.push(desktopHash)
      return { ok: true, windows: [] }
    }, charge: async () => true }
  let calls = 0
  const fetch = async () => {
    calls++
    return Response.json({ id: "fixture", model: config.upstreamModel, choices: [{ index: 0, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 } })
  }
  const app = new Hono()
  const common = { config, store, fetch, clientAddress: () => "203.0.113.40", requireDesktop: async () => true }
  registerAnonymousInferenceRoutes(app, common)
  const principal = { kind: "member" as const, id: createDenTypeId("user"), memberId: createDenTypeId("member"),
    organizationId: createDenTypeId("organization"), inferenceKeyId: createDenTypeId("inferenceKey") }
  const key = { id: principal.inferenceKeyId, organization_id: principal.organizationId, org_membership_id: principal.memberId,
    name: null, key_hash: "fixture", key_prefix: null, encrypted_key: null, status: "active" as const, revoked_at: null, created_at: new Date(), updated_at: new Date() }
  const memberHandler = createFreeMemberHandler({ ...common, findMember: async () => principal, defaultPinned: async () => false })
  app.post(MEMBER_FREE_CHAT_PATH, c => memberHandler(c, key))
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => app.request(url, init))
  const session = new DesktopFreeSession(signer, "https://gateway.test")
  const body = new TextEncoder().encode(JSON.stringify({ model: INFERENCE_FREE_MODEL_ID, messages: [{ role: "user", content: "hello" }] }))
  const send = (path: string, headers: Record<string,string>) => app.request(path, { method: "POST", body, headers: { "content-type": "application/json", ...headers } })
  for (const [path, member] of [[DESKTOP_FREE_CHAT_PATH, null], [MEMBER_FREE_CHAT_PATH, "Bearer fixture-a"], [MEMBER_FREE_CHAT_PATH, "Bearer fixture-c"]] as const) {
    assert.equal((await send(path, member ? { authorization: member } : {})).status, 403)
    const headers = await session.headers(member, path, "POST", body, new AbortController().signal)
    const response = await send(path, headers)
    assert.equal(response.status, 200)
    await response.text()
    assert.equal((await send(path, headers)).status, 401)
    if (member) assert.equal((await send(path, { ...headers, authorization: "Bearer fixture-b" })).status, 403)
  }
  const { createAnonymousIdentities } = await import("../src/free/guest/identity.js")
  const { installationHash } = createAnonymousIdentities({ machineId: "a".repeat(64) }, "203.0.113.40", config)
  assert.deepEqual(admittedDesktops, [installationHash, installationHash])
  assert.equal(calls, 3)
})
