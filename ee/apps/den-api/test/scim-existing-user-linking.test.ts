import assert from "node:assert/strict"
import { test } from "node:test"
import { scim } from "@better-auth/scim"
import { createDenDb } from "@openwork-ee/den-db"
import type { SQL } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema/org"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { organization } from "better-auth/plugins"
import { z } from "zod"
import { createScimExistingUserLinkCheck } from "../src/scim-existing-user-linking.js"

const orgId = createDenTypeId("organization")
const otherOrgId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const otherUserId = createDenTypeId("user")
const email = "existing@example.test"
const providerId = "synthetic-scim"
const now = new Date("2026-01-01T00:00:00Z")
const { db: queryBuilder } = createDenDb({
  mode: "planetscale",
  planetscale: { host: "scim.invalid", username: "synthetic", password: "synthetic" },
})

function compileMembershipQuery(where: SQL | undefined) {
  assert.ok(where)
  return queryBuilder.select({ id: MemberTable.id }).from(MemberTable).where(where).limit(1).toSQL()
}

type Membership = {
  id: string
  userId: string | null
  organizationId: string
  role: string
  removedAt: Date | null
  inviteId?: string
  createdAt: Date
}

function membership(overrides: Partial<Membership> = {}): Membership {
  return {
    id: createDenTypeId("member"), userId, organizationId: orgId,
    role: "admin", removedAt: null, createdAt: now, ...overrides,
  }
}

function fixture(options: {
  members?: Membership[]
  organizationId?: string | null
  newUser?: boolean
  invitation?: boolean
  failRead?: boolean
} = {}) {
  const organizationId = options.organizationId === undefined ? orgId : options.organizationId
  const members = options.members ?? [membership()]
  const data: Record<string, Record<string, unknown>[]> = {
    user: options.newUser ? [] : [{ id: userId, email, name: "Existing Member", emailVerified: true, createdAt: now, updatedAt: now }],
    account: [],
    member: members,
    organization: [{ id: orgId, name: "Synthetic Organization", slug: "synthetic", createdAt: now }],
    invitation: options.invitation ? [{ id: createDenTypeId("invitation"), organizationId: orgId, email, role: "admin", status: "pending", inviterId: otherUserId, expiresAt: new Date("2099-01-01"), createdAt: now }] : [],
    scimProvider: [{ id: createDenTypeId("scimProvider"), providerId, organizationId, scimToken: "synthetic-token", userId: otherUserId }],
  }
  const writes: string[] = []
  const queries: ReturnType<typeof compileMembershipQuery>[] = []
  const memory = memoryAdapter(data)
  const shouldLinkUser = createScimExistingUserLinkCheck(async (where) => {
    const query = compileMembershipQuery(where)
    queries.push(query)
    if (options.failRead) throw new Error("Synthetic membership lookup failure")
    assert.match(query.sql, /`member`\.`user_id` = \? and `member`\.`organization_id` = \? and `member`\.`removed_at` is null/)
    const [requestedUserId, requestedOrgId] = query.params
    return members.filter((member) => {
      if (!member.userId || member.removedAt !== null) return false
      const memberUserId = MemberTable.userId.mapToDriverValue(normalizeDenTypeId("user", member.userId))
      const memberOrgId = MemberTable.organizationId.mapToDriverValue(normalizeDenTypeId("organization", member.organizationId))
      return requestedUserId === memberUserId && requestedOrgId === memberOrgId
    })
  })
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "synthetic-scim-link-test-secret-not-for-production",
    telemetry: { enabled: false },
    logger: { disabled: true },
    database: (config: Parameters<typeof memory>[0]) => new Proxy(memory(config), {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver)
        if (typeof value === "function" && ["create", "update", "updateMany", "delete", "deleteMany"].includes(String(key))) {
          return (...args: unknown[]) => {
            writes.push(String(key))
            return Reflect.apply(value, target, args)
          }
        }
        return value
      },
    }),
    plugins: [organization(), scim({
      mapGroupToRoles: () => [],
      linkExistingUsers: { requireExistingOrgMembership: true, shouldLinkUser },
    })],
  })
  const token = Buffer.from(`synthetic-token:${providerId}${organizationId ? `:${organizationId}` : ""}`).toString("base64url")
  const provision = () => auth.handler(new Request("http://localhost:3000/api/auth/scim/v2/Users", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
    body: JSON.stringify({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: email, externalId: "synthetic-external-id", active: true,
      name: { givenName: "Provisioned", familyName: "Name" },
      emails: [{ primary: true, value: email, type: "work" }],
    }),
  }))
  return { data, writes, queries, shouldLinkUser, provision }
}

const resourceSchema = z.object({ id: z.string(), userName: z.string() })
const conflictSchema = z.object({ status: z.string(), scimType: z.string() })

async function assertConflictWithoutWrites(f: ReturnType<typeof fixture>) {
  const before = structuredClone(f.data)
  const response = await f.provision()
  assert.equal(response.status, 409)
  assert.deepEqual(conflictSchema.parse(await response.json()), { status: "409", scimType: "uniqueness" })
  assert.deepEqual(f.data, before)
  assert.deepEqual(f.writes, [])
}

