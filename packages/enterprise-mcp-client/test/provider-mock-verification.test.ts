import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js"
import {
  createDefaultScenario,
  createEnterpriseMcpMockServer,
  getProviderProfile,
  type ProviderProfileId,
} from "@openwork/enterprise-mcp-mock-server"
import {
  createEnterpriseMcpClient,
  EnterpriseMcpClientError,
  type EnterpriseMcpConnection,
  type EnterpriseMcpDiagnosticEvent,
  type EnterpriseMcpOAuthAuthorizationHandle,
  type EnterpriseMcpOAuthClientRegistration,
  type EnterpriseMcpOAuthCredential,
  type EnterpriseMcpOAuthPersistence,
} from "../src/index.js"

const correctClientSecret = "synthetic-test-client-secret-32-bytes"
const wrongClientSecret = "wrong-secret-must-not-be-echoed"

type MemoryState = {
  registration: EnterpriseMcpOAuthClientRegistration | undefined
  credential: EnterpriseMcpOAuthCredential | undefined
  authorizations: Map<string, { handle: EnterpriseMcpOAuthAuthorizationHandle; codeVerifier: string }>
  revision: number
}

function createMemoryPersistence(clientInformation: OAuthClientInformationMixed): {
  persistence: EnterpriseMcpOAuthPersistence
  state: MemoryState
} {
  const state: MemoryState = {
    registration: {
      clientInformation,
      revision: "revision-1",
      source: "pre-registered",
    },
    credential: undefined,
    authorizations: new Map(),
    revision: 1,
  }

  function nextRevision(): string {
    state.revision += 1
    return `revision-${state.revision}`
  }

  function assertActive(context: { commitExpiresAt: number; signal: AbortSignal }): void {
    if (context.signal.aborted || context.commitExpiresAt <= Date.now()) {
      throw new Error("The test persistence lifecycle expired")
    }
  }

  const persistence: EnterpriseMcpOAuthPersistence = {
    clientRegistrations: {
      load: async () => state.registration,
      save: async (input) => {
        assertActive(input.context)
        if (!state.registration) {
          state.registration = {
            clientInformation: input.clientInformation,
            revision: nextRevision(),
            expiresAt: input.expiresAt,
            source: "dynamic",
          }
        }
        return state.registration
      },
      invalidate: async () => {
        state.registration = undefined
      },
    },
    authorizations: {
      begin: async (input) => {
        assertActive(input.context)
        state.authorizations.set(input.id, {
          handle: {
            id: input.id,
            revision: nextRevision(),
            expiresAt: input.expiresAt,
            clientRegistrationRevision: input.clientRegistrationRevision,
          },
          codeVerifier: input.codeVerifier,
        })
      },
      load: async (input) => state.authorizations.get(input.id),
      invalidate: async (input) => {
        state.authorizations.delete(input.id)
      },
    },
    credentials: {
      load: async () => state.credential,
      save: async (input) => {
        assertActive(input.context)
        if (input.source === "authorization-code") {
          const pending = input.authorization ? state.authorizations.get(input.authorization.id) : undefined
          if (!pending || pending.handle.revision !== input.authorization?.revision) {
            throw new Error("The authorization transaction is no longer active")
          }
          if (pending.handle.clientRegistrationRevision !== input.clientRegistrationRevision) {
            throw new Error("The OAuth client registration changed")
          }
          state.authorizations.delete(pending.handle.id)
        }
        state.credential = {
          tokens: input.tokens,
          expiresAt: input.expiresAt,
          revision: nextRevision(),
        }
        assertActive(input.context)
      },
      invalidate: async () => {
        state.credential = undefined
      },
    },
  }
  return { persistence, state }
}

async function authorizeInBrowser(authorizeUrl: string): Promise<{ code: string; state: string }> {
  const response = await fetch(authorizeUrl, { redirect: "manual" })
  assert.equal(response.status, 302)
  const location = response.headers.get("location")
  assert.ok(location)
  const callback = new URL(location)
  const code = callback.searchParams.get("code")
  const state = callback.searchParams.get("state")
  assert.ok(code)
  assert.ok(state)
  return { code, state }
}

function connectionFor(input: {
  profileId: ProviderProfileId
  serverUrl: string
  clientSecret: string
}) {
  const scenario = createDefaultScenario(input.profileId)
  const memory = createMemoryPersistence({
    client_id: scenario.oauth.clientId,
    client_secret: input.clientSecret,
    token_endpoint_auth_method: "client_secret_post",
  })
  const connection: EnterpriseMcpConnection = {
    id: `${input.profileId}-verification`,
    serverUrl: input.serverUrl,
    authorization: { type: "oauth", persistence: memory.persistence },
  }
  return { scenario, connection, memory }
}

