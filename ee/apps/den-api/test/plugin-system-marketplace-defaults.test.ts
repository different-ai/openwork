import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let defaults: typeof import("../src/routes/org/plugin-system/default-marketplaces.js")
let schemas: typeof import("../src/routes/org/plugin-system/schemas.js")

beforeAll(async () => {
  seedRequiredEnv()
  defaults = await import("../src/routes/org/plugin-system/default-marketplaces.js")
  schemas = await import("../src/routes/org/plugin-system/schemas.js")
})

test("anthropic starter marketplace seeds a non-empty plugin catalog", () => {
  expect(defaults.DEFAULT_ANTHROPIC_STARTER_PLUGINS.length).toBeGreaterThan(0)

  const names = defaults.DEFAULT_ANTHROPIC_STARTER_PLUGINS.map((entry) => entry.name)
  expect(new Set(names).size).toBe(names.length)

  for (const entry of defaults.DEFAULT_ANTHROPIC_STARTER_PLUGINS) {
    expect(entry.name.trim().length).toBeGreaterThan(0)
    expect(entry.name.length).toBeLessThanOrEqual(255)
    expect(entry.description.trim().length).toBeGreaterThan(0)
  }
})

test("default marketplace logos pass logo url validation", () => {
  expect(schemas.marketplaceLogoUrlSchema.safeParse(defaults.DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL).success).toBe(true)
  expect(schemas.marketplaceLogoUrlSchema.safeParse(defaults.DEFAULT_ANTHROPIC_MARKETPLACE_LOGO_URL).success).toBe(true)
})

test("marketplace logo url accepts https and root-relative paths only", () => {
  expect(schemas.marketplaceLogoUrlSchema.safeParse("https://cdn.simpleicons.org/anthropic").success).toBe(true)
  expect(schemas.marketplaceLogoUrlSchema.safeParse("/openwork-mark.svg").success).toBe(true)

  expect(schemas.marketplaceLogoUrlSchema.safeParse("javascript:alert(1)").success).toBe(false)
  expect(schemas.marketplaceLogoUrlSchema.safeParse("http://insecure.example/logo.png").success).toBe(false)
  expect(schemas.marketplaceLogoUrlSchema.safeParse("//protocol-relative.example/logo.png").success).toBe(false)
  expect(schemas.marketplaceLogoUrlSchema.safeParse("data:image/svg+xml;base64,AAAA").success).toBe(false)
  expect(schemas.marketplaceLogoUrlSchema.safeParse("").success).toBe(false)
})

test("marketplace create and update schemas accept logoUrl", () => {
  expect(schemas.marketplaceCreateSchema.safeParse({ name: "Team Tools", logoUrl: "https://example.com/logo.svg" }).success).toBe(true)
  expect(schemas.marketplaceCreateSchema.safeParse({ name: "Team Tools", logoUrl: null }).success).toBe(true)

  expect(schemas.marketplaceUpdateSchema.safeParse({ logoUrl: "https://example.com/logo.svg" }).success).toBe(true)
  expect(schemas.marketplaceUpdateSchema.safeParse({ logoUrl: null }).success).toBe(true)
  expect(schemas.marketplaceUpdateSchema.safeParse({}).success).toBe(false)
})
