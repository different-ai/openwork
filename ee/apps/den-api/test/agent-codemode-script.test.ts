import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
}

const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
let organizationMetadata: Record<string, unknown> | null = null
let selectCount = 0
let registerAgentMcpRoutes: typeof import("../src/mcp/agent.js")["registerAgentMcpRoutes"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function installMocks() {
  mock.module("../src/db.js", () => ({
    db: {
      insert: () => ({
        values: () => ({
          execute: () => Promise.resolve(),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              selectCount += 1
              return Promise.resolve(selectCount % 2 === 1 ? [] : [{ metadata: organizationMetadata }])
            },
          }),
        }),
      }),
      transaction: () => Promise.resolve(null),
    },
  }))
  mock.module("../src/mcp/auth.js", () => ({
    getMcpResourceContext: (_request: Request, _route: string, requestId?: string) => ({
      route: "agent",
      resourceUrl: "http://127.0.0.1:8790/mcp/agent",
      metadataUrl: "http://127.0.0.1:8790/.well-known/oauth-protected-resource/mcp/agent",
      oauthResources: ["http://127.0.0.1:8790/mcp/agent"],
      firstPartyResources: [],
      requestId,
    }),
    verifyMcpRequest: () => Promise.resolve({
      userId,
      organizationId,
      scopes: new Set(["mcp:read", "mcp:write"]),
      payload: {},
    }),
  }))
}

function buildApp() {
  const app = new Hono<{ Variables: { requestId: string } }>()
  app.use("*", async (c, next) => {
    c.set("requestId", "req_codemode")
    await next()
  })
  app.get("/openapi.json", (c) => c.json({
    paths: {
      "/v1/workers": {
        get: {
          operationId: "getV1Workers",
          summary: "List workers",
          tags: ["Workers"],
        },
      },
      "/v1/workflows": {
        post: {
          operationId: "saveWorkflow",
          summary: "Save a successful Code Mode run as a Workflow inside an OpenWork Connect Plugin",
          tags: ["Workflows"],
        },
      },
    },
  }))
  registerAgentMcpRoutes(app)
  return app
}

async function rpc(app: ReturnType<typeof buildApp>, method: string, params: Record<string, unknown> = {}) {
  selectCount = 0
  const response = await app.request("http://127.0.0.1:8790/mcp/agent", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  expect(response.status).toBe(200)
  const body = await response.text()
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "))
  const payload: unknown = JSON.parse(dataLine?.slice("data: ".length) ?? body)
  if (!isRecord(payload)) throw new Error("Expected JSON-RPC object response")
  return payload
}

function resultRecord(payload: Record<string, unknown>) {
  if (!isRecord(payload.result)) throw new Error("Expected JSON-RPC result")
  return payload.result
}

function errorRecord(payload: Record<string, unknown>) {
  if (!isRecord(payload.error)) throw new Error("Expected JSON-RPC error")
  return payload.error
}

function listedToolNames(payload: Record<string, unknown>): string[] {
  const tools = resultRecord(payload).tools
  if (!Array.isArray(tools)) throw new Error("Expected MCP tools list")
  return tools.flatMap((tool) => isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [])
}

function firstText(payload: Record<string, unknown>): string {
  const content = resultRecord(payload).content
  if (!Array.isArray(content)) throw new Error("Expected MCP tool content")
  const text = content.find((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
  if (!isRecord(text) || typeof text.text !== "string") throw new Error("Expected text tool result")
  return text.text
}

beforeAll(async () => {
  seedRequiredEnv()
  installMocks()
  registerAgentMcpRoutes = (await import("../src/mcp/agent.js")).registerAgentMcpRoutes
})

beforeEach(() => {
  organizationMetadata = null
  selectCount = 0
})

afterAll(() => {
  mock.restore()
})

test("registers execute_capability_script without any org rollout flag", async () => {
  const tools = listedToolNames(await rpc(buildApp(), "tools/list"))
  expect(tools).toContain("execute_capability_script")
  expect(tools).not.toContain("save_artifact_view")
  expect(tools).not.toContain("activate_artifact_view_revision")
  expect(tools).not.toContain("retire_artifact_view")
})

test("registers Code Mode without enabling agent-authored MCP App views", async () => {
  const names = listedToolNames(await rpc(buildApp(), "tools/list"))
  expect(names).toContain("execute_capability_script")
  expect(names).toContain("render_workflow_artifact")
  expect(names).toContain("render_dynamic_artifact")
  expect(names).not.toContain("save_artifact_view")
  expect(names).not.toContain("activate_artifact_view_revision")
  expect(names).not.toContain("retire_artifact_view")
  expect(names.filter((name) => /^(search|select|clear)_programs?$|^(run|render)_selected_program$/.test(name))).toEqual([])
})

test("rejects guessed generated-view tool calls while keeping Workflows enabled", async () => {
  for (const name of ["save_artifact_view", "activate_artifact_view_revision", "retire_artifact_view"]) {
    const payload = await rpc(buildApp(), "tools/call", { name, arguments: {} })
    expect(errorRecord(payload)).toMatchObject({ code: -32602, message: expect.stringContaining("not found") })
  }
})

test("advertises standard Workflow discovery and execution instructions", async () => {
  const initialized = resultRecord(await rpc(buildApp(), "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "agent-codemode-test", version: "1.0.0" },
  }))
  expect(initialized.instructions).toContain("Workflows are saved procedures discovered through search_capabilities")
  expect(initialized.instructions).toContain("run through execute_capability using the exact capability name returned by search")
  expect(initialized.instructions).toContain("Workflow runs produce artifacts rendered by render_workflow_artifact")
  expect(initialized.instructions).not.toContain("search/selection tools")
})

test("executes a confined script by default", async () => {
  const payload = await rpc(buildApp(), "tools/call", {
    name: "execute_capability_script",
    arguments: { code: "return 1 + 1" },
  })
  expect(firstText(payload)).toBe("2")
})

test("normalizes JSON-encoded script input", async () => {
  const payload = await rpc(buildApp(), "tools/call", {
    name: "execute_capability_script",
    arguments: {
      code: "return { t: typeof input, v: input.channel }",
      input: "{\"channel\":\"bug\"}",
    },
  })
  expect(JSON.parse(firstText(payload))).toEqual({ t: "object", v: "bug" })
})

test("keeps object script input unchanged", async () => {
  const payload = await rpc(buildApp(), "tools/call", {
    name: "execute_capability_script",
    arguments: {
      code: "return { t: typeof input, v: input.channel }",
      input: { channel: "bug" },
    },
  })
  expect(JSON.parse(firstText(payload))).toEqual({ t: "object", v: "bug" })
})

test("exposes in-program capability search over the Den namespace", async () => {
  const payload = await rpc(buildApp(), "tools/call", {
    name: "execute_capability_script",
    arguments: { code: "return await tools.$codemode.search({ query: \"workers\" })" },
  })
  expect(firstText(payload)).toContain("tools.den.getWorkers")
})

test("makes the Workflow save operation discoverable through the standard capability catalog", async () => {
  const payload = await rpc(buildApp(), "tools/call", {
    name: "search_capabilities",
    arguments: { query: "save Workflow to Plugin" },
  })
  expect(firstText(payload)).toContain("saveWorkflow")
})
