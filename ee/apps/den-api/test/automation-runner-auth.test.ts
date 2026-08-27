import { beforeAll, describe, expect, test } from "bun:test"
import { AUTOMATION_MODEL_ATTENTION_CAPABILITY } from "@openwork/types/automations"
import { createHmac } from "node:crypto"

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
}

let AutomationRunnerAuth: typeof import("../src/automations/runner-auth.js")["AutomationRunnerAuth"]
let automationRunnerAudienceFromRequest: typeof import("../src/automations/runner-auth.js")["automationRunnerAudienceFromRequest"]
let automationRunnerAudienceFromRequestUrl: typeof import("../src/automations/runner-auth.js")["automationRunnerAudienceFromRequestUrl"]
let automationRunnerRejectionLogFields: typeof import("../src/automations/runner-auth.js")["automationRunnerRejectionLogFields"]
let AutomationRunnerRejectionLimiter: typeof import("../src/automations/runner-rejection-protection.js")["AutomationRunnerRejectionLimiter"]
let AutomationRunnerRequestAuthenticator: typeof import("../src/automations/runner-rejection-protection.js")["AutomationRunnerRequestAuthenticator"]
let automationRunnerRejectionLimitKey: typeof import("../src/automations/runner-rejection-protection.js")["automationRunnerRejectionLimitKey"]

beforeAll(async () => {
  seedRequiredEnv()
  ;({
    AutomationRunnerAuth,
    automationRunnerAudienceFromRequest,
    automationRunnerAudienceFromRequestUrl,
    automationRunnerRejectionLogFields,
  } = await import("../src/automations/runner-auth.js"))
  ;({
    AutomationRunnerRejectionLimiter,
    AutomationRunnerRequestAuthenticator,
    automationRunnerRejectionLimitKey,
  } = await import("../src/automations/runner-rejection-protection.js"))
})

function signedToken(secret: string, payloadValue: unknown) {
  const payload = Buffer.from(JSON.stringify(payloadValue)).toString("base64url")
  const signature = createHmac("sha256", secret)
    .update(`openwork-automation-runner-v1.${payload}`)
    .digest("base64url")
  return `${payload}.${signature}`
}

