import assert from "node:assert/strict"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { test } from "node:test"
import { GCP_CLOUD_PLATFORM_SCOPE, buildServiceAccountJwt, createGcpServiceAccountTokenMinter } from "../src/credentials/gcp-service-account.js"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const serviceAccount = {
  client_email: "sa@acme-proj.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function decodeSegment(segment: string) {
  const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))
  assert.ok(isRecord(value))
  return value
}

test("service-account JWT: RS256 header, claims and signature verify with the public key", () => {
  const now = new Date("2026-09-03T12:00:00Z")
  const jwt = buildServiceAccountJwt(serviceAccount, now)
  const [header, claims, signature] = jwt.split(".")
  assert.ok(header && claims && signature)
  assert.deepEqual(decodeSegment(header), { alg: "RS256", typ: "JWT" })
  assert.deepEqual(decodeSegment(claims), {
    iss: serviceAccount.client_email,
    scope: GCP_CLOUD_PLATFORM_SCOPE,
    aud: serviceAccount.token_uri,
    iat: now.getTime() / 1000,
    exp: now.getTime() / 1000 + 3600,
  })
  const verifier = createVerify("RSA-SHA256").update(`${header}.${claims}`)
  assert.equal(verifier.verify(publicKey, signature, "base64url"), true)
})

test("token minter: posts the jwt-bearer grant, caches per credential, re-mints near expiry", async () => {
  const calls: Array<{ url: string; assertion: string | null }> = []
  let counter = 0
  const minter = createGcpServiceAccountTokenMinter({
    fetch: async (input, init) => {
      const body = init?.body
      assert.ok(body instanceof URLSearchParams)
      assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer")
      calls.push({ url: input.toString(), assertion: body.get("assertion") })
      counter += 1
      return Response.json({ access_token: `ya29.minted-${counter}`, expires_in: 3600, token_type: "Bearer" })
    },
  })
  const t0 = new Date("2026-09-03T12:00:00Z")
  const first = await minter({ credentialId: "ipc_a", serviceAccount, now: t0 })
  assert.deepEqual(first, { kind: "token", accessToken: "ya29.minted-1" })
  assert.equal(calls[0]?.url, serviceAccount.token_uri)
  const [, claims] = calls[0]?.assertion?.split(".") ?? []
  assert.ok(claims)
  assert.equal(decodeSegment(claims).iss, serviceAccount.client_email)

  // Cache hit well before expiry.
  const cached = await minter({ credentialId: "ipc_a", serviceAccount, now: new Date(t0.getTime() + 30 * 60_000) })
  assert.deepEqual(cached, { kind: "token", accessToken: "ya29.minted-1" })
  assert.equal(calls.length, 1)

  // Another credential id mints separately.
  const other = await minter({ credentialId: "ipc_b", serviceAccount, now: t0 })
  assert.deepEqual(other, { kind: "token", accessToken: "ya29.minted-2" })

  // 60s before expiry → re-mint.
  const late = await minter({ credentialId: "ipc_a", serviceAccount, now: new Date(t0.getTime() + 3600_000 - 60_000) })
  assert.deepEqual(late, { kind: "token", accessToken: "ya29.minted-3" })
  assert.equal(calls.length, 3)
})

test("token minter: endpoint errors and unsignable keys are reported, not thrown", async () => {
  const failing = createGcpServiceAccountTokenMinter({ fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }) })
  const result = await failing({ credentialId: "ipc_x", serviceAccount, now: new Date() })
  assert.deepEqual(result, { kind: "error", message: "token endpoint returned 400" })

  const badKey = await failing({ credentialId: "ipc_y", serviceAccount: { ...serviceAccount, private_key: "not a key" }, now: new Date() })
  assert.equal(badKey.kind, "error")
  assert.ok(badKey.kind === "error" && badKey.message.startsWith("service account private_key could not sign"))
})
