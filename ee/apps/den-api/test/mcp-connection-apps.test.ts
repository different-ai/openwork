import { beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"

const API_ORIGIN = "http://127.0.0.1:8790"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
process.env.DB_MODE ??= "mysql"
process.env.DEN_DB_ENCRYPTION_KEY ??= "mcp-apps-test-encryption-key-1234567890"
process.env.BETTER_AUTH_SECRET ??= "mcp-apps-test-secret-1234567890123"
process.env.BETTER_AUTH_URL ??= API_ORIGIN
process.env.CORS_ORIGINS ??= API_ORIGIN

let connections: typeof import("../src/routes/org/mcp-connections.js")

beforeAll(async () => {
  connections = await import("../src/routes/org/mcp-connections.js")
})

// Dashboard elements must carry the exact reference names desktop entries use,
// mirroring `connectMcpAppHostName` in apps/server/src/connect-mcp-server-catalog.ts
// and `projectedMcpToolName` in apps/server/src/mcp-app-host.ts.
test("connect app-host server names mirror the desktop naming convention", () => {
  const connectionId = "emc_01dashboardfixture0000000000"
  const digest = createHash("sha256").update(connectionId).digest("hex").slice(0, 12)
  expect(connections.connectMcpAppHostServerName(connectionId)).toBe(`openwork-app-host-connect-${digest}`)
})

test("projected tool names sanitize like the desktop host", () => {
  expect(connections.projectedMcpToolName("openwork-app-host-connect-abc123", "render_report"))
    .toBe("openwork-app-host-connect-abc123_render_report")
  expect(connections.projectedMcpToolName("my server!", "tool.name"))
    .toBe("my_server__tool_name")
})

test("app visibility follows the app-host audience rule", () => {
  expect(connections.mcpToolVisibleToApp({})).toBe(true)
  expect(connections.mcpToolVisibleToApp({ _meta: { ui: { visibility: ["model", "app"] } } })).toBe(true)
  expect(connections.mcpToolVisibleToApp({ _meta: { ui: { visibility: ["app"] } } })).toBe(true)
  expect(connections.mcpToolVisibleToApp({ _meta: { ui: { visibility: ["model"] } } })).toBe(false)
  expect(connections.mcpToolVisibleToApp({ _meta: { ui: { visibility: ["model", "other"] } } })).toBe(false)
})

test("required launch input is detected from the input schema", () => {
  expect(connections.mcpToolRequiresInput({})).toBe(false)
  expect(connections.mcpToolRequiresInput({ inputSchema: { type: "object", required: [] } })).toBe(false)
  expect(connections.mcpToolRequiresInput({ inputSchema: { type: "object", required: ["query"] } })).toBe(true)
})

test("required launch-input keys are listed so authors can supply and Den can validate them", () => {
  expect(connections.mcpToolRequiredInputKeys({})).toEqual([])
  expect(connections.mcpToolRequiredInputKeys({ inputSchema: { type: "object", required: [] } })).toEqual([])
  expect(connections.mcpToolRequiredInputKeys({ inputSchema: { type: "object", required: ["cloudId", "pageId"] } }))
    .toEqual(["cloudId", "pageId"])
  // Non-string entries are provider schema noise, never keys an author can type.
  expect(connections.mcpToolRequiredInputKeys({ inputSchema: { type: "object", required: ["cloudId", 7, ""] } }))
    .toEqual(["cloudId"])
})
