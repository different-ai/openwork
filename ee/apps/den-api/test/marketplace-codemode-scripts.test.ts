import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { Tool } from "@openwork/codemode"
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  WorkflowRunTable,
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
import { Effect } from "effect"
import { Hono } from "hono"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_codemode_scripts"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

type Db = typeof import("../src/db.js").db
type MarketplaceCapabilities = typeof import("../src/mcp/marketplace-capabilities.js")
type CapabilityRegistry = typeof import("../src/mcp/capability-registry.js")
type PluginStore = typeof import("../src/routes/org/plugin-system/store.js")
type Workflows = typeof import("../src/workflows.js")
type WorkflowRuns = typeof import("../src/workflow-runs.js")
type WorkflowLibrary = typeof import("../src/workflow-library.js")

type SeededScript = {
  configObjectId: DenTypeId<"configObject">
  member: { orgMembershipId: DenTypeId<"member">; teamIds: [] }
  organizationId: DenTypeId<"organization">
  pluginId: DenTypeId<"plugin">
}

let db: Db
let marketplaceCapabilities: MarketplaceCapabilities
let capabilityRegistry: CapabilityRegistry
let pluginStore: PluginStore
let workflows: Workflows
let workflowRuns: WorkflowRuns
let workflowLibrary: WorkflowLibrary
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
  marketplaceCapabilities = await import("../src/mcp/marketplace-capabilities.js")
  workflows = await import("../src/workflows.js")
  workflowRuns = await import("../src/workflow-runs.js")
  workflowLibrary = await import("../src/workflow-library.js")
  capabilityRegistry = await import("../src/mcp/capability-registry.js")
})

afterAll(() => {
  mock.restore()
})

