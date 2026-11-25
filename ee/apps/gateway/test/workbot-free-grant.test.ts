import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { MEMBER_FREE_CHAT_PATH, WORKBOT_FREE_GRANT_HEADER, WORKBOT_FREE_GRANT_TTL_MS } from "@openwork/free-auto"
import { signWorkbotFreeGrant, verifyWorkbotFreeGrant } from "@openwork/free-auto/node"
import { INFERENCE_FREE_MODEL_ID } from "@openwork/types/den/inference"
import type { FreeAllowanceStore } from "../src/free/shared/allowance.js"

process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { readAutoConfig } = await import("../src/free/shared/config.js")
const { createFreeMemberHandler } = await import("../src/free/member/handler.js")

const secret = "fixture-workbot-grant-secret-0000000000"

test("a grant verifies only for its own key, organization and member, and only until it expires", () => {
  const claims = { keyId: "ink_a", organizationId: "org_a", memberId: "om_a" }
  const now = 1_800_000_000_000
  const grant = signWorkbotFreeGrant(secret, { ...claims, expiresAt: now + 60_000 })
  assert.equal(verifyWorkbotFreeGrant(secret, grant, claims, now), true)
  assert.equal(verifyWorkbotFreeGrant("another-workbot-grant-secret-00000000000", grant, claims, now), false)
  assert.equal(verifyWorkbotFreeGrant(secret, grant, { ...claims, keyId: "ink_b" }, now), false)
  assert.equal(verifyWorkbotFreeGrant(secret, grant, { ...claims, organizationId: "org_b" }, now), false)
  assert.equal(verifyWorkbotFreeGrant(secret, grant, claims, now + 60_000), false)
  assert.equal(verifyWorkbotFreeGrant(secret, `${grant.split(".")[0]}.forged`, claims, now), false)
  const tooLong = signWorkbotFreeGrant(secret, { ...claims, expiresAt: now + WORKBOT_FREE_GRANT_TTL_MS + 1 })
  assert.equal(verifyWorkbotFreeGrant(secret, tooLong, claims, now), false)
  assert.equal(verifyWorkbotFreeGrant(secret, null, claims, now), false)
})

test("with desktop proof required, a Den-signed Workbot grant replaces desktop proof for that member's key only", async () => {
  const config = readAutoConfig({ INFERENCE_FREE_ENABLED: "true", INFERENCE_FREE_OPENAI_API_KEY: "fixture",
    ANONYMOUS_ACCOUNTING_IDENTITY_KEY: "fixture-accounting-identity-key-000000", WORKBOT_FREE_GRANT_SECRET: secret })
  const admitted: string[] = []
  const store: FreeAllowanceStore = { family: "member", safetyPaused: async () => false, consumeNonce: async () => "accepted",
    consumeSession: async () => {}, read: async () => ({ state: "ready", allowance: null, code: null }),
    admit: async (_principal, _request, _choices, desktopHash) => {
      admitted.push(desktopHash ?? "no desktop")
      return { ok: true, windows: [] }
    }, charge: async () => true }
  const fetch = async () => Response.json({ id: "fixture", model: config.upstreamModel, choices: [{ index: 0, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 } })
  const principal = { kind: "member" as const, id: createDenTypeId("user"), memberId: createDenTypeId("member"),
    organizationId: createDenTypeId("organization"), inferenceKeyId: createDenTypeId("inferenceKey") }
  const key = { id: principal.inferenceKeyId, organization_id: principal.organizationId, org_membership_id: principal.memberId,
    name: null, key_hash: "fixture", key_prefix: null, encrypted_key: null, status: "active" as const, revoked_at: null, created_at: new Date(), updated_at: new Date() }
  const handler = createFreeMemberHandler({ config, store, fetch, clientAddress: () => "203.0.113.9", requireDesktop: () => true,
    findMember: async () => principal, defaultPinned: async () => false })
  const app = new Hono()
  app.post(MEMBER_FREE_CHAT_PATH, c => handler(c, key))
  const body = JSON.stringify({ model: INFERENCE_FREE_MODEL_ID, messages: [{ role: "user", content: "hello" }] })
  const send = (grant?: string) => app.request(MEMBER_FREE_CHAT_PATH, { method: "POST", body,
    headers: { "content-type": "application/json", authorization: "Bearer fixture", ...(grant ? { [WORKBOT_FREE_GRANT_HEADER]: grant } : {}) } })
  const claims = { keyId: key.id, organizationId: key.organization_id, memberId: key.org_membership_id, expiresAt: Date.now() + 60_000 }

  assert.equal((await send()).status, 426)
  assert.equal((await send(signWorkbotFreeGrant("another-workbot-grant-secret-00000000000", claims))).status, 426)
  assert.equal((await send(signWorkbotFreeGrant(secret, { ...claims, keyId: createDenTypeId("inferenceKey") }))).status, 426)
  assert.equal((await send(signWorkbotFreeGrant(secret, { ...claims, expiresAt: Date.now() - 1 }))).status, 426)
  assert.deepEqual(admitted, [])

  const allowed = await send(signWorkbotFreeGrant(secret, claims))
  assert.equal(allowed.status, 200)
  await allowed.text()
  assert.deepEqual(admitted, ["no desktop"])
})