describe("Automation runner credentials", () => {
  test("survive process-local auth instances while remaining scoped and tamper-evident", () => {
    const secret = "runner-auth-test-secret".repeat(3)
    const issuer = new AutomationRunnerAuth(secret)
    const verifier = new AutomationRunnerAuth(secret)
    const issued = issuer.issue({
      organizationId: "org_test",
      ownerMemberId: "member_test",
      runnerId: "desktop-test",
      capabilities: [AUTOMATION_MODEL_ATTENTION_CAPABILITY],
    }, "https://den.example.com/api/den")

    expect(verifier.authenticate(`Bearer ${issued.token}`, "https://den.example.com/api/den")).toEqual({
      ok: true,
      identity: {
        organizationId: "org_test",
        ownerMemberId: "member_test",
        runnerId: "desktop-test",
        capabilities: [AUTOMATION_MODEL_ATTENTION_CAPABILITY],
        audience: "https://den.example.com/api/den",
        expiresAt: issued.expiresAt,
      },
    })
    expect(new AutomationRunnerAuth(`${secret}x`).authenticate(
      `Bearer ${issued.token}`,
      "https://den.example.com/api/den",
    )).toMatchObject({ ok: false, rejection: { reason: "bad_signature" } })
    expect(verifier.authenticate(
      `Bearer ${issued.token}x`,
      "https://den.example.com/api/den",
    )).toMatchObject({ ok: false, rejection: { reason: "bad_signature" } })
  })

  test("classifies malformed, bad-signature, expired, and wrong-audience credentials", () => {
    const secret = "runner-auth-classification-secret".repeat(2)
    const verifier = new AutomationRunnerAuth(secret)
    const audience = "https://den.example.com/api/den"
    expect(verifier.authenticate("Bearer opaque", audience))
      .toMatchObject({ ok: false, rejection: { reason: "malformed_token", claims: {} } })

    const issued = verifier.issue({
      organizationId: "org_claimed",
      ownerMemberId: "member_claimed",
      runnerId: "runner_claimed",
      capabilities: [],
    }, audience)
    const badSignature = verifier.authenticate(`Bearer ${issued.token}x`, audience)
    expect(badSignature).toEqual({
      ok: false,
      rejection: {
        reason: "bad_signature",
        claims: {
          credentialVersion: 2,
          organizationId: "org_claimed",
          ownerMemberId: "member_claimed",
          runnerId: "runner_claimed",
          expiresAt: issued.expiresAt,
        },
      },
    })

    const expiredAt = Date.now() - 1
    const expired = signedToken(secret, {
      v: 2,
      o: "org_expired",
      m: "member_expired",
      r: "runner_expired",
      c: [],
      a: audience,
      e: expiredAt,
    })
    expect(verifier.authenticate(`Bearer ${expired}`, audience))
      .toMatchObject({ ok: false, rejection: { reason: "expired", claims: { expiresAt: expiredAt } } })
    expect(verifier.authenticate(`Bearer ${issued.token}`, "https://other.example.com/api/den"))
      .toMatchObject({ ok: false, rejection: { reason: "audience_mismatch" } })
  })

  test("logs only stable claimed-identity fingerprints for rejected credentials", () => {
    const secret = "runner-auth-safe-log-secret".repeat(3)
    const auth = new AutomationRunnerAuth(secret)
    const issued = auth.issue({
      organizationId: "org_never_log_raw",
      ownerMemberId: "member_never_log_raw",
      runnerId: "runner_never_log_raw",
      capabilities: [],
    }, "https://den.example.com")
    const result = auth.authenticate(`Bearer ${issued.token}x`, "https://den.example.com")
    if (result.ok) throw new Error("expected rejected runner credential")
    const fields = automationRunnerRejectionLogFields(result.rejection)
    expect(fields).toMatchObject({
      reason: "bad_signature",
      runner_auth_version: 2,
      runner_auth_expires_at_ms: issued.expiresAt,
      claimed_runner_id_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
      claimed_organization_id_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
      claimed_owner_member_id_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
    })
    const serialized = JSON.stringify(fields)
    for (const secretValue of [
      issued.token,
      issued.token.split(".")[1] ?? "missing-signature",
      secret,
      "org_never_log_raw",
      "member_never_log_raw",
      "runner_never_log_raw",
    ]) {
      expect(serialized).not.toContain(secretValue)
    }
  })

  test("keys rejected requests by Render's right-most forwarded address", () => {
    const secret = "runner-auth-forwarded-address-secret".repeat(2)
    const auth = new AutomationRunnerAuth(secret)
    const issued = auth.issue({
      organizationId: "org_forwarded",
      ownerMemberId: "member_forwarded",
      runnerId: "runner_forwarded",
      capabilities: [],
    }, "https://den.example.com")
    const result = auth.authenticate(`Bearer ${issued.token}x`, "https://den.example.com")
    if (result.ok) throw new Error("expected rejected runner credential")

    const first = automationRunnerRejectionLimitKey(result.rejection, new Headers({
      "x-forwarded-for": "198.51.100.1, 203.0.113.9",
      "x-real-ip": "192.0.2.1",
    }))
    const variedLeadingHop = automationRunnerRejectionLimitKey(result.rejection, new Headers({
      "x-forwarded-for": "198.51.100.200, , 203.0.113.9",
      "x-real-ip": "192.0.2.200",
    }))
    const changedTrustedHop = automationRunnerRejectionLimitKey(result.rejection, new Headers({
      "x-forwarded-for": "198.51.100.1, 203.0.113.10",
      "x-real-ip": "192.0.2.1",
    }))

    expect(variedLeadingHop).toBe(first)
    expect(changedTrustedHop).not.toBe(first)
  })

  test("untrusted claimed runner IDs cannot churn rejection limiter buckets", () => {
    const secret = "runner-auth-untrusted-id-secret".repeat(3)
    const auth = new AutomationRunnerAuth(secret)
    const limiter = new AutomationRunnerRejectionLimiter({
      maxFailures: 1,
      windowMs: 60_000,
      maxEntries: 4_096,
      now: () => 10_000,
    })
    let limited = 0
    let shouldLog = 0
    for (let index = 0; index < 4_097; index += 1) {
      const payload = Buffer.from(JSON.stringify({
        v: 2,
        o: `fake-org-${String(index)}`,
        m: `fake-member-${String(index)}`,
        r: `fake-runner-${String(index)}`,
        c: [],
        a: "https://den.example.com",
        e: Date.now() + 60_000,
      })).toString("base64url")
      const result = auth.authenticate(`Bearer ${payload}.invalid-signature`, "https://den.example.com")
      if (result.ok) throw new Error("expected bad-signature rejection")
      const key = automationRunnerRejectionLimitKey(result.rejection, new Headers({
        "x-forwarded-for": `attacker-${String(index)}, 203.0.113.9`,
      }))
      const rateLimit = limiter.record(key)
      if (rateLimit.limited) limited += 1
      if (rateLimit.shouldLog) shouldLog += 1
    }

    expect(limiter.size).toBe(1)
    expect(limited).toBe(4_096)
    expect(shouldLog).toBe(2)

    const expiredAt = Date.now() - 1
    const signedA = auth.authenticate(`Bearer ${signedToken(secret, {
      v: 2, o: "org", m: "member", r: "signed-runner-a", c: [], a: "https://den.example.com", e: expiredAt,
    })}`, "https://den.example.com")
    const signedB = auth.authenticate(`Bearer ${signedToken(secret, {
      v: 2, o: "org", m: "member", r: "signed-runner-b", c: [], a: "https://den.example.com", e: expiredAt,
    })}`, "https://den.example.com")
    if (signedA.ok || signedB.ok) throw new Error("expected signed expired rejections")
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9" })
    expect(automationRunnerRejectionLimitKey(signedA.rejection, headers))
      .not.toBe(automationRunnerRejectionLimitKey(signedB.rejection, headers))
  })

  test("binds a runner credential to the API base that minted it", () => {
    expect(automationRunnerAudienceFromRequestUrl(
      "https://den.example.com/api/den/v1/automation-runners/token?ignored=true",
    )).toBe("https://den.example.com/api/den")
    expect(() => automationRunnerAudienceFromRequestUrl("https://den.example.com/not-the-token-route"))
      .toThrow("automation_runner_audience_invalid")
    expect(automationRunnerAudienceFromRequest(
      new Request("https://den.example.com/api/den/v1/automation-runners/events"),
      { trustedOrigins: [] },
    )).toBe("https://den.example.com/api/den")
  })

  test("binds a Den Web proxied credential to its trusted public route", () => {
    const request = new Request("http://api.openworklabs.com/v1/automation-runners/token", {
      headers: {
        "x-forwarded-host": "app.openworklabs.com",
        "x-forwarded-proto": "https",
        "x-forwarded-prefix": "/api/den",
      },
    })

    expect(automationRunnerAudienceFromRequest(request, {
      trustedOrigins: ["https://app.openworklabs.com"],
    })).toBe("https://app.openworklabs.com/api/den")
  })

  test("binds a rotated preview hostname covered by a trusted wildcard", () => {
    const request = new Request("http://127.0.0.1:8788/v1/automation-runners/token", {
      headers: {
        "x-forwarded-host": "3005-rotated.daytonaproxy01.net",
        "x-forwarded-proto": "https",
        "x-forwarded-prefix": "/api/den",
      },
    })

    expect(automationRunnerAudienceFromRequest(request, {
      trustedOrigins: ["https://*.daytonaproxy01.net"],
    })).toBe("https://3005-rotated.daytonaproxy01.net/api/den")
  })

  test("trusts the Den Web proxy origin this API is actually served from", async () => {
    const { env } = await import("../src/env.js")
    const denWeb = new URL(env.betterAuthUrl)
    const request = new Request("http://api.internal/v1/automation-runners/token", {
      headers: {
        "x-forwarded-host": denWeb.host,
        "x-forwarded-proto": denWeb.protocol.replace(/:$/, ""),
        "x-forwarded-prefix": "/api/den",
      },
    })

    expect(automationRunnerAudienceFromRequest(request, {
      trustedOrigins: env.publicProxyTrustedOrigins,
    })).toBe(`${denWeb.origin}/api/den`)
    // Hosted deployments proxy every call server-side, so the Den Web origin
    // has no reason to appear in CORS_ORIGINS. Binding off that list alone
    // sends desktops to the internal API, where their credential is refused
    // and every desktop occurrence is recorded as missed.
    expect(automationRunnerAudienceFromRequest(request, { trustedOrigins: [] }))
      .toBe(`${denWeb.protocol}//api.internal`)
  })

  test("keeps a directly reached runner destination on its public scheme", () => {
    const request = new Request("http://api.den.test/v1/automation-runners/token", {
      headers: { "x-forwarded-proto": "https" },
    })

    expect(automationRunnerAudienceFromRequest(request, { trustedOrigins: [] }))
      .toBe("https://api.den.test")
  })

  test("ignores an untrusted forwarded runner destination", () => {
    const request = new Request("https://api.openworklabs.com/v1/automation-runners/token", {
      headers: {
        "x-forwarded-host": "attacker.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-prefix": "/api/den",
      },
    })

    expect(automationRunnerAudienceFromRequest(request, {
      trustedOrigins: ["https://app.openworklabs.com"],
    })).toBe("https://api.openworklabs.com")
  })

  test("keeps legacy v1 credentials capability-free", () => {
    const secret = "runner-auth-test-secret".repeat(3)
    const expiresAt = Date.now() + 60_000
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      o: "org_test",
      m: "member_test",
      r: "desktop-test",
      e: expiresAt,
    })).toString("base64url")
    const signature = createHmac("sha256", secret)
      .update(`openwork-automation-runner-v1.${payload}`)
      .digest("base64url")

    expect(new AutomationRunnerAuth(secret).authenticate(
      `Bearer ${payload}.${signature}`,
      "https://different.example.com",
    )).toEqual({
      ok: true,
      identity: {
        organizationId: "org_test",
        ownerMemberId: "member_test",
        runnerId: "desktop-test",
        capabilities: [],
        audience: null,
        expiresAt,
      },
    })
  })

  test("returns 401 then 429 without leaking claims, while a valid credential remains usable", async () => {
    const secret = "runner-auth-protocol-secret".repeat(3)
    const auth = new AutomationRunnerAuth(secret)
    const issued = auth.issue({
      organizationId: "org_protocol",
      ownerMemberId: "member_protocol",
      runnerId: "runner_protocol",
      capabilities: [],
    }, "https://den.example.com")
    const logs: Readonly<Record<string, unknown>>[] = []
    const limiter = new AutomationRunnerRejectionLimiter({
      maxFailures: 1,
      windowMs: 60_000,
      maxEntries: 2,
      now: () => 10_000,
    })
    const authenticator = new AutomationRunnerRequestAuthenticator({
      auth,
      limiter,
      audienceFromRequest: (request) => automationRunnerAudienceFromRequest(request, { trustedOrigins: [] }),
      isActiveOwner: async () => true,
      logRejection: (fields) => logs.push(fields),
    })
    const request = (authorization: string) => new Request(
      "https://den.example.com/v1/automation-runner/work",
      { headers: { authorization, "x-real-ip": "192.0.2.10" } },
    )

    const first = await authenticator.authenticate(request(`Bearer ${issued.token}x`))
    if (first.ok) throw new Error("expected first rejection")
    expect(first.response.status).toBe(401)
    expect(first.response.headers.get("retry-after")).toBeNull()
    expect(await first.response.json()).toEqual({ error: "runner_unauthorized" })

    const second = await authenticator.authenticate(request(`Bearer ${issued.token}x`))
    if (second.ok) throw new Error("expected rate-limited rejection")
    expect(second.response.status).toBe(429)
    expect(second.response.headers.get("retry-after")).toBe("60")
    expect(await second.response.json()).toEqual({ error: "runner_unauthorized" })

    const valid = await authenticator.authenticate(request(`Bearer ${issued.token}`))
    expect(valid).toMatchObject({ ok: true, identity: { runnerId: "runner_protocol" } })

    const serialized = JSON.stringify(logs)
    expect(logs).toHaveLength(2)
    expect(logs[1]).toMatchObject({ reason: "bad_signature", rate_limited: true, retry_after_seconds: 60 })
    for (const secretValue of [issued.token, secret, "org_protocol", "member_protocol", "runner_protocol"]) {
      expect(serialized).not.toContain(secretValue)
    }

    limiter.record("second-key")
    limiter.record("third-key")
    expect(limiter.size).toBe(2)
  })
})
