import { beforeAll, expect, test } from "bun:test"

import { HeadlessThreadError } from "@openwork/headless-threads"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type {
  RemoteSessionExecuteDeps,
  RemoteSessionRuntime,
  RemoteSessionThreadClient,
  RemoteSessionToolResult,
} from "../src/mcp/remote-session-capabilities.js"
import type { CloudWorkerAccess } from "../src/workers/worker-access.js"
import type { RemoteSessionCommandStore } from "../src/remote-sessions/commands.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
  process.env.DAYTONA_SNAPSHOT = "openwork-0.18.8"
}

type RemoteSessionModule = typeof import("../src/mcp/remote-session-capabilities.js")

let executeRemoteSessionCapability: RemoteSessionModule["executeRemoteSessionCapability"]
let parseRemoteSessionCapabilityName: RemoteSessionModule["parseRemoteSessionCapabilityName"]
let searchRemoteSessionCapabilities: RemoteSessionModule["searchRemoteSessionCapabilities"]
let remoteSessionCapabilityName: RemoteSessionModule["remoteSessionCapabilityName"]
let resolveRemoteSessionWorkspace: RemoteSessionModule["resolveRemoteSessionWorkspace"]

beforeAll(async () => {
  seedRequiredEnv()
  const module = await import("../src/mcp/remote-session-capabilities.js")
  executeRemoteSessionCapability = module.executeRemoteSessionCapability
  parseRemoteSessionCapabilityName = module.parseRemoteSessionCapabilityName
  searchRemoteSessionCapabilities = module.searchRemoteSessionCapabilities
  remoteSessionCapabilityName = module.remoteSessionCapabilityName
  resolveRemoteSessionWorkspace = module.resolveRemoteSessionWorkspace
})

const RUNTIME: RemoteSessionRuntime = {
  workerId: "worker_fixture",
  baseUrl: "http://worker.fixture",
  workspaceId: "ws_fixture",
  clientToken: "client-token",
  hostToken: "host-token",
}

const unavailableCommandStore: RemoteSessionCommandStore = {
  enqueue: async () => { throw new Error("command store not stubbed for this test") },
  claim: async () => { throw new Error("command store not stubbed for this test") },
  complete: async () => { throw new Error("command store not stubbed for this test") },
  get: async () => { throw new Error("command store not stubbed for this test") },
  listPendingForRunner: async () => { throw new Error("command store not stubbed for this test") },
}

const inactiveDesktopDeps = {
  commandStore: unavailableCommandStore,
  desktopPresence: async () => ({ connected: false, ownerMemberId: null }),
}

function readyDeps(client: Partial<RemoteSessionThreadClient>): RemoteSessionExecuteDeps {
  const failing = () => {
    throw new Error("client method not stubbed for this test")
  }
  return {
    ...inactiveDesktopDeps,
    getOpenWorkWebAccess: async () => ({ hasAccess: true }),
    resolveRuntime: async () => ({ ok: true, runtime: RUNTIME }),
    createClient: () => ({
      createThread: client.createThread ?? failing,
      sendTurn: client.sendTurn ?? failing,
      getThreadSnapshot: client.getThreadSnapshot ?? failing,
    }),
  }
}

