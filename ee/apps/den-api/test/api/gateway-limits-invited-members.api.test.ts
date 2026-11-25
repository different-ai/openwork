/**
 * Spend limits for people who have not accepted their invitation yet.
 *
 * 1. A limit can be assigned to an invited person: it is theirs from the
 *    moment they join.
 * 2. A canceled invitation can't be given a limit.
 * 3. Someone who became a member another way and then accepts the invitation
 *    keeps the limit that was assigned to the invitation.
 * 4. A configuration import invites the people of the file and assigns their
 *    limits in the same run: nothing is left for a second import, and the
 *    same file again writes nothing.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { ConfigApplyReport, ConfigBlob, ConfigChangeRequestSummary, ConfigPlan, ConfigPlanItem } from "@openwork/types/den/config-blobs"
import { gatewayFixtureEnv } from "./gateway-fixture.js"
import { bootDen, field, isRecord, list, summary, text, type Call, type Session } from "./harness.js"

const den = await bootDen({ env: gatewayFixtureEnv })
after(async () => {
  await den.close()
})

const { runConfigBlobWorkerOnce } = await import("../../src/config-blobs/worker.js")
const { db } = await import("../../src/db.js")
const { and, eq } = await import("@openwork-ee/den-db/drizzle")
const { GatewayUsageAssignmentTable, MemberTable } = await import("@openwork-ee/den-db/schema")
const { createDenTypeId, normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")

const AREAS = "members.people,ai-gateway.limits"
const BLOCKING = ["needs_mapping", "ref_unresolved", "drift", "collision.unique", "conflict.identity", "blocked", "needs_input"]

type Api = ReturnType<typeof den.as>

async function ok(call: Promise<Call>, label: string): Promise<Call> {
  const result = await call
  assert.ok(result.status < 300, `${label}: ${summary(result)}`)
  return result
}

async function invite(api: Api, email: string): Promise<{ memberId: string; inviteToken: string; invitationId: string }> {
  const invited = await ok(api("POST", "/v1/invitations", { email, role: "member" }), `invite ${email}`)
  const roster = await ok(api("GET", "/v1/org"), "roster")
  const member = list(field(roster.body, "members")).find((entry) => field(entry, "user", "email") === email)
  const invitation = list(field(roster.body, "invitations")).find((entry) => entry.email === email)
  return {
    memberId: text(member?.id, `member row of ${email}`),
    inviteToken: text(field(invited.body, "inviteToken"), "invite token"),
    invitationId: text(invitation?.id, `invitation of ${email}`),
  }
}

async function createLimit(api: Api, name: string): Promise<string> {
  const created = await ok(api("POST", "/v1/gateway/usage-limit-policies", { name, hardLimit: false, allowRequestReset: true, limits: [{ timeframe: "day", costUsd: "5" }] }), `limit ${name}`)
  return text(field(created.body, "id"), "limit id")
}

/** Member ids a limit is assigned to directly. */
async function assignedMembers(api: Api, name: string): Promise<string[]> {
  const policies = await ok(api("GET", "/v1/gateway/usage-limit-policies"), "limits")
  const policy = list(field(policies.body, "policies")).find((entry) => entry.name === name)
  assert.ok(policy, `limit "${name}" exists: ${summary(policies)}`)
  return list(policy.assignments).flatMap((entry) => typeof entry.memberId === "string" ? [entry.memberId] : []).sort()
}

/** The names of the limits that apply to the person asking. */
async function ownLimits(person: Session, orgId: string): Promise<string> {
  const status = await ok(den.as(person, orgId)("GET", "/v1/gateway/usage-limits/me"), "own limits")
  return status.text
}

const ada = await den.signUp("Ada Owner")
const orgA = await den.createOrg(ada, "Limits for invited people")
const apiA = den.as(ada, orgA.orgId)

test("a limit is assigned to an invited person and applies once they join", async () => {
  const bo = await den.signUp("Bo Invited")
  const pending = await invite(apiA, bo.email)
  const limit = await createLimit(apiA, "Bo spend")

  await ok(apiA("POST", `/v1/gateway/usage-limit-policies/${limit}/assignments`, { memberId: pending.memberId }), "assign to an invited person")
  assert.deepEqual(await assignedMembers(apiA, "Bo spend"), [pending.memberId])

  await ok(den.request(bo.token, "POST", "/v1/orgs/invitations/accept", { body: { id: pending.inviteToken } }), "accept")
  // Same member row, now Bo's: the limit is theirs without anyone assigning it again.
  assert.deepEqual(await assignedMembers(apiA, "Bo spend"), [pending.memberId])
  assert.match(await ownLimits(bo, orgA.orgId), /Bo spend/)
})

