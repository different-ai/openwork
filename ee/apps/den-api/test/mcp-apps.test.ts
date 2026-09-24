import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ExternalMcpConnectionAccessGrantTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrganizationTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  MCP_APP_CONFIG_SCHEMA_VERSION,
  MCP_APP_PAYLOAD_KIND,
  createMcpAppInputSchema,
  isAuthoredMcpAppVersion,
  mcpAppCompiledRevisionSchema,
  mcpAppIdSchema,
  mcpAppRevisionIdSchema,
  mcpAppResourceUri,
  mcpAppSummarySchema,
  MCP_APP_LAUNCH_TOOL_NAME,
  mcpAppServerPath,
  parseMcpAppResourceUri,
  redactMcpAppRevision,
  summarizeMcpAppRevision,
  updateMcpAppInputSchema,
  type McpAppSummary,
  type McpAppToolBinding,
  type McpAppToolDeclaration,
} from "@openwork/types/mcp-app"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
process.env.OPENWORK_DEV_MODE ??= "1"

let db: typeof import("../src/db.js").db
let apps: typeof import("../src/mcp-apps.js")
let store: typeof import("../src/routes/org/plugin-system/store.js")
let compiler: typeof import("../src/generated-artifact-view-builder.js")
let closeDb: () => Promise<void>
const organizations: DenTypeId<"organization">[] = []
const users: DenTypeId<"user">[] = []
const source = {
  title: "Project explorer",
  description: "Browse projects interactively.",
  reactSource: 'export default function App() { return <main>source-only-marker</main> }',
  cssSource: "main { color: navy; }",
  textFallback: "Open Project explorer to browse projects.",
}

async function actor(organizationId?: DenTypeId<"organization">, role = "member"): Promise<PluginArchActorContext> {
  const now = new Date()
  const id = organizationId ?? createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  users.push(userId)
  if (!organizationId) {
    organizations.push(id)
    await db.insert(OrganizationTable).values({ id, name: "App fixture", slug: `apps-${id}` })
  }
  await db.insert(AuthUserTable).values({ id: userId, name: "App tester", email: `${userId}@apps.test.local` })
  await db.insert(MemberTable).values({ id: memberId, organizationId: id, userId, role })
  return {
    memberTeams: [],
    session: { createdAt: now },
    organizationContext: {
      organization: { id, name: "App fixture", slug: `apps-${id}`, logo: null, allowedEmailDomains: null, metadata: null, createdAt: now, updatedAt: now },
      currentMember: { id: memberId, userId, role, directRole: role, adminTeams: [], createdAt: now, joinedAt: now, isOwner: role === "owner" },
      invitations: [], members: [], roles: [], teams: [],
    },
  }
}

function access(context: PluginArchActorContext) {
  return {
    organizationId: context.organizationContext.organization.id,
    member: { orgMembershipId: context.organizationContext.currentMember.id, teamIds: context.memberTeams.map((team) => team.id) },
  }
}

function ids(app: McpAppSummary) {
  return { appId: app.appId, revisionId: app.revisionId }
}

async function revisions(app: McpAppSummary) {
  return db.select().from(ConfigObjectVersionTable).where(eq(ConfigObjectVersionTable.configObjectId, normalizeDenTypeId("configObject", app.appId)))
}

async function grantPlugin(context: PluginArchActorContext, app: McpAppSummary, recipient: PluginArchActorContext, role: "viewer" | "editor" = "viewer") {
  await db.insert(PluginAccessGrantTable).values({
    id: createDenTypeId("pluginAccessGrant"),
    organizationId: context.organizationContext.organization.id,
    pluginId: normalizeDenTypeId("plugin", app.pluginId),
    orgMembershipId: recipient.organizationContext.currentMember.id,
    role,
    createdByOrgMembershipId: context.organizationContext.currentMember.id,
  })
}

const resolveTools = async () => []
const declaredTool: McpAppToolDeclaration = { name: "list_projects", description: "List projects.", capability: "getProjects" }
const toolBindings: McpAppToolBinding[] = [{ ...declaredTool, kind: "api", mode: "input", inputSchema: { type: "object" }, readOnly: true }]

function entry(app: McpAppSummary) {
  return { appId: app.appId, pluginId: app.pluginId, revisionId: app.revisionId, title: app.title, description: app.description, serverPath: app.serverPath }
}

test("shared URI contract accepts only exact immutable App resources", () => {
  const id = createDenTypeId("configObject")
  const version = createDenTypeId("configObjectVersion")
  const uri = mcpAppResourceUri(id, version)
  expect(mcpAppServerPath(id)).toBe(`/mcp/agent/connections/${id}`)
  expect(uri).toBe(`ui://openwork/apps/${id}/revisions/${version}/index.html`)
  expect(parseMcpAppResourceUri(uri)).toEqual({ appId: id, revisionId: version })
  for (const invalid of [uri + "?token=test", uri + "#x", uri + "\n", uri + "\r\n", uri.replace("index.html", "../index.html"), uri.replace(version, "latest"), uri.replace(id, `cob_z${id.slice(5)}`)]) {
    expect(parseMcpAppResourceUri(invalid)).toBeNull()
  }
  expect(mcpAppIdSchema.safeParse(id + "\n").success).toBe(false)
  expect(mcpAppRevisionIdSchema.safeParse(version + "\n").success).toBe(false)
  expect(isAuthoredMcpAppVersion({ schemaVersion: MCP_APP_CONFIG_SCHEMA_VERSION })).toBe(true)
  expect(isAuthoredMcpAppVersion({ normalizedPayloadJson: { kind: MCP_APP_PAYLOAD_KIND } })).toBe(true)
  expect(isAuthoredMcpAppVersion({ schemaVersion: "openwork.remote-mcp-app-installation/1", normalizedPayloadJson: { kind: "remote_mcp_app" } })).toBe(false)
})

