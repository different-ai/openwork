import { afterAll, beforeAll, expect, mock, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let store: typeof import("../src/routes/org/plugin-system/store.js")

beforeAll(async () => {
  seedRequiredEnv()
  mock.module("../src/db.js", () => ({ db: {} }))
  store = await import("../src/routes/org/plugin-system/store.js")
})

afterAll(() => {
  mock.restore()
})

function expectProbeProjection(rawSourceText: string) {
  const { projection } = store.deriveGithubImportedObjectProjection({
    objectType: "skill",
    path: "probe-plugin/skills/probe/SKILL.md",
    rawSourceText,
  })
  expect(projection.title).toBe("probe")
  expect(projection.description).toBe("Probe connector import")
  expect(projection.searchText).toContain("Run the probe checklist.")
}

test("derives a GitHub-imported skill projection from valid SKILL.md", () => {
  expectProbeProjection("---\nname: probe\ndescription: Probe connector import\n---\n\nRun the probe checklist.\n")
})

test("derives a GitHub-imported skill projection with CRLF line endings", () => {
  expectProbeProjection("---\r\nname: probe\r\ndescription: Probe connector import\r\n---\r\n\r\nRun the probe checklist.\r\n")
})

test("rejects a GitHub-imported skill without frontmatter", () => {
  try {
    store.deriveGithubImportedObjectProjection({
      objectType: "skill",
      path: "probe-plugin/skills/probe/SKILL.md",
      rawSourceText: "# No frontmatter\n\nBody.",
    })
    throw new Error("Expected skill projection to fail")
  } catch (error) {
    expect(error).toHaveProperty("error", "invalid_skill_frontmatter")
    expect(error).toHaveProperty("status", 400)
  }
})

test("strips frontmatter before deriving a GitHub-imported command projection", () => {
  const { projection } = store.deriveGithubImportedObjectProjection({
    objectType: "command",
    path: "probe-plugin/commands/run.md",
    rawSourceText: "---\nname: Run Probe\ndescription: Runs it\n---\nBody text.\n",
  })
  expect(projection.title).toBe("Run Probe")
  expect(projection.description).toBe("Runs it")
  expect(projection.searchText).not.toContain("name: Run Probe")
  expect(projection.searchText).toContain("Body text.")
})
