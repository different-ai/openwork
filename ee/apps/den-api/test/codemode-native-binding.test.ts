import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { Hono } from "hono"
import type { NativeProviderConnectionEntry } from "../src/capability-sources/native-provider-connections.js"
import { buildMcpCatalog } from "../src/mcp/catalog.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const connectionId = createDenTypeId("externalMcpConnection")
const entry: NativeProviderConnectionEntry = {
  id: connectionId,
  name: "Google Workspace",
  url: "https://workspace.google.com",
  authType: "oauth",
  credentialMode: "per_member",
  connected: true,
  connectedAt: null,
  connectedForMe: true,
  needsReconnect: false,
  missingFeatures: [],
  nativeProviderKey: "google-workspace",
  requiredBy: [],
  access: null,
}
let observedInvocation: unknown
let codemodeTools: typeof import("../src/mcp/codemode-tools.js")

beforeAll(async () => {
  seedRequiredEnv()
  mock.module("../src/capability-sources/native-provider-connections.js", () => ({
    listNativeProviderUsableEntries: () => Promise.resolve([entry]),
    nativeProviderConnectionPolicyError: () => Promise.resolve(null),
  }))
  mock.module("../src/mcp/invoke.js", () => ({
    invokeMcpOperation: (input: unknown) => {
      observedInvocation = input
      return Promise.resolve({ content: [{ type: "text", text: "{\"bound\":true}" }] })
    },
    normalizeToolBody: (value: unknown) => value,
    normalizeToolRecord: normalizeRecord,
  }))
  codemodeTools = await import("../src/mcp/codemode-tools.js")
})

afterAll(() => {
  mock.restore()
})

test("native Code Mode leaves bind invocation to the selected connection", async () => {
  observedInvocation = undefined
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
  const namespaces = codemodeTools.buildCodemodeConnectionNamespaceMaps({
    native: [entry],
    externalMcp: [],
  })
  const built = await codemodeTools.buildNativeProviderToolTree({
    app: new Hono(),
    env: undefined,
    catalog,
    principal: {
      userId: createDenTypeId("user"),
      organizationId,
      scopes: new Set(["mcp:read"]),
      payload: {},
    },
    organizationId,
    member: { orgMembershipId: memberId, teamIds: [] },
    namespaceContext: {
      nativeProviderEntries: [entry],
      externalMcpConnections: [],
      codemodeNativeProviderEntries: [entry],
      codemodeExternalMcpConnections: [],
      namespaces,
    },
  })
  const namespace = namespaces.native.get(connectionId)
  const leaf = namespace ? built.tools[namespace]?.getCapabilitiesGoogleWorkspaceGmailMessages : undefined
  if (!leaf) throw new Error("Expected native Code Mode leaf")

  await Effect.runPromise(leaf.run({ query: { maxResults: 1 } }))

  expect(isRecord(observedInvocation) ? observedInvocation.nativeConnectionId : undefined).toBe(connectionId)
})
