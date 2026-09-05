import { describe, expect, test } from "bun:test"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuditEventTable,
  AuthSessionTable,
  AuthUserTable,
  MemberTable,
  OrganizationRoleTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { shouldRevokeSessionsForRoleChange } from "../src/organization-role-hierarchy.js"

const API_ORIGIN = "http://127.0.0.1:8790"

describe("organization role change session revocation", () => {
  test("preserves sessions only for unchanged roles and unambiguous built-in upgrades", () => {
    expect(shouldRevokeSessionsForRoleChange("member", "admin")).toBe(false)
    expect(shouldRevokeSessionsForRoleChange("member", "member")).toBe(false)

    expect(shouldRevokeSessionsForRoleChange("admin", "member")).toBe(true)
    expect(shouldRevokeSessionsForRoleChange("owner", "admin")).toBe(true)
  })

  test("fails closed for custom, multi-role, and unknown role changes", () => {
    expect(shouldRevokeSessionsForRoleChange("qa", "admin")).toBe(true)
    expect(shouldRevokeSessionsForRoleChange("admin", "admin,qa")).toBe(true)
    expect(shouldRevokeSessionsForRoleChange("garbage", "unknown")).toBe(true)
  })

  test("the role route preserves a promoted bearer session and revokes it on demotion", async () => {
    process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
    process.env.DB_MODE ??= "mysql"
    process.env.DEN_DB_ENCRYPTION_KEY ??= "role-session-test-encryption-key-1234567890"
    process.env.BETTER_AUTH_SECRET ??= "role-session-test-secret-123456789012345"
    process.env.BETTER_AUTH_URL ??= API_ORIGIN
    process.env.CORS_ORIGINS ??= API_ORIGIN

    const [{ default: app }, { db }] = await Promise.all([
      import("../src/app.js"),
      import("../src/db.js"),
    ])
    const ownerUserId = createDenTypeId("user")
    const teammateUserId = createDenTypeId("user")
    const organizationId = createDenTypeId("organization")
    const ownerMemberId = createDenTypeId("member")
    const teammateMemberId = createDenTypeId("member")
    const ownerSessionId = createDenTypeId("session")
    const teammateSessionId = createDenTypeId("session")
    const ownerToken = `owner-${ownerSessionId}`
    const teammateToken = `teammate-${teammateSessionId}`

    const cleanup = async () => {
      await db.delete(AuditEventTable).where(eq(AuditEventTable.org_id, organizationId))
      await db.delete(AuthSessionTable).where(inArray(AuthSessionTable.id, [ownerSessionId, teammateSessionId]))
      await db.delete(OrganizationRoleTable).where(eq(OrganizationRoleTable.organizationId, organizationId))
      await db.delete(MemberTable).where(eq(MemberTable.organizationId, organizationId))
      await db.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
      await db.delete(AuthUserTable).where(inArray(AuthUserTable.id, [ownerUserId, teammateUserId]))
    }

    try {
      await db.insert(AuthUserTable).values([
        {
          id: ownerUserId,
          name: "Role Session Owner",
          email: `${ownerUserId}@role-session.test`,
          emailVerified: true,
        },
        {
          id: teammateUserId,
          name: "Role Session Teammate",
          email: `${teammateUserId}@role-session.test`,
          emailVerified: true,
        },
      ])
      await db.insert(OrganizationTable).values({
        id: organizationId,
        name: "Role Session Test",
        slug: `role-session-${organizationId}`,
      })
      await db.insert(MemberTable).values([
        { id: ownerMemberId, organizationId, userId: ownerUserId, role: "owner" },
        { id: teammateMemberId, organizationId, userId: teammateUserId, role: "member" },
      ])
      await db.insert(OrganizationRoleTable).values([
        { id: createDenTypeId("organizationRole"), organizationId, role: "admin", permission: "{}" },
        { id: createDenTypeId("organizationRole"), organizationId, role: "member", permission: "{}" },
      ])
      await db.insert(AuthSessionTable).values([
        {
          id: ownerSessionId,
          userId: ownerUserId,
          activeOrganizationId: organizationId,
          token: ownerToken,
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          id: teammateSessionId,
          userId: teammateUserId,
          activeOrganizationId: organizationId,
          token: teammateToken,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ])

      const sessionStatus = async () => (await app.fetch(new Request(`${API_ORIGIN}/v1/me`, {
        headers: { authorization: `Bearer ${teammateToken}`, origin: API_ORIGIN },
      }))).status
      const updateRole = async (role: "admin" | "member") => app.fetch(new Request(
        `${API_ORIGIN}/v1/members/${teammateMemberId}/role`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${ownerToken}`,
            "content-type": "application/json",
            "x-openwork-org-id": organizationId,
            origin: API_ORIGIN,
          },
          body: JSON.stringify({ role }),
        },
      ))

      expect(await sessionStatus()).toBe(200)
      const promotion = await updateRole("admin")
      expect(promotion.status, await promotion.clone().text()).toBe(200)
      expect(await sessionStatus()).toBe(200)
      const demotion = await updateRole("member")
      expect(demotion.status, await demotion.clone().text()).toBe(200)
      expect(await sessionStatus()).toBe(401)
    } finally {
      await cleanup()
    }
  })
})
