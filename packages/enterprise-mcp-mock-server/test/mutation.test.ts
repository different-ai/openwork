import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import {
  createDefaultScenario,
  createEnterpriseMcpMockServer,
  createFaultScenario,
  probeEnterpriseMcpMockServer,
  scenarioSchema,
} from "../src/index.js"
import { authorizeManual, callRpc, initializeSession, sessionHeaders } from "./wire-client.js"

const oauthClientSecret = "synthetic-test-client-secret-32-bytes"
const toolResultSchema = z.object({
  isError: z.boolean(),
  structuredContent: z.unknown().optional(),
})
const toolErrorSchema = z.object({
  error: z.object({ code: z.string() }),
})

test("mutations require approval and enforce idempotent duplicate versus conflicting arguments", async () => {
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const token = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const session = await initializeSession(server.baseUrl, scenario, token)
    const denied = await callRpc(server.baseUrl, scenario, session, 10, "tools/call", {
      name: "create_incident",
      arguments: {
        short_description: "Synthetic denied mutation",
        idempotency_key: "mutation-key-denied",
        approved: false,
      },
    })
    const deniedResult = toolResultSchema.parse(denied.envelope.result)
    assert.equal(deniedResult.isError, true)
    assert.equal(toolErrorSchema.parse(deniedResult.structuredContent).error.code, "MOCK_APPROVAL_REQUIRED")

    const argumentsValue = {
      short_description: "Synthetic approved mutation",
      idempotency_key: "mutation-key-approved",
      approved: true,
    }
    const first = await callRpc(server.baseUrl, scenario, session, 11, "tools/call", {
      name: "create_incident",
      arguments: argumentsValue,
    })
    assert.equal(toolResultSchema.parse(first.envelope.result).isError, false)
    assert.equal(server.snapshot().counts.operations, 1)

    const duplicate = await callRpc(server.baseUrl, scenario, session, 12, "tools/call", {
      name: "create_incident",
      arguments: argumentsValue,
    })
    assert.equal(toolResultSchema.parse(duplicate.envelope.result).isError, false)
    assert.equal(server.snapshot().counts.operations, 1)

    const reorderedDuplicate = await callRpc(server.baseUrl, scenario, session, 14, "tools/call", {
      name: "create_incident",
      arguments: {
        approved: true,
        idempotency_key: "mutation-key-approved",
        short_description: "Synthetic approved mutation",
      },
    })
    assert.equal(toolResultSchema.parse(reorderedDuplicate.envelope.result).isError, false)
    assert.equal(server.snapshot().counts.operations, 1)

    const conflict = await callRpc(server.baseUrl, scenario, session, 13, "tools/call", {
      name: "create_incident",
      arguments: { ...argumentsValue, short_description: "Different mutation with reused key" },
    })
    const conflictResult = toolResultSchema.parse(conflict.envelope.result)
    assert.equal(conflictResult.isError, true)
    assert.equal(toolErrorSchema.parse(conflictResult.structuredContent).error.code, "IDEMPOTENCY_CONFLICT")
    assert.equal(server.snapshot().counts.operations, 1)
  } finally {
    await server.stop()
  }
})

test("timeout after commit remains indeterminate and requires reconciliation before replay", async () => {
  const base = createFaultScenario("servicenow-inbound-quickstart", "mutation-timeout-after-commit")
  const scenario = scenarioSchema.parse({
    ...base,
    activeFault: { id: "mutation-timeout-after-commit", trigger: { occurrence: "once" } },
  })
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const token = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const session = await initializeSession(server.baseUrl, scenario, token)
    const params = {
      name: "create_incident",
      arguments: {
        short_description: "Synthetic indeterminate mutation",
        idempotency_key: "mutation-key-indeterminate",
        approved: true,
      },
    }
    await assert.rejects(
      fetch(server.mcpUrl, {
        method: "POST",
        headers: sessionHeaders(server.baseUrl, token.accessToken, session.sessionId, session.protocolVersion),
        body: JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/call", params }),
      }),
    )
    assert.equal(server.snapshot().operations[0]?.state, "indeterminate")

    const replay = await callRpc(server.baseUrl, scenario, session, 21, "tools/call", params)
    const replayResult = toolResultSchema.parse(replay.envelope.result)
    assert.equal(replayResult.isError, true)
    assert.equal(toolErrorSchema.parse(replayResult.structuredContent).error.code, "MUTATION_RECONCILIATION_REQUIRED")
    assert.equal(server.snapshot().operations[0]?.state, "indeterminate")

    await server.stop()
    assert.equal(server.snapshot().operations[0]?.state, "indeterminate")
    await server.start()
    const restartedToken = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const restartedSession = await initializeSession(server.baseUrl, scenario, restartedToken)
    const replayAfterRestart = await callRpc(server.baseUrl, scenario, restartedSession, 22, "tools/call", params)
    const restartedResult = toolResultSchema.parse(replayAfterRestart.envelope.result)
    assert.equal(restartedResult.isError, true)
    assert.equal(toolErrorSchema.parse(restartedResult.structuredContent).error.code, "MUTATION_RECONCILIATION_REQUIRED")
  } finally {
    await server.stop()
  }
})

test("local mutation approval fails before a configured provider fault can be emitted", async () => {
  const scenario = createFaultScenario("servicenow-inbound-quickstart", "provider-authorization-denied")
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const token = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const session = await initializeSession(server.baseUrl, scenario, token)
    const denied = await callRpc(server.baseUrl, scenario, session, 50, "tools/call", {
      name: "create_incident",
      arguments: {
        short_description: "Must not reach provider",
        idempotency_key: "local-approval-first",
        approved: false,
      },
    })
    const result = toolResultSchema.parse(denied.envelope.result)
    assert.equal(toolErrorSchema.parse(result.structuredContent).error.code, "MOCK_APPROVAL_REQUIRED")
    assert.equal(server.events().some((event) => event.kind === "fault"), false)
  } finally {
    await server.stop()
  }
})

test("safe-read probe mode rejects an explicit mutation override before any operation is prepared", async () => {
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const result = await probeEnterpriseMcpMockServer({
      baseUrl: server.baseUrl,
      scenario,
      credentials: { clientSecret: oauthClientSecret },
      mode: "safe-read",
      callTool: {
        name: "create_incident",
        arguments: {
          short_description: "Must remain uncommitted",
          idempotency_key: "safe-read-mutation-rejected",
          approved: true,
        },
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.error?.phase, "CONFIGURATION")
    assert.equal(server.snapshot().counts.operations, 0)
  } finally {
    await server.stop()
  }
})
