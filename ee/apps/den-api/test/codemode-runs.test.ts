import { createDenDb } from "@openwork-ee/den-db"
import { eq, sql } from "@openwork-ee/den-db/drizzle"
import { WorkflowRunTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"
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
  expect(adminRuns).toHaveLength(2)
  expect(memberRuns).toHaveLength(1)
  expect(memberRuns[0]?.org_membership_id).toBe(firstMemberId)
  expect(memberRuns[0]?.tool_call_count).toBe(1)
  expect(memberRuns[0]?.tool_calls).toEqual([{ name: "den.getV1Org" }])
})
