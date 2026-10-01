import { describe, expect, test } from "bun:test"
import { cookiesToRemember, REMEMBER_LOGIN_MS } from "./cookies"

const now = Date.UTC(2026, 8, 30, 12, 0, 0)
const expires = Math.floor((now + REMEMBER_LOGIN_MS) / 1_000)

function cookie(overrides: Record<string, unknown>) {
  return { name: "sid", value: "abc", domain: "app.example.com", path: "/", expires: -1, size: 6, httpOnly: true, secure: true, session: true, sameSite: "Lax", priority: "Medium", ...overrides }
}

describe("remembering sign-ins", () => {
  test("session cookies become persistent for thirty days", () => {
    expect(cookiesToRemember([cookie({})], now)).toEqual([
      { name: "sid", value: "abc", url: "https://app.example.com/", path: "/", secure: true, httpOnly: true, expires, sameSite: "Lax", priority: "Medium" },
    ])
  })

  test("cookies that already expire are left alone", () => {
    expect(cookiesToRemember([cookie({ session: false, expires: now / 1_000 + 3_600 })], now)).toEqual([])
  })

  test("host-only cookies stay host-only; domain cookies keep their domain", () => {
    const [hostOnly, domain] = cookiesToRemember([
      cookie({ name: "__Host-session", domain: "app.example.com", path: "/" }),
      cookie({ name: "shared", domain: ".example.com", path: "/account", secure: false }),
    ], now)
    expect(hostOnly?.url).toBe("https://app.example.com/")
    expect(hostOnly?.domain).toBeUndefined()
    expect(domain?.domain).toBe(".example.com")
    expect(domain?.url).toBeUndefined()
    expect(domain?.path).toBe("/account")
  })

  test("insecure host-only cookies keep an http url, and paths are preserved", () => {
    const [promoted] = cookiesToRemember([cookie({ secure: false, path: "/app" })], now)
    expect(promoted?.url).toBe("http://app.example.com/app")
    expect(promoted?.secure).toBe(false)
  })

  test("partitioned cookies keep their partition key", () => {
    const partitionKey = { topLevelSite: "https://example.com", hasCrossSiteAncestor: false }
    const [promoted] = cookiesToRemember([cookie({ partitionKey })], now)
    expect(promoted?.partitionKey).toEqual(partitionKey)
  })

  test("malformed entries are skipped", () => {
    expect(cookiesToRemember([null, "sid=abc", { name: "x" }, cookie({ domain: "" })], now)).toEqual([])
  })
})
