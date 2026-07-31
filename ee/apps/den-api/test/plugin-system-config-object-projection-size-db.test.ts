import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
process.env.DB_MODE ??= "mysql"
process.env.DEN_DB_ENCRYPTION_KEY ??= "projection-size-test-key-1234567890"
process.env.BETTER_AUTH_SECRET ??= "projection-size-test-secret-123456"
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"

let db: typeof import("../src/db.js").db
let eq: typeof import("@openwork-ee/den-db/drizzle").eq
let store: typeof import("../src/routes/org/plugin-system/store.js")

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")

const MYSQL_TEXT_MAX_BYTES = 65_535

async function clearSeededRows() {
  await db.delete(ConfigObjectVersionTable).where(eq(ConfigObjectVersionTable.organizationId, organizationId))
  await db.delete(ConfigObjectAccessGrantTable).where(eq(ConfigObjectAccessGrantTable.organizationId, organizationId))
  await db.delete(ConfigObjectTable).where(eq(ConfigObjectTable.organizationId, organizationId))
  await db.delete(MemberTable).where(eq(MemberTable.organizationId, organizationId))
  await db.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
}

beforeAll(async () => {
  const [dbModule, drizzleModule, storeModule] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/routes/org/plugin-system/store.js"),
  ])
  db = dbModule.db
  eq = drizzleModule.eq
  store = storeModule
  await clearSeededRows()
  await db.insert(OrganizationTable).values({
    id: organizationId,
    name: "Projection Size Test",
    slug: `projection-size-test-${organizationId.slice(-8)}`,
  })
  await db.insert(MemberTable).values({
    id: memberId,
    organizationId,
    role: "owner",
    userId,
  })
})

afterAll(async () => {
  if (db) await clearSeededRows()
})

function ownerContext(): PluginArchActorContext {
  const now = new Date("2026-07-31T00:00:00.000Z")
  return {
    memberTeams: [],
    organizationContext: {
      organization: {
        id: organizationId,
        name: "Projection Size Test",
        slug: `projection-size-test-${organizationId.slice(-8)}`,
        logo: null,
        allowedEmailDomains: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      },
      currentMember: {
        id: memberId,
        userId,
        role: "owner",
        createdAt: now,
        joinedAt: now,
        isOwner: true,
      },
      invitations: [],
      members: [],
      roles: [],
      teams: [],
    },
    session: { createdAt: now },
  }
}

function skillMarkdown(input: { body: string; name: string }) {
  return [
    "---",
    `name: ${input.name}`,
    "description: Babysits an open GitHub PR until merge-ready, reacting to review comments and CI failures.",
    "---",
    "",
    input.body,
  ].join("\n")
}

function paddedBody(input: { paragraph: string; targetBytes: number }) {
  const paragraphBytes = Buffer.byteLength(input.paragraph, "utf8")
  const repeats = Math.ceil(input.targetBytes / paragraphBytes)
  return Array.from({ length: repeats }, (_value, index) => `## Section ${index}\n\n${input.paragraph}`).join("\n\n")
}

async function readStoredRow(configObjectId: string) {
  const rows = await db.select().from(ConfigObjectTable).where(eq(ConfigObjectTable.id, configObjectId))
  const row = rows[0]
  if (!row) throw new Error(`config object ${configObjectId} was not persisted`)
  return row
}

// Regression: a real GitHub skill import (POST /v1/plugins/import-mcps-from-github-url) failed with
// MySQL 1406 because search_text was TEXT (65,535 bytes) while the projection carries the whole
// SKILL.md body. Migration 0048 widened config_object_version payloads but missed this column.
test("a skill larger than the MySQL TEXT ceiling keeps its full search projection", async () => {
  const body = paddedBody({
    paragraph: "Keep the PR moving toward merge by reacting to review comments, CI status changes, and branch currency as each arrives.",
    targetBytes: MYSQL_TEXT_MAX_BYTES + 20_000,
  })
  const rawSourceText = skillMarkdown({ body, name: "babysit-pr" })
  expect(Buffer.byteLength(rawSourceText, "utf8")).toBeGreaterThan(MYSQL_TEXT_MAX_BYTES)

  const created = await store.createConfigObject({
    context: ownerContext(),
    objectType: "skill",
    sourceMode: "import",
    value: { rawSourceText },
  })

  const row = await readStoredRow(created.id)
  expect(row.title).toBe("babysit-pr")
  expect(row.searchText).toBe([
    "babysit-pr",
    "Babysits an open GitHub PR until merge-ready, reacting to review comments and CI failures.",
    body,
  ].join("\n"))
})

