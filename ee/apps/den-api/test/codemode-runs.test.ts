import { createDenDb } from "@openwork-ee/den-db"
import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import { WorkflowRunTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { decodeKeysetCursor, encodeKeysetCursor } from "../src/list-pagination.js"
import {
  codemodeCodeDigest,
  listWorkflowRuns,
  parseCodemodeToolCalls,
  recordWorkflowRun,
  type RecordWorkflowRunInput,
} from "../src/workflow-runs.js"

const databaseUrl = "mysql://root:password@127.0.0.1:3306/openwork_test_workflow_runs"
const database = createDenDb({ databaseUrl, mode: "mysql" }).db
const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const firstMemberId = createDenTypeId("member")
const secondMemberId = createDenTypeId("member")
let databaseAvailable = true

beforeAll(async () => {
  try {
    await database.execute(sql`select 1`)
  } catch (error) {
    databaseAvailable = false
    console.warn("Skipping Workflow run DB assertions because local MySQL is unavailable.", error)
  }
}, 20_000)

afterAll(async () => {
  if (databaseAvailable) {
    await database.delete(WorkflowRunTable).where(eq(WorkflowRunTable.organization_id, organizationId))
    await database.delete(WorkflowRunTable).where(eq(WorkflowRunTable.organization_id, otherOrganizationId))
  }
})

test("code digest is stable and sha256-prefixed", () => {
  const digest = codemodeCodeDigest("return await tools.den.getV1Org({})")
  expect(digest).toBe(codemodeCodeDigest("return await tools.den.getV1Org({})"))
  expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/)
})

test("tool call receipts accept MySQL JSON text and reject malformed entries", () => {
  expect(parseCodemodeToolCalls('[{"name":"tools.reports.echo"}]')).toEqual([{ name: "tools.reports.echo" }])
  expect(parseCodemodeToolCalls("[]")).toEqual([])
  expect(() => parseCodemodeToolCalls('[{}]')).toThrow("workflow_run_tool_calls_invalid")
})

test("records and lists organization and member-scoped runs", async () => {
  if (!databaseAvailable) return

  const now = new Date()
  const common: Omit<RecordWorkflowRunInput, "organizationId" | "orgMembershipId"> = {
    code: "return true",
    source: "adhoc",
    status: "succeeded",
    toolCalls: [{ name: "den.getV1Org" }],
    durationMs: 12,
    startedAt: now,
    finishedAt: now,
  }
  const workflowRunId = await recordWorkflowRun(database, { ...common, organizationId, orgMembershipId: firstMemberId })
  await recordWorkflowRun(database, { ...common, organizationId, orgMembershipId: secondMemberId })
  await recordWorkflowRun(database, { ...common, organizationId: otherOrganizationId, orgMembershipId: firstMemberId })

  const adminRuns = await listWorkflowRuns(database, { organizationId })
  const memberRuns = await listWorkflowRuns(database, { organizationId, orgMembershipId: firstMemberId })

  expect(workflowRunId).toStartWith("wfr_")
  expect(adminRuns.items).toHaveLength(2)
  expect(adminRuns.nextCursor).toBeNull()
  expect(memberRuns.items).toHaveLength(1)
  expect(memberRuns.items[0]?.org_membership_id).toBe(firstMemberId)
  expect(memberRuns.items[0]?.tool_call_count).toBe(1)
  expect(memberRuns.items[0]?.tool_calls).toEqual([{ name: "den.getV1Org" }])
})

test("keyset cursors round-trip and reject malformed input", () => {
  const key = { at: new Date("2026-09-09T10:00:00.123Z"), id: "wfr_01test" }
  const cursor = encodeKeysetCursor(key)
  expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(decodeKeysetCursor(cursor)).toEqual(key)
  expect(decodeKeysetCursor("not base64url!")).toBeNull()
  expect(decodeKeysetCursor(Buffer.from("[]").toString("base64url"))).toBeNull()
  expect(decodeKeysetCursor(Buffer.from('{"at":"1","id":"x"}').toString("base64url"))).toBeNull()
  expect(decodeKeysetCursor(Buffer.from('{"at":1,"id":""}').toString("base64url"))).toBeNull()
})

test("workflow run pages join without gaps or duplicates and the no-cursor call is unchanged", async () => {
  if (!databaseAvailable) return

  const pagedOrganizationId = createDenTypeId("organization")
  const base = Date.UTC(2026, 8, 9, 12, 0, 0)
  // Two runs share a created_at so the id tiebreaker is exercised.
  const createdAt = [0, 1, 1, 2, 3].map((offset) => new Date(base + offset * 1000))
  for (const at of createdAt) {
    await recordWorkflowRun(database, {
      organizationId: pagedOrganizationId,
      code: "return true",
      source: "adhoc",
      status: "succeeded",
      toolCalls: [],
      durationMs: 1,
      startedAt: at,
      finishedAt: at,
    })
    await database.update(WorkflowRunTable).set({ created_at: at })
      .where(and(eq(WorkflowRunTable.organization_id, pagedOrganizationId), eq(WorkflowRunTable.started_at, at)))
  }
  try {
    const all = await listWorkflowRuns(database, { organizationId: pagedOrganizationId })
    expect(all.items).toHaveLength(5)
    expect(all.nextCursor).toBeNull()
    expect(all.items.map((row) => row.created_at.getTime())).toEqual(
      [...createdAt].reverse().map((at) => at.getTime()),
    )

    const first = await listWorkflowRuns(database, { organizationId: pagedOrganizationId, limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await listWorkflowRuns(database, {
      organizationId: pagedOrganizationId,
      limit: 2,
      cursor: decodeKeysetCursor(first.nextCursor ?? "") ?? undefined,
    })
    expect(second.items).toHaveLength(2)
    expect(second.nextCursor).not.toBeNull()
    const third = await listWorkflowRuns(database, {
      organizationId: pagedOrganizationId,
      limit: 2,
      cursor: decodeKeysetCursor(second.nextCursor ?? "") ?? undefined,
    })
    expect(third.items).toHaveLength(1)
    expect(third.nextCursor).toBeNull()

    const joined = [...first.items, ...second.items, ...third.items].map((row) => row.id)
    expect(joined).toEqual(all.items.map((row) => row.id))
    expect(new Set(joined).size).toBe(5)
  } finally {
    await database.delete(WorkflowRunTable).where(eq(WorkflowRunTable.organization_id, pagedOrganizationId))
  }
})
