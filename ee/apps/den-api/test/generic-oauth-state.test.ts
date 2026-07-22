import { createHmac } from "node:crypto"
import { beforeAll, describe, expect, test } from "bun:test"

const secret = "oauth-state-test-secret"
let verifyOAuthStateToken: typeof import("../src/capability-sources/generic-oauth.js")["verifyOAuthStateToken"]

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  verifyOAuthStateToken = (await import("../src/capability-sources/generic-oauth.js")).verifyOAuthStateToken
})

function signedState(payload: Record<string, unknown>) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url")
  return `${encodedPayload}.${signature}`
}

function versionTwoState(callbackMode?: string, authorizationResponseIssuerRequired: unknown = undefined) {
  return signedState({
    version: 2,
    organizationId: "org_test",
    orgMembershipId: "mbr_test",
    providerId: "xmcp_test",
    binding: "binding",
    ...(callbackMode ? { callbackMode } : {}),
    ...(authorizationResponseIssuerRequired !== undefined ? { authorizationResponseIssuerRequired } : {}),
    nonce: "nonce",
    iat: 1_700_000_000,
    exp: 1_700_000_600,
  })
}

describe("version-two OAuth state validation", () => {
  test("accepts only the supported callback modes", () => {
    expect(verifyOAuthStateToken({ token: versionTwoState("shared-v1"), secret, now: 1_700_000_100_000 })).not.toBeNull()
    expect(verifyOAuthStateToken({ token: versionTwoState("isolated-v1"), secret, now: 1_700_000_100_000 })).not.toBeNull()
    expect(verifyOAuthStateToken({ token: versionTwoState("legacy-v1"), secret, now: 1_700_000_100_000 })).not.toBeNull()
    expect(verifyOAuthStateToken({ token: versionTwoState("future-v1"), secret, now: 1_700_000_100_000 })).toBeNull()
    expect(verifyOAuthStateToken({ token: versionTwoState(), secret, now: 1_700_000_100_000 })).toBeNull()
    expect(verifyOAuthStateToken({ token: versionTwoState("shared-v1", false), secret, now: 1_700_000_100_000 }))
      .toMatchObject({ authorizationResponseIssuerRequired: false })
    expect(verifyOAuthStateToken({ token: versionTwoState("shared-v1", "false"), secret, now: 1_700_000_100_000 })).toBeNull()
    expect(verifyOAuthStateToken({ token: versionTwoState("shared-v1", false), secret, now: 1_700_000_601_000 })).toBeNull()
  })
})