test("SCIM adopts an active same-org member, preserving identity, profile and role without a duplicate membership", async () => {
  const f = fixture()
  const before = structuredClone(f.data)
  const response = await f.provision()
  assert.equal(response.status, 201)
  assert.equal(resourceSchema.parse(await response.json()).id, userId)
  assert.deepEqual(f.data.user, before.user)
  assert.deepEqual(f.data.member, before.member)
  assert.equal(f.data.account.length, 1)
  assert.equal(f.data.account[0]?.userId, userId)
  assert.equal(f.data.account[0]?.providerId, providerId)
  assert.deepEqual(f.writes, ["create"])
  assert.equal(f.queries.length, 1)
})

for (const scenario of [
  { name: "other-org membership", members: [membership({ organizationId: otherOrgId })] },
  { name: "missing membership (personal account)", members: [] },
  { name: "another user's same-org membership", members: [membership({ userId: otherUserId })] },
  { name: "removed same-org membership", members: [membership({ removedAt: now })] },
  { name: "removed same-org plus active other-org membership", members: [membership({ removedAt: now }), membership({ organizationId: otherOrgId })] },
  { name: "pending invitation only", members: [membership({ userId: null, inviteId: createDenTypeId("invitation") })], invitation: true },
  { name: "unscoped SCIM token", members: [membership()], organizationId: null },
]) {
  test(`SCIM rejects ${scenario.name} with 409 and no writes`, async () => {
    const f = fixture(scenario)
    await assertConflictWithoutWrites(f)
    assert.equal(f.queries.length, scenario.name.startsWith("removed") ? 1 : 0)
  })
}

test("SCIM rejects duplicate provider accounts before linking and performs no writes", async () => {
  const f = fixture()
  assert.equal((await f.provision()).status, 201)
  f.writes.length = 0
  f.queries.length = 0
  await assertConflictWithoutWrites(f)
  assert.equal(f.queries.length, 0)
})

test("SCIM still provisions a new user and member without consulting the existing-user policy", async () => {
  const f = fixture({ newUser: true, members: [], failRead: true })
  const response = await f.provision()
  assert.equal(response.status, 201)
  const resource = resourceSchema.parse(await response.json())
  assert.notEqual(resource.id, userId)
  assert.equal(resource.userName, email)
  assert.equal(f.data.user.length, 1)
  assert.equal(f.data.account.length, 1)
  assert.equal(f.data.member.length, 1)
  assert.equal(f.data.member[0]?.userId, resource.id)
  assert.equal(f.data.member[0]?.organizationId, orgId)
  assert.equal(f.data.member[0]?.role, "member")
  assert.equal(f.data.account[0]?.userId, resource.id)
  assert.deepEqual(f.writes, ["create", "create", "create"])
  assert.equal(f.queries.length, 0)
})

test("membership callback errors fail closed before any SCIM write", async () => {
  const f = fixture({ failRead: true })
  const before = structuredClone(f.data)
  assert.equal((await f.provision()).status, 500)
  assert.deepEqual(f.data, before)
  assert.deepEqual(f.writes, [])
  assert.equal(f.queries.length, 1)
})

test("callback refuses missing organization context independently of the plugin guard", async () => {
  const f = fixture()
  for (const organizationId of [undefined, null, ""]) {
    assert.equal(await f.shouldLinkUser({ user: { id: userId }, provider: { organizationId } }), false)
  }
  assert.equal(f.queries.length, 0)
  assert.deepEqual(f.writes, [])
})

test("membership callback re-reads removal state rather than caching an earlier approval", async () => {
  const member = membership()
  const f = fixture({ members: [member] })
  const input = { user: { id: userId }, provider: { organizationId: orgId } }
  assert.equal(await f.shouldLinkUser(input), true)
  member.removedAt = now
  assert.equal(await f.shouldLinkUser(input), false)
  assert.equal(f.queries.length, 2)
  assert.deepEqual(f.writes, [])
})

test("membership callback validates both TypeIDs before reading", async () => {
  const f = fixture()
  await assert.rejects(f.shouldLinkUser({ user: { id: orgId }, provider: { organizationId: orgId } }), /prefix mismatch/)
  await assert.rejects(f.shouldLinkUser({ user: { id: userId }, provider: { organizationId: userId } }), /prefix mismatch/)
  assert.equal(f.queries.length, 0)
  assert.deepEqual(f.writes, [])
})

test("membership query binds normalized user and organization IDs and requires removed_at IS NULL", async () => {
  const f = fixture()
  assert.equal(await f.shouldLinkUser({ user: { id: userId }, provider: { organizationId: orgId } }), true)
  const query = f.queries[0]
  assert.ok(query)
  assert.equal(query.sql, "select `id` from `member` where (`member`.`user_id` = ? and `member`.`organization_id` = ? and `member`.`removed_at` is null) limit ?")
  assert.deepEqual(query.params, [
    MemberTable.userId.mapToDriverValue(normalizeDenTypeId("user", userId)),
    MemberTable.organizationId.mapToDriverValue(normalizeDenTypeId("organization", orgId)),
    1,
  ])
})