function payload(result: RemoteSessionToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

const ORGANIZATION_ID = createDenTypeId("organization")

function executeInput(action: "create" | "send" | "read", body: unknown, hasWriteScope = true) {
  return {
    action,
    organizationId: ORGANIZATION_ID,
    userId: "user_fixture",
    hasWriteScope,
    body,
  }
}

test("capability names parse for exactly the three actions", () => {
  expect(parseRemoteSessionCapabilityName("remote-session:create")).toBe("create")
  expect(parseRemoteSessionCapabilityName("remote-session:send")).toBe("send")
  expect(parseRemoteSessionCapabilityName("remote-session:read")).toBe("read")
  expect(parseRemoteSessionCapabilityName("remote-session:delete")).toBeNull()
  expect(parseRemoteSessionCapabilityName("remote-session:")).toBeNull()
  expect(parseRemoteSessionCapabilityName("mcp:conn:tool")).toBeNull()
  expect(parseRemoteSessionCapabilityName("createRemoteSession")).toBeNull()
})

test("search finds the capabilities with executable shape metadata", () => {
  const matches = searchRemoteSessionCapabilities("create a remote session on the web", 10)
  expect(matches.length).toBeGreaterThan(0)
  const create = matches.find((match) => match.name === "remote-session:create")
  expect(create).toBeDefined()
  expect(create?.hasBody).toBe(true)
  expect(create?.invocation).toEqual({ argumentsField: "body" })
  expect(create?.kind).toBe("remote_session")
  expect(create?.argumentsSchema).toBeDefined()
  expect(create?.argumentsSchema).toMatchObject({
    properties: { title: { type: "string", maxLength: 120 } },
  })

  expect(searchRemoteSessionCapabilities("", 10)).toEqual([])
  expect(searchRemoteSessionCapabilities("unrelated zebra taxonomy", 10)).toEqual([])
})

test("task phrasings route to remote-session:create first", () => {
  for (const query of [
    "run slack search for messages on the remote session",
    "do this in the web",
    "hand this task off to the cloud",
  ]) {
    expect(searchRemoteSessionCapabilities(query, 10)[0]?.name).toBe("remote-session:create")
  }
})

test("create returns the native session identifiers", async () => {
  const result = await executeRemoteSessionCapability(
    executeInput("create", { title: "Handoff", prompt: "Summarize the repo" }),
    readyDeps({
      createThread: async (input) => {
        expect(input.title).toBe("Handoff")
        expect(input.prompt).toBe("Summarize the repo")
        return {
          id: "ses_native_1",
          workspaceId: "ws_fixture",
          title: "Handoff",
          directory: null,
          createdAt: 1,
          started: true,
        }
      },
    }),
  )
  expect(result.isError).toBeUndefined()
  const body = payload(result)
  expect(body.sessionId).toBe("ses_native_1")
  expect(body.workspaceId).toBe("ws_fixture")
  expect(body.workerId).toBe("worker_fixture")
  expect(body.target).toBe("cloud")
  expect(body.started).toBe(true)
})

test("create reports an offline desktop target with an actionable error", async () => {
  const result = await executeRemoteSessionCapability(
    executeInput("create", { target: "desktop" }),
    readyDeps({}),
  )
  expect(result.isError).toBe(true)
  expect(payload(result).error).toBe("desktop_offline")
})

test("cloud thread creation requires Web access before the runtime is resolved", async () => {
  let runtimeResolutions = 0
  const result = await executeRemoteSessionCapability(
    executeInput("create", { title: "Paid boundary" }),
    {
      ...inactiveDesktopDeps,
      getOpenWorkWebAccess: async () => ({ hasAccess: false }),
      resolveRuntime: async () => {
        runtimeResolutions += 1
        return { ok: true, runtime: RUNTIME }
      },
      createClient: () => {
        throw new Error("the Cloud client must not be created without Web access")
      },
    },
  )

  expect(result.isError).toBe(true)
  expect(payload(result)).toMatchObject({
    error: "openwork_web_access_required",
    retryable: false,
  })
  expect(runtimeResolutions).toBe(0)
})

test("desktop session queuing requires Web access before presence is probed or a command is queued", async () => {
  // Remote control of a connected desktop is an execution boundary, not a
  // read; without Web access it must neither observe presence nor enqueue.
  let presenceProbes = 0
  let enqueued = 0
  const result = await executeRemoteSessionCapability(
    executeInput("create", { target: "desktop", title: "Paid boundary" }),
    {
      ...readyDeps({}),
      getOpenWorkWebAccess: async () => ({ hasAccess: false }),
      desktopPresence: async () => {
        presenceProbes += 1
        return { connected: true, ownerMemberId: "member_fixture" }
      },
      commandStore: {
        ...unavailableCommandStore,
        enqueue: async () => {
          enqueued += 1
          throw new Error("a desktop command must not be queued without Web access")
        },
      },
    },
  )

  expect(result.isError).toBe(true)
  expect(payload(result)).toMatchObject({
    error: "openwork_web_access_required",
    retryable: false,
  })
  expect(presenceProbes).toBe(0)
  expect(enqueued).toBe(0)
})

test("create rejects titles longer than the desktop assignment limit", async () => {
  const result = await executeRemoteSessionCapability(
    executeInput("create", { target: "desktop", title: "x".repeat(121) }),
    readyDeps({}),
  )
  expect(result.isError).toBe(true)
  expect(payload(result).error).toBe("invalid_capability_arguments")
})

test("create and send require the write scope; read does not", async () => {
  const create = await executeRemoteSessionCapability(executeInput("create", {}, false), readyDeps({}))
  expect(create.isError).toBe(true)
  expect(payload(create).error).toBe("insufficient_mcp_scope")

  const send = await executeRemoteSessionCapability(
    executeInput("send", { sessionId: "ses_1", prompt: "hi" }, false),
    readyDeps({}),
  )
  expect(send.isError).toBe(true)
  expect(payload(send).error).toBe("insufficient_mcp_scope")

  const read = await executeRemoteSessionCapability(
    executeInput("read", { sessionId: "ses_1" }, false),
    readyDeps({
      getThreadSnapshot: async () => ({
        threadId: "ses_1",
        title: "t",
        directory: null,
        status: { type: "idle" },
        messages: [],
        todos: [],
      }),
    }),
  )
  expect(read.isError).toBeUndefined()
})

test("send returns an acceptance receipt without waiting for the reply", async () => {
  const result = await executeRemoteSessionCapability(
    executeInput("send", { sessionId: "ses_native_1", prompt: "Do the thing" }),
    readyDeps({
      sendTurn: async (threadId, input) => {
        expect(threadId).toBe("ses_native_1")
        expect(input.prompt).toBe("Do the thing")
        return {
          threadId,
          acceptedAt: 2,
          messageCountBefore: 3,
          messageId: "msg_accept_1",
          alreadyPresent: false,
        }
      },
    }),
  )
  expect(result.isError).toBeUndefined()
  const body = payload(result)
  expect(body.state).toBe("accepted")
  expect(body.messageId).toBe("msg_accept_1")
  expect(body.alreadyPresent).toBe(false)
})

test("read returns status and a bounded transcript slice", async () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    id: `msg_${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    parentId: null,
    createdAt: index,
    error: null,
    usage: null,
    parts: [{ id: `part_${index}`, type: "text", text: `message ${index}` }],
  }))
  const result = await executeRemoteSessionCapability(
    executeInput("read", { sessionId: "ses_native_1", limit: 5 }),
    readyDeps({
      getThreadSnapshot: async () => ({
        threadId: "ses_native_1",
        title: "Handoff",
        directory: null,
        status: { type: "idle" },
        messages,
        todos: [],
      }),
    }),
  )
  expect(result.isError).toBeUndefined()
  const body = payload(result)
  expect(body.status).toBe("idle")
  expect(body.messageCount).toBe(30)
  expect(Array.isArray(body.messages)).toBe(true)
  expect((body.messages as unknown[]).length).toBe(5)
  expect(body.finalAssistantText).toBe("message 29")
})

test("a missing session maps to unknown_session", async () => {
  const result = await executeRemoteSessionCapability(
    executeInput("read", { sessionId: "ses_gone" }),
    readyDeps({
      getThreadSnapshot: async () => {
        throw new HeadlessThreadError({
          code: "http_error",
          message: "not found",
          method: "GET",
          path: "/workspace/ws_1/opencode/session/ses_gone",
          status: 404,
        })
      },
    }),
  )
  expect(result.isError).toBe(true)
  const body = payload(result)
  expect(body.error).toBe("unknown_session")
  expect(body.retryable).toBe(false)
})

test("engine startup retries only a rejected create, not a partially created session", async () => {
  for (const path of ["/workspace/ws_1/opencode/session", "/workspace/ws_1/opencode/session/ses_created/prompt_async"]) {
    const result = await executeRemoteSessionCapability(
      executeInput("create", { prompt: "Say hi" }),
      readyDeps({
        createThread: async () => {
          throw new HeadlessThreadError({
            code: "opencode_unconfigured",
            message: "OpenCode base URL is missing for this workspace",
            method: "POST",
            path,
            status: 400,
          })
        },
      }),
    )
    const canRetry = path.endsWith("/opencode/session")
    expect(result.isError).toBe(true)
    expect(payload(result).error).toBe(canRetry ? "cloud_runtime_waking" : "remote_session_request_failed")
    expect(payload(result).retryable).toBe(canRetry)
    expect(payload(result).retryAfterMs).toBe(canRetry ? 30_000 : undefined)
  }
})

test("a waking runtime is reported as retryable without touching the client", async () => {
  const result = await executeRemoteSessionCapability(
    executeInput("create", {}),
    {
      ...inactiveDesktopDeps,
      getOpenWorkWebAccess: async () => ({ hasAccess: true }),
      resolveRuntime: async () => ({
        ok: false,
        error: "cloud_runtime_waking",
        message: "Your OpenWork Cloud workspace is still starting.",
        retryable: true,
      }),
      createClient: () => {
        throw new Error("createClient must not be called when the runtime is not ready")
      },
    },
  )
  expect(result.isError).toBe(true)
  const body = payload(result)
  expect(body.error).toBe("cloud_runtime_waking")
  expect(body.retryable).toBe(true)
})

test("remote sessions route workspace discovery only to the signed preview", async () => {
  const access: CloudWorkerAccess = {
    workerId: createDenTypeId("worker"),
    url: "https://fresh.preview.example.test",
    expiresAt: new Date("2026-08-27T12:00:00.000Z"),
    clientToken: "client-token",
    hostToken: "host-token",
  }
  const requested: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    requested.push(String(input))
    expect(init?.redirect).toBe("error")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer client-token")
    expect(new Headers(init?.headers).get("x-openwork-host-token")).toBe("host-token")
    return Response.json({ activeId: "workspace-signed-preview" })
  }

  const workspace = await resolveRemoteSessionWorkspace(access, fetchImpl)

  expect(workspace).toEqual({
    baseUrl: "https://fresh.preview.example.test",
    workspaceId: "workspace-signed-preview",
  })
  expect(requested).toEqual(["https://fresh.preview.example.test/workspaces"])
})

test("an unreachable healthy runtime is retryable and is not mislabeled as waking", async () => {
  const result = await executeRemoteSessionCapability(
    executeInput("create", {}),
    {
      ...inactiveDesktopDeps,
      getOpenWorkWebAccess: async () => ({ hasAccess: true }),
      resolveRuntime: async () => ({
        ok: false,
        error: "cloud_runtime_unreachable",
        message: "The healthy runtime transport is unreachable.",
        retryable: true,
      }),
      createClient: () => {
        throw new Error("createClient must not be called when transport is unreachable")
      },
    },
  )

  expect(result.isError).toBe(true)
  expect(payload(result)).toMatchObject({ error: "cloud_runtime_unreachable", retryable: true })
  expect(payload(result).error).not.toBe("cloud_runtime_waking")
})

test("a member without a cloud workspace gets the needs-setup action", async () => {
  const result = await executeRemoteSessionCapability(
    executeInput("create", {}),
    {
      ...inactiveDesktopDeps,
      getOpenWorkWebAccess: async () => ({ hasAccess: true }),
      resolveRuntime: async () => ({
        ok: false,
        error: "needs_cloud_setup",
        message: "No OpenWork Cloud workspace is available for your account yet.",
        retryable: false,
      }),
      createClient: () => {
        throw new Error("createClient must not be called when the runtime is not ready")
      },
    },
  )
  expect(result.isError).toBe(true)
  expect(payload(result).error).toBe("needs_cloud_setup")
})

test("invalid arguments are rejected with issue paths", async () => {
  const result = await executeRemoteSessionCapability(
    executeInput("send", { prompt: "missing session id" }),
    readyDeps({}),
  )
  expect(result.isError).toBe(true)
  const body = payload(result)
  expect(body.error).toBe("invalid_capability_arguments")
  const issues = body.issues as { path: string }[]
  expect(issues.some((issue) => issue.path === "sessionId")).toBe(true)
})

test("capability names round-trip through the registry parser", async () => {
  const { CAPABILITY_SOURCES } = await import("../src/mcp/capability-registry.js")
  const source = CAPABILITY_SOURCES.remoteSession
  for (const action of ["create", "send", "read"] as const) {
    const name = remoteSessionCapabilityName(action)
    expect(source.parseName(name)).toEqual({ kind: "remoteSession", name, action })
  }
  expect(source.parseName("remote-session:unknown")).toBeNull()
  // Other sources must not claim remote-session names.
  expect(CAPABILITY_SOURCES.catalog.parseName("remote-session:create")).toBeNull()
  expect(CAPABILITY_SOURCES.externalMcp.parseName("remote-session:create")).toBeNull()
  expect(CAPABILITY_SOURCES.marketplace.parseName("remote-session:create")).toBeNull()
})

async function registryContext(input: { remoteSessionsEnabled: boolean }) {
  const registry = await import("../src/mcp/capability-registry.js")
  const { createDenTypeId: createId } = await import("@openwork-ee/utils/typeid")
  const { Hono } = await import("hono")
  const organizationId = createId("organization")
  type SearchContext = Parameters<(typeof registry)["CAPABILITY_SOURCES"]["remoteSession"]["search"]>[0]
  const context: SearchContext = {
    app: new Hono(),
    env: undefined,
    catalog: [],
    principal: {
      userId: createId("user"),
      organizationId,
      scopes: new Set(["mcp:read", "mcp:write"]),
      payload: {},
    },
    organizationId,
    member: { orgMembershipId: createId("member"), teamIds: [] },
    redirectUriBase: "http://127.0.0.1:8790",
    generatedArtifactViewsEnabled: false,
    externalMcpConnectionsEnabled: true,
    remoteSessionsEnabled: input.remoteSessionsEnabled,
    resolvePlatformAdmin: () => Promise.resolve(false),
    resolveNamespaceContext: () => Promise.resolve({
      nativeProviderEntries: [],
      externalMcpConnections: [],
      codemodeNativeProviderEntries: [],
      codemodeExternalMcpConnections: [],
      namespaces: { native: new Map(), externalMcp: new Map() },
    }),
    sourceFilter: { api: true, admin: true, mcp: true, marketplace: true, skills: true },
    reportExternalCoverage: () => {},
  }
  return { registry, context }
}

test("a deployment that cannot host Cloud never discovers remote-session capabilities", async () => {
  const { registry, context } = await registryContext({ remoteSessionsEnabled: false })
  const source = registry.CAPABILITY_SOURCES.remoteSession
  const matches = await source.search(context, "remote session cloud web", 10)
  expect(matches).toEqual([])

  const executed = await source.execute(
    context,
    { kind: "remoteSession", name: "remote-session:create", action: "create" },
    { name: "remote-session:create", body: {} },
  )
  expect(executed.isError).toBe(true)
  const text = executed.content.find((part) => part.type === "text")
  expect(text?.type === "text" ? text.text : "").toContain("unknown_capability")
})

test("a hosted Cloud deployment discovers remote-session capabilities for every organization", async () => {
  const { registry, context } = await registryContext({ remoteSessionsEnabled: true })
  const source = registry.CAPABILITY_SOURCES.remoteSession
  const matches = await source.search(context, "remote session cloud web", 10)
  expect(matches.map((match) => match.name)).toContain("remote-session:create")
})
