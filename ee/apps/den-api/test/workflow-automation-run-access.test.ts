import { Tool } from "@openwork/codemode"
import { Effect } from "effect"
import { artifactDigest } from "../src/workflow-artifacts.js"
import type { BuiltCodemodeTools } from "../src/mcp/codemode-tools.js"
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  ArtifactViewTable,
  ArtifactViewRevisionTable,
  DashboardAppTable,
  WorkflowRunTable,
  AuthUserTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ConnectorAccountTable,
  ConnectorInstanceTable,
  ConnectorInstanceAccessGrantTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
  OrganizationTable,
  TeamTable,
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
  marketplaceId: DenTypeId<"marketplace">
  viewerMemberId: DenTypeId<"member">
  ownerContext: PluginArchActorContext
  viewerContext: PluginArchActorContext
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
    await db.delete(DashboardAppTable).where(inArray(DashboardAppTable.organization_id, createdOrganizationIds))
    await db.delete(ArtifactViewRevisionTable).where(inArray(ArtifactViewRevisionTable.organization_id, createdOrganizationIds))
    await db.delete(ArtifactViewTable).where(inArray(ArtifactViewTable.organization_id, createdOrganizationIds))
    await db.delete(WorkflowRunTable).where(inArray(WorkflowRunTable.organization_id, createdOrganizationIds))
    await db.delete(ConfigObjectVersionTable).where(inArray(ConfigObjectVersionTable.organizationId, createdOrganizationIds))
    await db.delete(ConfigObjectAccessGrantTable).where(inArray(ConfigObjectAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.organizationId, createdOrganizationIds))
    await db.delete(PluginAccessGrantTable).where(inArray(PluginAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(MarketplacePluginTable).where(inArray(MarketplacePluginTable.organizationId, createdOrganizationIds))
    await db.delete(MarketplaceAccessGrantTable).where(inArray(MarketplaceAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(ConfigObjectTable).where(inArray(ConfigObjectTable.organizationId, createdOrganizationIds))
    await db.delete(PluginTable).where(inArray(PluginTable.organizationId, createdOrganizationIds))
    await db.delete(MarketplaceTable).where(inArray(MarketplaceTable.organizationId, createdOrganizationIds))
    await db.delete(ConnectorInstanceAccessGrantTable).where(inArray(ConnectorInstanceAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(ConnectorInstanceTable).where(inArray(ConnectorInstanceTable.organizationId, createdOrganizationIds))
    await db.delete(ConnectorAccountTable).where(inArray(ConnectorAccountTable.organizationId, createdOrganizationIds))
    await db.delete(TeamTable).where(inArray(TeamTable.organizationId, createdOrganizationIds))
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
        directRole: "owner",
        adminTeams: [],
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
  return {
    configObjectId, configObjectVersionId, organizationId, ownerMemberId, pluginId: plugin.id, marketplaceId, viewerMemberId,
    ownerContext: context,
    viewerContext: {
      ...context,
      organizationContext: {
        ...context.organizationContext,
        currentMember: {
          ...context.organizationContext.currentMember,
          id: viewerMemberId, userId: viewerUserId, role: "member", directRole: "member", isOwner: false,
        },
      },
    },
  }
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

test("artifact catalog SQL bounds each view independently and keeps exact old revisions readable", async () => {
  const seeded = await seedWorkflowWithViewer()
  await prepareLiveWorkflow(seeded)
  const catalog = await import("../src/artifact-views.js")
  const savedApps = await import("../src/saved-apps.js")
  const expected = new Map<string, string[]>()
  const createdAt = new Date("2026-01-01T00:00:00.000Z")
  // Cross the 10-view batch boundary, and the 50-revision per-view boundary.
  for (let viewIndex = 0; viewIndex < 11; viewIndex++) {
    const id = createDenTypeId("artifactView")
    const revisions: Array<typeof ArtifactViewRevisionTable.$inferInsert> = Array.from({ length: 55 }, () => ({
      id: createDenTypeId("artifactViewRevision"), artifact_view_id: id, organization_id: seeded.organizationId,
      created_by_member_id: seeded.ownerMemberId, created_at: createdAt,
      react_source: "export default function App() { return null }", css_source: "/* synthetic */",
      compiled_html: `<html>${"synthetic ".repeat(1024)}</html>`, compiled_html_bytes: 10253,
      build_status: "ready", build_diagnostics: [], source_digest: artifactDigest("source"),
      resource_digest: artifactDigest("html"), output_schema_digest: artifactDigest({ type: "object" }),
      output_schema: { type: "object" }, csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
      compiler_name: "test", compiler_version: "1", react_version: "19",
    }))
    const ids = revisions.map((revision) => revision.id).sort().reverse()
    expected.set(id, ids)
    await db.insert(ArtifactViewTable).values({
      id, organization_id: seeded.organizationId, config_object_id: seeded.configObjectId,
      owner_member_id: seeded.ownerMemberId, title: `Synthetic app ${viewIndex}`, active_revision_id: ids[0],
      data_mode: viewIndex % 2 === 0 ? "live" : "snapshot",
    })
    await db.insert(ArtifactViewRevisionTable).values(revisions)
  }
  const views = await catalog.listArtifactViews({ context: seeded.viewerContext })
  expect(views).toHaveLength(11)
  for (const view of views) {
    expect(view.revisions.map((revision) => revision.id)).toEqual(expected.get(view.id)?.slice(0, 50))
    expect(JSON.stringify(view)).not.toContain("<html>")
    expect(JSON.stringify(view)).not.toContain("export default")
    const oldId = expected.get(view.id)?.[54]
    if (!oldId) throw new Error("Missing old revision")
    const exact = await catalog.getGeneratedArtifactViewRevision({ context: seeded.viewerContext, artifactViewId: view.id, revisionId: oldId })
    expect(exact.revision.id).toBe(oldId)
  }
  expect(await savedApps.listSavedApps(seeded.viewerContext)).toHaveLength(11)
  expect(await catalog.listArtifactViewsForScript({ context: seeded.viewerContext, configObjectId: seeded.configObjectId })).toHaveLength(11)

  const { executeWorkflow } = await import("../src/mcp/workflow-service.js")
  const snapshot = await executeWorkflow({
    database: db, organizationId: seeded.organizationId, orgMembershipId: seeded.ownerMemberId,
    pluginId: seeded.pluginId, configObjectId: seeded.configObjectId, configObjectVersionId: seeded.configObjectVersionId,
    normalizedPayloadJson: { language: "codemode-js", requiredCapabilities: [], outputSchema: liveOutputSchema },
    code: 'return { report: "rollback snapshot" }', validateOutput: true,
    buildTools: async () => ({ tools: {}, manifest: [] }),
  })
  if (!snapshot.ok || !snapshot.receiptId) throw new Error("Expected snapshot")
  for (const view of views) {
    const oldId = expected.get(view.id)?.[54]
    if (!oldId) throw new Error("Missing rollback revision")
    const activated = await catalog.activateArtifactViewRevision({ context: seeded.ownerContext, artifactViewId: view.id, revisionId: oldId })
    expect(activated.revisions).toHaveLength(51)
    expect(activated.revisions.find((revision) => revision.id === activated.activeRevisionId)?.id).toBe(oldId)
    const detail = await catalog.getArtifactView({ context: seeded.viewerContext, artifactViewId: view.id })
    expect(detail.revisions.map((revision) => revision.id)).toEqual([...expected.get(view.id)!.slice(0, 50), oldId])
    const app = await savedApps.getSavedApp({ context: seeded.viewerContext, appId: view.id,
      ...(view.dataMode === "snapshot" ? { receiptId: snapshot.receiptId } : {}),
      buildTools: async () => actorTools(seeded.viewerMemberId),
    })
    expect(app.revision?.id).toBe(oldId)
    expect(app.html).toContain("<html>")
    expect(app.previewNotice).toBeNull()
    expect(app.payload?.data).toMatchObject(view.dataMode === "live" ? { actor: seeded.viewerMemberId } : { report: "rollback snapshot" })
  }
  for (const listed of [
    await catalog.listArtifactViews({ context: seeded.viewerContext }),
    await catalog.listArtifactViewsForScript({ context: seeded.viewerContext, configObjectId: seeded.configObjectId }),
    (await savedApps.listSavedApps(seeded.viewerContext)).map((app) => app.view),
  ]) {
    for (const view of listed) {
      expect(view.revisions).toHaveLength(51)
      expect(view.revisions.find((revision) => revision.id === view.activeRevisionId)?.id).toBe(expected.get(view.id)?.[54])
      expect(JSON.stringify(view)).not.toContain("<html>")
      expect(JSON.stringify(view)).not.toContain("export default")
    }
  }
  const [first, second] = views
  if (!first || !second) throw new Error("Expected multiple views")
  const [foreignRevision] = await db.select().from(ArtifactViewRevisionTable).where(eq(ArtifactViewRevisionTable.artifact_view_id, second.id)).limit(1)
  if (!foreignRevision) throw new Error("Expected foreign revision")
  await db.update(ArtifactViewTable).set({ active_revision_id: foreignRevision.id }).where(eq(ArtifactViewTable.id, first.id))
  const corrupted = await catalog.getArtifactView({ context: seeded.viewerContext, artifactViewId: first.id })
  expect(corrupted.revisions).toHaveLength(50)
  expect(corrupted.revisions.some((revision) => revision.id === foreignRevision.id)).toBe(false)
  const batched = await catalog.listArtifactViews({ context: seeded.viewerContext })
  expect(batched.find((view) => view.id === first.id)?.revisions.map((revision) => revision.id)).toEqual(expected.get(first.id)?.slice(0, 50))
})

test("catalog access matches detail for direct grants, revocation, invalid versions and removed memberships", async () => {
  const seeded = await seedWorkflowWithViewer()
  const catalog = await import("../src/artifact-views.js")
  const input = { context: seeded.viewerContext, configObjectId: seeded.configObjectId }
  await db.insert(ArtifactViewTable).values({
    id: createDenTypeId("artifactView"), organization_id: seeded.organizationId,
    config_object_id: seeded.configObjectId, owner_member_id: seeded.ownerMemberId, title: "Access probe",
  })
  // Direct workflow grants must continue to work without access to a Plugin.
  await db.delete(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, seeded.organizationId))
  await db.delete(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.organizationId, seeded.organizationId))
  expect((await workflows.getWorkflowAccess(input)).canManage).toBe((await workflows.getWorkflowDetail(input)).canManage)
  expect(await catalog.listArtifactViews({ context: seeded.viewerContext })).toHaveLength(1)
  expect((await workflows.getWorkflowAccess({ ...input, context: seeded.ownerContext })).canManage).toBe(true)
  const otherOrganizationInput = {
    ...input,
    context: { ...input.context, organizationContext: { ...input.context.organizationContext,
      organization: { ...input.context.organizationContext.organization, id: createDenTypeId("organization") },
    } },
  }
  await expect(workflows.getWorkflowDetail(otherOrganizationInput)).rejects.toThrow("workflow_not_found")
  await expect(workflows.getWorkflowAccess(otherOrganizationInput)).rejects.toThrow("workflow_not_found")
  await db.update(ConfigObjectTable).set({ deletedAt: new Date() }).where(eq(ConfigObjectTable.id, seeded.configObjectId))
  await expect(workflows.getWorkflowDetail(input)).rejects.toThrow("workflow_not_found")
  await expect(workflows.getWorkflowAccess(input)).rejects.toThrow("workflow_not_found")
  await db.update(ConfigObjectTable).set({ deletedAt: null }).where(eq(ConfigObjectTable.id, seeded.configObjectId))
  await db.update(PluginTable).set({ deletedAt: new Date() }).where(eq(PluginTable.id, seeded.pluginId))
  await expect(workflows.getWorkflowDetail(input)).rejects.toThrow("workflow_not_found")
  await expect(workflows.getWorkflowAccess(input)).rejects.toThrow("workflow_not_found")
  await db.update(PluginTable).set({ deletedAt: null }).where(eq(PluginTable.id, seeded.pluginId))

  const [version] = await db.select().from(ConfigObjectVersionTable).where(eq(ConfigObjectVersionTable.id, seeded.configObjectVersionId))
  if (!version) throw new Error("Missing version")
  await db.insert(ConfigObjectVersionTable).values({
    ...version, id: createDenTypeId("configObjectVersion"), createdAt: new Date(version.createdAt.getTime() + 1000),
    normalizedPayloadJson: { language: "invalid" },
  })
  expect((await workflows.getWorkflowDetail(input)).currentVersion.id).toBe(version.id)
  expect(await workflows.getWorkflowAccess(input)).toMatchObject({ configObjectId: seeded.configObjectId })
  await db.update(ConfigObjectVersionTable).set({ isDeletedVersion: true }).where(eq(ConfigObjectVersionTable.id, version.id))
  await expect(workflows.getWorkflowDetail(input)).rejects.toThrow("workflow_version_not_found")
  await expect(workflows.getWorkflowAccess(input)).rejects.toThrow("workflow_version_not_found")
  expect(await catalog.listArtifactViews({ context: seeded.viewerContext })).toEqual([])
  await db.update(ConfigObjectVersionTable).set({ isDeletedVersion: false }).where(eq(ConfigObjectVersionTable.id, version.id))

  await db.update(PluginConfigObjectTable).set({ removedAt: new Date() }).where(eq(PluginConfigObjectTable.configObjectId, seeded.configObjectId))
  await expect(workflows.getWorkflowDetail(input)).rejects.toThrow("workflow_not_found")
  await expect(workflows.getWorkflowAccess(input)).rejects.toThrow("workflow_not_found")
  await db.update(PluginConfigObjectTable).set({ removedAt: null }).where(eq(PluginConfigObjectTable.configObjectId, seeded.configObjectId))
  await db.delete(ConfigObjectAccessGrantTable).where(eq(ConfigObjectAccessGrantTable.configObjectId, seeded.configObjectId))
  await expect(workflows.getWorkflowDetail(input)).rejects.toThrow()
  await expect(workflows.getWorkflowAccess(input)).rejects.toThrow()
  expect(await catalog.listArtifactViews({ context: seeded.viewerContext })).toEqual([])
})

const liveOutputSchema = { type: "object" }
const liveRequired = { scriptPath: "tools.den.me", capabilityName: "getMe" }

async function prepareLiveWorkflow(seeded: SeededWorkflow) {
  await db.update(ConfigObjectVersionTable).set({
    rawSourceText: "const actor = await tools.den.me({}); return { actor, runtime: input.runtime };",
    normalizedPayloadJson: {
      language: "codemode-js",
      requiredCapabilities: [liveRequired],
      outputSchema: liveOutputSchema,
      inputSchema: { type: "object", required: ["runtime"] },
      exampleInput: { runtime: { today: "2000-01-01", now: "2000-01-01T00:00:00Z" } },
    },
  }).where(eq(ConfigObjectVersionTable.id, seeded.configObjectVersionId))
}

function actorTools(memberId: string, readOnly = true): BuiltCodemodeTools {
  return {
    tools: {
      den: {
        me: Tool.make({ description: "Read caller identity", input: { type: "object" }, run: () => Effect.succeed(memberId) }),
      },
    },
    manifest: [{ ...liveRequired, authority: "den", readOnly }],
  }
}

function appResources(seeded: SeededWorkflow, context = seeded.viewerContext) {
  return [
    { context, resourceId: seeded.configObjectId, resourceKind: "config_object" },
    { context, resourceId: seeded.pluginId, resourceKind: "plugin" },
    { context, resourceId: seeded.marketplaceId, resourceKind: "marketplace" },
  ] satisfies Array<Parameters<PluginStore["listResourceAccess"]>[0]>
}

async function grantAppManager(seeded: SeededWorkflow) {
  for (const resource of appResources(seeded, seeded.ownerContext)) {
    await pluginStore.createResourceAccessGrant({ ...resource, value: { orgMembershipId: seeded.viewerMemberId, role: "manager" } })
  }
  await db.update(ConfigObjectTable).set({ createdByOrgMembershipId: seeded.viewerMemberId })
    .where(eq(ConfigObjectTable.id, seeded.configObjectId))
}

async function bindApp(seeded: SeededWorkflow, state = "draft") {
  await prepareLiveWorkflow(seeded)
  const views = await import("../src/artifact-views.js")
  const view = await views.saveArtifactViewRevision({ context: seeded.ownerContext, configObjectId: seeded.configObjectId,
    title: "Managed report", reactSource: "export default function App({data}) { return <div>{data.actor}</div> }" })
  const revisionId = view.revisions[0]?.id
  if (!revisionId) throw new Error("Missing app revision")
  if (state !== "draft") await views.activateArtifactViewRevision({ context: seeded.ownerContext, artifactViewId: view.id, revisionId })
  if (state === "retired") await views.retireArtifactView({ context: seeded.ownerContext, artifactViewId: view.id })
  await db.update(ArtifactViewTable).set({ owner_member_id: seeded.viewerMemberId }).where(eq(ArtifactViewTable.id, view.id))
  return view
}

const changedWorkflow = {
  metadata: { title: "Scheduled briefing" },
  rawSourceText: 'return { actor: "changed" }',
  normalizedPayloadJson: { language: "codemode-js", outputSchema: liveOutputSchema, requiredCapabilities: [] },
}

async function testChangedWorkflow(seeded: SeededWorkflow, context: PluginArchActorContext) {
  const draft = { name: "Scheduled briefing", code: changedWorkflow.rawSourceText, outputSchema: liveOutputSchema, requiredCapabilities: [] }
  const buildTools = async () => ({ tools: {}, manifest: [] })
  const tested = await workflows.testWorkflowDraft({ context, configObjectId: seeded.configObjectId, draft, buildTools })
  if (!tested.ok || !tested.receiptId) throw new Error("Expected tested draft")
  return { context, configObjectId: seeded.configObjectId, draft, buildTools, receiptId: tested.receiptId }
}

test.each(["draft", "active", "retired"])("%s app bindings deny backing workflow owners indirect edits and sharing through every parent", async (state) => {
  const seeded = await seedWorkflowWithViewer()
  await grantAppManager(seeded)
  const teamId = createDenTypeId("team")
  await db.insert(TeamTable).values({ id: teamId, organizationId: seeded.organizationId, name: "Report readers" })
  await bindApp(seeded, state)
  const context = seeded.viewerContext
  const tested = await testChangedWorkflow(seeded, context)
  const before = await workflows.getWorkflowDetail({ context, configObjectId: seeded.configObjectId })
  expect(before.canManage).toBe(true)
  const versions = await db.select().from(ConfigObjectVersionTable).where(eq(ConfigObjectVersionTable.configObjectId, seeded.configObjectId))
  const appRows = await db.select().from(ArtifactViewTable).where(eq(ArtifactViewTable.config_object_id, seeded.configObjectId))
  const grants = await Promise.all(appResources(seeded).map((resource) => pluginStore.listResourceAccess(resource)))
  for (const operation of [
    () => pluginStore.createConfigObjectVersion({ context, configObjectId: seeded.configObjectId, value: changedWorkflow }),
    ...(["archive", "delete", "restore"] satisfies Array<"archive" | "delete" | "restore">).map((action) =>
      () => pluginStore.setConfigObjectLifecycle({ context, configObjectId: seeded.configObjectId, action })),
    () => workflows.createWorkflowVersion(tested),
    () => workflows.saveWorkflow({ context, organizationId: seeded.organizationId, ownerMemberId: seeded.viewerMemberId,
      workflow: { pluginId: seeded.pluginId, name: tested.draft.name, code: tested.draft.code, outputSchema: liveOutputSchema }, buildTools: tested.buildTools }),
    () => pluginStore.attachConfigObjectToPlugin({ context, configObjectId: seeded.configObjectId, pluginId: seeded.pluginId }),
    () => pluginStore.removeConfigObjectFromPlugin({ context, configObjectId: seeded.configObjectId, pluginId: seeded.pluginId }),
    () => pluginStore.attachPluginToMarketplace({ context, pluginId: seeded.pluginId, marketplaceId: seeded.marketplaceId }),
    () => pluginStore.removePluginFromMarketplace({ context, pluginId: seeded.pluginId, marketplaceId: seeded.marketplaceId }),
    ...(["archive", "restore"] satisfies Array<"archive" | "restore">).map((action) =>
      () => pluginStore.setPluginLifecycle({ context, pluginId: seeded.pluginId, action })),
    ...(["archive", "delete", "restore"] satisfies Array<"archive" | "delete" | "restore">).map((action) =>
      () => pluginStore.setMarketplaceLifecycle({ context, marketplaceId: seeded.marketplaceId, action })),
  ]) await expect(operation()).rejects.toThrow("Only organization owners and admins")
  for (const resource of appResources(seeded)) {
    for (const value of [
      { orgMembershipId: seeded.viewerMemberId, role: "viewer" }, { teamId, role: "viewer" }, { orgWide: true, role: "viewer" },
    ] satisfies Array<Parameters<PluginStore["createResourceAccessGrant"]>[0]["value"]>) {
      await expect(pluginStore.createResourceAccessGrant({ ...resource, value })).rejects.toThrow("Only organization owners and admins")
    }
  }
  const [configGrant] = await db.select().from(ConfigObjectAccessGrantTable).where(eq(ConfigObjectAccessGrantTable.configObjectId, seeded.configObjectId))
  const [pluginGrant] = await db.select().from(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.pluginId, seeded.pluginId))
  const [marketplaceGrant] = await db.select().from(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.marketplaceId, seeded.marketplaceId))
  if (!configGrant || !pluginGrant || !marketplaceGrant) throw new Error("Missing grants")
  for (const resource of [
    { context, resourceKind: "config_object", resourceId: seeded.configObjectId, grantId: configGrant.id },
    { context, resourceKind: "plugin", resourceId: seeded.pluginId, grantId: pluginGrant.id },
    { context, resourceKind: "marketplace", resourceId: seeded.marketplaceId, grantId: marketplaceGrant.id },
  ] satisfies Array<Parameters<PluginStore["deleteResourceAccessGrant"]>[0]>) {
    await expect(pluginStore.deleteResourceAccessGrant(resource)).rejects.toThrow("Only organization owners and admins")
  }
  expect(await db.select().from(ConfigObjectVersionTable).where(eq(ConfigObjectVersionTable.configObjectId, seeded.configObjectId))).toEqual(versions)
  expect(await db.select().from(ArtifactViewTable).where(eq(ArtifactViewTable.config_object_id, seeded.configObjectId))).toEqual(appRows)
  expect(await Promise.all(appResources(seeded).map((resource) => pluginStore.listResourceAccess(resource)))).toEqual(grants)
  const fresh = await workflows.executeLiveArtifactWorkflow({ context, configObjectId: seeded.configObjectId,
    expectedOutputSchemaDigest: artifactDigest(liveOutputSchema), buildTools: async () => actorTools(seeded.viewerMemberId) })
  expect(fresh.ok).toBe(true)
  if (fresh.ok) expect(fresh.value).toMatchObject({ actor: seeded.viewerMemberId })
})

test("non-app workflow editors and managers retain version, lifecycle and access permissions", async () => {
  const seeded = await seedWorkflowWithViewer()
  await grantAppManager(seeded)
  await pluginStore.createResourceAccessGrant({ context: seeded.ownerContext, resourceKind: "config_object", resourceId: seeded.configObjectId,
    value: { orgMembershipId: seeded.viewerMemberId, role: "editor" } })
  await pluginStore.createConfigObjectVersion({ context: seeded.viewerContext, configObjectId: seeded.configObjectId, value: changedWorkflow })
  expect((await workflows.getWorkflowDetail({ context: seeded.ownerContext, configObjectId: seeded.configObjectId })).currentVersion.code).toBe(changedWorkflow.rawSourceText)
  await bindApp(seeded)
  await expect(pluginStore.createConfigObjectVersion({ context: seeded.viewerContext, configObjectId: seeded.configObjectId, value: changedWorkflow }))
    .rejects.toThrow("Only organization owners and admins")
  const plain = await seedWorkflowWithViewer()
  await grantAppManager(plain)
  const tested = await testChangedWorkflow(plain, plain.viewerContext)
  await workflows.createWorkflowVersion(tested)
  await workflows.saveWorkflow({ context: plain.viewerContext, organizationId: plain.organizationId, ownerMemberId: plain.viewerMemberId,
    workflow: { pluginId: plain.pluginId, name: tested.draft.name, code: tested.draft.code, outputSchema: liveOutputSchema }, buildTools: tested.buildTools })
  for (const resource of appResources(plain)) {
    await pluginStore.createResourceAccessGrant({ ...resource, value: { orgMembershipId: plain.ownerMemberId, role: "viewer" } })
  }
  await pluginStore.setConfigObjectLifecycle({ context: plain.viewerContext, configObjectId: plain.configObjectId, action: "archive" })
  await pluginStore.setConfigObjectLifecycle({ context: plain.viewerContext, configObjectId: plain.configObjectId, action: "restore" })
})

test.each(["owner", "admin"])("%s can edit app-bound workflows and change inherited app access without an ownership override", async (role) => {
  const seeded = await seedWorkflowWithViewer()
  await grantAppManager(seeded)
  const view = await bindApp(seeded, "retired")
  await db.update(MemberTable).set({ role }).where(eq(MemberTable.id, seeded.ownerMemberId))
  const context: PluginArchActorContext = { ...seeded.ownerContext, organizationContext: { ...seeded.ownerContext.organizationContext,
    currentMember: { ...seeded.ownerContext.organizationContext.currentMember, role, directRole: role, isOwner: role === "owner" } } }
  await pluginStore.createConfigObjectVersion({ context, configObjectId: seeded.configObjectId, value: changedWorkflow })
  const tested = await testChangedWorkflow(seeded, context)
  await workflows.createWorkflowVersion(tested)
  await workflows.saveWorkflow({ context, organizationId: seeded.organizationId, ownerMemberId: seeded.ownerMemberId,
    workflow: { pluginId: seeded.pluginId, name: tested.draft.name, code: tested.draft.code, outputSchema: liveOutputSchema }, buildTools: tested.buildTools })
  for (const resource of appResources(seeded, context)) {
    await pluginStore.createResourceAccessGrant({ ...resource, value: { orgMembershipId: seeded.viewerMemberId, role: "editor" } })
  }
  const [grant] = await db.select().from(ConfigObjectAccessGrantTable).where(eq(ConfigObjectAccessGrantTable.configObjectId, seeded.configObjectId))
  if (!grant) throw new Error("Missing config grant")
  await pluginStore.deleteResourceAccessGrant({ context, resourceKind: "config_object", resourceId: seeded.configObjectId, grantId: grant.id })
  await pluginStore.removeConfigObjectFromPlugin({ context, configObjectId: seeded.configObjectId, pluginId: seeded.pluginId })
  await pluginStore.attachConfigObjectToPlugin({ context, configObjectId: seeded.configObjectId, pluginId: seeded.pluginId })
  await pluginStore.removePluginFromMarketplace({ context, pluginId: seeded.pluginId, marketplaceId: seeded.marketplaceId })
  await pluginStore.attachPluginToMarketplace({ context, pluginId: seeded.pluginId, marketplaceId: seeded.marketplaceId })
  await pluginStore.setPluginLifecycle({ context, pluginId: seeded.pluginId, action: "archive" })
  await pluginStore.setPluginLifecycle({ context, pluginId: seeded.pluginId, action: "restore" })
  await pluginStore.setMarketplaceLifecycle({ context, marketplaceId: seeded.marketplaceId, action: "archive" })
  await pluginStore.setMarketplaceLifecycle({ context, marketplaceId: seeded.marketplaceId, action: "restore" })
  await pluginStore.setConfigObjectLifecycle({ context, configObjectId: seeded.configObjectId, action: "delete" })
  await pluginStore.setConfigObjectLifecycle({ context, configObjectId: seeded.configObjectId, action: "restore" })
  const { activateArtifactViewRevision } = await import("../src/artifact-views.js")
  const revisionId = view.revisions[0]?.id
  if (!revisionId) throw new Error("Missing app revision")
  expect((await activateArtifactViewRevision({ context, artifactViewId: view.id, revisionId })).status).toBe("active")
})

test("detached parents remain manageable but restoring app access still requires an admin", async () => {
  const seeded = await seedWorkflowWithViewer()
  await grantAppManager(seeded)
  await bindApp(seeded, "retired")
  await pluginStore.removeConfigObjectFromPlugin({ context: seeded.ownerContext, configObjectId: seeded.configObjectId, pluginId: seeded.pluginId })
  for (const resource of appResources(seeded).filter((resource) => resource.resourceKind !== "config_object")) {
    await pluginStore.createResourceAccessGrant({ ...resource, value: { orgMembershipId: seeded.ownerMemberId, role: "viewer" } })
  }
  await expect(pluginStore.attachConfigObjectToPlugin({ context: seeded.viewerContext, configObjectId: seeded.configObjectId, pluginId: seeded.pluginId }))
    .rejects.toThrow("Only organization owners and admins")
  await pluginStore.attachConfigObjectToPlugin({ context: seeded.ownerContext, configObjectId: seeded.configObjectId, pluginId: seeded.pluginId })
  await pluginStore.removePluginFromMarketplace({ context: seeded.ownerContext, pluginId: seeded.pluginId, marketplaceId: seeded.marketplaceId })
  await pluginStore.createResourceAccessGrant({ context: seeded.viewerContext, resourceKind: "marketplace", resourceId: seeded.marketplaceId,
    value: { orgMembershipId: seeded.ownerMemberId, role: "viewer" } })
  await expect(pluginStore.attachPluginToMarketplace({ context: seeded.viewerContext, pluginId: seeded.pluginId, marketplaceId: seeded.marketplaceId }))
    .rejects.toThrow("Only organization owners and admins")
  const foreign = await seedWorkflowWithViewer()
  await expect(pluginStore.createConfigObjectVersion({ context: foreign.ownerContext, configObjectId: seeded.configObjectId, value: changedWorkflow }))
    .rejects.toThrow("Config object not found")
  await expect(pluginStore.createResourceAccessGrant({ context: foreign.ownerContext, resourceKind: "plugin", resourceId: seeded.pluginId,
    value: { orgMembershipId: foreign.viewerMemberId, role: "viewer" } })).rejects.toThrow("Plugin not found")
})

test.each([false, true])("connector cleanup preserves admin-only app bindings (bound: %s)", async (bound) => {
  const seeded = await seedWorkflowWithViewer()
  const account = await pluginStore.createConnectorAccount({ context: seeded.ownerContext, connectorType: "github", displayName: "Synthetic repository", remoteId: "synthetic" })
  const instance = await pluginStore.createConnectorInstance({ context: seeded.ownerContext, connectorAccountId: account.id, connectorType: "github", name: "Synthetic import" })
  await pluginStore.createResourceAccessGrant({ context: seeded.ownerContext, resourceKind: "connector_instance", resourceId: instance.id,
    value: { orgMembershipId: seeded.viewerMemberId, role: "editor" } })
  await db.update(ConfigObjectTable).set({ connectorInstanceId: instance.id }).where(eq(ConfigObjectTable.id, seeded.configObjectId))
  if (bound) {
    await bindApp(seeded, "retired")
    await expect(pluginStore.removeConnectorInstance({ context: seeded.viewerContext, connectorInstanceId: instance.id }))
      .rejects.toThrow("Only organization owners and admins")
    await expect(pluginStore.disconnectConnectorAccount({ context: seeded.viewerContext, connectorAccountId: account.id }))
      .rejects.toThrow("Only organization owners and admins")
    expect(await db.select().from(ConfigObjectVersionTable).where(eq(ConfigObjectVersionTable.configObjectId, seeded.configObjectId))).toHaveLength(1)
    expect(await db.select().from(ConnectorInstanceTable).where(eq(ConnectorInstanceTable.id, instance.id))).toHaveLength(1)
  } else {
    const removed = await pluginStore.removeConnectorInstance({ context: seeded.viewerContext, connectorInstanceId: instance.id })
    expect(removed.deletedConfigObjectCount).toBe(1)
  }
})

describe("live generated apps and personal receipts", () => {
  test("published workflow snapshot reads retain other members' explicit runs but exclude live provenance", async () => {
    const seeded = await seedWorkflowWithViewer()
    await prepareLiveWorkflow(seeded)
    const { executeWorkflow } = await import("../src/mcp/workflow-service.js")
    const snapshot = await executeWorkflow({
      database: db, organizationId: seeded.organizationId, orgMembershipId: seeded.ownerMemberId,
      pluginId: seeded.pluginId, configObjectId: seeded.configObjectId,
      configObjectVersionId: seeded.configObjectVersionId,
      normalizedPayloadJson: { language: "codemode-js", requiredCapabilities: [], outputSchema: liveOutputSchema },
      code: 'return { report: "shared snapshot" }', validateOutput: true,
      buildTools: async () => ({ tools: {}, manifest: [] }),
    })
    if (!snapshot.ok || !snapshot.receiptId) throw new Error("expected legacy snapshot")
    const live = await workflows.executeLiveArtifactWorkflow({
      context: seeded.ownerContext, configObjectId: seeded.configObjectId,
      expectedOutputSchemaDigest: artifactDigest(liveOutputSchema),
      buildTools: async () => actorTools(seeded.ownerMemberId),
    })
    if (!live.ok || !live.receiptId) throw new Error("expected live result")
    const query = { context: seeded.viewerContext, configObjectId: seeded.configObjectId }
    for (let read = 0; read < 2; read += 1) {
      const detail = await workflows.getWorkflowDetail(query)
      expect(detail.latestSnapshot?.receiptId).toBe(snapshot.receiptId)
      expect(detail.latestSuccessfulSnapshot?.receiptId).toBe(snapshot.receiptId)
      expect(JSON.stringify(detail)).not.toContain(live.receiptId)
      expect((await workflows.listWorkflowSnapshots(query)).items.map((row) => row.receiptId)).toEqual([snapshot.receiptId])
      expect((await workflows.getWorkflowSnapshot({ ...query, receiptId: snapshot.receiptId }))?.value).toEqual({ report: "shared snapshot" })
      expect(await workflows.getWorkflowSnapshot({ ...query, receiptId: live.receiptId })).toBeNull()
    }
    const { saveArtifactViewRevision } = await import("../src/artifact-views.js")
    const { getSavedApp } = await import("../src/saved-apps.js")
    const view = await saveArtifactViewRevision({
      context: seeded.ownerContext, configObjectId: seeded.configObjectId,
      title: "Live isolation", reactSource: "export default function App() { return <div>Live</div> }",
    })
    const load = { context: seeded.viewerContext, appId: view.id, revisionId: view.revisions[0]?.id }
    for (const receiptId of [snapshot.receiptId, live.receiptId]) {
      await expect(getSavedApp({ ...load, receiptId })).rejects.toThrow("artifact_view_live_receipt_override_denied")
    }
    const missing = await getSavedApp({ ...load, buildTools: async () => ({ tools: {}, manifest: [] }) })
    expect(missing.payload).toBeNull()
    expect(missing.runError).toMatchObject({ error: "capability_unavailable" })
    expect(JSON.stringify(missing)).not.toContain("shared snapshot")
    for (let read = 0; read < 2; read += 1) {
      const fresh = await getSavedApp({ ...load, buildTools: async () => actorTools(seeded.viewerMemberId) })
      expect(fresh.payload?.data).toMatchObject({ actor: seeded.viewerMemberId })
      expect(JSON.stringify(fresh.payload)).not.toContain(seeded.ownerMemberId)
    }
    await db.update(WorkflowRunTable).set({ source: "unrecognized" }).where(eq(WorkflowRunTable.id, snapshot.receiptId))
    expect(await workflows.getWorkflowSnapshot({ ...query, receiptId: snapshot.receiptId })).toBeNull()
  })

  test("viewer runs the saved current code with their own tools; exact, list and detail receipts stay private", async () => {
    const seeded = await seedWorkflowWithViewer()
    await prepareLiveWorkflow(seeded)
    const run = (context: PluginArchActorContext) => workflows.executeLiveArtifactWorkflow({
      context, configObjectId: seeded.configObjectId,
      expectedOutputSchemaDigest: artifactDigest(liveOutputSchema), timeZone: "Asia/Tokyo",
      buildTools: async () => actorTools(context.organizationContext.currentMember.id),
    })
    const owner = await run(seeded.ownerContext)
    const viewer = await run(seeded.viewerContext)
    expect(owner.ok).toBe(true)
    expect(viewer.ok).toBe(true)
    if (!owner.ok || !viewer.ok || !owner.receiptId || !viewer.receiptId) throw new Error("expected durable results")
    expect(owner.value).toMatchObject({ actor: seeded.ownerMemberId })
    expect(viewer.value).toMatchObject({ actor: seeded.viewerMemberId, runtime: { timeZone: "Asia/Tokyo" } })
    expect(JSON.stringify(viewer.value)).not.toContain("2000-01-01")
    expect(viewer.receiptId).not.toBe(owner.receiptId)
    for (const [context, own, foreign] of [
      [seeded.ownerContext, owner.receiptId, viewer.receiptId],
      [seeded.viewerContext, viewer.receiptId, owner.receiptId],
    ] satisfies Array<[PluginArchActorContext, string, string]>) {
      const detail = await workflows.getWorkflowDetail({ context, configObjectId: seeded.configObjectId })
      expect(detail.latestSuccessfulSnapshot?.receiptId).toBe(own)
      expect(JSON.stringify(detail)).not.toContain(foreign)
      const page = await workflows.listWorkflowSnapshots({ context, configObjectId: seeded.configObjectId })
      expect(page.items.map((entry) => entry.receiptId)).toEqual([own])
      expect(await workflows.getWorkflowSnapshot({ context, configObjectId: seeded.configObjectId, receiptId: foreign })).toBeNull()
    }
    const detail = await workflows.getWorkflowDetail({ context: seeded.viewerContext, configObjectId: seeded.configObjectId })
    expect(detail.canRun).toBe(false)
    expect(detail.canManage).toBe(false)
    expect(detail.currentVersion.code).toBeNull()
    expect(detail.latestSuccessfulSnapshot?.finishedAt).not.toBe(seeded.viewerContext.organizationContext.organization.createdAt.toISOString())
    expect(detail.freshness.state).toBe("fresh")
  })

  test("schema mismatch fails before tool construction; write and metadata-only capabilities never run", async () => {
    const seeded = await seedWorkflowWithViewer()
    await prepareLiveWorkflow(seeded)
    let built = 0
    await expect(workflows.executeLiveArtifactWorkflow({
      context: seeded.viewerContext, configObjectId: seeded.configObjectId,
      expectedOutputSchemaDigest: artifactDigest({ type: "string" }),
      buildTools: async () => { built += 1; return actorTools(seeded.viewerMemberId) },
    })).rejects.toThrow("artifact_view_schema_incompatible")
    expect(built).toBe(0)
    for (const tools of [
      actorTools(seeded.viewerMemberId, false),
      { ...actorTools(seeded.viewerMemberId), manifest: [{ ...liveRequired, readOnly: true }] },
    ]) {
      const result = await workflows.executeLiveArtifactWorkflow({
        context: seeded.viewerContext, configObjectId: seeded.configObjectId,
        expectedOutputSchemaDigest: artifactDigest(liveOutputSchema),
        buildTools: async () => tools,
      })
      expect(result).toMatchObject({ ok: false, error: "capability_unavailable", providerCallAttempted: false })
    }
  })

  test("missing caller connection cannot fall back to another member's successful receipt", async () => {
    const seeded = await seedWorkflowWithViewer()
    await prepareLiveWorkflow(seeded)
    const owner = await workflows.executeLiveArtifactWorkflow({
      context: seeded.ownerContext, configObjectId: seeded.configObjectId,
      expectedOutputSchemaDigest: artifactDigest(liveOutputSchema),
      buildTools: async () => actorTools(seeded.ownerMemberId),
    })
    expect(owner.ok).toBe(true)
    const missing = await workflows.executeLiveArtifactWorkflow({
      context: seeded.viewerContext, configObjectId: seeded.configObjectId,
      expectedOutputSchemaDigest: artifactDigest(liveOutputSchema),
      buildTools: async () => ({ tools: {}, manifest: [] }),
    })
    expect(missing).toMatchObject({ ok: false, error: "capability_unavailable", providerCallAttempted: false })
    const detail = await workflows.getWorkflowDetail({ context: seeded.viewerContext, configObjectId: seeded.configObjectId })
    expect(detail.latestSuccessfulSnapshot).toBeNull()
    expect(detail.latestSnapshot?.status).toBe("failed")
  })

  test("snapshot app previews allow another member's legacy receipt but never their live receipt", async () => {
    const seeded = await seedWorkflowWithViewer()
    await prepareLiveWorkflow(seeded)
    const owner = await workflows.executeLiveArtifactWorkflow({
      context: seeded.ownerContext, configObjectId: seeded.configObjectId,
      expectedOutputSchemaDigest: artifactDigest(liveOutputSchema),
      buildTools: async () => actorTools(seeded.ownerMemberId),
    })
    if (!owner.ok || !owner.receiptId) throw new Error("expected durable result")
    const appId = createDenTypeId("artifactView")
    const revisionId = createDenTypeId("artifactViewRevision")
    await db.insert(ArtifactViewTable).values({
      id: appId, organization_id: seeded.organizationId,
      config_object_id: seeded.configObjectId, owner_member_id: seeded.ownerMemberId,
      title: "Receipt isolation", active_revision_id: revisionId,
    })
    await db.insert(ArtifactViewRevisionTable).values({
      id: revisionId, organization_id: seeded.organizationId, artifact_view_id: appId,
      created_by_member_id: seeded.ownerMemberId, react_source: "return null",
      css_source: "", compiled_html: "<html></html>", build_status: "ready",
      source_digest: artifactDigest("source"), resource_digest: artifactDigest("html"),
      output_schema_digest: artifactDigest(liveOutputSchema), output_schema: liveOutputSchema,
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
      build_diagnostics: [], compiler_name: "test", compiler_version: "1", react_version: "19",
    })
    const { getSavedApp } = await import("../src/saved-apps.js")
    const { executeWorkflow } = await import("../src/mcp/workflow-service.js")
    const legacy = await executeWorkflow({
      database: db, organizationId: seeded.organizationId, orgMembershipId: seeded.ownerMemberId,
      pluginId: seeded.pluginId, configObjectId: seeded.configObjectId,
      configObjectVersionId: seeded.configObjectVersionId,
      normalizedPayloadJson: { language: "codemode-js", requiredCapabilities: [], outputSchema: liveOutputSchema },
      code: 'return { report: "published snapshot" }', validateOutput: true,
      buildTools: async () => ({ tools: {}, manifest: [] }),
    })
    if (!legacy.ok || !legacy.receiptId) throw new Error("expected legacy snapshot")
    for (let read = 0; read < 2; read += 1) {
      const shared = await getSavedApp({ context: seeded.viewerContext, appId, receiptId: legacy.receiptId })
      expect(shared.payload?.artifact.receiptId).toBe(legacy.receiptId)
      expect(shared.payload?.data).toEqual({ report: "published snapshot" })
      expect(shared.html).toBe("<html></html>")
    }
    const foreign = await getSavedApp({ context: seeded.viewerContext, appId, receiptId: owner.receiptId })
    expect(foreign.payload).toBeNull()
    expect(JSON.stringify(foreign)).not.toContain(seeded.ownerMemberId)
    const own = await getSavedApp({ context: seeded.ownerContext, appId, receiptId: owner.receiptId })
    expect(own.payload?.artifact.receiptId).toBe(owner.receiptId)
    expect(own.payload?.artifact.generatedAt).toBe((await workflows.getWorkflowSnapshot({
      context: seeded.ownerContext, configObjectId: seeded.configObjectId, receiptId: owner.receiptId,
    }))?.finishedAt)
    const { saveArtifactViewRevision } = await import("../src/artifact-views.js")
    const revised = await saveArtifactViewRevision({
      context: seeded.ownerContext, artifactViewId: appId, configObjectId: seeded.configObjectId,
      title: "Receipt isolation", reactSource: "export default function App({ data }) { return <pre>{JSON.stringify(data)}</pre> }",
    })
    expect(revised.dataMode).toBe("snapshot")
    expect(revised.activeRevisionId).toBe(revisionId)
    expect(revised.revisions[0]?.buildStatus).toBe("ready")
  })
})

test("new views default live and saved-app previews run fresh; personal snapshot creation is denied", async () => {
  const seeded = await seedWorkflowWithViewer()
  await prepareLiveWorkflow(seeded)
  const { saveArtifactViewRevision } = await import("../src/artifact-views.js")
  const draft = {
    context: seeded.ownerContext, configObjectId: seeded.configObjectId,
    title: "Live calendar", reactSource: "export default function App({ data }) { return <pre>{JSON.stringify(data)}</pre> }",
  }
  const view = await saveArtifactViewRevision(draft)
  expect(view.dataMode).toBe("live")
  expect(view.revisions[0]?.buildStatus).toBe("ready")
  await expect(saveArtifactViewRevision({ ...draft, dataMode: "snapshot" })).rejects.toThrow("artifact_view_snapshot_personal_data_denied")
  const { getSavedApp } = await import("../src/saved-apps.js")
  const load = {
    context: seeded.viewerContext, appId: view.id, revisionId: view.revisions[0]?.id,
    timeZone: "America/New_York",
    buildTools: async () => actorTools(seeded.viewerMemberId),
  }
  const first = await getSavedApp(load)
  const second = await getSavedApp(load)
  expect(first.payload?.data).toMatchObject({ actor: seeded.viewerMemberId })
  expect(second.payload?.artifact.receiptId).not.toBe(first.payload?.artifact.receiptId)
  await expect(getSavedApp({ ...load, receiptId: first.payload?.artifact.receiptId })).rejects.toThrow("artifact_view_live_receipt_override_denied")
})
