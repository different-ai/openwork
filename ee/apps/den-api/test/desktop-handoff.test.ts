import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let desktopHandoffModule: typeof import("../src/routes/auth/desktop-handoff.js")

beforeAll(async () => {
  seedRequiredEnv()
  desktopHandoffModule = await import("../src/routes/auth/desktop-handoff.js")
})

test("desktop handoff Den base URL resolves trusted web app origin through proxy path", () => {
  const request = new Request("http://den-api.internal/v1/auth/desktop-handoff", {
    headers: { origin: "https://app.openworklabs.com" },
  })

  expect(desktopHandoffModule.resolveDesktopDenBaseUrl(request)).toBe("https://app.openworklabs.com/api/den")
})

test("desktop handoff Den base URL fails closed instead of falling back to public cloud", () => {
  const request = new Request("http://den-api.internal/v1/auth/desktop-handoff", {
    headers: { host: "", "x-forwarded-host": "bad host", "x-forwarded-proto": "https" },
  })

  expect(() => desktopHandoffModule.resolveDesktopDenBaseUrl(request)).toThrow("trusted Den base URL")
})

test("desktop handoff Den base URL rejects valid but untrusted forwarded hosts", () => {
  const request = new Request("http://den-api.internal/v1/auth/desktop-handoff", {
    headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" },
  })

  expect(() => desktopHandoffModule.resolveDesktopDenBaseUrl(request)).toThrow("trusted Den base URL")
})