test("authoring requires complete source and rejects Workflow, tool-grant, and custom sizing fields", () => {
  expect(createMcpAppInputSchema.parse(source)).toEqual(source)
  const update = { ...source, appId: createDenTypeId("configObject"), expectedRevisionId: createDenTypeId("configObjectVersion") }
  expect(updateMcpAppInputSchema.parse(update)).toEqual(update)
  for (const extra of [
    { parentWorkflowId: createDenTypeId("configObject") },
    { outputSchema: { type: "object" } },
    { allowedTools: ["external_tool"] },
    { height: 600 },
    { internal: true },
  ]) {
    expect(createMcpAppInputSchema.safeParse({ ...source, ...extra }).success).toBe(false)
    expect(updateMcpAppInputSchema.safeParse({ ...update, ...extra }).success).toBe(false)
  }
  for (const patch of [{ reactSource: "" }, { title: " " }, { textFallback: " " }, { reactSource: "é".repeat(100_001) }, { cssSource: "é".repeat(50_001) }]) {
    expect(createMcpAppInputSchema.safeParse({ ...source, ...patch }).success).toBe(false)
  }
  expect(updateMcpAppInputSchema.safeParse({ ...update, expectedRevisionId: undefined }).success).toBe(false)
  expect(updateMcpAppInputSchema.safeParse({ ...update, reactSource: undefined }).success).toBe(false)
  expect(updateMcpAppInputSchema.safeParse({ ...update, pluginId: createDenTypeId("plugin") }).success).toBe(false)
  const tool = { name: "list_projects", description: "List projects.", capability: "getProjects" }
  expect(createMcpAppInputSchema.safeParse({ ...source, tools: [tool, { ...tool, name: "run_report", mode: "live" }] }).success).toBe(true)
  for (const tools of [
    [tool, tool],
    [{ ...tool, name: MCP_APP_LAUNCH_TOOL_NAME }],
    [{ ...tool, name: "List Projects" }],
    [{ ...tool, mode: "background" }],
    [{ ...tool, grant: "all" }],
    Array.from({ length: 21 }, (_, index) => ({ ...tool, name: `tool_${index}` })),
  ]) {
    expect(createMcpAppInputSchema.safeParse({ ...source, tools }).success).toBe(false)
  }
})

test("compiler output satisfies the stored contract and generic redaction returns only launch metadata", async () => {
  const { buildGeneratedMcpApp } = await import("../src/generated-artifact-view-builder.js")
  const compiled = await buildGeneratedMcpApp(source)
  if (!compiled.ok) throw new Error("Fixture compiler failed")
  const payload = mcpAppCompiledRevisionSchema.parse({
    kind: MCP_APP_PAYLOAD_KIND,
    schemaVersion: 1,
    pluginId: createDenTypeId("plugin"),
    title: source.title,
    description: source.description,
    textFallback: source.textFallback,
    tools: [],
    html: compiled.html,
    htmlBytes: compiled.htmlBytes,
    resourceDigest: compiled.resourceDigest,
    sourceDigest: compiled.sourceDigest,
    csp: compiled.csp,
    compilerName: compiled.compilerName,
    compilerVersion: compiled.compilerVersion,
    reactVersion: compiled.reactVersion,
  })
  const identity = { appId: createDenTypeId("configObject"), revisionId: createDenTypeId("configObjectVersion") }
  const summary = summarizeMcpAppRevision({ ...identity, payload })
  expect(mcpAppSummarySchema.parse(summary)).toEqual(summary)
  expect(summary).toMatchObject({ toolName: MCP_APP_LAUNCH_TOOL_NAME, serverPath: mcpAppServerPath(identity.appId), tools: [] })
  const projection = { configObjectId: identity.appId, id: identity.revisionId, normalizedPayloadJson: payload }
  expect(redactMcpAppRevision(projection)).toEqual({ ...summary, kind: MCP_APP_PAYLOAD_KIND, schemaVersion: 1 })
  for (const invalid of [{ ...payload, html: "" }, { ...payload, reactSource: source.reactSource }, { ...payload, csp: { ...payload.csp, connectDomains: ["https://example.com"] } }]) {
    expect(redactMcpAppRevision({ ...projection, normalizedPayloadJson: invalid })).toBeNull()
  }
})

