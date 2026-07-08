import { beforeAll, describe, expect, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { ExternalMcpConnectionRow } from "../src/capability-sources/external-mcp-connections.js"
import type { ExternalMcpToolManifestRow } from "../src/capability-sources/external-mcp-manifests.js"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_manifests"
process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"

let classifyManifest: typeof import("../src/capability-sources/external-mcp-manifests.js").classifyManifest
let computeManifestConfigHash: typeof import("../src/capability-sources/external-mcp-manifests.js").computeManifestConfigHash
let createBoundedManifestRevalidationQueue: typeof import("../src/capability-sources/external-mcp-manifests.js").createBoundedManifestRevalidationQueue
let revalidateManifestWithClaim: typeof import("../src/capability-sources/external-mcp-manifests.js").revalidateManifestWithClaim

beforeAll(async () => {
  const manifests = await import("../src/capability-sources/external-mcp-manifests.js")
  classifyManifest = manifests.classifyManifest
  computeManifestConfigHash = manifests.computeManifestConfigHash
  createBoundedManifestRevalidationQueue = manifests.createBoundedManifestRevalidationQueue
  revalidateManifestWithClaim = manifests.revalidateManifestWithClaim
})

function connection(url: string): ExternalMcpConnectionRow {
  const now = new Date("2026-01-01T00:00:00.000Z")
  return {
    id: createDenTypeId("externalMcpConnection"),
    organizationId: createDenTypeId("organization"),
    name: "Test MCP",
    url,
    authType: "none",
    credentialMode: "shared",
    apiKey: null,
    accessToken: null,
    refreshToken: null,
    tokenType: null,
    scope: null,
    expiresAt: null,
    pendingCodeVerifier: null,
    connectedAt: now,
    createdByOrgMembershipId: createDenTypeId("member"),
    createdAt: now,
    updatedAt: now,
  }
}

function manifestRow(input: {
  configHash: string
  connection: ExternalMcpConnectionRow
  listedAt: Date | null
  toolCount: number
  tools: ExternalMcpToolManifestRow["tools"]
}): ExternalMcpToolManifestRow {
  const now = new Date("2026-01-01T00:00:00.000Z")
  return {
    id: createDenTypeId("externalMcpToolManifest"),
    organizationId: input.connection.organizationId,
    externalMcpConnectionId: input.connection.id,
    principal: "shared",
    configHash: input.configHash,
    status: "error",
    tools: input.tools,
    toolCount: input.toolCount,
    toolsHash: input.tools.length > 0 ? "old-tools-hash" : null,
    toolsTruncated: false,
    lastError: "refresh failed",
    durationMs: 7,
    listedAt: input.listedAt,
    staleAt: now,
    refreshStartedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

describe("external MCP tool manifests", () => {
  test("old-config failure rows classify as misses under the current config", () => {
    const oldConnection = connection("https://old.example.com/mcp")
    const currentConnection = connection("https://new.example.com/mcp")
    const failureRow = manifestRow({
      configHash: computeManifestConfigHash(oldConnection),
      connection: currentConnection,
      listedAt: null,
      toolCount: 0,
      tools: [],
    })

    expect(classifyManifest(failureRow, currentConnection).state).toBe("miss")
  })

  test("lease refresh rows do not make old-config tools usable", () => {
    const oldConnection = connection("https://old.example.com/mcp")
    const currentConnection = connection("https://new.example.com/mcp")
    const staleRow = manifestRow({
      configHash: computeManifestConfigHash(oldConnection),
      connection: currentConnection,
      listedAt: new Date("2026-01-01T00:00:00.000Z"),
      toolCount: 1,
      tools: [{ name: "old-tool", description: "Tool from the previous server." }],
    })

    expect(classifyManifest(staleRow, currentConnection).state).toBe("miss")
  })

  test("bounded revalidation queue caps in-flight work and drops overflow", async () => {
    const queue = createBoundedManifestRevalidationQueue({ concurrency: 2, maxBacklog: 2 })
    let inFlight = 0
    let maxInFlight = 0
    let releaseBlocker = () => undefined
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })

    const tasks = [0, 1, 2, 3, 4].map((value) =>
      queue.enqueue(async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await blocker
        inFlight -= 1
        expect(value).toBeGreaterThanOrEqual(0)
      }))
    const acceptedTasks = tasks.flatMap((task) => task ? [task] : [])

    expect(acceptedTasks.length).toBe(4)
    expect(tasks.filter((task) => task === null).length).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(maxInFlight).toBeLessThanOrEqual(2)
    expect(queue.stats()).toEqual({ active: 2, queued: 2 })

    releaseBlocker()
    await Promise.all(acceptedTasks)
    expect(queue.stats()).toEqual({ active: 0, queued: 0 })
  })

  test("revalidation reports lease_held when another worker owns the lease", async () => {
    const currentConnection = connection("https://current.example.com/mcp")
    const row = manifestRow({
      configHash: computeManifestConfigHash(currentConnection),
      connection: currentConnection,
      listedAt: null,
      toolCount: 0,
      tools: [],
    })

    const result = await revalidateManifestWithClaim({
      connection: currentConnection,
      principal: "shared",
      redirectUri: "https://den.example.com/v1/mcp-connections/callback",
      row,
      claimRefresh: async () => false,
    })

    expect(result).toBe("lease_held")
  })
})
