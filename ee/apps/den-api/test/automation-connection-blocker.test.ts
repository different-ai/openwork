/**
 * An Automation run whose agent was told a connection must be connected or
 * reconnected fails and names the connection, instead of reading as a success
 * with the problem buried in its transcript. The payloads below mirror what
 * `execute_capability` returns (external-capabilities.ts buildExternalConnectionStatus,
 * wrapped by capability-registry.ts externalCapabilityErrorToolResult).
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { connectionBlockerFromToolCalls, connectionBlockerFromToolResult } from "@openwork/headless-threads"
import { AUTOMATION_CLOUD_DEFAULT_MODEL } from "@openwork/types/automations"
import { createHeadlessRunnerClient } from "../../../packages/headless-protocol/src/client.ts"

// Importing these modules never touches the database; the values only satisfy env validation.
for (const [name, value] of Object.entries({
  OPENWORK_DEV_MODE: "1",
  DB_MODE: "mysql",
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den",
  DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
  BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!",
  BETTER_AUTH_URL: "http://localhost:8790",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

const { executeHeadlessAgent } = await import("../src/automations/headless-agent-executor.ts")

const connectionsUrl = "http://localhost:8790/dashboard/your-connections?connectionId=mcp_gmail"

function reconnectStatus(state: "needs_connection" | "reauth_required" = "reauth_required") {
  return {
    version: 1,
    kind: "connection_action",
    source: "openwork-cloud",
    layer: "mcp_connection",
    connectionId: "mcp_gmail",
    connectionName: "Gmail",
    authType: "oauth",
    credentialMode: "per_member",
    state,
    errorCode: state === "needs_connection" ? "not_connected" : "invalid_grant",
    message: "Gmail rejected the saved sign-in.",
    actor: "member",
    action: {
      type: state === "needs_connection" ? "connect" : "reconnect",
      label: `${state === "needs_connection" ? "Connect" : "Reconnect"} Gmail`,
      surface: "openwork_your_connections",
      retry: "search_capabilities",
      url: connectionsUrl,
    },
  }
}

/** The text an agent reads when `execute_capability` hits the connection. */
function failedCallText(state?: "needs_connection" | "reauth_required"): string {
  return JSON.stringify({
    error: "connection_required",
    message: "Gmail needs to be reconnected.",
    connectionStatus: reconnectStatus(state),
    connectionCard: "Execute \"mcp_gmail:*\" once to show the member an actionable connection card, then relay the action in text.",
  })
}

test("a failed capability call that needs a reconnect names the connection", () => {
  const blocker = connectionBlockerFromToolResult(failedCallText())
  assert.equal(blocker?.connectionId, "mcp_gmail")
  assert.equal(blocker?.connectionName, "Gmail")
  assert.equal(blocker?.state, "reauth_required")
  assert.equal("actionUrl" in (blocker ?? {}), false, "links are built from the id, never taken from a tool result")

  // The engine may wrap the result in its own error message.
  assert.equal(connectionBlockerFromToolResult(`MCP error -32000: ${failedCallText("needs_connection")}`)?.state, "needs_connection")
})

test("only a connection the agent tried to use counts", () => {
  // Search lists every connection's status; that is what exists, not what failed.
  const search = JSON.stringify({ matches: [{ name: "mcp_gmail:*", kind: "connection_status", connectionStatus: reconnectStatus() }] })
  assert.equal(connectionBlockerFromToolResult(search), null)
  // A healthy connection card, a provider outage and look-alike JSON from another tool are not blockers.
  assert.equal(connectionBlockerFromToolResult(JSON.stringify({ schemaVersion: "1", connectionId: "c", connectionName: "Gmail", state: "connected" })), null)
  assert.equal(connectionBlockerFromToolResult(JSON.stringify({ connectionStatus: { ...reconnectStatus(), state: "provider_error" } })), null)
  assert.equal(connectionBlockerFromToolResult(JSON.stringify({ connectionId: "c", connectionName: "Gmail", state: "reauth_required" })), null)
  assert.equal(connectionBlockerFromToolCalls([{ name: "bash", output: "ok" }, { name: "openwork-cloud_execute_capability", error: failedCallText() }])?.connectionName, "Gmail")
})

