import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

// Scheduling a Workflow executes it. These tests pin the rule that read access
// to a Workflow is not run access: a viewer may not pin it to a Cloud
// Automation, while an editor grant (the bar the detail reports as canRun) may.

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_workflow_run_access"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

type Db = typeof import("../src/db.js").db
type PluginStore = typeof import("../src/routes/org/plugin-system/store.js")
type Workflows = typeof import("../src/workflows.js")

type SeededWorkflow = {
  configObjectId: DenTypeId<"configObject">
  configObjectVersionId: DenTypeId<"configObjectVersion">
  organizationId: DenTypeId<"organization">
  ownerMemberId: DenTypeId<"member">
  pluginId: DenTypeId<"plugin">
  viewerMemberId: DenTypeId<"member">
}

let db: Db
let pluginStore: PluginStore
let workflows: Workflows
const createdOrganizationIds: DenTypeId<"organization">[] = []
const createdUserIds: DenTypeId<"user">[] = []

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()
  db = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db }))
  pluginStore = await import("../src/routes/org/plugin-system/store.js")
  workflows = await import("../src/workflows.js")
})

afterAll(() => {
  mock.restore()
})

afterEach(async () => {
  if (createdOrganizationIds.length > 0) {
    await db.delete(ConfigObjectVersionTable).where(inArray(ConfigObjectVersionTable.organizationId, createdOrganizationIds))
    await db.delete(ConfigObjectAccessGrantTable).where(inArray(ConfigObjectAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.organizationId, createdOrganizationIds))
    await db.delete(PluginAccessGrantTable).where(inArray(PluginAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(MarketplacePluginTable).where(inArray(MarketplacePluginTable.organizationId, createdOrganizationIds))
    await db.delete(MarketplaceAccessGrantTable).where(inArray(MarketplaceAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(ConfigObjectTable).where(inArray(ConfigObjectTable.organizationId, createdOrganizationIds))
    await db.delete(PluginTable).where(inArray(PluginTable.organizationId, createdOrganizationIds))
    await db.delete(MarketplaceTable).where(inArray(MarketplaceTable.organizationId, createdOrganizationIds))
    await db.delete(MemberTable).where(inArray(MemberTable.organizationId, createdOrganizationIds))
    await db.delete(OrganizationTable).where(inArray(OrganizationTable.id, createdOrganizationIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(AuthUserTable).where(inArray(AuthUserTable.id, createdUserIds))
  }
  createdOrganizationIds.length = 0
  createdUserIds.length = 0
})

/** An org owner publishes a Workflow org-wide, which grants every member viewer access; a plain member joins. */
async function seedWorkflowWithViewer(): Promise<SeededWorkflow> {
  const organizationId = createDenTypeId("organization")
  const ownerUserId = createDenTypeId("user")
  const ownerMemberId = createDenTypeId("member")
  const viewerUserId = createDenTypeId("user")
  const viewerMemberId = createDenTypeId("member")
  const marketplaceId = createDenTypeId("marketplace")
  const now = new Date()
  createdOrganizationIds.push(organizationId)
  createdUserIds.push(ownerUserId, viewerUserId)

  await db.insert(AuthUserTable).values([
    { id: ownerUserId, name: "Workflow Owner", email: `${ownerUserId}@run-access.test.local` },
    { id: viewerUserId, name: "Workflow Viewer", email: `${viewerUserId}@run-access.test.local` },
  ])
  await db.insert(OrganizationTable).values({ id: organizationId, name: "Run Access Org", slug: `run-access-${organizationId}` })
  await db.insert(MemberTable).values([
    { id: ownerMemberId, organizationId, userId: ownerUserId, role: "owner" },
    { id: viewerMemberId, organizationId, userId: viewerUserId, role: "member" },
  ])
  await db.insert(MarketplaceTable).values({
    id: marketplaceId,
    organizationId,
    name: "Run Access Marketplace",
    description: "Workflow run access tests",
    status: "active",
    createdByOrgMembershipId: ownerMemberId,
  })
  await db.insert(MarketplaceAccessGrantTable).values({
    id: createDenTypeId("marketplaceAccessGrant"),
    organizationId,
    marketplaceId,
    orgMembershipId: ownerMemberId,
    teamId: null,
    orgWide: false,
    role: "manager",
    createdByOrgMembershipId: ownerMemberId,
  })

  const context: PluginArchActorContext = {
    memberTeams: [],
    organizationContext: {
      organization: {
        id: organizationId,
        name: "Run Access Org",
        slug: `run-access-${organizationId}`,
        logo: null,
        allowedEmailDomains: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      },
      currentMember: {
        id: ownerMemberId,
        userId: ownerUserId,
        role: "owner",
        createdAt: now,
        joinedAt: now,
        isOwner: true,
      },
      invitations: [],
      members: [],
      roles: [],
      teams: [],
    },
    session: { createdAt: now },
  }
  const plugin = await pluginStore.createPluginBundle({
    components: [{
      type: "workflow",
      value: {
        metadata: { title: "Scheduled briefing", description: "Scheduled briefing description" },
        normalizedPayloadJson: { language: "codemode-js", requiredCapabilities: [] },
        rawSourceText: "return { ok: true }",
      },
    }],
    context,
    marketplaceId,
    name: "Scheduled briefing Plugin",
    orgWide: true,
  })
  const memberships = await db
    .select({ configObjectId: PluginConfigObjectTable.configObjectId })
    .from(PluginConfigObjectTable)
    .where(eq(PluginConfigObjectTable.pluginId, plugin.id))
  const configObjectId = memberships[0]?.configObjectId
  if (!configObjectId) throw new Error("Workflow Plugin has no config object")
  const versions = await db
    .select({ id: ConfigObjectVersionTable.id })
    .from(ConfigObjectVersionTable)
    .where(eq(ConfigObjectVersionTable.configObjectId, configObjectId))
  const configObjectVersionId = versions[0]?.id
  if (!configObjectVersionId) throw new Error("Workflow has no version")
  return { configObjectId, configObjectVersionId, organizationId, ownerMemberId, pluginId: plugin.id, viewerMemberId }
}

function pinnedAction(seeded: SeededWorkflow) {
  return {
    kind: "saved_script" as const,
    script: {
      pluginId: seeded.pluginId,
      configObjectId: seeded.configObjectId,
      configObjectVersionId: seeded.configObjectVersionId,
    },
    input: {},
  }
}

describe("pinning a Workflow to a Cloud Automation", () => {
  test("refuses an owner who can only view the Workflow", async () => {
    const seeded = await seedWorkflowWithViewer()

    const viewerGrants = await db.select({ role: ConfigObjectAccessGrantTable.role, orgWide: ConfigObjectAccessGrantTable.orgWide })
      .from(ConfigObjectAccessGrantTable)
      .where(eq(ConfigObjectAccessGrantTable.configObjectId, seeded.configObjectId))
    expect(viewerGrants).toContainEqual({ role: "viewer", orgWide: true })

    await expect(workflows.validateWorkflowAutomationAction({
      organizationId: seeded.organizationId,
      ownerMemberId: seeded.viewerMemberId,
      action: pinnedAction(seeded),
    })).rejects.toThrow("automation_saved_script_forbidden")
  })

  test("admits an owner once they hold an editor grant on the Workflow", async () => {
    const seeded = await seedWorkflowWithViewer()
    await db.insert(ConfigObjectAccessGrantTable).values({
      id: createDenTypeId("configObjectAccessGrant"),
      organizationId: seeded.organizationId,
      configObjectId: seeded.configObjectId,
      orgMembershipId: seeded.viewerMemberId,
      teamId: null,
      orgWide: false,
      role: "editor",
      createdByOrgMembershipId: seeded.ownerMemberId,
    })

    await expect(workflows.validateWorkflowAutomationAction({
      organizationId: seeded.organizationId,
      ownerMemberId: seeded.viewerMemberId,
      action: pinnedAction(seeded),
    })).resolves.toBeUndefined()
  })

  test("admits the publishing owner, whose admin role needs no grant", async () => {
    const seeded = await seedWorkflowWithViewer()

    await expect(workflows.validateWorkflowAutomationAction({
      organizationId: seeded.organizationId,
      ownerMemberId: seeded.ownerMemberId,
      action: pinnedAction(seeded),
    })).resolves.toBeUndefined()
  })
})
