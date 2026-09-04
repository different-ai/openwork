import { beforeAll, expect, test } from "bun:test"
import { Tool } from "@openwork/codemode"
import { Effect } from "effect"
import { Hono } from "hono"
import { buildMcpCatalog } from "../src/mcp/catalog.js"

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