function headlessRun(toolOutput: string) {
  const turns: string[] = []
  const runnerFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? "GET"
    if (method === "POST" && url.pathname === "/v1/sessions") return Response.json({ id: "hs_connection_blocker" }, { status: 201 })
    if (method === "POST" && url.pathname.endsWith("/turns")) {
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
      if (typeof body === "object" && body && "messageId" in body && typeof body.messageId === "string") turns.push(body.messageId)
      return Response.json({ state: "accepted" }, { status: 202 })
    }
    const messageId = url.searchParams.get("messageId") ?? ""
    if (!turns.includes(messageId)) return Response.json({ turns: [], messages: [], finalAssistantText: "" })
    return Response.json({
      turns: [{ messageId, status: "completed", error: null, model: "gateway/member-model" }],
      messages: [
        { role: "assistant", messageId, text: "", toolCalls: [{ id: "call_1", name: "openwork-cloud_execute_capability", input: { name: "mcp_gmail:send" } }] },
        { role: "tool", messageId, callId: "call_1", name: "openwork-cloud_execute_capability", output: toolOutput, isError: true },
        { role: "assistant", messageId, text: "I could not send the summary because Gmail needs to be reconnected.", toolCalls: [] },
      ],
      finalAssistantText: "I could not send the summary because Gmail needs to be reconnected.",
    })
  }
  const deps = {
    config: { url: "http://runner", token: "r".repeat(40) },
    fetch: runnerFetch,
    mintToken: async () => ({ token: "ow_mcp_at_unit" }),
    maxTokenTtlMs: 3_600_000,
  }
  return executeHeadlessAgent({
    organizationId: "org_1",
    ownerMemberId: "mem_1",
    automationRunId: "run_connection_blocker",
    automationName: "Daily summary",
    action: { kind: "agent", instructions: "Email me a summary.", model: AUTOMATION_CLOUD_DEFAULT_MODEL },
    maximumRuntimeMs: 60_000,
    previousReceipt: null,
    signal: new AbortController().signal,
    onAdmitted: async () => {},
  }, {
    client: createHeadlessRunnerClient(deps),
    ownerUserId: async () => "usr_1",
    stillHeadless: async () => true,
    cloudModel: async () => "gateway/member-model",
    gatewayCatalog: async () => ({ defaultModel: "gateway/member-model", models: [{ id: "gateway/member-model", name: "Member model" }] }),
    stepTurns: async () => false,
    sleep: async () => {},
    pollIntervalMs: 0,
  })
}

test("a cloud run that could not use a connection fails, keeps the agent's answer, and says what to fix", async () => {
  const result = await headlessRun(failedCallText())
  assert.equal(result.ok, false, JSON.stringify(result))
  if (result.ok) return
  assert.equal(result.status, "failed")
  assert.equal(result.code, "connection_action_required")
  assert.equal(result.retryable, false)
  assert.notEqual(result.needsAttention, true, "the Automation keeps its schedule; only this run failed")
  assert.match(result.message, /Reconnect Gmail in OpenWork/)
  assert.equal(result.resultSummary, "I could not send the summary because Gmail needs to be reconnected.")
  const warning = result.events?.find((event) => event.type === "warning")
  assert.equal(warning?.payload.code, "connection_action_required")
  assert.equal(warning?.payload.connectionName, "Gmail")
  assert.equal(warning?.payload.connectionId, "mcp_gmail")
  assert.equal(result.events?.at(-1)?.type, "terminal")
})

test("a cloud run whose tools all worked still succeeds", async () => {
  const result = await headlessRun(JSON.stringify({ ok: true, messageId: "gmail_123" }))
  assert.equal(result.ok, true, JSON.stringify(result))
})