async function verifyHealthyProfile(profileId: "servicenow-inbound-quickstart" | "microsoft-enterprise"): Promise<void> {
  const scenario = createDefaultScenario(profileId)
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret: correctClientSecret } })
  await server.start()
  try {
    const events: EnterpriseMcpDiagnosticEvent[] = []
    const { connection, memory } = connectionFor({
      profileId,
      serverUrl: server.mcpUrl,
      clientSecret: correctClientSecret,
    })
    const client = createEnterpriseMcpClient({
      fetch,
      diagnosticSink: (event) => events.push(event),
    })
    const redirectUri = scenario.oauth.redirectUris[0]
    assert.ok(redirectUri)
    const authorizationId = `${profileId}-signed-state`
    const started = await client.connect({ connection, redirectUri, authorizationId })
    assert.equal(started.status, "needs_auth")
    if (started.status !== "needs_auth") throw new Error("Expected browser authorization")
    const callback = await authorizeInBrowser(started.authorizeUrl)
    assert.equal(callback.state, authorizationId)

    await client.completeAuthorization({
      connection,
      redirectUri,
      code: callback.code,
      authorizationId: callback.state,
    })
    assert.ok(memory.state.credential?.tokens.access_token)
    assert.equal(memory.state.authorizations.size, 0)
    assert.deepEqual(await client.connect({
      connection,
      redirectUri,
      authorizationId: `${authorizationId}-connected`,
    }), { status: "connected" })

    const tools = await client.listTools({ connection, redirectUri })
    const expectedToolNames = getProviderProfile(profileId).tools.map((tool) => tool.name)
    assert.deepEqual(tools.map((tool) => tool.name), expectedToolNames)

    const safeRead = profileId === "servicenow-inbound-quickstart"
      ? { toolName: "lookup_incidents", arguments: { active: true, limit: 2 } }
      : { toolName: "microsoft_graph_suggest_queries", arguments: { intent: "List active users" } }
    const result = await client.callTool({
      connection,
      redirectUri,
      toolName: safeRead.toolName,
      arguments: safeRead.arguments,
    })
    assert.equal("isError" in result && result.isError, false)

    for (const phase of [
      "oauth-resource-discovery",
      "oauth-server-discovery",
      "oauth-token-exchange",
      "mcp-initialize",
      "mcp-tool-discovery",
      "mcp-tool-execution",
    ]) {
      assert.ok(events.some((event) => event.requestPhase === phase), `${profileId} did not observe ${phase}`)
    }
  } finally {
    await server.stop()
  }
}

async function verifyInvalidClientProfile(profileId: "servicenow-inbound-quickstart" | "microsoft-enterprise"): Promise<void> {
  const scenario = createDefaultScenario(profileId)
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret: correctClientSecret } })
  await server.start()
  try {
    const events: EnterpriseMcpDiagnosticEvent[] = []
    const { connection } = connectionFor({
      profileId,
      serverUrl: server.mcpUrl,
      clientSecret: wrongClientSecret,
    })
    const client = createEnterpriseMcpClient({ fetch, diagnosticSink: (event) => events.push(event) })
    const redirectUri = scenario.oauth.redirectUris[0]
    assert.ok(redirectUri)
    const authorizationId = `${profileId}-invalid-client-state`
    const started = await client.connect({ connection, redirectUri, authorizationId })
    assert.equal(started.status, "needs_auth")
    if (started.status !== "needs_auth") throw new Error("Expected browser authorization")
    const callback = await authorizeInBrowser(started.authorizeUrl)

    await assert.rejects(
      client.completeAuthorization({
        connection,
        redirectUri,
        code: callback.code,
        authorizationId: callback.state,
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnterpriseMcpClientError)
        assert.equal(error.code, "MCP_AUTHORIZATION_CALLBACK_FAILED")
        assert.equal(error.operationPhase, "authorization-callback")
        assert.equal(error.requestPhase, "oauth-token-exchange")
        assert.doesNotMatch(error.message, new RegExp(wrongClientSecret))
        return true
      },
    )
    assert.ok(events.some((event) =>
      event.outcome === "failed"
      && event.operationPhase === "authorization-callback"
      && event.requestPhase === "oauth-token-exchange"))
  } finally {
    await server.stop()
  }
}

describe("package-first enterprise MCP client against provider-shaped mock servers", () => {
  const verificationProfiles: readonly ("servicenow-inbound-quickstart" | "microsoft-enterprise")[] = [
    "servicenow-inbound-quickstart",
    "microsoft-enterprise",
  ]
  for (const profileId of verificationProfiles) {
    it(`completes OAuth, catalog discovery, and a safe read for ${profileId}`, async () => {
      await verifyHealthyProfile(profileId)
    })

    it(`attributes an invalid client secret to OAuth token exchange for ${profileId}`, async () => {
      await verifyInvalidClientProfile(profileId)
    })
  }
})
