import { beforeAll, expect, test } from "bun:test"

import { Tool } from "@openwork/codemode"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Effect } from "effect"
import { Hono } from "hono"
import type {
  CapabilityLeaf,
  CapabilityRegistryContext,
  CapabilitySource,
  CapabilitySourceKind,
  ExecuteCapabilityToolResult,
  ParsedCapability,
} from "../src/mcp/capability-registry.js"
import type { CapabilityMatch } from "../src/mcp/search.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
}

let CAPABILITY_SOURCE_KINDS: typeof import("../src/mcp/capability-registry.js")["CAPABILITY_SOURCE_KINDS"]
let catalogOperationAvailableToCapabilities: typeof import("../src/mcp/capability-registry.js")["catalogOperationAvailableToCapabilities"]
let createCapabilityRegistry: typeof import("../src/mcp/capability-registry.js")["createCapabilityRegistry"]
let codemodeScriptPath: typeof import("../src/mcp/codemode-namespaces.js")["codemodeScriptPath"]

beforeAll(async () => {
  seedRequiredEnv()
  const capabilityRegistry = await import("../src/mcp/capability-registry.js")
  CAPABILITY_SOURCE_KINDS = capabilityRegistry.CAPABILITY_SOURCE_KINDS
  catalogOperationAvailableToCapabilities = capabilityRegistry.catalogOperationAvailableToCapabilities
  createCapabilityRegistry = capabilityRegistry.createCapabilityRegistry
  codemodeScriptPath = (await import("../src/mcp/codemode-namespaces.js")).codemodeScriptPath
})

const FIXTURES: Record<CapabilitySourceKind, { capabilityName: string; namespace: string; toolName: string }> = {
  catalog: { capabilityName: "listFixtureWidgets", namespace: "den", toolName: "listFixtureWidgets" },
  native: { capabilityName: "native:fixture:nativeAction", namespace: "native_fixture", toolName: "nativeAction" },
  externalMcp: { capabilityName: "mcp:fixture:externalAction", namespace: "external_fixture", toolName: "externalAction" },
  marketplace: { capabilityName: "plugin:fixture:content", namespace: "marketplace", toolName: "plugin:fixture:content" },
  builtinSkill: { capabilityName: "skill:fixture", namespace: "skills", toolName: "skill:fixture" },
  remoteSession: { capabilityName: "remote-session:create", namespace: "remote_session", toolName: "create" },
  admin: { capabilityName: "admin:fixtureAction", namespace: "admin", toolName: "fixtureAction" },
}

function textResult(value: unknown): ExecuteCapabilityToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function unknownResult(name: string): ExecuteCapabilityToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({
        error: "unknown_capability",
        message: `No capability named "${name}". Call search_capabilities to find a valid name.`,
      }),
    }],
  }
}

function fixtureMatch(kind: CapabilitySourceKind): CapabilityMatch {
  const fixture = FIXTURES[kind]
  return {
    name: fixture.capabilityName,
    method: "FIXTURE",
    path: `/fixture/${kind}`,
    score: 10,
    summary: `${kind} fixture capability`,
    pathParams: [],
    queryParams: [],
    hasBody: false,
    kind: "capability",
    scriptPath: codemodeScriptPath(fixture.namespace, fixture.toolName),
  }
}

function fixtureLeaf(kind: CapabilitySourceKind): CapabilityLeaf {
  const fixture = FIXTURES[kind]
  return {
    namespace: fixture.namespace,
    toolName: fixture.toolName,
    capabilityName: fixture.capabilityName,
    scriptPath: codemodeScriptPath(fixture.namespace, fixture.toolName),
    definition: Tool.make({
      description: `${kind} fixture capability`,
      input: { type: "object" },
      run: () => Effect.succeed({ source: kind }),
    }),
  }
}

function parsedCapability(kind: CapabilitySourceKind, name: string): ParsedCapability | null {
  if (name !== FIXTURES[kind].capabilityName) return null
  if (kind === "catalog") return { kind, name }
  if (kind === "native") return { kind, name, connectionId: "fixture", toolName: "nativeAction" }
  if (kind === "externalMcp") return { kind, name, connectionId: "fixture", toolName: "externalAction" }
  if (kind === "marketplace") return { kind, name, pluginId: "fixture", configObjectId: "content" }
  if (kind === "builtinSkill") return { kind, name }
  if (kind === "remoteSession") return { kind, name, action: "create" }
  return { kind, name, toolName: "fixtureAction" }
}

function fixtureSource(kind: CapabilitySourceKind): CapabilitySource {
  const adminOnly = kind === "admin"
  return {
    kind,
    parseName: (name) => parsedCapability(kind, name),
    search: async (ctx) => adminOnly && !(await ctx.resolvePlatformAdmin()) ? [] : [fixtureMatch(kind)],
    enumerate: async (ctx) => adminOnly && !(await ctx.resolvePlatformAdmin()) ? [] : [fixtureLeaf(kind)],
    execute: async (ctx, _parsed, input) => adminOnly && !(await ctx.resolvePlatformAdmin())
      ? unknownResult(input.name)
      : textResult({ resolvedSource: kind }),
  }
}

