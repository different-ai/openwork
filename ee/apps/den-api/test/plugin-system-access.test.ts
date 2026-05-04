import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let accessModule: typeof import("../src/routes/org/plugin-system/access.js")

beforeAll(async () => {
  seedRequiredEnv()
  accessModule = await import("../src/routes/org/plugin-system/access.js")
})

function createActorContext(input?: { isOwner?: boolean; role?: string; teamIds?: string[] }) {
  return {
    memberTeams: (input?.teamIds ?? []).map((teamId) => ({
      createdAt: new Date("2026-04-17T00:00:00.000Z"),
      id: teamId,
      name: teamId,
      organizationId: "org_test",
      updatedAt: new Date("2026-04-17T00:00:00.000Z"),
    })),
    organizationContext: {
      currentMember: {
        createdAt: new Date("2026-04-17T00:00:00.000Z"),
        id: "member_current",
        isOwner: input?.isOwner ?? false,
        role: input?.role ?? "member",
        userId: "user_current",
      },
    },
  } as any
}

test("org owners and admins get plugin-system capability access", () => {
  expect(accessModule.isPluginArchOrgAdmin(createActorContext({ isOwner: true }))).toBe(true)
  expect(accessModule.isPluginArchOrgAdmin(createActorContext({ role: "member,admin" }))).toBe(true)
  expect(accessModule.isPluginArchOrgAdmin(createActorContext({ role: "member" }))).toBe(false)

  expect(accessModule.hasPluginArchCapability(createActorContext({ isOwner: true }), "plugin.create")).toBe(true)
  expect(accessModule.hasPluginArchCapability(createActorContext({ role: "admin" }), "marketplace.create")).toBe(true)
  expect(accessModule.hasPluginArchCapability(createActorContext({ role: "admin" }), "connector_instance.create")).toBe(true)
  expect(accessModule.hasPluginArchCapability(createActorContext({ role: "member" }), "config_object.create")).toBe(false)
})

test("grant resolution supports direct, team, org-wide, and highest-role precedence", () => {
  const grants = [
    {
      orgMembershipId: null,
      orgWide: true,
      removedAt: null,
      role: "viewer",
      teamId: null,
    },
    {
      orgMembershipId: null,
      orgWide: false,
      removedAt: null,
      role: "editor",
      teamId: "team_alpha",
    },
    {
      orgMembershipId: "member_current",
      orgWide: false,
      removedAt: null,
      role: "manager",
      teamId: null,
    },
  ] as const

  expect(accessModule.resolvePluginArchGrantRole({ grants: [...grants], memberId: "member_current", teamIds: ["team_alpha"] })).toBe("manager")
  expect(accessModule.resolvePluginArchGrantRole({ grants: [...grants], memberId: "other_member", teamIds: ["team_alpha"] })).toBe("editor")
  expect(accessModule.resolvePluginArchGrantRole({ grants: [...grants], memberId: "other_member", teamIds: [] })).toBe("viewer")
})

test("removed grants are ignored during resolution", () => {
  expect(accessModule.resolvePluginArchGrantRole({
    grants: [{
      orgMembershipId: "member_current",
      orgWide: false,
      removedAt: new Date("2026-04-17T00:00:00.000Z"),
      role: "manager",
      teamId: null,
    }],
    memberId: "member_current",
    teamIds: [],
  })).toBeNull()
})
