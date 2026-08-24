import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { exchangeAuthorization, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/client"
import { z } from "zod"
import {
  createEnterpriseMcpClient,
  createEnterpriseMcpTokenResponseCompat,
  SLACK_STYLE_OAUTH_ERROR_MAPPING,
  type EnterpriseMcpConnection,
  type EnterpriseMcpDiagnosticEvent,
} from "../src/index.js"
import { createEnterpriseMcpRequestObserver } from "../src/request-observer.js"
import { redactedResponseBodyExcerpt } from "../src/response-body-excerpt.js"

const SAFE_SLACK_ERROR = "Slack-style provider error: invalid_refresh_token"
const AUTHORIZATION_CODE = "SECRETVALUE123"
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureABCD"
const SLACK_REFRESH_TOKEN = "xoxe-1-1234567890-abcdef"
const BEARER_TOKEN = "Bearer abcdefghijklmnopqrstuvwx"
const GITHUB_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"
const OPAQUE_TOKEN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn"

const tokenResponseSchema = z.object({
  ok: z.boolean().optional(),
  access_token: z.string(),
  token_type: z.string(),
}).passthrough()

const discoverRequestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.literal("server/discover"),
  params: z.object({ _meta: z.record(z.string(), z.unknown()) }).passthrough(),
}).passthrough()

function tokenRequestInit(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: "approved-code" }),
  }
}

function noAuthConnection(): EnterpriseMcpConnection {
  return {
    id: "slack-compat-connection",
    serverUrl: "https://mcp.example.test/mcp",
    authorization: { type: "none" },
  }
}

