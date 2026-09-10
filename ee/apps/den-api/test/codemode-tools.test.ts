import { beforeAll, expect, mock, spyOn, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js"
import type { ExternalMcpConnectionRow } from "../src/capability-sources/external-mcp-connections.js"
import { Tool } from "@openwork/codemode"
import { Effect } from "effect"
import { Hono } from "hono"
import { buildMcpCatalog } from "../src/mcp/catalog.js"

// These catalog tests supply principals directly; authentication must not seed a database at import time.
mock.module("../src/auth.js", () => ({
  auth: { handler: () => Promise.resolve(Response.json({ keys: [] })) },
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
  DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
  DEN_MCP_FIRST_PARTY_RESOURCES: [
    "http://127.0.0.1:8790/mcp", "http://127.0.0.1:8790/mcp/agent", "http://127.0.0.1:8790/mcp/admin",
  ],
  DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
  DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
  DEN_MCP_OAUTH_RESOURCE: "http://127.0.0.1:8790/mcp/agent",
  DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
  DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
  DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
  DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
}))

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let buildExternalNamespaceMap: typeof import("../src/mcp/codemode-tools.js")["buildExternalNamespaceMap"]
let buildCodemodeConnectionNamespaceMaps: typeof import("../src/mcp/codemode-tools.js")["buildCodemodeConnectionNamespaceMaps"]
let buildDenCatalogToolTree: typeof import("../src/mcp/codemode-tools.js")["buildDenCatalogToolTree"]
let buildNativeProviderManifest: typeof import("../src/mcp/codemode-tools.js")["buildNativeProviderManifest"]
let CAPABILITY_SOURCE_KINDS: typeof import("../src/mcp/capability-registry.js")["CAPABILITY_SOURCE_KINDS"]
let CAPABILITY_SOURCES: typeof import("../src/mcp/capability-registry.js")["CAPABILITY_SOURCES"]
let isCodemodeEligibleConnection: typeof import("../src/mcp/codemode-tools.js")["isCodemodeEligibleConnection"]
let firstUnattendedUnsafeCapability: typeof import("../src/mcp/codemode-tools.js")["firstUnattendedUnsafeCapability"]
let restrictCodemodeToolTree: typeof import("../src/mcp/codemode-tools.js")["restrictCodemodeToolTree"]
let sanitizeNamespaceSegment: typeof import("../src/mcp/codemode-tools.js")["sanitizeNamespaceSegment"]
let stripUndefinedEntries: typeof import("../src/mcp/codemode-tools.js")["stripUndefinedEntries"]
let parseNativeCapabilityName: typeof import("../src/mcp/native-capabilities.js")["parseNativeCapabilityName"]

beforeAll(async () => {
  seedRequiredEnv()
  const codemodeTools = await import("../src/mcp/codemode-tools.js")
  const capabilityRegistry = await import("../src/mcp/capability-registry.js")
  const nativeCapabilities = await import("../src/mcp/native-capabilities.js")
  buildExternalNamespaceMap = codemodeTools.buildExternalNamespaceMap
  buildCodemodeConnectionNamespaceMaps = codemodeTools.buildCodemodeConnectionNamespaceMaps
  buildDenCatalogToolTree = codemodeTools.buildDenCatalogToolTree
  buildNativeProviderManifest = codemodeTools.buildNativeProviderManifest
  CAPABILITY_SOURCE_KINDS = capabilityRegistry.CAPABILITY_SOURCE_KINDS
  CAPABILITY_SOURCES = capabilityRegistry.CAPABILITY_SOURCES
  isCodemodeEligibleConnection = codemodeTools.isCodemodeEligibleConnection
  firstUnattendedUnsafeCapability = codemodeTools.firstUnattendedUnsafeCapability
  restrictCodemodeToolTree = codemodeTools.restrictCodemodeToolTree
  sanitizeNamespaceSegment = codemodeTools.sanitizeNamespaceSegment
  stripUndefinedEntries = codemodeTools.stripUndefinedEntries
  parseNativeCapabilityName = nativeCapabilities.parseNativeCapabilityName
})

test("sanitizes connection names into interpreter-safe namespaces", () => {
  expect(sanitizeNamespaceSegment("Acme Drive")).toBe("acme_drive")
  expect(sanitizeNamespaceSegment("123 / CRM")).toBe("_123_crm")
  expect(sanitizeNamespaceSegment("***")).toBe("_")
})

test("strips undefined object entries while preserving array positions", () => {
  expect(stripUndefinedEntries({
    channel: "bug",
    omitted: undefined,
    nested: { omitted: undefined, kept: true },
    values: [1, undefined, { omitted: undefined, kept: 2 }],
  })).toEqual({
    channel: "bug",
    nested: { kept: true },
    values: [1, null, { kept: 2 }],
  })
})

test("reserves prototype-sensitive connection namespaces", () => {
  const namespaces = buildExternalNamespaceMap([
    { id: "proto", name: "__proto__" },
    { id: "constructor", name: "constructor" },
    { id: "prototype", name: "prototype" },
  ])

  expect([...namespaces.values()]).toEqual(["__proto___2", "constructor_2", "prototype_2"])
})

test("restricts prototype-sensitive namespaces without mutating Object.prototype", () => {
  const definition = Tool.make({
    description: "Prototype safety test tool",
    input: { type: "object" },
    run: () => Effect.succeed("safe"),
  })
  const entry = { scriptPath: "tools.__proto__.someToolName", capabilityName: "prototypeSafety" }
  expect(Object.hasOwn(Object.prototype, "someToolName")).toBe(false)

  const result = restrictCodemodeToolTree({
    built: {
      tools: Object.fromEntries([["__proto__", { someToolName: definition }]]),
      manifest: [entry],
    },
    requiredCapabilities: [entry],
  })

  expect(Object.hasOwn(Object.prototype, "someToolName")).toBe(false)
  expect(result.missing).toEqual([])
  expect(result.tools.__proto__?.someToolName).toBe(definition)
})

test("excludes connections disabled or pending OAuth issuer review", () => {
  expect(isCodemodeEligibleConnection({
    toolPolicy: { version: 1, allDisabled: true, disabledTools: [] },
    oauthIssuerReviewRequiredAt: null,
  })).toBe(false)
  expect(isCodemodeEligibleConnection({
    toolPolicy: null,
    oauthIssuerReviewRequiredAt: new Date(),
  })).toBe(false)
  expect(isCodemodeEligibleConnection({
    toolPolicy: null,
    oauthIssuerReviewRequiredAt: null,
  })).toBe(true)
})

test("allows only first-party read-only Den capabilities in unattended Cloud runs", () => {
  const required = { scriptPath: "tools.den.reports_read", capabilityName: "reports_read" }
  const built = {
    tools: {},
    manifest: [{ ...required, readOnly: true, authority: "den" as const }],
  }
  expect(firstUnattendedUnsafeCapability(built, [required])).toBeNull()
  expect(firstUnattendedUnsafeCapability({ ...built, manifest: [{ ...required, readOnly: true, authority: "external" as const }] }, [required])).toEqual(required)
  expect(firstUnattendedUnsafeCapability({ ...built, manifest: [{ ...required, readOnly: false, authority: "den" as const }] }, [required])).toEqual(required)
  expect(firstUnattendedUnsafeCapability({ ...built, manifest: [] }, [required])).toEqual(required)
})

test("excludes credential-bound native routes from the Den namespace and manifest", () => {
  const catalog = buildMcpCatalog({
    paths: {
      "/v1/workers": {
        get: { operationId: "getV1Workers", tags: ["Workers"] },
      },
      "/v1/capabilities/google-workspace/gmail/messages": {
        get: {
          operationId: "getV1CapabilitiesGoogleWorkspaceGmailMessages",
          tags: ["Capability Sources"],
        },
      },
      "/v1/capabilities/microsoft-365/calendar/events": {
        get: {
          operationId: "getV1CapabilitiesMicrosoft365CalendarEvents",
          tags: ["Capability Sources"],
        },
      },
      // Synthetic: every shipped /v1/capabilities/* route is a native provider
      // today, so this guards the generic rule that only native-provider
      // prefixes are withheld from tools.den.
      "/v1/capabilities/other-source/status": {
        get: {
          operationId: "getV1CapabilitiesOtherSourceStatus",
          tags: ["Capability Sources"],
        },
      },
    },
  })
  const built = buildDenCatalogToolTree({
    app: new Hono(),
    env: undefined,
    catalog,
    principal: { userId: "user", organizationId: "organization", scopes: new Set(["mcp:read"]), payload: {} },
  })

  expect(built.tools.den?.getCapabilitiesGoogleWorkspaceGmailMessages).toBeUndefined()
  expect(built.tools.den?.getCapabilitiesMicrosoft365CalendarEvents).toBeUndefined()
  expect(built.tools.den?.getCapabilitiesOtherSourceStatus).toBeDefined()
  expect(built.tools.den?.getWorkers).toBeDefined()
  const manifestPaths = built.manifest.map((entry) => entry.scriptPath)
  expect(manifestPaths).toContain("tools.den.getCapabilitiesOtherSourceStatus")
  expect(manifestPaths).toContain("tools.den.getWorkers")
  // Absence asserted by scriptPath, not by whole-object equality: extra manifest
  // fields (readOnly/authority) would make an object comparison pass vacuously.
  expect(manifestPaths).not.toContain("tools.den.getCapabilitiesGoogleWorkspaceGmailMessages")
  expect(manifestPaths).not.toContain("tools.den.getCapabilitiesMicrosoft365CalendarEvents")
})

test("allocates native and external namespaces from one collision set", () => {
  const namespaces = buildCodemodeConnectionNamespaceMaps({
    native: [
      { id: "native-den", name: "den" },
      { id: "native-codemode", name: "$codemode" },
      { id: "native-shared", name: "Shared" },
    ],
    externalMcp: [
      { id: "external-shared", name: "Shared" },
      { id: "external-constructor", name: "constructor" },
    ],
  })
  const allocated = [...namespaces.native.values(), ...namespaces.externalMcp.values()]

  expect(new Set(allocated).size).toBe(allocated.length)
  expect(allocated).not.toContain("den")
  expect(allocated).not.toContain("$codemode")
  expect(allocated).not.toContain("constructor")
  expect(namespaces.native.get("native-shared")).toBe("shared")
  expect(namespaces.externalMcp.get("external-shared")).toBe("shared_2")
})

test("registers every capability source kind with all three verbs", () => {
  expect(Object.keys(CAPABILITY_SOURCES).sort()).toEqual([...CAPABILITY_SOURCE_KINDS].sort())
  for (const kind of CAPABILITY_SOURCE_KINDS) {
    expect(CAPABILITY_SOURCES[kind].kind).toBe(kind)
    expect(typeof CAPABILITY_SOURCES[kind].search).toBe("function")
    expect(typeof CAPABILITY_SOURCES[kind].execute).toBe("function")
    expect(typeof CAPABILITY_SOURCES[kind].enumerate).toBe("function")
  }
})

test("native manifest capability names round-trip through the native parser", () => {
  const catalog = buildMcpCatalog({
    paths: {
      "/v1/capabilities/google-workspace/gmail/messages": {
        get: {
          operationId: "getV1CapabilitiesGoogleWorkspaceGmailMessages",
          tags: ["Capability Sources"],
        },
      },
    },
  })
  const manifest = buildNativeProviderManifest({
    connections: [{ id: "native-connection", nativeProviderKey: "google-workspace" }],
    catalog,
    namespaces: new Map([["native-connection", "google_workspace"]]),
  })

  expect(manifest).toHaveLength(1)
  expect(parseNativeCapabilityName(manifest[0]?.capabilityName ?? "")).toEqual({
    connectionId: "native-connection",
    toolName: "getCapabilitiesGoogleWorkspaceGmailMessages",
  })
})

test("generic search and Code Mode retain model audience, live policy and unconditional write scope", async () => {
  const connections = await import("../src/capability-sources/external-mcp-connections.js")
  const runtime = await import("../src/capability-sources/external-mcp-client-runtime.js")
  const { buildExternalMcpToolTree } = await import("../src/mcp/codemode-tools.js")
  const { createCapabilityRegistryContext, executeCapability } = await import("../src/mcp/capability-registry.js")
  const { runCodemodeScript } = await import("../src/mcp/codemode-run.js")
  const { searchExternalCapabilities } = await import("../src/mcp/external-capabilities.js")
  const { clearExternalToolsSearchCache, getExternalToolsSearchCache } = await import("../src/mcp/external-tools-search-cache.js")
  const organizationId = createDenTypeId("organization")
  const memberId = createDenTypeId("member")
  const connection: ExternalMcpConnectionRow = {
    id: createDenTypeId("externalMcpConnection"), organizationId,
    name: "Scope fixture", url: "https://scope.example.test/mcp",
    authType: "none", kind: "external_mcp", credentialMode: "shared",
    externalKey: null, nativeProviderKey: null, oauthConfiguration: null,
    toolPolicy: null, exposeDirectly: false, apiKey: null, accessToken: null,
    refreshToken: null, tokenType: null, scope: null, expiresAt: null,
    pendingCodeVerifier: null, credentialHealth: null, oauthIssuerReviewRequiredAt: null,
    connectedAt: null, createdByOrgMembershipId: memberId, createdAt: new Date(), updatedAt: new Date(),
  }
  let allowed = true
  let calls = 0
  let liveTool: McpTool = { name: "scope_tool", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }
  spyOn(connections, "getExternalMcpConnection").mockImplementation(async () => connection)
  spyOn(connections, "memberCanUseExternalMcpConnection").mockImplementation(async () => allowed)
  spyOn(runtime, "listExternalMcpTools").mockImplementation(async () => [liveTool])
  spyOn(runtime, "callExternalMcpTool").mockImplementation(async () => {
    calls += 1
    return { content: [{ type: "text", text: "scope result" }] }
  })
  try {
    const cases: Array<{ annotations?: McpTool["annotations"]; requiredScope: string }> = [
      { requiredScope: "mcp:write" },
      { annotations: { readOnlyHint: false }, requiredScope: "mcp:write" },
      { annotations: { destructiveHint: false }, requiredScope: "mcp:write" },
      { annotations: { readOnlyHint: true, destructiveHint: true }, requiredScope: "mcp:write" },
      { annotations: { readOnlyHint: true }, requiredScope: "mcp:write" },
      { annotations: { readOnlyHint: true, destructiveHint: false }, requiredScope: "mcp:write" },
    ]
    for (const scopes of [new Set(["mcp:read"]), new Set(["mcp:read", "mcp:write"]), new Set(["mcp:write"]), new Set(["mcp:read", "mcp:write", "mcp:app-host"])]) {
      const member = { orgMembershipId: memberId, teamIds: [] }
      const context = createCapabilityRegistryContext({
        app: new Hono(), env: undefined, catalog: [], organizationId, member,
        principal: { userId: createDenTypeId("user"), organizationId, scopes, payload: {} },
        redirectUriBase: "https://openwork.example", generatedArtifactViewsEnabled: false,
        organizationMetadata: null, mcpConnectionsGatingEnabled: false,
      })
      liveTool = { ...liveTool, annotations: { readOnlyHint: true } }
      const namespaceContext = {
        nativeProviderEntries: [], codemodeNativeProviderEntries: [],
        externalMcpConnections: [connection], codemodeExternalMcpConnections: [connection],
        namespaces: buildCodemodeConnectionNamespaceMaps({ native: [], externalMcp: [connection] }),
      }
      const build = () => buildExternalMcpToolTree({
        organizationId, member, scopes, redirectUriBase: context.redirectUriBase, namespaceContext,
      })
      const search = () => searchExternalCapabilities({
        organizationId, member, redirectUriBase: context.redirectUriBase, namespaceContext, query: "scope",
      })
      const built = await build()
      const leaf = built.manifest[0]
      if (!leaf) throw new Error("Missing external Code Mode leaf")
      expect(leaf).toMatchObject({ readOnly: true, authority: "external" })
      expect(firstUnattendedUnsafeCapability(built, [leaf])).toEqual(leaf)
      for (const entry of cases) {
        // Keep the already-built tree: dispatch must not trust its read-only snapshot.
        liveTool = { ...liveTool, annotations: entry.annotations }
        const before = calls
        const generic = await executeCapability(context, { name: leaf.capabilityName, body: {} })
        const script = await runCodemodeScript({ code: `return await ${leaf.scriptPath}({})`, tools: built.tools, timeoutMs: 1_000 })
        if (scopes.has(entry.requiredScope)) {
          expect(generic.isError).not.toBe(true)
          expect(script).toMatchObject({ ok: true, value: "scope result" })
          expect(calls).toBe(before + 2)
        } else {
          expect(generic.isError).toBe(true)
          const text = generic.content.find((part) => part.type === "text")
          if (!text || text.type !== "text") throw new Error("Missing scope error")
          expect(JSON.parse(text.text)).toMatchObject({ error: "insufficient_mcp_scope", requiredScope: entry.requiredScope })
          expect(script).toMatchObject({ ok: false, error: { message: expect.stringContaining(entry.requiredScope) } })
          expect(calls).toBe(before)
        }
      }
      for (const { visibility, visible } of [
        { visibility: undefined, visible: true },
        { visibility: ["model"], visible: true },
        { visibility: ["model", "app"], visible: true },
        { visibility: ["app"], visible: false },
        { visibility: [], visible: false },
        { visibility: ["model", "invalid"], visible: false },
        { visibility: ["app", null], visible: false },
        { visibility: "model", visible: false },
        { visibility: null, visible: false },
        { visibility: {}, visible: false },
      ]) {
        liveTool = { ...liveTool, _meta: { ui: { visibility } } }
        clearExternalToolsSearchCache()
        const names = visible ? [leaf.capabilityName] : []
        expect((await search()).map(tool => tool.name)).toEqual(names)
        expect((await search()).map(tool => tool.name)).toEqual(names)
        // The cache retains provider bytes, not an audience-specific projection.
        expect(getExternalToolsSearchCache({ organizationId, connectionId: connection.id,
          credentialMode: "shared", updatedAt: connection.updatedAt })).toEqual({ outcome: "success", tools: [liveTool] })
        const current = await build()
        expect(current.manifest.map(tool => tool.capabilityName)).toEqual(names)
        expect(Object.values(current.tools).flatMap(tools => Object.keys(tools))).toEqual(visible ? [liveTool.name] : [])
        expect(restrictCodemodeToolTree({ built: current, requiredCapabilities: [leaf] }).missing).toEqual(visible ? [] : [leaf])
        const before = calls
        const generic = await executeCapability(context, { name: leaf.capabilityName, body: { audience: "app" } })
        // Retained callbacks must re-read visibility even when the token also has App-host scope.
        const script = await runCodemodeScript({ code: `return await ${leaf.scriptPath}({})`, tools: built.tools, timeoutMs: 1_000 })
        const executable = visible && scopes.has("mcp:write")
        expect(generic.isError === true).toBe(!executable)
        expect(script.ok).toBe(executable)
        expect(calls).toBe(before + (executable ? 2 : 0))
      }
      liveTool = { ...liveTool, _meta: undefined }
      connection.toolPolicy = { version: 1, allDisabled: false, disabledTools: [liveTool.name] }
      clearExternalToolsSearchCache()
      expect(await search()).toEqual([])
      expect((await build()).manifest).toEqual([])
      const beforePolicy = calls
      expect((await executeCapability(context, { name: leaf.capabilityName, body: {} })).isError).toBe(true)
      expect((await runCodemodeScript({ code: `return await ${leaf.scriptPath}({})`, tools: built.tools, timeoutMs: 1_000 })).ok).toBe(false)
      expect(calls).toBe(beforePolicy)
      connection.toolPolicy = null
      allowed = false
      const before = calls
      expect((await executeCapability(context, { name: leaf.capabilityName, body: {} })).isError).toBe(true)
      expect((await runCodemodeScript({ code: `return await ${leaf.scriptPath}({})`, tools: built.tools, timeoutMs: 1_000 })).ok).toBe(false)
      expect(calls).toBe(before)
      allowed = true
    }
  } finally {
    clearExternalToolsSearchCache()
    mock.restore()
  }
})
