import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrganizationTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_membercreate"
process.env.DB_MODE ??= "mysql"
process.env.DEN_DB_ENCRYPTION_KEY ??= "member-create-test-key-123456789"
process.env.BETTER_AUTH_SECRET ??= "member-create-test-secret-123456"
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"

let db: typeof import("../src/db.js").db
let store: typeof import("../src/routes/org/plugin-system/store.js")
let marketplaceCapabilities: typeof import("../src/mcp/marketplace-capabilities.js")

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const memberUserId = createDenTypeId("user")
const otherMemberId = createDenTypeId("member")
const otherMemberUserId = createDenTypeId("user")
const adminId = createDenTypeId("member")
const adminUserId = createDenTypeId("user")
const marketplaceId = createDenTypeId("marketplace")

async function clearRows() {
  await db.delete(MarketplacePluginTable).where(eq(MarketplacePluginTable.organizationId, organizationId))
  await db.delete(ConfigObjectAccessGrantTable).where(eq(ConfigObjectAccessGrantTable.organizationId, organizationId))
  await db.delete(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.organizationId, organizationId))
  await db.delete(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, organizationId))
  await db.delete(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.organizationId, organizationId))
  await db.delete(ConfigObjectVersionTable).where(eq(ConfigObjectVersionTable.organizationId, organizationId))
  await db.delete(ConfigObjectTable).where(eq(ConfigObjectTable.organizationId, organizationId))
  await db.delete(PluginTable).where(eq(PluginTable.organizationId, organizationId))
  await db.delete(MarketplaceTable).where(eq(MarketplaceTable.organizationId, organizationId))
  await db.delete(MemberTable).where(eq(MemberTable.organizationId, organizationId))
  await db.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
}

beforeAll(async () => {
  mock.restore()
  db = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db }))
  store = await import("../src/routes/org/plugin-system/store.js")
  marketplaceCapabilities = await import("../src/mcp/marketplace-capabilities.js")
  await clearRows()

  await db.insert(OrganizationTable).values({
    id: organizationId,
    name: "Member Plugin Creation Test",
    slug: `member-plugin-create-${organizationId}`,
  })
  await db.insert(MemberTable).values([
    { id: memberId, organizationId, role: "member", userId: memberUserId },
    { id: otherMemberId, organizationId, role: "member", userId: otherMemberUserId },
    { id: adminId, organizationId, role: "admin", userId: adminUserId },
  ])
  await db.insert(MarketplaceTable).values({
    createdByOrgMembershipId: adminId,
    description: "Visible but not editable by members",
    id: marketplaceId,
    name: "Admin Marketplace",
    organizationId,
    status: "active",
  })
  await db.insert(MarketplaceAccessGrantTable).values({
    createdByOrgMembershipId: adminId,
    id: createDenTypeId("marketplaceAccessGrant"),
    marketplaceId,
    organizationId,
    orgMembershipId: null,
    orgWide: true,
    role: "viewer",
    teamId: null,
  })
})

afterAll(async () => {
  await clearRows()
  mock.restore()
})

function actorContext(input: {
  id: typeof memberId
  isOwner: boolean
  role: string
  userId: typeof memberUserId
}): PluginArchActorContext {
  const now = new Date()
  return {
    memberTeams: [],
    organizationContext: {
      organization: {
        id: organizationId,
        name: "Member Plugin Creation Test",
        slug: `member-plugin-create-${organizationId}`,
        logo: null,
        allowedEmailDomains: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      },
      currentMember: {
        id: input.id,
        userId: input.userId,
        role: input.role,
        createdAt: now,
        joinedAt: now,
        isOwner: input.isOwner,
      },
      invitations: [],
      members: [],
      roles: [],
      teams: [],
    },
    session: { createdAt: now },
  }
}

