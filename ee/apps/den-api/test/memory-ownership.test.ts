import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"

// TASK-2 [B4]: the cross-user access regression test — the merge gate. Requires a local
// MySQL with the memory schema pushed (pnpm --filter @openwork-ee/den-db db:push).

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let session: typeof import("../src/session.js")

const alice = createDenTypeId("user")
const bob = createDenTypeId("user")
const aliceOrg = createDenTypeId("organization")
const bobOrg = createDenTypeId("organization")

beforeAll(async () => {
  seedRequiredEnv()
  const [appMod, dbMod, schemaMod, drizzleMod, sessionMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/session.js"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  session = sessionMod

  await db.insert(schema.AuthUserTable).values([
    { id: alice, name: "Alice", email: `alice+${alice}@memory.test.local` },
    { id: bob, name: "Bob", email: `bob+${bob}@memory.test.local` },
  ])
  // orgMemberRoute() on POST /v1/memory only lets a caller save to an org they are a member of,
  // so each user needs a real org + membership row (slug carries the id to stay unique).
  await db.insert(schema.OrganizationTable).values([
    { id: aliceOrg, name: "Alice Org", slug: `alice-org-${aliceOrg}` },
    { id: bobOrg, name: "Bob Org", slug: `bob-org-${bobOrg}` },
  ])
  await db.insert(schema.MemberTable).values([
    { id: createDenTypeId("member"), organizationId: aliceOrg, userId: alice, role: "owner" },
    { id: createDenTypeId("member"), organizationId: bobOrg, userId: bob, role: "owner" },
  ])
})

afterAll(async () => {
  const ids = [alice, bob]
  const memories = await db
    .select({ id: schema.MemoryTable.id })
    .from(schema.MemoryTable)
    .where(drizzle.inArray(schema.MemoryTable.user_id, ids))
  const memoryIds = memories.map((row) => row.id)
  if (memoryIds.length > 0) {
    await db.delete(schema.MemoryContextTable).where(drizzle.inArray(schema.MemoryContextTable.memory_id, memoryIds))
    await db.delete(schema.MemoryTable).where(drizzle.inArray(schema.MemoryTable.id, memoryIds))
  }
  const orgIds = [aliceOrg, bobOrg]
  await db.delete(schema.MemberTable).where(drizzle.inArray(schema.MemberTable.organizationId, orgIds))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.inArray(schema.OrganizationRoleTable.organizationId, orgIds))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, orgIds))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, ids))
})

function request(
  method: string,
  path: string,
  who: { userId: string; organizationId: string },
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader(who),
  }
  if (body !== undefined) headers["content-type"] = "application/json"
  return app.fetch(
    new Request(`http://den-api.local${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

test("cross-user access is denied — save, IDOR 404, recall, cascade delete", async () => {
  const aliceCreds = { userId: alice, organizationId: aliceOrg }
  const bobCreds = { userId: bob, organizationId: bobOrg }

  // Alice saves a memory with a context.
  const saveRes = await request("POST", "/v1/memory", aliceCreds, {
    content: "Acme renewal deal closes in Q3 at 5000 per month",
    tags: ["acme", "deal"],
    contexts: [{ snippet: "we agreed on 5000/mo", origin: "active_conversation" }],
  })
  expect(saveRes.status).toBe(201)
  const saved = await saveRes.json()
  const memoryId: string = saved.memory.id
  expect(memoryId.startsWith("mem_")).toBe(true)
  expect(saved.memory.scope).toBe("user")

  // Bob cannot delete Alice's memory — 404, non-leaking.
  const bobDelete = await request("DELETE", `/v1/memory/${memoryId}`, bobCreds)
  expect(bobDelete.status).toBe(404)

  // Bob's list + search never surface Alice's memory.
  const bobList = await (await request("GET", "/v1/memory", bobCreds)).json()
  expect(bobList.memories.some((m: { id: string }) => m.id === memoryId)).toBe(false)
  const bobSearch = await (await request("GET", "/v1/memory/search?q=Acme", bobCreds)).json()
  expect(bobSearch.results.some((m: { id: string }) => m.id === memoryId)).toBe(false)

  // Alice still owns it after Bob's attempts, and natural-language recall finds it.
  const aliceSearch = await (await request("GET", "/v1/memory/search?q=Acme%20renewal%20deal", aliceCreds)).json()
  expect(aliceSearch.results.some((m: { id: string }) => m.id === memoryId)).toBe(true)

  // Owner delete cascades to context rows and is idempotent (second delete → 404).
  const aliceDelete = await request("DELETE", `/v1/memory/${memoryId}`, aliceCreds)
  expect(aliceDelete.status).toBe(204)
  const remainingContexts = await db
    .select({ id: schema.MemoryContextTable.id })
    .from(schema.MemoryContextTable)
    .where(drizzle.eq(schema.MemoryContextTable.memory_id, memoryId))
  expect(remainingContexts.length).toBe(0)
  expect((await request("DELETE", `/v1/memory/${memoryId}`, aliceCreds)).status).toBe(404)
})

test("empty search returns 200 with an empty result set (not an error)", async () => {
  const res = await request("GET", "/v1/memory/search?q=zzzznonexistentqueryzzzz", { userId: alice, organizationId: aliceOrg })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.results).toEqual([])
})

test("client-supplied scope='org' is forced to 'user' server-side", async () => {
  const res = await request("POST", "/v1/memory", { userId: alice, organizationId: aliceOrg }, {
    content: "scope forcing check",
    scope: "org",
  })
  expect(res.status).toBe(201)
  const saved = await res.json()
  expect(saved.memory.scope).toBe("user")
  const row = await db.select().from(schema.MemoryTable).where(drizzle.eq(schema.MemoryTable.id, saved.memory.id))
  expect(row[0]?.scope).toBe("user")
})

test("input bounds are enforced (400)", async () => {
  const res = await request("POST", "/v1/memory", { userId: alice, organizationId: aliceOrg }, {
    content: "x".repeat(100_000),
  })
  expect(res.status).toBe(400)
})

test("saving to an org the caller is not a member of is rejected (404) — orgMemberRoute gate", async () => {
  // Alice presents a principal scoped to Bob's org, which she does not belong to.
  const res = await request("POST", "/v1/memory", { userId: alice, organizationId: bobOrg }, {
    content: "should never persist under a non-member org",
  })
  expect(res.status).toBe(404)
  // Nothing was written for Alice under Bob's org.
  const rows = await db
    .select({ id: schema.MemoryTable.id })
    .from(schema.MemoryTable)
    .where(drizzle.and(drizzle.eq(schema.MemoryTable.user_id, alice), drizzle.eq(schema.MemoryTable.org_id, bobOrg)))
  expect(rows.length).toBe(0)
})
