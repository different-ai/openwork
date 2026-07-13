import { describe, expect, test } from "bun:test"
import { controlPlaneOrigin, parseEnterpriseMockLabEnv } from "../src/env.js"
import { AuthenticationError, SecurityService } from "../src/security.js"

describe("Enterprise Mock Lab environment", () => {
  test("requires a strong admin secret and a literal loopback host", () => {
    expect(() => parseEnterpriseMockLabEnv({})).toThrow()
    expect(() => parseEnterpriseMockLabEnv({ ENTERPRISE_MOCK_LAB_ADMIN_SECRET: "short" })).toThrow()
    expect(() => parseEnterpriseMockLabEnv({
      ENTERPRISE_MOCK_LAB_ADMIN_SECRET: "a-secure-local-admin-secret-that-is-long-enough",
      ENTERPRISE_MOCK_LAB_HOST: "0.0.0.0",
    })).toThrow()
  })

  test("formats IPv4 and IPv6 loopback control-plane origins", () => {
    expect(controlPlaneOrigin({ ENTERPRISE_MOCK_LAB_HOST: "127.0.0.1", ENTERPRISE_MOCK_LAB_PORT: 8794 })).toBe("http://127.0.0.1:8794")
    expect(controlPlaneOrigin({ ENTERPRISE_MOCK_LAB_HOST: "::1", ENTERPRISE_MOCK_LAB_PORT: 8794 })).toBe("http://[::1]:8794")
  })
})

describe("SecurityService", () => {
  test("rate-limits repeated invalid admin secrets", () => {
    let now = 1_000
    const security = new SecurityService({
      adminSecret: "correct-admin-secret-with-at-least-32-characters",
      expectedOrigin: "http://127.0.0.1:8794",
      now: () => now,
      sessionTtlSeconds: 3_600,
    })

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(() => security.authenticate("wrong", "local")).toThrow(AuthenticationError)
    }
    try {
      security.authenticate("wrong", "local")
      throw new Error("expected authentication to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticationError)
      expect((error as AuthenticationError).code).toBe("rate_limited")
    }

    expect(() => security.authenticate("correct-admin-secret-with-at-least-32-characters", "local")).toThrow("Too many")
    now += 60_001
    expect(security.authenticate("correct-admin-secret-with-at-least-32-characters", "local").id).toBeString()
  })

  test("expires sessions and never includes the admin secret in its cookie", () => {
    let now = 1_000
    const adminSecret = "correct-admin-secret-with-at-least-32-characters"
    const security = new SecurityService({
      adminSecret,
      expectedOrigin: "http://127.0.0.1:8794",
      now: () => now,
      randomToken: () => "fixed-session-token",
      sessionTtlSeconds: 300,
    })
    const session = security.authenticate(adminSecret, "local")
    const cookie = security.sessionCookie(session)

    expect(cookie).toContain("HttpOnly")
    expect(cookie).not.toContain(adminSecret)
    expect(security.requireSession(new Request("http://127.0.0.1:8794", { headers: { cookie } })).id).toBe(session.id)
    now += 300_001
    expect(() => security.requireSession(new Request("http://127.0.0.1:8794", { headers: { cookie } }))).toThrow()
  })
})
