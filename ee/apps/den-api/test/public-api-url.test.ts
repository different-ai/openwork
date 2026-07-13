import { describe, expect, test } from "bun:test"
import {
  normalizeConfiguredPublicApiBaseUrl,
  publicRequestUrl,
} from "../src/request-url.js"

describe("public API URL configuration", () => {
  test("callback base resolution keeps the configured prefix", async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
    process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
    process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
    const { resolvePublicApiBaseUrl } = await import("../src/capability-sources/generic-oauth.js")

    expect(resolvePublicApiBaseUrl(
      new Request("http://den-api.internal:8790/v1/example"),
      "https://openwork.example/api/den/",
    )).toBe("https://openwork.example/api/den")
  })

  test("preserves and normalizes an HTTPS pathname prefix", () => {
    expect(normalizeConfiguredPublicApiBaseUrl("https://openwork.example/api/den/", {
      allowInsecureHttp: false,
    })).toBe("https://openwork.example/api/den")
  })

  test("requires HTTPS outside development and localhost", () => {
    expect(() => normalizeConfiguredPublicApiBaseUrl("http://openwork.example/api/den", {
      allowInsecureHttp: false,
    })).toThrow("must use HTTPS")
    expect(normalizeConfiguredPublicApiBaseUrl("http://127.0.0.1:8790/api/den", {
      allowInsecureHttp: false,
    })).toBe("http://127.0.0.1:8790/api/den")
    expect(normalizeConfiguredPublicApiBaseUrl("http://openwork.example/api/den", {
      allowInsecureHttp: true,
    })).toBe("http://openwork.example/api/den")
  })

  test("rejects malformed and non-base URLs", () => {
    expect(() => normalizeConfiguredPublicApiBaseUrl("not a url", {
      allowInsecureHttp: false,
    })).toThrow("absolute http or https URL")
    expect(() => normalizeConfiguredPublicApiBaseUrl("https://openwork.example/api?tenant=one", {
      allowInsecureHttp: false,
    })).toThrow("cannot contain credentials, a query string, or a fragment")
  })
})

describe("publicRequestUrl forwarded host policy", () => {
  const request = new Request("http://den-api.internal:8790/v1/example", {
    headers: {
      "x-forwarded-host": "connect.example.com",
      "x-forwarded-proto": "https",
    },
  })

  test("honors a forwarded host on a configured trusted origin", () => {
    expect(publicRequestUrl(request, {
      trustedOrigins: ["https://connect.example.com"],
    }).origin).toBe("https://connect.example.com")
  })

  test("ignores an untrusted or malformed forwarded host", () => {
    expect(publicRequestUrl(request, {
      trustedOrigins: ["https://app.example.com"],
    }).origin).toBe("https://den-api.internal:8790")

    const malformed = new Request("http://den-api.internal:8790/v1/example", {
      headers: {
        "x-forwarded-host": "attacker.example@connect.example.com",
        "x-forwarded-proto": "https",
      },
    })
    expect(publicRequestUrl(malformed, {
      trustedOrigins: ["https://connect.example.com"],
    }).origin).toBe("https://den-api.internal:8790")
  })
})
