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
const rules = "/v1/admin/limits/workspace-creation/rules"
const setRule = (actor: Session, scope: "email" | "domain", value: string, limit: number | null) =>
  den.request(actor.token, "PUT", rules, { body: { scope, value, limit } })
const removeRule = (scope: "email" | "domain", value: string) =>
  den.request(admin.token, "DELETE", `${rules}/${scope}/${encodeURIComponent(value)}`)
const run = Math.random().toString(36).slice(2, 8)
const domain = `acme-${run}.test`

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

test("an email rule beats a domain rule, a domain rule applies to each person, and changes are audited", async () => {
  assert.equal((await setRule(await den.signUp("Not admin"), "domain", domain, 10)).status, 403)
  const domainRule = await setRule(admin, "domain", `@${domain.toUpperCase()}`, 2)
  assert.equal(domainRule.status, 200, summary(domainRule))
  assert.deepEqual(list(field(domainRule.body, "rules")).map(rule => [rule.scope, rule.value, rule.limit]), [["domain", domain, 2]])
  const bob = await den.signUp("Bob", `bob-${run}@${domain}`)
  const carol = await den.signUp("Carol", `carol-${run}@${domain}`)
  for (const person of [bob, carol]) {
    for (const name of ["One", "Two"]) assert.equal((await create(person, name)).status, 201)
    assertRefused(await create(person, "Three"), 2)
  }
  assert.equal((await setRule(admin, "email", `Bob-${run}+vip@${domain}`, 4)).status, 200)
  assert.equal((await create(bob, "Three")).status, 201)
  assert.equal((await create(bob, "Four")).status, 201)
  assertRefused(await create(bob, "Five"), 4)
  assertRefused(await create(carol, "Three"), 2)
  assert.equal((await setRule(admin, "email", `bob-${run}@${domain}`, null)).status, 200)
  assert.equal((await create(bob, "Five")).status, 201)
  assert.equal((await removeRule("email", `bob-${run}@${domain}`)).status, 200)
  assert.equal((await removeRule("email", `bob-${run}@${domain}`)).status, 404)
  assertRefused(await create(bob, "Six"), 2)
  assert.equal((await removeRule("domain", domain)).status, 200)
  assert.equal((await create(carol, "Three")).status, 201)
  assert.equal((await setRule(admin, "email", "not-an-email", 3)).status, 400)
  const audited = await db.$primary.select({ action: PlatformAuditEventTable.action }).from(PlatformAuditEventTable)
    .where(eq(PlatformAuditEventTable.actor_id, normalizeDenTypeId("user", admin.userId)))
  const actions = audited.map(row => row.action)
  assert.equal(actions.filter(action => action.startsWith("platform.workspace_create_limit.rule.set.")).length >= 4, true, actions.join(", "))
  assert.equal(actions.filter(action => action.startsWith("platform.workspace_create_limit.rule.remove.")).length >= 2, true, actions.join(", "))
})

test("plus aliases and Gmail dot variants share one count", async () => {
  const local = `alice${run}`
  const first = await den.signUp("Alice", `${local}+1@gmail.com`)
  const second = await den.signUp("Alice alias", `${local}+xyz@googlemail.com`)
  const dotted = await den.signUp("Alice dots", `${local.slice(0, 2)}.${local.slice(2)}@gmail.com`)
  assert.equal((await create(first, "One")).status, 201)
  assert.equal((await create(second, "Two")).status, 201)
  assert.equal((await create(dotted, "Three")).status, 201)
  for (const person of [first, second, dotted]) assertRefused(await create(person, "Four"), 3)
  const status = await den.request(admin.token, "GET", `/v1/admin/users/${second.userId}/workspace-limit`)
  assert.equal(field(status.body, "identity"), `${local}@gmail.com`)
  assert.equal(field(status.body, "created"), 3)
  assert.equal((await setRule(admin, "email", `${local.slice(0, 3)}.${local.slice(3)}+other@gmail.com`, 4)).status, 200)
  assert.equal((await create(dotted, "Four")).status, 201)
  assertRefused(await create(first, "Five"), 4)
})

test("alias accounts creating at the same time cannot exceed the limit together", async () => {
  const local = `dana${run}`
  const people = await Promise.all(["a", "b", "c"].map(tag => den.signUp(`Dana ${tag}`, `${local}+${tag}@${domain}`)))
  const results = await Promise.all(people.flatMap(person => [create(person, "Parallel one"), create(person, "Parallel two")]))
  assert.deepEqual(results.map(call => call.status).sort(), [201, 201, 201, 403, 403, 403], results.map(summary).join("\n"))
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