function fixtureSources(): Record<CapabilitySourceKind, CapabilitySource> {
  return {
    catalog: fixtureSource("catalog"),
    native: fixtureSource("native"),
    externalMcp: fixtureSource("externalMcp"),
    marketplace: fixtureSource("marketplace"),
    builtinSkill: fixtureSource("builtinSkill"),
    remoteSession: fixtureSource("remoteSession"),
    admin: fixtureSource("admin"),
  }
}

function fixtureContext(platformAdmin: boolean): CapabilityRegistryContext {
  const organizationId = createDenTypeId("organization")
  const memberId = createDenTypeId("member")
  let platformAdminResolution: Promise<boolean> | undefined
  return {
    app: new Hono(),
    env: undefined,
    catalog: [],
    principal: {
      userId: createDenTypeId("user"),
      organizationId,
      scopes: new Set(["mcp:read", "mcp:write"]),
      payload: {},
    },
    organizationId,
    member: { orgMembershipId: memberId, teamIds: [] },
    redirectUriBase: "http://127.0.0.1:8790",
    generatedArtifactViewsEnabled: false,
    externalMcpConnectionsEnabled: true,
    remoteSessionsEnabled: true,
    resolvePlatformAdmin: () => {
      platformAdminResolution ??= Promise.resolve(platformAdmin)
      return platformAdminResolution
    },
    resolveNamespaceContext: () => Promise.resolve({
      nativeProviderEntries: [],
      externalMcpConnections: [],
      codemodeNativeProviderEntries: [],
      codemodeExternalMcpConnections: [],
      namespaces: { native: new Map(), externalMcp: new Map() },
    }),
  }
}

function firstText(result: ExecuteCapabilityToolResult): string {
  const part = result.content.find((candidate) => candidate.type === "text")
  return part?.type === "text" ? part.text : ""
}

async function expectSearchExecuteTreeParity(platformAdmin: boolean) {
  const registry = createCapabilityRegistry(fixtureSources())
  const context = fixtureContext(platformAdmin)
  const searched = await registry.search(context, { query: "fixture", limit: 20 })
  const tree = await registry.buildToolTree(context)
  const treePaths = new Set(Object.entries(tree.tools).flatMap(([namespace, tools]) => (
    Object.keys(tools).map((toolName) => codemodeScriptPath(namespace, toolName))
  )))
  const callableMatches = searched.matches.filter((match) => match.kind === "capability")

  for (const match of callableMatches) {
    const executed = await registry.execute(context, { name: match.name })
    expect(firstText(executed)).not.toContain("unknown_capability")
    expect(match.scriptPath).toBeDefined()
    expect(treePaths.has(match.scriptPath ?? "")).toBe(true)
    expect(tree.manifest).toContainEqual({
      capabilityName: match.name,
      scriptPath: match.scriptPath,
    })
  }

  return { callableMatches, context, registry, tree }
}

test("every member capability found by search resolves through execute and exists in the script tree", async () => {
  const result = await expectSearchExecuteTreeParity(false)
  expect(result.callableMatches.map((match) => match.name).sort()).toEqual(
    CAPABILITY_SOURCE_KINDS
      .filter((kind) => kind !== "admin")
      .map((kind) => FIXTURES[kind].capabilityName)
      .sort(),
  )
})

test("a platform admin receives the same parity set plus admin capabilities", async () => {
  const result = await expectSearchExecuteTreeParity(true)
  expect(result.callableMatches.map((match) => match.name)).toContain(FIXTURES.admin.capabilityName)
})

test("a non-admin member has zero admin capabilities in search, execute, and the script tree", async () => {
  const result = await expectSearchExecuteTreeParity(false)
  expect(result.callableMatches.some((match) => match.name.startsWith("admin:"))).toBe(false)
  expect(result.tree.manifest.some((entry) => entry.capabilityName.startsWith("admin:"))).toBe(false)

  const executed = await result.registry.execute(result.context, { name: FIXTURES.admin.capabilityName })
  expect(firstText(executed)).toContain("unknown_capability")
})

test("keeps installation and disabled generated-view operations out of every generic capability consumer", () => {
  const disabled = { generatedArtifactViewsEnabled: false }
  expect(catalogOperationAvailableToCapabilities(disabled, { method: "POST", path: "/v1/remote-mcp-apps" })).toBe(false)
  expect(catalogOperationAvailableToCapabilities(disabled, { method: "GET", path: "/v1/remote-mcp-apps/{appId}" })).toBe(false)
  expect(catalogOperationAvailableToCapabilities({ generatedArtifactViewsEnabled: true }, {
    method: "POST",
    path: "/v1/remote-mcp-apps/{appId}/activate",
  })).toBe(false)
  expect(catalogOperationAvailableToCapabilities(disabled, { method: "POST", path: "/v1/artifact-views/{artifactViewId}/retire" })).toBe(false)
  expect(catalogOperationAvailableToCapabilities(disabled, { method: "GET", path: "/v1/workflows/{configObjectId}/views" })).toBe(false)
  expect(catalogOperationAvailableToCapabilities(disabled, { method: "GET", path: "/v1/workflows/{configObjectId}" })).toBe(true)
  expect(catalogOperationAvailableToCapabilities({ generatedArtifactViewsEnabled: true }, {
    method: "POST",
    path: "/v1/artifact-views/{artifactViewId}/retire",
  })).toBe(true)
})
