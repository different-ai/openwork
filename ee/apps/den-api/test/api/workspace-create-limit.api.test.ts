import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { MemberTable, PlatformAuditEventTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, summary, text, type Session } from "./harness.js"

const den = await bootDen({ env: { DEN_AUDIT_CAPTURE_ENABLED: "true", DEN_WORKSPACE_CREATE_LIMIT_CONTACT: "mailto:limits@example.test" } })
after(() => den.close())
const { db } = await import("../../src/db.js")
const { updateFeatureRollout } = await import("../../src/features.js")
const admin = await den.signUp("Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
before(() => updateFeatureRollout({ key: "workspaceCreateLimit", enabled: true, defaultEnabled: false }))

const create = (person: Session, name: string) => den.request(person.token, "POST", "/v1/org", { body: { name } })
const setLimit = (actor: Session, person: Session, limit: number | null | "default") =>
  den.request(actor.token, "PUT", `/v1/admin/users/${person.userId}/workspace-limit`, { body: { limit } })

function assertRefused(call: Awaited<ReturnType<typeof create>>, limit: number) {
  assert.equal(call.status, 403, summary(call))
  assert.equal(field(call.body, "error"), "workspace_limit_reached")
  assert.equal(field(call.body, "limit"), limit)
  assert.equal(field(call.body, "message"), `You've reached the limit of ${limit} workspaces. Contact us to raise it.`)
  assert.equal(field(call.body, "contact"), "mailto:limits@example.test")
}

test("three workspaces succeed, the fourth is refused with the typed error and recorded for admins", async () => {
  const person = await den.signUp("Three workspaces")
  for (const name of ["One", "Two", "Three"]) assert.equal((await create(person, name)).status, 201)
  assertRefused(await create(person, "Four"), 3)
  const events = await db.$primary.select().from(PlatformAuditEventTable)
    .where(and(eq(PlatformAuditEventTable.action, "workspace.create_limit.reached"), eq(PlatformAuditEventTable.actor_id, normalizeDenTypeId("user", person.userId))))
  assert.equal(events.length, 1)
  const status = await den.request(admin.token, "GET", `/v1/admin/users/${person.userId}/workspace-limit`)
  assert.equal(status.status, 200, summary(status))
  assert.equal(field(status.body, "created"), 3)
  assert.equal(field(status.body, "limit"), 3)
})

test("an admin override allows more, removing the limit allows any number, and only admins can set it", async () => {
  const person = await den.signUp("Override person")
  for (const name of ["One", "Two", "Three"]) assert.equal((await create(person, name)).status, 201)
  assert.equal((await setLimit(person, person, 10)).status, 403)
  const raised = await setLimit(admin, person, 4)
  assert.equal(raised.status, 200, summary(raised))
  assert.equal(field(raised.body, "override"), true)
  assert.equal((await create(person, "Four")).status, 201)
  assertRefused(await create(person, "Five"), 4)
  assert.equal((await setLimit(admin, person, null)).status, 200)
  assert.equal((await create(person, "Five")).status, 201)
  assert.equal((await setLimit(admin, person, "default")).status, 200)
  assertRefused(await create(person, "Six"), 3)
})

test("handing ownership to someone else does not reset the founder's count", async () => {
  const founder = await den.signUp("Transfer founder")
  const first = await den.createOrg(founder, "Handed over")
  const teammate = await den.newMember(first.owner, first.orgId, "New owner")
  await db.update(MemberTable).set({ role: "owner" }).where(eq(MemberTable.id, normalizeDenTypeId("member", teammate.memberId)))
  await db.update(MemberTable).set({ role: "member" }).where(eq(MemberTable.id, normalizeDenTypeId("member", first.owner.memberId)))
  for (const name of ["Two", "Three"]) assert.equal((await create(founder, name)).status, 201)
  assertRefused(await create(founder, "Four"), 3)
})

test("concurrent creations cannot exceed the limit", async () => {
  const person = await den.signUp("Concurrent person")
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => create(person, `Parallel ${index}`)))
  assert.deepEqual(results.map(call => call.status).sort(), [201, 201, 201, 403, 403, 403], results.map(summary).join("\n"))
})

test("claiming a provisional workspace and Better Auth creation follow the same limit", async () => {
  const person = await den.signUp("Claim person")
  for (const name of ["One", "Two", "Three"]) assert.equal((await create(person, name)).status, 201)
  const provisional = await den.request(null, "POST", "/v1/bootstrap/workspace", { body: { workspaceName: "Provisional" } })
  assert.equal(provisional.status, 200, summary(provisional))
  const [link] = list(field(provisional.body, "claimLinks"))
  assertRefused(await den.request(person.token, "POST", "/v1/bootstrap/claims/accept", { body: { token: text(link?.token, "claim token") } }), 3)
  const betterAuth = await den.request(person.token, "POST", "/api/auth/organization/create", {
    headers: { cookie: person.cookie }, body: { name: "Direct", slug: `direct-${Date.now().toString(36)}` },
  })
  assert.equal(betterAuth.status, 403, summary(betterAuth))
  assert.equal(field(betterAuth.body, "code"), "workspace_limit_reached")
  const memberships = await db.$primary.select({ id: MemberTable.id }).from(MemberTable).where(eq(MemberTable.userId, normalizeDenTypeId("user", person.userId)))
  assert.equal(memberships.length, 3)
})

test("with the feature off, creation is not limited", async () => {
  await updateFeatureRollout({ key: "workspaceCreateLimit", enabled: false, defaultEnabled: false })
  try {
    const person = await den.signUp("Unlimited person")
    for (const name of ["One", "Two", "Three", "Four"]) assert.equal((await create(person, name)).status, 201)
  } finally {
    await updateFeatureRollout({ key: "workspaceCreateLimit", enabled: true, defaultEnabled: false })
  }
})