test("a canceled invitation can't be given a limit", async () => {
  const cy = await den.signUp("Cy Canceled")
  const pending = await invite(apiA, cy.email)
  const limit = await createLimit(apiA, "Cy spend")
  await ok(apiA("POST", `/v1/invitations/${pending.invitationId}/cancel`, {}), "cancel invitation")

  const refused = await apiA("POST", `/v1/gateway/usage-limit-policies/${limit}/assignments`, { memberId: pending.memberId })
  assert.equal(refused.status, 404, summary(refused))
  assert.deepEqual(await assignedMembers(apiA, "Cy spend"), [])
})

test("someone who is already a member when they accept keeps the limit of their invitation", async () => {
  const di = await den.signUp("Di Twice")
  const pending = await invite(apiA, di.email)
  const limit = await createLimit(apiA, "Di spend")
  await ok(apiA("POST", `/v1/gateway/usage-limit-policies/${limit}/assignments`, { memberId: pending.memberId }), "assign to an invited person")

  // ARRANGE: Di became a member another way (directory sync, a second sign-in route) while the invitation was pending.
  const joined = createDenTypeId("member")
  await db.insert(MemberTable).values({
    id: joined,
    organizationId: normalizeDenTypeId("organization", orgA.orgId),
    userId: normalizeDenTypeId("user", di.userId),
    role: "member",
    joinedAt: new Date(),
  })

  await ok(den.request(di.token, "POST", "/v1/orgs/invitations/accept", { body: { id: pending.inviteToken } }), "accept")
  assert.deepEqual(await assignedMembers(apiA, "Di spend"), [joined])
  const left = await db.select({ id: GatewayUsageAssignmentTable.id }).from(GatewayUsageAssignmentTable)
    .where(and(eq(GatewayUsageAssignmentTable.policyId, limit), eq(GatewayUsageAssignmentTable.memberId, normalizeDenTypeId("member", pending.memberId))))
  assert.deepEqual(left, [], "nothing stays on the invitation's deleted member row")
  assert.match(await ownLimits(di, orgA.orgId), /Di spend/)
})

// ---------------------------------------------------------------------------
// Configuration import

function asBlob(value: unknown): ConfigBlob {
  assert.ok(isRecord(value) && value.format === "openwork.config-blob", "a config blob")
  return JSON.parse(JSON.stringify(value))
}

function asSummary(call: Call): ConfigChangeRequestSummary {
  const value = field(call.body, "changeRequest")
  assert.ok(isRecord(value) && typeof value.id === "string", summary(call))
  return JSON.parse(JSON.stringify(value))
}

function asPlan(value: unknown): ConfigPlan {
  assert.ok(isRecord(value) && typeof value.planHash === "string", "a plan")
  return JSON.parse(JSON.stringify(value))
}

const planItems = (plan: ConfigPlan): ConfigPlanItem[] => plan.areas.flatMap((area) => area.items)
const nameOf = (item: ConfigPlanItem) => item.blob?.name ?? item.target?.name ?? ""
const writes = (plan: ConfigPlan) => planItems(plan).filter((item) => ["create", "update", "rename", "delete"].includes(item.op))
const describe = (items: readonly ConfigPlanItem[]) => JSON.stringify(items.map((item) => ({ area: item.area, name: nameOf(item), op: item.op, flags: item.flags, reasons: item.reasons })), null, 1)

async function drive(api: Api, id: string): Promise<ConfigChangeRequestSummary> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await runConfigBlobWorkerOnce()
    const current = asSummary(await ok(api("GET", `/v1/config-blobs/change-requests/${id}`), "change request"))
    if (!["uploaded", "analyzing", "queued", "applying", "stale"].includes(current.status)) return current
  }
  throw new Error(`change request ${id} never settled`)
}

async function upload(api: Api, blob: ConfigBlob, title: string): Promise<{ id: string; plan: ConfigPlan }> {
  const request = asSummary(await ok(api("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge", title }), "upload"))
  const analyzed = await drive(api, request.id)
  assert.equal(analyzed.status, "needs_review", JSON.stringify(analyzed.errors))
  await ok(api("PUT", `/v1/config-blobs/change-requests/${request.id}/decisions`, { skips: [], refs: [], people: { sendInviteEmails: false } }), "decisions")
  return { id: request.id, plan: asPlan(field((await ok(api("GET", `/v1/config-blobs/change-requests/${request.id}/plan`), "plan")).body, "plan")) }
}

