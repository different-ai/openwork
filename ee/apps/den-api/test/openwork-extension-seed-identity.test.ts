import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let store: typeof import("../src/routes/org/plugin-system/store.js")

beforeAll(async () => {
  seedRequiredEnv()
  store = await import("../src/routes/org/plugin-system/store.js")
})

test("new built-ins have stable organization-scoped plugin IDs", () => {
  const first = store.defaultOpenWorkPluginId("org_alpha", "openwork-browser")
  const repeated = store.defaultOpenWorkPluginId("org_alpha", "openwork-browser")
  const otherOrganization = store.defaultOpenWorkPluginId("org_beta", "openwork-browser")
  const otherManifest = store.defaultOpenWorkPluginId("org_alpha", "ollama")

  expect(first).toBe(repeated)
  expect(first).toStartWith("plg_")
  expect(first).not.toBe(otherOrganization)
  expect(first).not.toBe(otherManifest)
})

test("stable identity is independent of mutable display copy", () => {
  const organizationId = "org_alpha"
  const identity = store.defaultOpenWorkManifestIdentityForPlugin({
    description: "Edited description",
    id: store.defaultOpenWorkPluginId(organizationId, "openwork-browser"),
    name: "Edited name",
    organizationId,
  })

  expect(identity?.matchedBy).toBe("stable-id")
  expect(identity?.manifest.id).toBe("openwork-browser")
})

test("pre-convergence rows retain an explicit exact-copy fallback", () => {
  const organizationId = "org_legacy"
  const legacyId = store.defaultOpenWorkPluginId(organizationId, "legacy-random-row")
  const legacy = store.defaultOpenWorkManifestIdentityForPlugin({
    description: "Generate image artifacts with gpt-image-2.",
    id: legacyId,
    name: "OpenAI Image Gen",
    organizationId,
  })
  const editedLegacy = store.defaultOpenWorkManifestIdentityForPlugin({
    description: "User-edited copy",
    id: legacyId,
    name: "OpenAI Image Gen",
    organizationId,
  })

  expect(legacy?.matchedBy).toBe("legacy-name-description")
  expect(legacy?.manifest.id).toBe("openai-image-gen")
  expect(editedLegacy).toBeNull()
})
