import { describe, expect, test } from "bun:test"

describe("desktop handoff public URL", () => {
  test("does not send 0.0.0.0 to desktop clients", async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
    process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
    process.env.BETTER_AUTH_URL = "https://public.example.test"

    const { resolveDesktopDenBaseUrl } = await import("../src/routes/auth/desktop-handoff.js")

    expect(resolveDesktopDenBaseUrl(new Request("http://0.0.0.0:8788/v1/auth/desktop-handoff", {
      headers: { origin: "http://0.0.0.0:3005" },
    }))).toBe("https://public.example.test/api/den")

    expect(resolveDesktopDenBaseUrl(new Request("http://127.0.0.1:8788/v1/auth/desktop-handoff", {
      headers: {
        "x-forwarded-host": "0.0.0.0:3005",
        "x-forwarded-proto": "https",
      },
    }))).toBe("https://public.example.test/api/den")
  })
})