const memberContext = actorContext({ id: memberId, isOwner: false, role: "member", userId: memberUserId })
const otherMemberContext = actorContext({ id: otherMemberId, isOwner: false, role: "member", userId: otherMemberUserId })
const adminContext = actorContext({ id: adminId, isOwner: false, role: "admin", userId: adminUserId })

function skillComponent(name: string): { type: "skill"; value: { rawSourceText: string } } {
  return {
    type: "skill",
    value: { rawSourceText: `---\nname: ${name}\ndescription: Test ${name}.\n---\n\nFollow the test instructions.` },
  }
}

async function rejectedStatus(action: () => Promise<unknown>) {
  try {
    await action()
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
      return error.status
    }
    throw error
  }
  throw new Error("Expected action to reject")
}

async function rejectedRouteFailure(action: () => Promise<unknown>): Promise<{ error: string; message: string; status: number }> {
  try {
    await action()
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "status" in error
      && typeof error.status === "number"
      && "error" in error
      && typeof error.error === "string"
      && "message" in error
      && typeof error.message === "string"
    ) {
      return { error: error.error, message: error.message, status: error.status }
    }
    throw error
  }
  throw new Error("Expected action to reject")
}

async function pluginCount() {
  const rows = await db.select({ id: PluginTable.id }).from(PluginTable).where(eq(PluginTable.organizationId, organizationId))
  return rows.length
}

test("a member creates a plugin bundle with a skill and receives manager access", async () => {
  const plugin = await store.createPluginBundle({
    components: [skillComponent("member-created-skill")],
    context: memberContext,
    name: "Member-created plugin",
  })

  const managerGrants = await db
    .select()
    .from(PluginAccessGrantTable)
    .where(and(
      eq(PluginAccessGrantTable.pluginId, plugin.id),
      eq(PluginAccessGrantTable.orgMembershipId, memberId),
      eq(PluginAccessGrantTable.role, "manager"),
    ))
  expect(managerGrants).toHaveLength(1)
  expect(await store.getPluginDetail(memberContext, plugin.id)).toMatchObject({ id: plugin.id, memberCount: 1 })
})

test("same-creator active plugin names conflict while archived and other-creator names do not", async () => {
  const first = await store.createPlugin({ context: memberContext, name: "Duplicate member plugin" })
  const duplicate = await rejectedRouteFailure(() => store.createPlugin({ context: memberContext, name: "  Duplicate member plugin  " }))
  expect(duplicate).toMatchObject({ error: "duplicate_plugin", status: 409 })
  expect(duplicate.message).toContain(first.id)

  await store.setPluginLifecycle({ action: "archive", context: memberContext, pluginId: first.id })
  const replacement = await store.createPlugin({ context: memberContext, name: "Duplicate member plugin" })
  expect(replacement.id).not.toBe(first.id)

  const otherCreatorPlugin = await store.createPlugin({ context: otherMemberContext, name: "Duplicate member plugin" })
  expect(otherCreatorPlugin.id).not.toBe(replacement.id)
})

