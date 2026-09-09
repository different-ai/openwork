import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { eq, sql } from "@openwork-ee/den-db/drizzle"
import { WorkerTable, WorkflowRunTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"
import { z } from "zod"
import { decodeKeysetCursor, encodeKeysetCursor, keysetCursorQuerySchema } from "../src/list-pagination.js"

// Proves the additive cursor pagination on the limit-only lists
// (docs/api-style.md#pagination): two pages join without gaps or duplicates
// and the no-cursor call keeps its default ordering and limit.

const API_ORIGIN = "http://127.0.0.1:8790"
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_list_pagination"
process.env.DB_MODE ??= "mysql"
process.env.DEN_DB_ENCRYPTION_KEY ??= "list-pagination-test-encryption-key-1234567890"
process.env.BETTER_AUTH_SECRET ??= "list-pagination-test-secret-123456789012"
process.env.BETTER_AUTH_URL ??= API_ORIGIN
process.env.CORS_ORIGINS ??= API_ORIGIN

type Db = typeof import("../src/db.js").db
type Workflows = typeof import("../src/workflows.js")
type WorkerList = typeof import("../src/workers/list.js")
type Middleware = typeof import("../src/middleware/index.js")

let db: Db
let workflows: Workflows
let workerList: WorkerList
let middleware: Middleware
let databaseAvailable = true

const organizationId = createDenTypeId("organization")
const workerOrgId = createDenTypeId("org")
const configObjectId = createDenTypeId("configObject")
const base = Date.UTC(2026, 8, 9, 12, 0, 0)

beforeAll(async () => {
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({ databaseUrl: process.env.DATABASE_URL, mode: "mysql" }).db
  db = realDb
  mock.module("../src/db.js", () => ({ db: realDb }))
  workflows = await import("../src/workflows.js")
  workerList = await import("../src/workers/list.js")
  middleware = await import("../src/middleware/index.js")
  try {
    await db.execute(sql`select 1`)
  } catch (error) {
    databaseAvailable = false
    console.warn("Skipping list pagination DB assertions because local MySQL is unavailable.", error)
  }
}, 20_000)

afterAll(async () => {
  if (!databaseAvailable) return
  await db.delete(WorkflowRunTable).where(eq(WorkflowRunTable.organization_id, organizationId))
  await db.delete(WorkerTable).where(eq(WorkerTable.org_id, workerOrgId))
})

function cursorFrom(nextCursor: string | null) {
  const decoded = decodeKeysetCursor(nextCursor ?? "")
  if (!decoded) throw new Error("expected a decodable nextCursor")
  return decoded
}

/** Walk every page with `limit` and return the joined ids plus the page count. */
async function walk<Item>(
  page: (cursor: ReturnType<typeof cursorFrom> | undefined) => Promise<{ items: Item[]; nextCursor: string | null }>,
  id: (item: Item) => string,
) {
  const ids: string[] = []
  let pages = 0
  let cursor: ReturnType<typeof cursorFrom> | undefined
  for (;;) {
    const result = await page(cursor)
    pages += 1
    ids.push(...result.items.map(id))
    if (result.nextCursor === null) return { ids, pages }
    cursor = cursorFrom(result.nextCursor)
  }
}

test("workflow snapshot pages join without gaps or duplicates and the no-cursor call is unchanged", async () => {
  if (!databaseAvailable) return

  // Two snapshots share a finished_at so the id tiebreaker is exercised.
  const finishedAt = [0, 1, 1, 2, 3].map((offset) => new Date(base + offset * 1000))
  const pluginId = createDenTypeId("plugin")
  const versionId = createDenTypeId("configObjectVersion")
  for (const at of finishedAt) {
    await db.insert(WorkflowRunTable).values({
      id: createDenTypeId("workflowRun"),
      organization_id: organizationId,
      plugin_id: pluginId,
      config_object_id: configObjectId,
      config_object_version_id: versionId,
      source: "workflow",
      code_digest: "sha256:test",
      status: "succeeded",
      tool_calls: [],
      started_at: at,
      finished_at: at,
    })
  }
  // A run of the same Workflow that never produced an artifact must stay excluded.
  await db.insert(WorkflowRunTable).values({
    id: createDenTypeId("workflowRun"),
    organization_id: organizationId,
    config_object_id: configObjectId,
    source: "workflow-test",
    code_digest: "sha256:test",
    status: "succeeded",
    tool_calls: [],
    started_at: new Date(base + 9000),
    finished_at: new Date(base + 9000),
  })

  const all = await workflows.workflowSnapshotPage(organizationId, configObjectId, {})
  expect(all.items).toHaveLength(5)
  expect(all.nextCursor).toBeNull()
  expect(all.items.map((item) => new Date(item.finishedAt).getTime())).toEqual(
    [...finishedAt].reverse().map((at) => at.getTime()),
  )

  const paged = await walk(
    (cursor) => workflows.workflowSnapshotPage(organizationId, configObjectId, { limit: 2, cursor }),
    (item) => item.receiptId,
  )
  expect(paged.pages).toBe(3)
  expect(paged.ids).toEqual(all.items.map((item) => item.receiptId))
  expect(new Set(paged.ids).size).toBe(5)
})

test("worker pages join without gaps or duplicates and the no-cursor call is unchanged", async () => {
  if (!databaseAvailable) return

  // Two workers share a created_at so the id tiebreaker is exercised.
  const createdAt = [0, 1, 1, 2, 3].map((offset) => new Date(base + offset * 1000))
  for (const [index, at] of createdAt.entries()) {
    await db.insert(WorkerTable).values({
      id: createDenTypeId("worker"),
      org_id: workerOrgId,
      name: `worker-${index}`,
      destination: "local",
      status: "healthy",
      created_at: at,
      updated_at: at,
    })
  }
  // Another organization's worker must never appear.
  await db.insert(WorkerTable).values({
    id: createDenTypeId("worker"),
    org_id: createDenTypeId("org"),
    name: "foreign",
    destination: "local",
    status: "healthy",
  })

  const all = await workerList.listWorkersPage({ orgId: workerOrgId, limit: 20 })
  expect(all.items).toHaveLength(5)
  expect(all.nextCursor).toBeNull()
  expect(all.items.map((row) => row.created_at.getTime())).toEqual(
    [...createdAt].reverse().map((at) => at.getTime()),
  )

  const paged = await walk(
    (cursor) => workerList.listWorkersPage({ orgId: workerOrgId, limit: 2, cursor }),
    (row) => row.id,
  )
  expect(paged.pages).toBe(3)
  expect(paged.ids).toEqual(all.items.map((row) => row.id))
  expect(new Set(paged.ids).size).toBe(5)
})

test("an undecodable cursor is a 400 invalid_request and a valid one reaches the handler decoded", async () => {
  const app = new Hono()
  app.get(
    "/list",
    middleware.queryValidator(z.object({ cursor: keysetCursorQuerySchema.optional() })),
    (c) => c.json({ cursor: c.req.valid("query").cursor ?? null }),
  )

  const invalid = await app.request("/list?cursor=not-a-cursor")
  expect(invalid.status).toBe(400)
  const invalidBody: unknown = await invalid.json()
  expect(invalidBody).toMatchObject({ error: "invalid_request" })
  expect(JSON.stringify(invalidBody)).toContain("Invalid cursor.")

  const key = { at: new Date(base), id: "wfr_01cursor" }
  const valid = await app.request(`/list?cursor=${encodeKeysetCursor(key)}`)
  expect(valid.status).toBe(200)
  expect(await valid.json()).toEqual({ cursor: { at: key.at.toISOString(), id: key.id } })

  const first = await app.request("/list")
  expect(first.status).toBe(200)
  expect(await first.json()).toEqual({ cursor: null })
})