// Byte-vs-character trap: under the 65,535 character limit the response schema declares, but over the
// 65,535 byte limit the column enforced, because em dashes cost 3 bytes each in UTF-8.
test("a multibyte skill under the character limit but over the byte limit persists", async () => {
  const body = paddedBody({
    paragraph: "Résumé — babysit the PR — react to review comments — keep the base current — never force-push. 日本語のテキストも含む。",
    targetBytes: MYSQL_TEXT_MAX_BYTES + 5_000,
  })
  const rawSourceText = skillMarkdown({ body, name: "babysit-pr-multibyte" })
  expect(rawSourceText.length).toBeLessThan(MYSQL_TEXT_MAX_BYTES)
  expect(Buffer.byteLength(rawSourceText, "utf8")).toBeGreaterThan(MYSQL_TEXT_MAX_BYTES)

  const created = await store.createConfigObject({
    context: ownerContext(),
    objectType: "skill",
    sourceMode: "import",
    value: { rawSourceText },
  })

  const row = await readStoredRow(created.id)
  expect(row.searchText).toContain("日本語のテキストも含む。")
})

// The same insert carries title varchar(255), and the non-skill branch derives it from an unclamped
// metadata name ("<pluginName> / <serverName>") or the first line of an arbitrary connector file.
test("an over-long derived title is clamped to the column width instead of failing the insert", async () => {
  const pluginName = "A".repeat(240)
  const serverName = "B".repeat(80)

  const created = await store.createConfigObject({
    context: ownerContext(),
    objectType: "mcp",
    sourceMode: "import",
    value: {
      metadata: { name: `${pluginName} / ${serverName}` },
      normalizedPayloadJson: { type: "http", url: "https://example.com/mcp" },
    },
  })

  const row = await readStoredRow(created.id)
  expect(row.title.length).toBe(255)
  expect(row.title.startsWith("A".repeat(240))).toBe(true)
})

// Non-skill objects (connector-synced agents, commands, context files) have no authored contract to
// reject, so their projection is clamped to the same budget instead of bloating list responses.
test("a non-skill source beyond the 1 MiB budget is clamped without losing valid UTF-8", async () => {
  const rawSourceText = `Oversized Agent\n${paddedBody({
    paragraph: "Agent instructions padded with multibyte content — 日本語 — to cross the budget.",
    targetBytes: 1_048_576 + 5_000,
  })}`
  expect(Buffer.byteLength(rawSourceText, "utf8")).toBeGreaterThan(1_048_576)

  const created = await store.createConfigObject({
    context: ownerContext(),
    objectType: "agent",
    sourceMode: "import",
    value: { rawSourceText },
  })

  const row = await readStoredRow(created.id)
  expect(row.searchText).not.toBeNull()
  const searchText = row.searchText ?? ""
  expect(Buffer.byteLength(searchText, "utf8")).toBeLessThanOrEqual(1_048_576)
  expect(searchText).not.toContain("\uFFFD")
  expect(searchText.startsWith("Oversized Agent")).toBe(true)
})

// A pathological repository should fail the request cleanly rather than 500 on the driver, matching
// the 1 MiB cap the public config-object route already enforces.
test("a skill beyond the 1 MiB payload cap is rejected with a 400 instead of a driver error", async () => {
  const body = paddedBody({
    paragraph: "Oversized skill content that no real repository would ship.",
    targetBytes: 1_048_576 + 1_000,
  })
  const rawSourceText = skillMarkdown({ body, name: "oversized-skill" })
  expect(Buffer.byteLength(rawSourceText, "utf8")).toBeGreaterThan(1_048_576)

  const failure = await store.createConfigObject({
    context: ownerContext(),
    objectType: "skill",
    sourceMode: "import",
    value: { rawSourceText },
  }).then(() => null, (error: unknown) => error)

  expect(failure).toBeInstanceOf(Error)
  expect(failure).toMatchObject({ error: "skill_source_too_large", status: 400 })
})