async function apply(api: Api, id: string, plan: ConfigPlan): Promise<ConfigApplyReport> {
  const queued = await ok(api("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: plan.planHash }), "approve and apply")
  assert.equal(asSummary(queued).status, "queued")
  const settled = await drive(api, id)
  const detail = await ok(api("GET", `/v1/config-blobs/change-requests/${id}`), "detail")
  const runs: ConfigApplyReport[] = JSON.parse(JSON.stringify(field(detail.body, "runs") ?? []))
  const run = runs[0]
  assert.ok(run, "one run")
  assert.equal(settled.status, "applied", `${JSON.stringify(settled.errors)}\n${JSON.stringify(run.items.filter((entry) => entry.status === "failed"), null, 1)}`)
  assert.equal(run.counts.failed, 0)
  return run
}

test("an import assigns limits to the people it invites in the same run", async () => {
  // The source: two people who joined, one limit for both.
  const eli = await den.newMember(ada, orgA.orgId, "Eli Source")
  const fay = await den.newMember(ada, orgA.orgId, "Fay Source")
  const limit = await createLimit(apiA, "Pair spend")
  for (const memberId of [eli.memberId, fay.memberId]) {
    await ok(apiA("POST", `/v1/gateway/usage-limit-policies/${limit}/assignments`, { memberId }), "limit assignment")
  }
  const exported = asBlob((await ok(apiA("GET", `/v1/config-blobs/export?areas=${AREAS}`), "export")).body)
  // Only the limit of this test travels.
  const limits = field(exported.areas, "ai-gateway", "limits")
  assert.ok(isRecord(limits) && Array.isArray(limits.items))
  limits.items = limits.items.filter((entry) => isRecord(entry) && entry.name === "Pair spend")

  const ian = await den.signUp("Ian Importer")
  const orgB = await den.createOrg(ian, "Limits copy")
  const apiB = den.as(ian, orgB.orgId)

  const first = await upload(apiB, exported, "People and limits")
  const blockingItems = planItems(first.plan).filter((item) => item.flags.some((flag) => BLOCKING.includes(flag)))
  assert.deepEqual(blockingItems, [], describe(blockingItems))
  const planned = planItems(first.plan).find((item) => item.area === "ai-gateway.limits" && nameOf(item) === "Pair spend")
  assert.ok(planned, describe(planItems(first.plan)))
  assert.equal(planned.op, "create", describe([planned]))
  assert.doesNotMatch((planned.reasons ?? []).join("\n"), /will not be assigned yet|Import again/)

  const run = await apply(apiB, first.id, first.plan)
  const warnings = run.items.flatMap((entry) => entry.warnings.map((warning) => `${entry.area}: ${warning}`))
  assert.deepEqual(warnings.filter((warning) => warning.startsWith("ai-gateway.limits")), [], warnings.join("\n"))

  // Both people are invited, not joined, and hold the limit.
  const roster = await ok(apiB("GET", "/v1/org"), "roster")
  const invited = list(field(roster.body, "members")).filter((entry) => [eli.email, fay.email].includes(String(field(entry, "user", "email"))))
  assert.equal(invited.length, 2, summary(roster))
  assert.ok(invited.every((entry) => entry.joinedAt === null || entry.joinedAt === undefined), "nobody has joined yet")
  assert.deepEqual(await assignedMembers(apiB, "Pair spend"), invited.map((entry) => text(entry.id, "member id")).sort())

  // The same file again: nothing to write, nothing to skip for later.
  const again = await upload(apiB, exported, "People and limits again")
  assert.deepEqual(writes(again.plan), [], describe(writes(again.plan)))
  assert.doesNotMatch(JSON.stringify(planItems(again.plan).map((item) => item.reasons)), /Import again/)
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${again.id}/cancel`, {}), "cancel")

  // Eli joins: the limit applies without another import.
  const invitation = list(field(roster.body, "invitations")).find((entry) => entry.email === eli.email)
  await ok(den.request(eli.token, "POST", "/v1/orgs/invitations/accept", { body: { id: text(invitation?.id, "invitation id") } }), "accept")
  assert.match(await ownLimits(eli, orgB.orgId), /Pair spend/)
})
