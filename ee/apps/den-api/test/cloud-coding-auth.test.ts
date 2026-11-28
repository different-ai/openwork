import assert from "node:assert/strict"
import { createHmac, generateKeyPairSync, verify } from "node:crypto"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createCloudCodingAppJwt, verifyCloudCodingGithubSignature } from "../src/cloud-coding/github-api.js"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/cloud_coding_unit"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-cloud-coding-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-cloud-coding-unit-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"

const { createCloudCodingState, verifyCloudCodingState } = await import("../src/cloud-coding/state.js")

test("state is signed, expires after ten minutes, and rejects tampering", () => {
  const input = { kind: "link", organizationId: createDenTypeId("organization"), memberId: createDenTypeId("member"), userId: createDenTypeId("user") } as const
  const now = Date.now()
  const token = createCloudCodingState(input, now)
  const value = verifyCloudCodingState(token, now + 599_999)
  assert.ok(value)
  assert.deepEqual(value, { ...input, nonce: value.nonce, exp: now + 600_000 })
  assert.notEqual(createCloudCodingState(input, now), token)
  assert.equal(verifyCloudCodingState(token, now + 600_000), null)
  assert.equal(verifyCloudCodingState(`${token.startsWith("a") ? "b" : "a"}${token.slice(1)}`, now), null)
  assert.equal(verifyCloudCodingState(`${token}.extra`, now), null)
})

test("app JWT uses RS256 and the configured issuer", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const now = 1_800_000_000_000
  const token = createCloudCodingAppJwt({ appId: "42", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), slug: "acme-cloud-coding", clientId: "acme", clientSecret: "test-only", webhookSecret: null, apiBaseUrl: "https://unit.test", webBaseUrl: "https://unit.test" }, now)
  const [header, claims, signature] = token.split(".")
  assert.ok(header && claims && signature)
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" })
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), { iat: now / 1000 - 60, exp: now / 1000 + 540, iss: "42" })
  assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")))
})

test("webhook signature authenticates the exact raw body", () => {
  const raw = '{"action":"deleted"}'
  const secret = "acme-fake-webhook-secret"
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
  assert.equal(verifyCloudCodingGithubSignature(raw, signature, secret), true)
  assert.equal(verifyCloudCodingGithubSignature(`${raw}\n`, signature, secret), false)
  assert.equal(verifyCloudCodingGithubSignature(raw, signature, "wrong"), false)
  assert.equal(verifyCloudCodingGithubSignature(raw, signature.slice(1), secret), false)
})