test("a member cannot import plugins from GitHub without starting a fetch", async () => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (input, init) => {
    fetchCalls += 1
    return originalFetch(input, init)
  }

  try {
    expect(await rejectedStatus(() => store.importGithubPluginMcps({
      authType: "none",
      context: memberContext,
      credentialMode: "shared",
      githubUrl: "https://github.com/openworklabs/test-plugin",
    }))).toBe(403)
    expect(fetchCalls).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("a member cannot apply connector discovery", async () => {
  expect(await rejectedStatus(() => store.applyGithubConnectorDiscovery({
    autoImportNewPlugins: false,
    connectorInstanceId: createDenTypeId("connectorInstance"),
    context: memberContext,
    selectedKeys: [],
  }))).toBe(403)
})

test("a member cannot create an org-wide bundle and no plugin is written", async () => {
  const before = await pluginCount()
  const status = await rejectedStatus(() => store.createPluginBundle({
    components: [skillComponent("blocked-org-wide-skill")],
    context: memberContext,
    name: "Blocked org-wide plugin",
    orgWide: true,
  }))

  expect(status).toBe(403)
  expect(await pluginCount()).toBe(before)
})

test("a member cannot publish to a marketplace they cannot edit and no plugin is written", async () => {
  const before = await pluginCount()
  const status = await rejectedStatus(() => store.createPluginBundle({
    context: memberContext,
    marketplaceId,
    name: "Blocked marketplace plugin",
  }))

  expect([403, 404]).toContain(status)
  expect(await pluginCount()).toBe(before)
})

test("a member manager can grant another member access but cannot grant org-wide access", async () => {
  const rawSourceText = "---\nname: member-shared-skill\ndescription: Member shared skill.\n---\n\nFollow the shared instructions."
  const plugin = await store.createPluginBundle({
    components: [{ type: "skill", value: { rawSourceText } }],
    context: memberContext,
    name: "Member-managed plugin",
  })

  expect(await rejectedStatus(() => store.createResourceAccessGrant({
    context: memberContext,
    resourceId: plugin.id,
    resourceKind: "plugin",
    value: { orgWide: true, role: "viewer" },
  }))).toBe(403)

  const grant = await store.createResourceAccessGrant({
    context: memberContext,
    resourceId: plugin.id,
    resourceKind: "plugin",
    value: { orgMembershipId: otherMemberId, role: "viewer" },
  })
  expect(grant).toMatchObject({ orgMembershipId: otherMemberId, orgWide: false, role: "viewer" })

  const memberships = await db.select().from(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.pluginId, plugin.id))
  const configObjectId = memberships[0]?.configObjectId
  if (!configObjectId) throw new Error("Shared plugin has no config object")
  const capabilityName = marketplaceCapabilities.buildMarketplaceCapabilityName(plugin.id, configObjectId)
  const matches = await marketplaceCapabilities.searchMarketplaceCapabilities({
    enabled: true,
    limit: 20,
    member: { orgMembershipId: otherMemberId, teamIds: [] },
    organizationId,
    query: "member shared skill",
  })
  expect(matches.some((match) => match.name === capabilityName)).toBe(true)

  const execution = await marketplaceCapabilities.executeMarketplaceCapability({
    configObjectId,
    enabled: true,
    member: { orgMembershipId: otherMemberId, teamIds: [] },
    organizationId,
    pluginId: plugin.id,
  })
  if (!execution.ok) throw new Error(execution.message)
  expect(execution.result).toMatchObject({ content: rawSourceText, marketplace: null })

  expect(await rejectedStatus(() => store.createResourceAccessGrant({
    context: otherMemberContext,
    resourceId: plugin.id,
    resourceKind: "plugin",
    value: { orgMembershipId: adminId, role: "viewer" },
  }))).toBe(403)
})

test("an admin can create an org-wide plugin bundle end-to-end", async () => {
  const plugin = await store.createPluginBundle({
    components: [skillComponent("admin-org-wide-skill")],
    context: adminContext,
    name: "Admin org-wide plugin",
    orgWide: true,
  })
  const memberships = await db.select().from(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.pluginId, plugin.id))
  const pluginGrants = await db.select().from(PluginAccessGrantTable).where(and(
    eq(PluginAccessGrantTable.pluginId, plugin.id),
    eq(PluginAccessGrantTable.orgWide, true),
  ))
  const configObjectGrants = memberships[0]
    ? await db.select().from(ConfigObjectAccessGrantTable).where(and(
        eq(ConfigObjectAccessGrantTable.configObjectId, memberships[0].configObjectId),
        eq(ConfigObjectAccessGrantTable.orgWide, true),
      ))
    : []

  expect(await store.getPluginDetail(adminContext, plugin.id)).toMatchObject({ id: plugin.id, memberCount: 1 })
  expect(pluginGrants).toHaveLength(1)
  expect(configObjectGrants).toHaveLength(1)
})