describe.skipIf(!process.env.DEN_TEST_DATABASE_URL)("authored MCP Apps with isolated database fixtures", () => {
  beforeAll(async () => {
    const url = process.env.DEN_TEST_DATABASE_URL
    if (!url) throw new Error("Set DEN_TEST_DATABASE_URL to an isolated prepared test database.")
    const databaseUrl = new URL(url)
    if (databaseUrl.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname)
      || !/(?:^|_)test(?:_|$)/u.test(databaseUrl.pathname.slice(1))) {
      throw new Error("DEN_TEST_DATABASE_URL must name an isolated prepared loopback MySQL test database.")
    }
    process.env.DATABASE_URL = url
    const connection = (await import("@openwork-ee/den-db")).createDenDb({ databaseUrl: url, mode: "mysql" })
    db = connection.db
    closeDb = async () => { if ("end" in connection.client) await connection.client.end() }
    mock.module("../src/db.js", () => ({ db }))
    mock.module("../src/auth.js", () => ({
      auth: { api: { getSession: async () => null, verifyApiKey: async () => ({ valid: false, key: null }) }, handler: async () => new Response("{}") },
      DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
      DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
      DEN_MCP_FIRST_PARTY_RESOURCES: ["http://127.0.0.1:8790/mcp"],
      DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
      DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
      DEN_MCP_OAUTH_RESOURCE: "http://127.0.0.1:8790/mcp",
      DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
      DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
      DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
      DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
    }))
    apps = await import("../src/mcp-apps.js")
    store = await import("../src/routes/org/plugin-system/store.js")
    compiler = await import("../src/generated-artifact-view-builder.js")
  })

  afterEach(async () => {
    if (organizations.length) {
      await db.delete(ConfigObjectVersionTable).where(inArray(ConfigObjectVersionTable.organizationId, organizations))
      await db.delete(ConfigObjectAccessGrantTable).where(inArray(ConfigObjectAccessGrantTable.organizationId, organizations))
      await db.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.organizationId, organizations))
      await db.delete(PluginAccessGrantTable).where(inArray(PluginAccessGrantTable.organizationId, organizations))
      await db.delete(MarketplacePluginTable).where(inArray(MarketplacePluginTable.organizationId, organizations))
      await db.delete(MarketplaceAccessGrantTable).where(inArray(MarketplaceAccessGrantTable.organizationId, organizations))
      await db.delete(ConfigObjectTable).where(inArray(ConfigObjectTable.organizationId, organizations))
      await db.delete(PluginTable).where(inArray(PluginTable.organizationId, organizations))
      await db.delete(MarketplaceTable).where(inArray(MarketplaceTable.organizationId, organizations))
      await db.delete(MemberTable).where(inArray(MemberTable.organizationId, organizations))
      await db.delete(OrganizationTable).where(inArray(OrganizationTable.id, organizations))
    }
    if (users.length) await db.delete(AuthUserTable).where(inArray(AuthUserTable.id, users))
    organizations.length = 0
    users.length = 0
  })

  afterAll(async () => {
    mock.restore()
    await closeDb?.()
  })

  test("create publishes a compiled immutable revision in a private Plugin with creator manager grants only", async () => {
    const context = await actor()
    const viewer = await actor(access(context).organizationId)
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    expect(mcpAppSummarySchema.parse(app)).toEqual(app)
    expect(await apps.listAccessibleMcpApps(access(context))).toEqual([entry(app)])
    expect(await apps.listAccessibleMcpApps(access(viewer))).toEqual([])
    expect(await apps.listAccessibleMcpApps({ ...access(context), enabled: false })).toEqual([])
    expect(await apps.listAccessibleMcpApps({ ...access(context), member: null })).toEqual([])
    await expect(apps.loadMcpAppResource({ ...access(context), ...ids(app), enabled: false })).rejects.toThrow("not available")
    await expect(apps.loadMcpAppResource({ ...access(context), ...ids(app), member: null })).rejects.toThrow("not available")
    const rows = await revisions(app)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.schemaVersion).toBe(MCP_APP_CONFIG_SCHEMA_VERSION)
    expect(mcpAppCompiledRevisionSchema.parse(rows[0]?.normalizedPayloadJson).html).toContain("<!doctype html>")
    expect((await apps.readMcpApp({ context, appId: app.appId })).reactSource).toBe(source.reactSource)
    const configGrants = await db.select().from(ConfigObjectAccessGrantTable).where(eq(ConfigObjectAccessGrantTable.organizationId, access(context).organizationId))
    const pluginGrants = await db.select().from(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, access(context).organizationId))
    for (const grants of [configGrants, pluginGrants]) {
      expect(grants).toHaveLength(1)
      expect(grants[0]).toMatchObject({ orgMembershipId: access(context).member.orgMembershipId, orgWide: false, teamId: null, role: "manager" })
    }
    expect(await db.select().from(MarketplacePluginTable).where(eq(MarketplacePluginTable.organizationId, access(context).organizationId))).toHaveLength(0)
    expect(await db.select().from(ExternalMcpConnectionAccessGrantTable).where(eq(ExternalMcpConnectionAccessGrantTable.organizationId, access(context).organizationId))).toHaveLength(0)
  })

  test("a repeated title explains the existing Plugin instead of failing opaquely", async () => {
    const context = await actor()
    const first = await apps.createMcpApp({ resolveTools, context, ...source })
    const repeated = apps.createMcpApp({ resolveTools, context, ...source })
    await expect(repeated).rejects.toMatchObject({ code: "duplicate_plugin" })
    await expect(repeated).rejects.toThrow(first.pluginId)
    await expect(repeated).rejects.toThrow("pass its pluginId")
    expect(await apps.listAccessibleMcpApps(access(context))).toEqual([entry(first)])
    const second = await apps.createMcpApp({ resolveTools, context, ...source, pluginId: first.pluginId })
    expect(second.pluginId).toBe(first.pluginId)
  })

  test("existing Plugin sharing enables resources, not source edits or viewer resharing", async () => {
    const context = await actor()
    const viewer = await actor(access(context).organizationId)
    const first = await apps.createMcpApp({ resolveTools, context, ...source })
    await grantPlugin(context, first, viewer, "editor")
    const app = await apps.createMcpApp({ resolveTools, context, ...source, title: "Second app", pluginId: first.pluginId })
    expect(app.pluginId).toBe(first.pluginId)
    expect(await db.select().from(PluginTable).where(eq(PluginTable.organizationId, access(context).organizationId))).toHaveLength(1)
    expect((await apps.loadMcpAppResource({ ...access(viewer), ...ids(app) })).app).toEqual(app)
    await expect(apps.readMcpApp({ context: viewer, appId: app.appId })).rejects.toThrow("Missing editor access")
    await expect(apps.updateMcpApp({ resolveTools, context: viewer, ...source, appId: app.appId, expectedRevisionId: app.revisionId })).rejects.toThrow("Missing editor access")
    const ownedPlugin = await store.createPlugin({ context: viewer, name: "Viewer owned" })
    await expect(store.attachConfigObjectToPlugin({ context: viewer, configObjectId: normalizeDenTypeId("configObject", app.appId), pluginId: ownedPlugin.id })).rejects.toThrow("Missing manager access")
    expect(await db.select().from(ExternalMcpConnectionAccessGrantTable).where(eq(ExternalMcpConnectionAccessGrantTable.organizationId, access(context).organizationId))).toHaveLength(0)
    await db.update(PluginAccessGrantTable).set({ removedAt: new Date() }).where(eq(PluginAccessGrantTable.orgMembershipId, access(viewer).member.orgMembershipId))
    await expect(apps.loadMcpAppResource({ ...access(viewer), ...ids(app) })).rejects.toThrow("not available")
  })

  test("App managers can attach existing Apps without creating an ownership dependency or duplicate launch", async () => {
    const context = await actor()
    const viewer = await actor(access(context).organizationId)
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const plugin = await store.createPlugin({ context, name: "Additional App plugin" })
    const configObjectId = normalizeDenTypeId("configObject", app.appId)
    await store.attachConfigObjectToPlugin({ context, configObjectId, pluginId: plugin.id })
    await grantPlugin(context, { ...app, pluginId: plugin.id }, viewer)
    expect(await apps.listAccessibleMcpApps(access(context))).toHaveLength(1)
    expect(await apps.listAccessibleMcpApps(access(viewer))).toEqual([{ ...entry(app), pluginId: plugin.id }])
    await store.setPluginLifecycle({ context, pluginId: normalizeDenTypeId("plugin", app.pluginId), action: "archive" })
    expect((await apps.loadMcpAppResource({ ...access(viewer), ...ids(app) })).app).toEqual({ ...app, pluginId: plugin.id })
    await store.removeConfigObjectFromPlugin({ context, configObjectId, pluginId: plugin.id })
    expect(await apps.listAccessibleMcpApps(access(viewer))).toEqual([])
    await expect(apps.loadMcpAppResource({ ...access(viewer), ...ids(app) })).rejects.toThrow("not available")
  })

  test("explicit marketplace membership grants authorize resource reads without generic context reads", async () => {
    const context = await actor()
    const viewer = await actor(access(context).organizationId)
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const marketplaceId = createDenTypeId("marketplace")
    await db.insert(MarketplaceTable).values({ id: marketplaceId, organizationId: access(context).organizationId, name: "Shared catalog", createdByOrgMembershipId: access(context).member.orgMembershipId })
    await db.insert(MarketplacePluginTable).values({ id: createDenTypeId("marketplacePlugin"), marketplaceId, pluginId: normalizeDenTypeId("plugin", app.pluginId), organizationId: access(context).organizationId })
    await db.insert(MarketplaceAccessGrantTable).values({ id: createDenTypeId("marketplaceAccessGrant"), marketplaceId, organizationId: access(context).organizationId, orgMembershipId: access(viewer).member.orgMembershipId, role: "viewer", createdByOrgMembershipId: access(context).member.orgMembershipId })
    expect(await apps.listAccessibleMcpApps(access(viewer))).toEqual([entry(app)])
    expect((await apps.loadMcpAppResource({ ...access(viewer), ...ids(app) })).html).toContain("<!doctype html>")
    await expect(apps.readMcpApp({ context: viewer, appId: app.appId })).rejects.toThrow("Missing editor access")
    await db.update(MarketplaceAccessGrantTable).set({ removedAt: new Date() }).where(eq(MarketplaceAccessGrantTable.marketplaceId, marketplaceId))
    await expect(apps.loadMcpAppResource({ ...access(viewer), ...ids(app) })).rejects.toThrow("not available")
  })

  test("direct config-object grants allow runtime and only editor grants allow source replacement", async () => {
    const context = await actor()
    const editor = await actor(access(context).organizationId)
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const configObjectId = normalizeDenTypeId("configObject", app.appId)
    const grantId = createDenTypeId("configObjectAccessGrant")
    await db.insert(ConfigObjectAccessGrantTable).values({ id: grantId, configObjectId, organizationId: access(context).organizationId, orgMembershipId: access(editor).member.orgMembershipId, role: "viewer", createdByOrgMembershipId: access(context).member.orgMembershipId })
    expect((await apps.loadMcpAppResource({ ...access(editor), ...ids(app) })).app).toEqual(app)
    await expect(apps.updateMcpApp({ resolveTools, context: editor, ...source, appId: app.appId, expectedRevisionId: app.revisionId })).rejects.toThrow("Missing editor access")
    await db.update(ConfigObjectAccessGrantTable).set({ role: "editor" }).where(eq(ConfigObjectAccessGrantTable.id, grantId))
    const updated = await apps.updateMcpApp({ resolveTools, context: editor, ...source, title: "Editor revision", appId: app.appId, expectedRevisionId: app.revisionId })
    expect(updated.title).toBe("Editor revision")
    await db.update(MemberTable).set({ removedAt: new Date() }).where(eq(MemberTable.id, access(editor).member.orgMembershipId))
    await expect(apps.loadMcpAppResource({ ...access(editor), ...ids(updated) })).rejects.toThrow("not available")
  })

  test("organization crossing, unassigned admins, and foreign exact revisions are denied", async () => {
    const context = await actor()
    const otherOrg = await actor(undefined, "owner")
    const unassignedAdmin = await actor(access(context).organizationId, "owner")
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const other = await apps.createMcpApp({ resolveTools, context: otherOrg, ...source })
    for (const principal of [access(otherOrg), access(unassignedAdmin), { ...access(context), organizationId: access(otherOrg).organizationId }]) {
      await expect(apps.loadMcpAppResource({ ...principal, ...ids(app) })).rejects.toThrow("not available")
    }
    await expect(apps.readMcpApp({ context: otherOrg, appId: app.appId })).rejects.toThrow("not available")
    await expect(apps.createMcpApp({ resolveTools, context: otherOrg, ...source, pluginId: app.pluginId })).rejects.toThrow("Plugin is not available")
    await expect(apps.loadMcpAppResource({ ...access(context), appId: app.appId, revisionId: other.revisionId })).rejects.toThrow("not available")
    const second = await apps.createMcpApp({ resolveTools, context, ...source, title: "Same org other App" })
    await expect(apps.loadMcpAppResource({ ...access(context), appId: app.appId, revisionId: second.revisionId })).rejects.toThrow("not available")
  })

  test("failed compilation publishes nothing, preserves the prior revision, and does not leak diagnostics", async () => {
    const context = await actor()
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const original = await revisions(app)
    const build = spyOn(compiler, "buildGeneratedMcpApp").mockRejectedValue(new Error("sensitive-builder-detail"))
    try {
      await expect(apps.updateMcpApp({ resolveTools, context, ...source, appId: app.appId, expectedRevisionId: app.revisionId })).rejects.toThrow("No revision was published")
      await expect(apps.createMcpApp({ resolveTools, context, ...source, title: "Failed new app" })).rejects.toThrow("MCP App compilation failed")
    } finally {
      build.mockRestore()
    }
    expect(await revisions(app)).toEqual(original)
    expect(await apps.listAccessibleMcpApps(access(context))).toEqual([entry(app)])
    expect(await db.select().from(PluginTable).where(eq(PluginTable.organizationId, access(context).organizationId))).toHaveLength(1)
    const failed = await compiler.buildGeneratedMcpApp({ ...source, description: source.description, reactSource: "export default function App() { return fetch('synthetic-secret') }" })
    const failingBuild = spyOn(compiler, "buildGeneratedMcpApp").mockResolvedValue({ ...failed, ok: false, diagnostics: [{ level: "error", message: "synthetic-secret", line: 2, column: 4 }] })
    try {
      await expect(apps.updateMcpApp({ resolveTools, context, ...source, appId: app.appId, expectedRevisionId: app.revisionId })).rejects.toMatchObject({
        code: "mcp_app_compile_failed",
        message: "MCP App compilation failed at line 2, column 4. Check React/TSX syntax and provide a default-exported React component. No revision was published.",
      })
    } finally {
      failingBuild.mockRestore()
    }
  })

  test("compiler integrity failures publish nothing and source corruption never leaks through generic reads", async () => {
    const context = await actor()
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const result = await compiler.buildGeneratedMcpApp(source)
    if (!result.ok) throw new Error("Fixture compiler failed")
    for (const invalid of [
      { ...result, sourceDigest: `sha256:${"0".repeat(64)}` },
      { ...result, resourceDigest: `sha256:${"0".repeat(64)}` },
      { ...result, htmlBytes: result.htmlBytes + 1 },
    ]) {
      const build = spyOn(compiler, "buildGeneratedMcpApp").mockResolvedValue(invalid)
      try {
        await expect(apps.updateMcpApp({ resolveTools, context, ...source, appId: app.appId, expectedRevisionId: app.revisionId })).rejects.toMatchObject({ code: "mcp_app_invalid_build" })
      } finally {
        build.mockRestore()
      }
    }
    expect(await revisions(app)).toHaveLength(1)
    await db.update(ConfigObjectVersionTable).set({ rawSourceText: JSON.stringify({ reactSource: "tampered-source-marker", cssSource: "" }) }).where(eq(ConfigObjectVersionTable.id, normalizeDenTypeId("configObjectVersion", app.revisionId)))
    await expect(apps.readMcpApp({ context, appId: app.appId })).rejects.toThrow("integrity check")
    const detail = await store.getConfigObjectDetail(context, normalizeDenTypeId("configObject", app.appId))
    expect(JSON.stringify(detail)).not.toContain("tampered-source-marker")
    expect((await apps.loadMcpAppResource({ ...access(context), ...ids(app) })).html).toBe(result.html)
  })

  test("write authorization is rechecked after compilation before inserting a revision", async () => {
    const context = await actor()
    const editor = await actor(access(context).organizationId)
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const grantId = createDenTypeId("configObjectAccessGrant")
    await db.insert(ConfigObjectAccessGrantTable).values({ id: grantId, configObjectId: normalizeDenTypeId("configObject", app.appId), organizationId: access(context).organizationId, orgMembershipId: access(editor).member.orgMembershipId, role: "editor", createdByOrgMembershipId: access(context).member.orgMembershipId })
    const result = await compiler.buildGeneratedMcpApp(source)
    const build = spyOn(compiler, "buildGeneratedMcpApp").mockImplementation(async () => {
      await db.update(ConfigObjectAccessGrantTable).set({ removedAt: new Date() }).where(eq(ConfigObjectAccessGrantTable.id, grantId))
      return result
    })
    try {
      await expect(apps.updateMcpApp({ resolveTools, context: editor, ...source, appId: app.appId, expectedRevisionId: app.revisionId })).rejects.toThrow("Missing editor access")
    } finally {
      build.mockRestore()
    }
    expect(await revisions(app)).toHaveLength(1)
    expect(await apps.listAccessibleMcpApps(access(context))).toEqual([entry(app)])
  })

  test("successful updates activate only the new revision and preserve immutable old resources", async () => {
    const context = await actor()
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const original = await apps.loadMcpAppResource({ ...access(context), ...ids(app) })
    const updated = await apps.updateMcpApp({ resolveTools, context, ...source, title: "Revised title", textFallback: "Revised fallback", reactSource: "export default function App() { return <p>New</p> }", appId: app.appId, expectedRevisionId: app.revisionId })
    expect(updated.revisionId).not.toBe(app.revisionId)
    expect(updated.toolName).toBe(app.toolName)
    expect(await apps.listAccessibleMcpApps(access(context))).toEqual([entry(updated)])
    expect(await apps.loadMcpAppResource({ ...access(context), ...ids(app) })).toEqual(original)
    expect((await apps.loadMcpAppResource({ ...access(context), ...ids(updated) })).resourceDigest).not.toBe(original.resourceDigest)
    await expect(apps.updateMcpApp({ resolveTools, context, ...source, appId: app.appId, expectedRevisionId: app.revisionId })).rejects.toThrow("has changed")
    expect(await revisions(app)).toHaveLength(2)
    const build = spyOn(compiler, "buildGeneratedMcpApp")
    try {
      await apps.readMcpApp({ context, appId: app.appId })
      await apps.listAccessibleMcpApps(access(context))
      await apps.loadMcpAppResource({ ...access(context), ...ids(app) })
      expect(build).not.toHaveBeenCalled()
    } finally {
      build.mockRestore()
    }
  })

  test("transactional expected revision guard permits only one concurrent replacement", async () => {
    const context = await actor()
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const results = await Promise.allSettled(["First writer", "Second writer"].map((title) => apps.updateMcpApp({ resolveTools, context, ...source, title, appId: app.appId, expectedRevisionId: app.revisionId })))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    const failed = results.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") expect(failed.reason).toMatchObject({ code: "mcp_app_revision_conflict", status: 409 })
    expect(await revisions(app)).toHaveLength(2)
  })

  test("archive and delete stop all launches and historical resource reads", async () => {
    const context = await actor()
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const updated = await apps.updateMcpApp({ resolveTools, context, ...source, appId: app.appId, expectedRevisionId: app.revisionId })
    const configObjectId = normalizeDenTypeId("configObject", app.appId)
    for (const action of ["archive", "delete"] satisfies Array<"archive" | "delete">) {
      await store.setConfigObjectLifecycle({ context, configObjectId, action })
      expect(await apps.listAccessibleMcpApps(access(context))).toEqual([])
      for (const revision of [app, updated]) await expect(apps.loadMcpAppResource({ ...access(context), ...ids(revision) })).rejects.toThrow("not available")
      await expect(apps.updateMcpApp({ resolveTools, context, ...source, appId: app.appId, expectedRevisionId: updated.revisionId })).rejects.toThrow("not available")
      await store.setConfigObjectLifecycle({ context, configObjectId, action: "restore" })
    }
  })

  test("generic storage rejects reserved schema and kind spoofing, including bundles and declassification", async () => {
    const context = await actor()
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const configObjectId = normalizeDenTypeId("configObject", app.appId)
    for (const value of [
      { schemaVersion: MCP_APP_CONFIG_SCHEMA_VERSION, rawSourceText: "forged" },
      { normalizedPayloadJson: { kind: MCP_APP_PAYLOAD_KIND, html: "forged" } },
    ]) {
      for (const objectType of ["app", "custom"] satisfies Array<"app" | "custom">) {
        await expect(store.createConfigObject({ context, objectType, sourceMode: "cloud", value })).rejects.toThrow("must be compiled")
        await expect(store.createPluginBundle({ context, name: "Forged bundle", components: [{ type: objectType, value }] })).rejects.toThrow("must be compiled")
      }
      await expect(store.createConfigObjectVersion({ context, configObjectId, value })).rejects.toThrow("must be compiled")
    }
    await expect(store.createConfigObjectVersion({ context, configObjectId, value: { rawSourceText: "declassified" } })).rejects.toThrow("must be compiled")
    expect(await revisions(app)).toHaveLength(1)
    expect(await db.select().from(PluginTable).where(eq(PluginTable.organizationId, access(context).organizationId))).toHaveLength(1)
  })

  test("generic projections contain summary metadata but no source or HTML; legacy Apps remain unchanged", async () => {
    const context = await actor()
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const configObjectId = normalizeDenTypeId("configObject", app.appId)
    const detail = await store.getConfigObjectDetail(context, configObjectId)
    const versions = await store.listConfigObjectVersions({ context, configObjectId })
    expect(detail.latestVersion?.rawSourceText).toBeNull()
    expect(detail.latestVersion?.normalizedPayloadJson).toMatchObject(app)
    expect(detail.searchText).toBe(`${source.title}\n${source.description}`)
    for (const projection of [detail, versions]) {
      expect(JSON.stringify(projection)).not.toContain("source-only-marker")
      expect(JSON.stringify(projection)).not.toContain("<!doctype html>")
      expect(JSON.stringify(projection)).not.toContain(source.cssSource)
    }
    const legacy = await store.createConfigObject({ context, objectType: "app", sourceMode: "import", value: { schemaVersion: "openwork.remote-mcp-app-installation/1", normalizedPayloadJson: { kind: "remote_mcp_app" }, rawSourceText: "legacy source" } })
    expect(legacy.latestVersion?.rawSourceText).toBe("legacy source")
    await expect(store.createConfigObjectVersion({ context, configObjectId: legacy.id, value: { rawSourceText: "legacy updated source" } })).resolves.toBeDefined()
  })

  test("an App's own server carries its declared tools to every member its Plugin is shared with", async () => {
    const context = await actor()
    const viewer = await actor(access(context).organizationId)
    const outsider = await actor(access(context).organizationId)
    const declared: McpAppToolDeclaration[][] = []
    const resolving = async (tools: McpAppToolDeclaration[]) => { declared.push(tools); return tools.length === 0 ? [] : toolBindings }
    const app = await apps.createMcpApp({ resolveTools: resolving, context, ...source, tools: [declaredTool] })
    expect(declared).toEqual([[declaredTool]])
    expect(app.tools).toEqual([{ ...declaredTool, mode: "input", readOnly: true }])
    expect(app.serverPath).toBe(mcpAppServerPath(app.appId))
    const server = (member: PluginArchActorContext, enabled = true) => apps.loadMcpAppServerDefinition({ ...access(member), enabled, appId: app.appId })
    expect(await server(context)).toEqual({ app, tools: toolBindings })
    await expect(server(viewer)).rejects.toThrow("not available")
    await grantPlugin(context, app, viewer)
    expect((await server(viewer)).tools).toEqual(toolBindings)
    await expect(server(outsider)).rejects.toThrow("not available")
    await expect(server(viewer, false)).rejects.toThrow("not available")

    const kept = await apps.updateMcpApp({ resolveTools: resolving, context, ...source, appId: app.appId, expectedRevisionId: app.revisionId })
    expect(declared.at(-1)).toEqual([{ ...declaredTool, mode: "input" }])
    expect(kept.tools).toEqual(app.tools)
    const cleared = await apps.updateMcpApp({ resolveTools: resolving, context, ...source, tools: [], appId: app.appId, expectedRevisionId: kept.revisionId })
    expect(declared.at(-1)).toEqual([])
    expect(cleared.tools).toEqual([])
    expect(await server(viewer)).toEqual({ app: { ...cleared, pluginId: app.pluginId }, tools: [] })
  })

  test("a tool that cannot be resolved publishes nothing", async () => {
    const context = await actor()
    const failing = async () => { throw new apps.McpAppError(422, "mcp_app_tool_unavailable", "Tool list_projects: unavailable. No revision was published.") }
    await expect(apps.createMcpApp({ resolveTools: failing, context, ...source, tools: [declaredTool] })).rejects.toThrow("No revision was published")
    expect(await apps.listAccessibleMcpApps(access(context))).toEqual([])
    const plugins = await db.select().from(PluginTable).where(eq(PluginTable.organizationId, access(context).organizationId))
    expect(plugins).toEqual([])
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    await expect(apps.updateMcpApp({ resolveTools: failing, context, ...source, tools: [declaredTool], appId: app.appId, expectedRevisionId: app.revisionId })).rejects.toThrow("No revision was published")
    expect(await revisions(app)).toHaveLength(1)
  })

  test("URL-imported Apps that share the object type never get their own server", async () => {
    const context = await actor()
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const legacy = await store.createConfigObject({
      context, objectType: "app", sourceMode: "import", pluginIds: [normalizeDenTypeId("plugin", app.pluginId)],
      value: { schemaVersion: "openwork.remote-mcp-app-installation/1", normalizedPayloadJson: { kind: "remote_mcp_app" }, rawSourceText: "legacy source" },
    })
    expect(await apps.listAccessibleMcpApps(access(context))).toEqual([entry(app)])
    await expect(apps.loadMcpAppServerDefinition({ ...access(context), enabled: true, appId: legacy.id })).rejects.toThrow("not available")
    const organizationId = access(context).organizationId
    expect(await apps.isActiveMcpApp({ organizationId, appId: app.appId })).toBe(true)
    expect(await apps.isActiveMcpApp({ organizationId, appId: createDenTypeId("configObject") })).toBe(false)
    expect(await apps.isActiveMcpApp({ organizationId, appId: "not-an-app" })).toBe(false)
  })

  test("resource integrity and strict CSP validation reject tampered stored payloads", async () => {
    const context = await actor()
    const app = await apps.createMcpApp({ resolveTools, context, ...source })
    const [version] = await revisions(app)
    if (!version) throw new Error("Missing fixture version")
    const payload = mcpAppCompiledRevisionSchema.parse(version.normalizedPayloadJson)
    await db.update(ConfigObjectVersionTable).set({ normalizedPayloadJson: { ...payload, html: payload.html + "tampered" } }).where(eq(ConfigObjectVersionTable.id, version.id))
    await expect(apps.loadMcpAppResource({ ...access(context), ...ids(app) })).rejects.toThrow("integrity check")
    await db.update(ConfigObjectVersionTable).set({ normalizedPayloadJson: { ...payload, csp: { ...payload.csp, connectDomains: ["https://example.com"] } } }).where(eq(ConfigObjectVersionTable.id, version.id))
    // Listing reads metadata only; the App's own server and resources refuse the tampered revision.
    await expect(apps.loadMcpAppServerDefinition({ ...access(context), appId: app.appId })).rejects.toThrow("not available")
    await expect(apps.loadMcpAppResource({ ...access(context), ...ids(app) })).rejects.toThrow("not available")
  })

  test("shared writes preserve session freshness while source reads and private edits do not require step-up", async () => {
    const context = await actor(undefined, "owner")
    const viewer = await actor(access(context).organizationId)
    const stale = { ...context, session: { createdAt: new Date(0) } }
    const app = await apps.createMcpApp({ resolveTools, context: stale, ...source })
    const updated = await apps.updateMcpApp({ resolveTools, context: stale, ...source, appId: app.appId, expectedRevisionId: app.revisionId })
    await grantPlugin(context, app, viewer)
    await expect(apps.readMcpApp({ context: stale, appId: app.appId })).resolves.toBeDefined()
    await expect(apps.updateMcpApp({ resolveTools, context: stale, ...source, appId: app.appId, expectedRevisionId: updated.revisionId })).rejects.toMatchObject({ error: "reauth" })
    await expect(apps.createMcpApp({ resolveTools, context: stale, ...source, pluginId: app.pluginId })).rejects.toMatchObject({ error: "reauth" })
  })

  test("encoded payload size is bounded even when the HTML byte limit passes", async () => {
    const context = await actor()
    const result = await compiler.buildGeneratedMcpApp({ ...source, description: source.description })
    if (!result.ok) throw new Error("Fixture compiler failed")
    const build = spyOn(compiler, "buildGeneratedMcpApp").mockResolvedValue({ ...result, html: "\\".repeat(700_000), htmlBytes: 700_000 })
    try {
      await expect(apps.createMcpApp({ resolveTools, context, ...source })).rejects.toMatchObject({ code: "mcp_app_invalid_build" })
      expect(await db.select().from(PluginTable).where(eq(PluginTable.organizationId, access(context).organizationId))).toHaveLength(0)
    } finally {
      build.mockRestore()
    }
  })
})
