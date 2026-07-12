import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import {
  createDefaultScenario,
  createEnterpriseMcpMockServer,
  createFaultScenario,
  getProviderProfile,
  scenarioSchema,
  toolInputSchemaSchema,
} from "../src/index.js"
import { authorizeManual, callRpc, initializeSession, rpcHeaders, sessionHeaders } from "./wire-client.js"

const oauthClientSecret = "synthetic-test-client-secret-32-bytes"
const errorEnvelopeSchema = z.object({ error: z.object({ code: z.number(), message: z.string() }) })

test("Origin is rejected before credentials and session binding prevents cross-token use or deletion", async () => {
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const hostileOrigin = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    assert.equal(hostileOrigin.status, 403)
    assert.equal(hostileOrigin.headers.get("www-authenticate"), null)

    const firstToken = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const secondToken = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const firstSession = await initializeSession(server.baseUrl, scenario, firstToken)
    const profile = getProviderProfile(scenario.profileId)
    const hijackHeaders = sessionHeaders(
      server.baseUrl,
      secondToken.accessToken,
      firstSession.sessionId,
      firstSession.protocolVersion,
    )
    const hijack = await fetch(new URL(profile.endpointPath, server.baseUrl), {
      method: "POST",
      headers: hijackHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    })
    assert.equal(hijack.status, 403)

    const foreignDelete = await fetch(new URL(profile.endpointPath, server.baseUrl), {
      method: "DELETE",
      headers: hijackHeaders,
    })
    assert.equal(foreignDelete.status, 403)
    assert.equal(server.snapshot().counts.sessions, 1)

    const ownDelete = await fetch(new URL(profile.endpointPath, server.baseUrl), {
      method: "DELETE",
      headers: sessionHeaders(
        server.baseUrl,
        firstToken.accessToken,
        firstSession.sessionId,
        firstSession.protocolVersion,
      ),
    })
    assert.equal(ownDelete.status, 204)
    assert.equal(server.snapshot().counts.sessions, 0)
  } finally {
    await server.stop()
  }
})

