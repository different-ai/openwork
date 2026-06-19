import { createHmac } from "node:crypto"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let sessionModule: typeof import("../src/session.js")
const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")

beforeAll(async () => {
  seedRequiredEnv()
  sessionModule = await import("../src/session.js")
})

function forgeHeaderWithSecret(secret: string, principal: { userId: string; organizationId: string; expiresAt: number }) {
  const payload = Buffer.from(JSON.stringify(principal), "utf8").toString("base64url")
  const signature = createHmac("sha256", secret).update(payload).digest("base64url")
  return `${payload}.${signature}`
}

test("legitimately created header round-trips and verifies", () => {
  const header = sessionModule.createInternalMcpPrincipalHeader({
    userId,
    organizationId,
  })

  const parsed = sessionModule.verifyInternalMcpPrincipalHeader(header)
  expect(parsed).not.toBeNull()
  expect(parsed?.userId).toBe(userId)
  expect(parsed?.organizationId).toBe(organizationId)
})

test("header forged with BETTER_AUTH_SECRET is REJECTED (trust boundary closed)", () => {
  // This is the exact pre-fix forgery: signing the principal with betterAuthSecret.
  // After the fix the internal header is signed with a per-process secret, so an
  // attacker who knows BETTER_AUTH_SECRET can no longer impersonate anyone.
  const forged = forgeHeaderWithSecret(process.env.BETTER_AUTH_SECRET as string, {
    userId,
    organizationId,
    expiresAt: Date.now() + 60_000,
  })

  expect(sessionModule.verifyInternalMcpPrincipalHeader(forged)).toBeNull()
})

test("header signed with an arbitrary attacker secret is REJECTED", () => {
  const forged = forgeHeaderWithSecret("attacker-knows-this-not-the-server-secret", {
    userId,
    organizationId,
    expiresAt: Date.now() + 60_000,
  })

  expect(sessionModule.verifyInternalMcpPrincipalHeader(forged)).toBeNull()
})

test("expired header is REJECTED even if signature is valid", () => {
  // Create a legitimately-signed header (correct per-process secret) but at a
  // moment far enough in the past that its expiresAt has already elapsed. This
  // isolates the expiry check: the signature passes, only the TTL rejects it.
  const realNow = Date.now
  Date.now = () => realNow() - 120_000 // pretend it's 2 minutes ago
  const header = sessionModule.createInternalMcpPrincipalHeader({ userId, organizationId })
  Date.now = realNow // restore real time — the header is now expired

  // Confirm signature alone would be valid (header was created by the real signer)
  // but the function rejects it because expiresAt is in the past.
  expect(sessionModule.verifyInternalMcpPrincipalHeader(header)).toBeNull()
})

test("malformed / empty headers are REJECTED", () => {
  expect(sessionModule.verifyInternalMcpPrincipalHeader(null)).toBeNull()
  expect(sessionModule.verifyInternalMcpPrincipalHeader("")).toBeNull()
  expect(sessionModule.verifyInternalMcpPrincipalHeader("garbage")).toBeNull()
  expect(sessionModule.verifyInternalMcpPrincipalHeader("a.b.c")).toBeNull()
})