afterEach(async () => {
  if (createdOrganizationIds.length > 0) {
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
    await db.delete(MemberTable).where(inArray(MemberTable.organizationId, createdOrganizationIds))
    await db.delete(OrganizationTable).where(inArray(OrganizationTable.id, createdOrganizationIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(AuthUserTable).where(inArray(AuthUserTable.id, createdUserIds))
  }
  createdOrganizationIds.length = 0
  createdUserIds.length = 0
})

async function seedScript(input: {
  code: string
  objectType?: "script" | "workflow"
  payload: Record<string, unknown>
  title: string
}): Promise<SeededScript> {
  const organizationId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  const marketplaceId = createDenTypeId("marketplace")
  const now = new Date()
  createdOrganizationIds.push(organizationId)
  createdUserIds.push(userId)

  await db.insert(AuthUserTable).values({ id: userId, name: "Script Tester", email: `${userId}@scripts.test.local` })
  await db.insert(OrganizationTable).values({ id: organizationId, name: "Script Test Org", slug: `scripts-${organizationId}` })
  await db.insert(MemberTable).values({ id: memberId, organizationId, userId, role: "owner" })
  await db.insert(MarketplaceTable).values({
    id: marketplaceId,
    organizationId,
    name: "Script Marketplace",
    description: "Saved script tests",
    status: "active",
    createdByOrgMembershipId: memberId,
  })
  await db.insert(MarketplaceAccessGrantTable).values({
    id: createDenTypeId("marketplaceAccessGrant"),
    organizationId,
    marketplaceId,
    orgMembershipId: memberId,
    teamId: null,
    orgWide: false,
    role: "manager",
    createdByOrgMembershipId: memberId,
  })

  const context: PluginArchActorContext = {
    memberTeams: [],
    organizationContext: {
      organization: {
        id: organizationId,
        name: "Script Test Org",
        slug: `scripts-${organizationId}`,
        logo: null,
        allowedEmailDomains: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      },
      currentMember: {
        id: memberId,
        userId,
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
      type: input.objectType ?? "workflow",
      value: {
        metadata: { title: input.title, description: `${input.title} description` },
        normalizedPayloadJson: input.payload,
        rawSourceText: input.code,
      },
    }],
    context,
    marketplaceId,
    name: `${input.title} Plugin`,
    orgWide: true,
  })
  const memberships = await db
    .select({ configObjectId: PluginConfigObjectTable.configObjectId })
    .from(PluginConfigObjectTable)
    .where(eq(PluginConfigObjectTable.pluginId, plugin.id))
  const configObjectId = memberships[0]?.configObjectId
  if (!configObjectId) throw new Error("Workflow Plugin has no config object")
  return {
    configObjectId,
    member: { orgMembershipId: memberId, teamIds: [] },
    organizationId,
    pluginId: plugin.id,
  }
}

function executeScript(seeded: SeededScript, input: {
  body?: unknown
  buildTools?: Parameters<MarketplaceCapabilities["executeMarketplaceCapability"]>[0]["buildTools"]
  validateScriptOutput?: boolean
} = {}) {
  return marketplaceCapabilities.executeMarketplaceCapability({
    body: input.body,
    buildTools: input.buildTools,
    validateScriptOutput: input.validateScriptOutput,
    configObjectId: seeded.configObjectId,
    enabled: true,
    member: seeded.member,
    organizationId: seeded.organizationId,
    pluginId: seeded.pluginId,
  })
}

describe("saved marketplace Workflows", () => {
  test("promotes a successful run using strict public capability references", async () => {
    const seeded = await seedScript({
      title: "Promotion Fixture",
      code: "return null",
      payload: { language: "codemode-js", requiredCapabilities: [] },
    })
    const code = "return { briefing: await tools.reports.echo({ text: input.topic }) }"
    const now = new Date()
    await db.insert(WorkflowRunTable).values({
      id: createDenTypeId("workflowRun"),
      organization_id: seeded.organizationId,
      org_membership_id: seeded.member.orgMembershipId,
      source: "mcp",
      code_digest: workflowRuns.codemodeCodeDigest(code),
      status: "succeeded",
      tool_calls: [{ name: "tools.reports.echo" }],
      tool_call_count: 1,
      duration_ms: 5,
      started_at: now,
      finished_at: now,
    })

    const saved = await workflows.saveWorkflow({
      organizationId: seeded.organizationId,
      ownerMemberId: seeded.member.orgMembershipId,
      workflow: {
        name: "Promoted briefing",
        code,
        currentInput: { topic: "launch" },
        inputSchema: {
          type: "object",
          properties: { topic: { type: "string" } },
          required: ["topic"],
        },
      },
      buildTools: async () => ({
        tools: {},
        manifest: [{
          capabilityName: "reports.echo",
          scriptPath: "tools.reports.echo",
          readOnly: true,
          authority: "external",
        }],
      }),
    })

    const versions = await db.select().from(ConfigObjectVersionTable)
      .where(eq(ConfigObjectVersionTable.id, saved.configObjectVersionId))
    expect(versions[0]?.normalizedPayloadJson).toMatchObject({
      language: "codemode-js",
      requiredCapabilities: [{
        capabilityName: "reports.echo",
        scriptPath: "tools.reports.echo",
      }],
    })
    expect(versions[0]?.normalizedPayloadJson).not.toHaveProperty("requiredCapabilities.0.readOnly")
    expect(versions[0]?.normalizedPayloadJson).not.toHaveProperty("requiredCapabilities.0.unattendedApproved")
  })

  test("saves a Workflow directly into a chosen existing Plugin", async () => {
    const seeded = await seedScript({
      title: "Chosen Plugin Fixture",
      code: "return null",
      payload: { language: "codemode-js", requiredCapabilities: [] },
    })
    const code = "return { shared: true }"
    const now = new Date()
    await db.insert(WorkflowRunTable).values({
      id: createDenTypeId("workflowRun"),
      organization_id: seeded.organizationId,
      org_membership_id: seeded.member.orgMembershipId,
      source: "mcp",
      code_digest: workflowRuns.codemodeCodeDigest(code),
      status: "succeeded",
      tool_calls: [],
      tool_call_count: 0,
      duration_ms: 5,
      started_at: now,
      finished_at: now,
    })
    const context: PluginArchActorContext = {
      memberTeams: [],
      organizationContext: {
        organization: {
          id: seeded.organizationId,
          name: "Script Test Org",
          slug: `scripts-${seeded.organizationId}`,
          logo: null,
          allowedEmailDomains: null,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        },
        currentMember: {
          id: seeded.member.orgMembershipId,
          userId: createDenTypeId("user"),
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

    const saved = await workflows.saveWorkflow({
      organizationId: seeded.organizationId,
      ownerMemberId: seeded.member.orgMembershipId,
      context,
      workflow: { pluginId: seeded.pluginId, name: "Shared Workflow", code },
      buildTools: async () => ({ tools: {}, manifest: [] }),
    })

    expect(saved.pluginId).toBe(seeded.pluginId)
    const memberships = await db.select().from(PluginConfigObjectTable).where(and(
      eq(PluginConfigObjectTable.pluginId, seeded.pluginId),
      eq(PluginConfigObjectTable.configObjectId, saved.configObjectId),
    ))
    expect(memberships).toHaveLength(1)
  })

  test("does not let a Plugin editor replace an existing Workflow version", async () => {
    const seeded = await seedScript({
      title: "Manager-owned Workflow",
      code: "return { owner: true }",
      payload: { language: "codemode-js", requiredCapabilities: [] },
    })
    const editorUserId = createDenTypeId("user")
    const editorMemberId = createDenTypeId("member")
    const now = new Date()
    const code = "return { replaced: true }"
    createdUserIds.push(editorUserId)
    await db.insert(AuthUserTable).values({
      id: editorUserId,
      name: "Workflow Editor",
      email: `${editorUserId}@scripts.test.local`,
    })
    await db.insert(MemberTable).values({
      id: editorMemberId,
      organizationId: seeded.organizationId,
      userId: editorUserId,
      role: "member",
    })
    await db.insert(PluginAccessGrantTable).values({
      id: createDenTypeId("pluginAccessGrant"),
      organizationId: seeded.organizationId,
      pluginId: seeded.pluginId,
      orgMembershipId: editorMemberId,
      teamId: null,
      orgWide: false,
      role: "editor",
      createdByOrgMembershipId: seeded.member.orgMembershipId,
    })
    await db.insert(WorkflowRunTable).values({
      id: createDenTypeId("workflowRun"),
      organization_id: seeded.organizationId,
      org_membership_id: editorMemberId,
      source: "mcp",
      code_digest: workflowRuns.codemodeCodeDigest(code),
      status: "succeeded",
      tool_calls: [],
      tool_call_count: 0,
      duration_ms: 5,
      started_at: now,
      finished_at: now,
    })
    const context: PluginArchActorContext = {
      memberTeams: [],
      organizationContext: {
        organization: {
          id: seeded.organizationId,
          name: "Script Test Org",
          slug: `scripts-${seeded.organizationId}`,
          logo: null,
          allowedEmailDomains: null,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        },
        currentMember: {
          id: editorMemberId,
          userId: editorUserId,
          role: "member",
          createdAt: now,
          joinedAt: now,
          isOwner: false,
        },
        invitations: [],
        members: [],
        roles: [],
        teams: [],
      },
      session: { createdAt: now },
    }

    await expect(workflows.saveWorkflow({
      organizationId: seeded.organizationId,
      ownerMemberId: editorMemberId,
      context,
      workflow: { pluginId: seeded.pluginId, name: "Manager-owned Workflow", code },
      buildTools: async () => ({ tools: {}, manifest: [] }),
    })).rejects.toThrow("Missing manager access for config object.")

    const versions = await db.select().from(ConfigObjectVersionTable).where(eq(
      ConfigObjectVersionTable.configObjectId,
      seeded.configObjectId,
    ))
    expect(versions).toHaveLength(1)
  })

  test("does not disclose an inaccessible parent Plugin through a direct Workflow grant", async () => {
    const seeded = await seedScript({
      title: "Directly shared Workflow",
      code: "return { shared: true }",
      payload: {
        language: "codemode-js",
        exampleInput: { token: "viewer-authoring-secret" },
        requiredCapabilities: [],
      },
    })
    const viewerUserId = createDenTypeId("user")
    const viewerMemberId = createDenTypeId("member")
    const now = new Date()
    createdUserIds.push(viewerUserId)
    await db.insert(AuthUserTable).values({
      id: viewerUserId,
      name: "Direct Workflow Viewer",
      email: `${viewerUserId}@scripts.test.local`,
    })
    await db.insert(MemberTable).values({
      id: viewerMemberId,
      organizationId: seeded.organizationId,
      userId: viewerUserId,
      role: "member",
    })
    await db.update(PluginAccessGrantTable).set({ removedAt: now }).where(and(
      eq(PluginAccessGrantTable.pluginId, seeded.pluginId),
      eq(PluginAccessGrantTable.orgWide, true),
    ))
    await db.update(ConfigObjectAccessGrantTable).set({ removedAt: now }).where(and(
      eq(ConfigObjectAccessGrantTable.configObjectId, seeded.configObjectId),
      eq(ConfigObjectAccessGrantTable.orgWide, true),
    ))
    await db.insert(ConfigObjectAccessGrantTable).values({
      id: createDenTypeId("configObjectAccessGrant"),
      organizationId: seeded.organizationId,
      configObjectId: seeded.configObjectId,
      orgMembershipId: viewerMemberId,
      teamId: null,
      orgWide: false,
      role: "viewer",
      createdByOrgMembershipId: seeded.member.orgMembershipId,
    })
    const context: PluginArchActorContext = {
      memberTeams: [],
      organizationContext: {
        organization: {
          id: seeded.organizationId,
          name: "Script Test Org",
          slug: `scripts-${seeded.organizationId}`,
          logo: null,
          allowedEmailDomains: null,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        },
        currentMember: {
          id: viewerMemberId,
          userId: viewerUserId,
          role: "member",
          createdAt: now,
          joinedAt: now,
          isOwner: false,
        },
        invitations: [],
        members: [],
        roles: [],
        teams: [],
      },
      session: { createdAt: now },
    }

    const detail = await workflowLibrary.getWorkflowLibraryDetail({
      context,
      configObjectId: seeded.configObjectId,
    })
    expect(detail.workflow.plugin).toBeNull()
    expect(detail.script.currentVersion.code).toBeNull()
    expect(detail.script.currentVersion.exampleInput).toBeNull()
    expect(JSON.stringify(detail)).not.toContain("viewer-authoring-secret")
    expect(JSON.stringify(detail)).not.toContain("return { shared: true }")
    expect(JSON.stringify(detail.workflow)).not.toContain("Directly shared Workflow Plugin")

    const library = await workflowLibrary.listWorkflowLibraryItems({ context })
    expect(library).toHaveLength(1)
    expect(library[0]?.plugin).toBeNull()
    expect(library[0]).not.toHaveProperty("code")
    expect(library[0]).not.toHaveProperty("data")
    expect(library[0]).not.toHaveProperty("html")
    expect(library[0]).not.toHaveProperty("compiledHtml")
  })

  test("executes a createPluginBundle Workflow with typed input binding", async () => {
    const seeded = await seedScript({
      title: "Summarize Account",
      code: "return { account: input.account, doubled: input.count * 2 }",
      payload: {
        language: "codemode-js",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { account: { type: "string" }, count: { type: "number" } },
          required: ["account", "count"],
        },
        requiredCapabilities: [],
      },
    })

    const result = await executeScript(seeded, { body: { account: "Acme", count: 4 } })
    if (!result.ok) throw new Error(result.message)
    expect(result.result).toMatchObject({
      kind: "workflow",
      status: "executed",
      value: { account: "Acme", doubled: 8 },
      toolCalls: [],
    })
    const matches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      enabled: true,
      member: seeded.member,
      organizationId: seeded.organizationId,
      query: "summarize account",
    })
    expect(matches[0]).toMatchObject({ kind: "workflow", hasBody: true })
    expect(matches[0]?.path).toStartWith("plugin://")
  })

  test("executes a legacy script object through the canonical Workflow capability", async () => {
    const seeded = await seedScript({
      title: "Legacy Script",
      code: "return { migrated: input.value }",
      objectType: "script",
      payload: { language: "codemode-js", requiredCapabilities: [] },
    })
    const stored = await db.select({ objectType: ConfigObjectTable.objectType })
      .from(ConfigObjectTable)
      .where(eq(ConfigObjectTable.id, seeded.configObjectId))
    expect(stored[0]?.objectType).toBe("script")

    const matches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      enabled: true,
      member: seeded.member,
      organizationId: seeded.organizationId,
      query: "legacy script",
    })
    expect(matches[0]).toMatchObject({ kind: "workflow", hasBody: true })

    const result = await executeScript(seeded, { body: { value: "compatible" } })
    if (!result.ok) throw new Error(result.message)
    expect(result.result).toMatchObject({
      kind: "workflow",
      status: "executed",
      value: { migrated: "compatible" },
    })
  })

  test("keeps saved scripts discoverable and executable without any rollout flag", async () => {
    const seeded = await seedScript({
      title: "Hidden Script",
      code: "return 1",
      payload: { language: "codemode-js", requiredCapabilities: [] },
    })
    const matches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      enabled: true,
      member: seeded.member,
      organizationId: seeded.organizationId,
      query: "hidden script",
    })
    expect(matches[0]).toMatchObject({ kind: "workflow" })
    const result = await executeScript(seeded)
    if (!result.ok) throw new Error(result.message)
    expect(result.result).toMatchObject({ kind: "workflow", status: "executed", value: 1 })
  })

  test("fails closed before running when a declared capability is unavailable", async () => {
    let invocations = 0
    const available = Tool.make({
      description: "Available test tool",
      input: { type: "object" },
      run: () => Effect.sync(() => {
        invocations += 1
        return "called"
      }),
    })
    const seeded = await seedScript({
      title: "Missing Capability Script",
      code: "return await tools.den.available({})",
      payload: {
        language: "codemode-js",
        requiredCapabilities: [{ capabilityName: "missingCapability", scriptPath: "tools.den.missingCapability" }],
      },
    })

    const result = await executeScript(seeded, {
      buildTools: () => Promise.resolve({
        tools: { den: { available } },
        manifest: [{ capabilityName: "available", scriptPath: "tools.den.available" }],
      }),
    })
    expect(result).toMatchObject({
      ok: false,
      error: "capability_unavailable",
      providerCallAttempted: false,
      missing: [{ capabilityName: "missingCapability", scriptPath: "tools.den.missingCapability" }],
    })
    expect(invocations).toBe(0)
  })

  test("keeps saved scripts and execute_capability_script out of the composable tree", async () => {
    const seeded = await seedScript({
      title: "Recursive Script",
      code: "return 'must not run'",
      payload: { language: "codemode-js", requiredCapabilities: [] },
    })
    const capabilityName = marketplaceCapabilities.buildMarketplaceCapabilityName(seeded.pluginId, seeded.configObjectId)
    const requiredCapabilities = [
      { capabilityName, scriptPath: `tools.marketplace[${JSON.stringify(capabilityName)}]` },
      { capabilityName: "execute_capability_script", scriptPath: "tools.den.execute_capability_script" },
    ]
    await db.update(ConfigObjectVersionTable)
      .set({ normalizedPayloadJson: { language: "codemode-js", requiredCapabilities } })
      .where(eq(ConfigObjectVersionTable.configObjectId, seeded.configObjectId))

    let platformAdmin: Promise<boolean> | undefined
    const context: Parameters<CapabilityRegistry["buildCapabilityToolTree"]>[0] = {
      app: new Hono(),
      env: undefined,
      catalog: [],
      principal: {
        userId: createDenTypeId("user"),
        organizationId: seeded.organizationId,
        scopes: new Set(["mcp:read", "mcp:write"]),
        payload: {},
      },
      organizationId: seeded.organizationId,
      member: seeded.member,
      redirectUriBase: "http://127.0.0.1:8790",
      externalMcpConnectionsEnabled: true,
      resolvePlatformAdmin: () => {
        platformAdmin ??= Promise.resolve(false)
        return platformAdmin
      },
      resolveNamespaceContext: () => Promise.resolve({
        nativeProviderEntries: [],
        externalMcpConnections: [],
        codemodeNativeProviderEntries: [],
        codemodeExternalMcpConnections: [],
        namespaces: { native: new Map(), externalMcp: new Map() },
      }),
    }
    const built = await capabilityRegistry.buildCapabilityToolTree(context)
    expect(built.manifest).not.toContainEqual(expect.objectContaining({ capabilityName }))
    expect(built.manifest).not.toContainEqual(expect.objectContaining({ capabilityName: "execute_capability_script" }))

    const result = await executeScript(seeded, {
      buildTools: () => capabilityRegistry.buildCapabilityToolTree(context),
    })
    expect(result).toMatchObject({
      ok: false,
      error: "capability_unavailable",
      providerCallAttempted: false,
      missing: requiredCapabilities,
    })
    if (result.ok) throw new Error("Expected Workflow recursion to be blocked")
    expect(result.message).toContain("is unavailable or disabled")
  })

  test("rejects input that does not match the saved inputSchema", async () => {
    const seeded = await seedScript({
      title: "Typed Script",
      code: "return input.name",
      payload: {
        language: "codemode-js",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        requiredCapabilities: [],
      },
    })

    const result = await executeScript(seeded, { body: { name: 42 } })
    expect(result).toMatchObject({
      ok: false,
      error: "invalid_capability_arguments",
      sameArgumentsRetryable: false,
      retry: { action: "correct_arguments", searchRequired: false },
    })
    if (result.ok || result.error !== "invalid_capability_arguments") throw new Error("Expected invalid script arguments")
    expect(result.issues.length).toBeGreaterThan(0)
  })

  test("validates saved script output before returning an artifact-ready result", async () => {
    const seeded = await seedScript({
      title: "Typed Result Script",
      code: "return { count: 'not-a-number' }",
      payload: {
        language: "codemode-js",
        outputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
        requiredCapabilities: [],
      },
    })

    const legacyResult = await executeScript(seeded)
    if (!legacyResult.ok) throw new Error(legacyResult.message)
    expect(legacyResult.result).toMatchObject({ status: "executed", value: { count: "not-a-number" } })

    const result = await executeScript(seeded, { validateScriptOutput: true })
    expect(result).toMatchObject({
      ok: false,
      error: "invalid_capability_arguments",
      sameArgumentsRetryable: false,
    })
  })

  test("lists accessible Workflows with exact versions and artifact schemas", async () => {
    const seeded = await seedScript({
      title: "Artifact Script",
      code: "return { briefing: input.topic }",
      payload: {
        language: "codemode-js",
        inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
        outputSchema: { type: "object", properties: { briefing: { type: "string" } }, required: ["briefing"] },
        requiredCapabilities: [],
      },
    })

    const accessibleWorkflows = await marketplaceCapabilities.listAccessibleWorkflows({
      member: seeded.member,
      organizationId: seeded.organizationId,
    })
    expect(accessibleWorkflows).toHaveLength(1)
    expect(accessibleWorkflows[0]).toMatchObject({
      pluginId: seeded.pluginId,
      configObjectId: seeded.configObjectId,
      title: "Artifact Script",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    })
    expect(accessibleWorkflows[0]?.configObjectVersionId).toStartWith("cov_")
  })
})