test("transport, JSON-RPC, protocol, and session validation stay precisely shaped", async () => {
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const profile = getProviderProfile(scenario.profileId)
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const token = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const plainText = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { ...rpcHeaders(server.baseUrl, token.accessToken), "content-type": "text/plain" },
      body: "not json",
    })
    assert.equal(plainText.status, 415)

    const jsonp = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { ...rpcHeaders(server.baseUrl, token.accessToken), "content-type": "application/jsonp" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    assert.equal(jsonp.status, 415)

    const malformed = await fetch(server.mcpUrl, {
      method: "POST",
      headers: rpcHeaders(server.baseUrl, token.accessToken),
      body: "{",
    })
    assert.equal(malformed.status, 200)
    const malformedValue: unknown = JSON.parse(await malformed.text())
    assert.equal(errorEnvelopeSchema.parse(malformedValue).error.code, -32700)

    const invalidRequest = await fetch(server.mcpUrl, {
      method: "POST",
      headers: rpcHeaders(server.baseUrl, token.accessToken),
      body: JSON.stringify({ hello: "world" }),
    })
    const invalidValue: unknown = JSON.parse(await invalidRequest.text())
    assert.equal(errorEnvelopeSchema.parse(invalidValue).error.code, -32600)

    const missingAccept = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
        origin: new URL(server.baseUrl).origin,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    assert.equal(missingAccept.status, 406)

    const nearMatchAccept = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        accept: "application/jsonp, text/event-streaming",
        "content-type": "application/json",
        origin: new URL(server.baseUrl).origin,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    assert.equal(nearMatchAccept.status, 406)

    const explicitlyRejectedRepresentations = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        accept: "application/json;q=0, text/event-stream;q=0",
        "content-type": "application/json",
        origin: new URL(server.baseUrl).origin,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    assert.equal(explicitlyRejectedRepresentations.status, 406)

    const lowercaseBearer = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { ...rpcHeaders(server.baseUrl, token.accessToken), authorization: `bearer ${token.accessToken}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 19,
        method: "initialize",
        params: { protocolVersion: scenario.protocol.version, capabilities: {}, clientInfo: { name: "wire-test", version: "1" } },
      }),
    })
    assert.equal(lowercaseBearer.status, 200)

    const missingCapabilities = await fetch(server.mcpUrl, {
      method: "POST",
      headers: rpcHeaders(server.baseUrl, token.accessToken),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 20,
        method: "initialize",
        params: { protocolVersion: "1900-01-01", clientInfo: { name: "wire-test", version: "1" } },
      }),
    })
    assert.equal(errorEnvelopeSchema.parse(JSON.parse(await missingCapabilities.text())).error.code, -32602)

    const downgraded = await fetch(server.mcpUrl, {
      method: "POST",
      headers: rpcHeaders(server.baseUrl, token.accessToken),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 21,
        method: "initialize",
        params: {
          protocolVersion: "1900-01-01",
          capabilities: {},
          clientInfo: { name: "wire-test", version: "1" },
        },
      }),
    })
    const downgradedEnvelope = z.object({
      result: z.object({ protocolVersion: z.string() }),
    }).parse(JSON.parse(await downgraded.text()))
    assert.equal(downgradedEnvelope.result.protocolVersion, scenario.protocol.version)
    assert.equal(downgraded.headers.get("mcp-protocol-version"), scenario.protocol.version)

    const session = await initializeSession(server.baseUrl, scenario, token)
    const missingSession = await fetch(server.mcpUrl, {
      method: "POST",
      headers: rpcHeaders(server.baseUrl, token.accessToken),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    })
    assert.equal(missingSession.status, 400)

    const wrongProtocol = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        ...sessionHeaders(server.baseUrl, token.accessToken, session.sessionId, "1900-01-01"),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    })
    assert.equal(wrongProtocol.status, 400)

    const unknown = await callRpc(server.baseUrl, scenario, session, 4, "unknown/method", {})
    assert.equal(unknown.envelope.error?.code, -32601)
    const invalidArguments = await callRpc(server.baseUrl, scenario, session, 5, "tools/call", {
      name: "get_incident",
      arguments: { number: 42, extra: true },
    })
    assert.equal(invalidArguments.envelope.error?.code, -32602)

    const initializedWithId = await fetch(server.mcpUrl, {
      method: "POST",
      headers: sessionHeaders(server.baseUrl, session.accessToken, session.sessionId, session.protocolVersion),
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "notifications/initialized" }),
    })
    assert.equal(initializedWithId.status, 200)
    assert.equal(errorEnvelopeSchema.parse(JSON.parse(await initializedWithId.text())).error.code, -32600)

    const unknownNotification = await fetch(server.mcpUrl, {
      method: "POST",
      headers: sessionHeaders(server.baseUrl, session.accessToken, session.sessionId, session.protocolVersion),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/synthetic-unknown" }),
    })
    assert.equal(unknownNotification.status, 202)
    assert.equal(await unknownNotification.text(), "")

    const clientResponse = await fetch(server.mcpUrl, {
      method: "POST",
      headers: sessionHeaders(server.baseUrl, session.accessToken, session.sessionId, session.protocolVersion),
      body: JSON.stringify({ jsonrpc: "2.0", id: 91, result: { accepted: true } }),
    })
    assert.equal(clientResponse.status, 202)
    assert.equal(await clientResponse.text(), "")

    const badCursor = await callRpc(server.baseUrl, scenario, session, 7, "tools/list", { cursor: "page:1junk" })
    assert.equal(badCursor.envelope.error?.code, -32602)

    const oversized = "x".repeat(1024 * 1024 + 1)
    const oversizedResponse = await fetch(new URL(profile.endpointPath, server.baseUrl), {
      method: "POST",
      headers: rpcHeaders(server.baseUrl, token.accessToken),
      body: oversized,
    })
    assert.equal(oversizedResponse.status, 413)
  } finally {
    await server.stop()
  }
})

test("tool results mirror structured content for legacy clients and keep the synthetic profile vendor-neutral", async () => {
  const base = createDefaultScenario("synthetic-enterprise-oauth-mcp")
  const scenario = scenarioSchema.parse({ ...base, oauth: { ...base.oauth, registration: "manual" } })
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const token = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const session = await initializeSession(server.baseUrl, scenario, token)
    const call = await callRpc(server.baseUrl, scenario, session, 30, "tools/call", {
      name: "search_records",
      arguments: { query: "synthetic" },
    })
    const result = z.object({
      isError: z.literal(false),
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
      structuredContent: z.object({ provider: z.string() }).passthrough(),
    }).parse(call.envelope.result)
    assert.equal(result.structuredContent.provider, "synthetic")
    assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), result.structuredContent)
  } finally {
    await server.stop()
  }
})

test("invalid tool-schema fault is genuinely invalid JSON Schema on the wire", async () => {
  const scenario = createFaultScenario("servicenow-inbound-quickstart", "mcp-invalid-tool-schema")
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const token = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const session = await initializeSession(server.baseUrl, scenario, token)
    const list = await callRpc(server.baseUrl, scenario, session, 29, "tools/list", {})
    const result = z.object({
      tools: z.array(z.object({ inputSchema: z.unknown() }).passthrough()).min(1),
    }).parse(list.envelope.result)
    const inputSchema = z.object({
      type: z.literal("object"),
      required: z.string(),
    }).passthrough().parse(result.tools[0]?.inputSchema)

    assert.equal(inputSchema.required, "missing")
    assert.equal(toolInputSchemaSchema.safeParse(inputSchema).success, false)
  } finally {
    await server.stop()
  }
})

test("provider tool faults expose top-level Den-compatible evidence and a detailed nested error", async () => {
  const scenario = createFaultScenario("servicenow-inbound-quickstart", "provider-authorization-denied")
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const token = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const session = await initializeSession(server.baseUrl, scenario, token)
    const call = await callRpc(server.baseUrl, scenario, session, 31, "tools/call", {
      name: "get_incident",
      arguments: { number: "INC0000001" },
    })
    const result = z.object({
      isError: z.literal(true),
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
      structuredContent: z.object({
        providerStatus: z.literal(403),
        category: z.literal("provider_acl"),
        requestId: z.string(),
        error: z.object({ code: z.literal("PROVIDER_ACL_DENIED"), providerRequestId: z.string() }).passthrough(),
      }).passthrough(),
    }).parse(call.envelope.result)
    assert.equal(result.structuredContent.requestId, result.structuredContent.error.providerRequestId)
    assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), result.structuredContent)
  } finally {
    await server.stop()
  }
})
