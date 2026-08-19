/**
 * Runnable demo for the terminal-401 credential guard (legacy flow
 * enterprise-mcp-terminal-401-guard). Drives the real createEnterpriseMcpClient
 * through three provider scenarios and prints machine-readable evidence:
 *
 *   act 1  tool execution gets a transient 401 (no WWW-Authenticate proof)
 *          -> the stored credential must survive
 *   act 2  a background tool-discovery probe gets 401 + invalid_token
 *          -> the stored credential must survive (probes never invalidate)
 *   act 3  tool execution gets 401 + invalid_token proof
 *          -> the credential is invalidated once and a credential-invalidation
 *             diagnostic is emitted
 *
 * Output: human-readable act lines plus a final DEMO_RESULT_JSON=<json> line.
 */
import { z } from "zod"
import {
  createEnterpriseMcpClient,
  type EnterpriseMcpConnection,
  type EnterpriseMcpDiagnosticEvent,
  type EnterpriseMcpFetch,
  type EnterpriseMcpOAuthAuthorizationHandle,
  type EnterpriseMcpOAuthClientRegistration,
  type EnterpriseMcpOAuthCredential,
  type EnterpriseMcpOAuthPersistence,
} from "../src/index.js"
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"

const rpcRequestSchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string(),
})

class DemoOAuthPersistence implements EnterpriseMcpOAuthPersistence {
  registration: EnterpriseMcpOAuthClientRegistration | undefined
  credential: EnterpriseMcpOAuthCredential | undefined
  invalidationCount = 0
  private revision = 0
  private discoveryState: OAuthDiscoveryState | undefined
  private readonly authorizationRecords = new Map<
    string,
    { handle: EnterpriseMcpOAuthAuthorizationHandle; codeVerifier: string }
  >()

  private nextRevision(): string {
    this.revision += 1
    return `revision-${this.revision}`
  }

  readonly clientRegistrations = {
    load: async () => this.registration,
    save: async (input: {
      clientInformation: OAuthClientInformationMixed
      expiresAt?: number
      source: "client-metadata" | "dynamic"
    }) => {
      if (!this.registration) {
        this.registration = {
          clientInformation: input.clientInformation,
          revision: this.nextRevision(),
          expiresAt: input.expiresAt,
          source: input.source,
        }
      }
      return this.registration
    },
    invalidate: async () => {
      this.registration = undefined
    },
  }

  readonly authorizations = {
    begin: async (input: {
      id: string
      codeVerifier: string
      expiresAt: number
      clientRegistrationRevision?: string
    }) => {
      this.authorizationRecords.set(input.id, {
        handle: {
          id: input.id,
          revision: this.nextRevision(),
          expiresAt: input.expiresAt,
          clientRegistrationRevision: input.clientRegistrationRevision,
        },
        codeVerifier: input.codeVerifier,
      })
    },
    load: async (input: { id: string }) => this.authorizationRecords.get(input.id),
    invalidate: async (input: { id: string }) => {
      this.authorizationRecords.delete(input.id)
    },
  }

  readonly discovery = {
    load: async () => this.discoveryState,
    save: async (input: { state: OAuthDiscoveryState }) => {
      this.discoveryState = input.state
    },
    invalidate: async () => {
      this.discoveryState = undefined
    },
  }

  readonly credentials = {
    load: async () => this.credential,
    save: async (input: { tokens: OAuthTokens; expiresAt?: number }) => {
      this.credential = {
        tokens: input.tokens,
        expiresAt: input.expiresAt,
        revision: this.nextRevision(),
      }
    },
    invalidate: async () => {
      this.credential = undefined
      this.invalidationCount += 1
    },
  }

  seed(): void {
    this.registration = {
      clientInformation: { client_id: "demo-client" },
      revision: this.nextRevision(),
      source: "pre-registered",
    }
    this.credential = {
      tokens: { access_token: "demo-access-token", token_type: "Bearer" },
      revision: this.nextRevision(),
    }
  }
}

function scriptedProviderFetch(input: {
  rejectMethod: "tools/call" | "tools/list"
  status: number
  wwwAuthenticate?: string
}): EnterpriseMcpFetch {
  return async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : undefined
    if (!body) return new Response(null, { status: 202 })
    const request = rpcRequestSchema.parse(JSON.parse(body))
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 })
    if (request.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "terminal-401-guard-demo", version: "1.0.0" },
        },
      })
    }
    if (request.method === input.rejectMethod) {
      const headers = new Headers()
      if (input.wwwAuthenticate) headers.set("www-authenticate", input.wwwAuthenticate)
      return new Response(null, { status: input.status, headers })
    }
    if (request.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [{ name: "demo-tool", inputSchema: { type: "object", properties: {} } }] },
      })
    }
    return new Response(null, { status: 404 })
  }
}

type ActResult = {
  act: string
  operation: "tools/call" | "tools/list"
  providerResponse: string
  credentialIntact: boolean
  invalidationCount: number
  invalidationDiagnostics: EnterpriseMcpDiagnosticEvent[]
}

async function runAct(input: {
  act: string
  operation: "tools/call" | "tools/list"
  status: number
  wwwAuthenticate?: string
}): Promise<ActResult> {
  const persistence = new DemoOAuthPersistence()
  persistence.seed()
  const events: EnterpriseMcpDiagnosticEvent[] = []
  const client = createEnterpriseMcpClient({
    fetch: scriptedProviderFetch({
      rejectMethod: input.operation,
      status: input.status,
      wwwAuthenticate: input.wwwAuthenticate,
    }),
    diagnosticSink: (event) => events.push(event),
  })
  const connection: EnterpriseMcpConnection = {
    id: `demo-${input.act}`,
    serverUrl: "https://mcp.example.test/mcp",
    authorization: { type: "oauth", persistence },
  }
  const operation = input.operation === "tools/call"
    ? client.callTool({ connection, redirectUri: "https://den.example.test/oauth/callback", toolName: "demo-tool", arguments: {} })
    : client.listTools({ connection, redirectUri: "https://den.example.test/oauth/callback" })
  const rejected = await operation.then(() => false, () => true)
  if (!rejected) throw new Error(`act "${input.act}" expected the provider rejection to surface`)
  return {
    act: input.act,
    operation: input.operation,
    providerResponse: `${input.status}${input.wwwAuthenticate ? ` with WWW-Authenticate: ${input.wwwAuthenticate}` : " without a WWW-Authenticate challenge"}`,
    credentialIntact: persistence.credential?.tokens.access_token === "demo-access-token",
    invalidationCount: persistence.invalidationCount,
    invalidationDiagnostics: events.filter((event) => event.kind === "credential-invalidation"),
  }
}

const acts: ActResult[] = [
  await runAct({ act: "transient-401-on-execute", operation: "tools/call", status: 401 }),
  await runAct({
    act: "invalid-token-on-discovery-probe",
    operation: "tools/list",
    status: 401,
    wwwAuthenticate: 'Bearer error="invalid_token"',
  }),
  await runAct({
    act: "invalid-token-on-execute",
    operation: "tools/call",
    status: 401,
    wwwAuthenticate: 'Bearer error="invalid_token"',
  }),
]

for (const act of acts) {
  console.log(
    `act=${act.act} operation=${act.operation} provider=${act.providerResponse} `
    + `credentialIntact=${act.credentialIntact} invalidations=${act.invalidationCount} `
    + `invalidationDiagnostics=${act.invalidationDiagnostics.length}`,
  )
}
console.log(`DEMO_RESULT_JSON=${JSON.stringify(acts)}`)