describe("Slack-style MCP compatibility", () => {
  it("maps the documented provider errors from one exported table", () => {
    assert.equal(SLACK_STYLE_OAUTH_ERROR_MAPPING.invalid_code, "invalid_grant")
    assert.equal(SLACK_STYLE_OAUTH_ERROR_MAPPING.bad_client_secret, "invalid_client")
    assert.equal(SLACK_STYLE_OAUTH_ERROR_MAPPING.no_user_scopes, "invalid_scope")
    assert.equal(SLACK_STYLE_OAUTH_ERROR_MAPPING.invalid_auth, "access_denied")
  })

  it("turns an HTTP-200 ok:false token exchange into a typed OAuth error", async () => {
    const translations: EnterpriseMcpDiagnosticEvent[] = []
    const compatibleFetch = createEnterpriseMcpTokenResponseCompat({
      fetch: async () => Response.json({
        ok: false,
        error: "invalid_code",
        access_token: "must-not-be-diagnosed",
        weird_field: "xoxp-arbitrary",
      }),
      onTranslation: (translation) => translations.push({
        kind: "request",
        connectionId: "slack-compat-connection",
        operationPhase: "authorization-callback",
        ...translation,
      }),
    })
    const sdkFetch: typeof fetch = async (url, init) => compatibleFetch(
      typeof url === "string" || url instanceof URL ? url : url.url,
      init,
    )

    await assert.rejects(
      exchangeAuthorization("https://provider.example.test", {
        metadata: {
          issuer: "https://provider.example.test",
          authorization_endpoint: "https://provider.example.test/authorize",
          token_endpoint: "https://provider.example.test/token",
          response_types_supported: ["code"],
        },
        clientInformation: { client_id: "enterprise-client" },
        authorizationCode: "approved-code",
        codeVerifier: "pkce-verifier",
        redirectUri: "https://den.example.test/callback",
        fetchFn: sdkFetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof OAuthError)
        assert.equal(error.code, OAuthErrorCode.InvalidGrant)
        assert.match(error.message, /Slack-style provider error: invalid_code/)
        return true
      },
    )
    assert.equal(translations.length, 1)
    const translation = translations[0]
    assert.ok(translation && translation.kind !== "credential-invalidation")
    assert.equal(translation.httpStatus, 400)
    assert.match(translation.responseBodyExcerpt ?? "", /invalid_code/)
    assert.doesNotMatch(translation.responseBodyExcerpt ?? "", /must-not-be-diagnosed/)
    assert.doesNotMatch(translation.responseBodyExcerpt ?? "", /weird_field|xoxp-arbitrary/)
  })

  it("normalizes a non-Bearer token_type while preserving other token fields", async () => {
    const compatibleFetch = createEnterpriseMcpTokenResponseCompat({
      fetch: async () => Response.json({
        ok: true,
        access_token: "xoxp-secret-token",
        token_type: "user",
        scope: "search:read",
      }),
    })

    const response = await compatibleFetch("https://provider.example.test/token", tokenRequestInit())
    const body = tokenResponseSchema.parse(await response.json())
    assert.equal(body.token_type, "Bearer")
    assert.equal(body.access_token, "xoxp-secret-token")
    assert.equal(body.scope, "search:read")
  })

  it("passes standard token responses through as the original Response", async () => {
    const original = Response.json({ access_token: "standard-token", token_type: "Bearer" })
    const compatibleFetch = createEnterpriseMcpTokenResponseCompat({ fetch: async () => original })

    assert.strictEqual(
      await compatibleFetch("https://provider.example.test/token", tokenRequestInit()),
      original,
    )
  })

  it("negotiates the stateless protocol without initialize or a session id", async () => {
    const methods: string[] = []
    const headers: Headers[] = []
    const events: EnterpriseMcpDiagnosticEvent[] = []
    const client = createEnterpriseMcpClient({
      diagnosticSink: (event) => events.push(event),
      fetch: async (_url, init) => {
        headers.push(new Headers(init?.headers))
        const body = init?.body
        assert.equal(typeof body, "string")
        const parsed: unknown = JSON.parse(body as string)
        const request = discoverRequestSchema.parse(parsed)
        methods.push(request.method)
        return Response.json({
          jsonrpc: "2.0" as const,
          id: request.id,
          result: {
            supportedVersions: ["2026-07-28"],
            capabilities: {},
            _meta: {
              "io.modelcontextprotocol/serverInfo": { name: "stateless-test", version: "1.0.0" },
            },
          },
        })
      },
    })

    assert.deepEqual(await client.connect({
      connection: noAuthConnection(),
      redirectUri: "https://den.example.test/callback",
    }), { status: "connected" })
    assert.deepEqual(methods, ["server/discover"])
    assert.equal(headers[0]?.get("mcp-protocol-version"), "2026-07-28")
    assert.equal(headers[0]?.get("mcp-method"), "server/discover")
    assert.equal(headers[0]?.has("mcp-session-id"), false)
    assert.equal(events.filter((event) => event.kind !== "credential-invalidation"
      && event.protocolEra === "modern"
      && event.protocolVersion === "2026-07-28").length, 1)
  })

  for (const status of [401, 500]) {
    it(`does not downgrade the discovery probe after HTTP ${status}`, async () => {
      let protocolRequests = 0
      const client = createEnterpriseMcpClient({
        fetch: async (_url, init) => {
          if (typeof init?.body === "string") protocolRequests += 1
          return Response.json({ error: "provider_rejected" }, { status })
        },
      })

      await assert.rejects(client.connect({
        connection: noAuthConnection(),
        redirectUri: "https://den.example.test/callback",
      }))
      assert.equal(protocolRequests, 1)
    })
  }

  it("captures a bounded MCP error body excerpt with sensitive values redacted", async () => {
    const events: EnterpriseMcpDiagnosticEvent[] = []
    const originalBody = {
      error: "provider_rejected",
      access_token: "must-not-appear",
      authorization_code: "also-secret",
    }
    const observer = createEnterpriseMcpRequestObserver({
      connectionId: "slack-compat-connection",
      operationPhase: "connection-handshake",
      fetch: async () => Response.json(originalBody, { status: 400 }),
      diagnosticSink: (event) => events.push(event),
      signal: new AbortController().signal,
      clock: { now: () => Date.now() },
    })

    const response = await observer.fetch("https://mcp.example.test/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    assert.deepEqual(await response.json(), originalBody)
    const failed = events.find((event) => event.kind === "request" && event.outcome === "failed")
    assert.ok(failed && failed.kind !== "credential-invalidation")
    assert.match(failed.responseBodyExcerpt ?? "", /\[redacted\]/)
    assert.doesNotMatch(failed.responseBodyExcerpt ?? "", /must-not-appear|also-secret/)
    assert.ok((failed.responseBodyExcerpt?.length ?? 0) <= 2_000)
  })

  it("redacts credential content inside non-sensitive fields and raw text", () => {
    const errorDescription = [
      SAFE_SLACK_ERROR,
      `authorization_code=${AUTHORIZATION_CODE}`,
      JWT,
      SLACK_REFRESH_TOKEN,
      BEARER_TOKEN,
      GITHUB_TOKEN,
      OPAQUE_TOKEN,
    ].join("; ")
    const excerpt = redactedResponseBodyExcerpt(JSON.stringify({
      error_description: errorDescription,
      access_token: "key-based-secret",
    }))

    assert.match(excerpt, new RegExp(SAFE_SLACK_ERROR))
    assert.match(excerpt, /authorization_code=\[redacted\]/)
    assert.match(excerpt, /"access_token":"\[redacted\]"/)
    for (const secret of [
      AUTHORIZATION_CODE,
      JWT,
      SLACK_REFRESH_TOKEN,
      "abcdefghijklmnopqrstuvwx",
      GITHUB_TOKEN,
      OPAQUE_TOKEN,
      "key-based-secret",
    ]) {
      assert.doesNotMatch(excerpt, new RegExp(secret))
    }
    assert.ok(excerpt.length <= 2_000)

    const rawExcerpt = redactedResponseBodyExcerpt(
      `not-json ${SAFE_SLACK_ERROR}; authorization_code=${AUTHORIZATION_CODE}; ${JWT}; ${SLACK_REFRESH_TOKEN}`,
    )
    assert.match(rawExcerpt, new RegExp(SAFE_SLACK_ERROR))
    assert.match(rawExcerpt, /authorization_code=\[redacted\]/)
    assert.doesNotMatch(rawExcerpt, new RegExp(`${AUTHORIZATION_CODE}|${JWT}|${SLACK_REFRESH_TOKEN}`))
  })
})
