import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
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
import { isSensitiveCredentialKey, redactSensitiveText, redactedSensitiveResponseString, redactedResponseBodyExcerpt } from "../src/response-body-excerpt.js"

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

  it("normalizes long uppercase runs within a hard subprocess deadline", () => {
    const moduleUrl = new URL("../src/response-body-excerpt.ts", import.meta.url).href
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { isSensitiveCredentialKey, redactSensitiveText } from ${JSON.stringify(moduleUrl)};
      const repeated = "A".repeat(200000);
      assert.equal(isSensitiveCredentialKey(repeated), false);
      assert.equal(redactSensitiveText(repeated), repeated);
      assert.equal(isSensitiveCredentialKey(repeated + "SecretAccessKey"), true);
      assert.equal(isSensitiveCredentialKey(repeated + "SecretAccessKeyValue"), true);
      assert.equal(isSensitiveCredentialKey("A_".repeat(100000) + "code_verifier_value"), true);
      assert.equal(isSensitiveCredentialKey(repeated + "ClientAssertion"), true);
      assert.equal(isSensitiveCredentialKey(repeated + "CodeVerifierLength"), false);
    `], { encoding: "utf8", timeout: 4000 })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
  })

  it("omits whole auth and credential containers in raw JSON without inspecting their leaf names", () => {
    for (const key of ["auth", "credential", "credentials", "authentication"]) {
      for (const value of [{ opaque: 'opaque7 } ] "quoted"', nested: ["opaque7"] }, ["opaque7", { text: "opaque7" }], {}, []]) {
        const source = `log {"${key}":${JSON.stringify(value)},"result":"useful"}`
        for (const redact of [redactSensitiveText, redactedSensitiveResponseString]) {
          const clean = redact(source)
          assert.equal(clean, `log {"${key}":"[redacted]","result":"useful"}`)
          assert.equal(redact(clean), clean)
        }
      }
      for (const source of [`${key}={opaque:'opaque7'`, `${key}=[{"opaque":"opaque7"}} trailing`]) {
        assert.equal(redactSensitiveText(source), `${key}="[redacted]"`)
      }
    }
    const metadata = 'log {"authentication_method":{"public":"useful"},"credential_count":2}'
    assert.equal(redactSensitiveText(metadata), metadata)
  })

  it("shares credential handling across selective and conservative policies", () => {
    for (const key of ["AWS_SECRET_ACCESS_KEY", "SecretAccessKey", "SessionToken", "AWS_SESSION_TOKEN", "awsSecretAccessKey", "APIKey", "foo2Token", "code_verifier", "codeVerifier", "PKCECodeVerifier", "pkce.verifier", "client_assertion", "OAuthClientAssertion", "assertion", "jwt_assertion", "saml_assertion", "SAMLResponse", "access_token_value", "client_secret_value", "SecretAccessKeyValue", "code_verifier_value", "custom_token_payload", "signing_key_material", "oauth_assertion_blob", "service_password_backup", "access_token_countdown", "access_token_count_value", "auth", "authentication", "authorization", "oauth", "oauth2", "credential", "credentials", "creds", "token", "tokens", "grant", "grants", "secret", "secrets", "password", "passwords", "passwd", "pwd", "passphrase", "passphrases", "cookie", "cookies", "assertion", "assertions", "bearer", "jwt"]) {
      assert.equal(isSensitiveCredentialKey(key), true)
      for (const redact of [redactSensitiveText, redactedSensitiveResponseString]) {
        const value = "opaque-short-fixture"
        assert.equal(redact(`${key}=${value}`), `${key}=[redacted]`)
        assert.equal(redact(JSON.stringify({ [key]: value })), JSON.stringify({ [key]: "[redacted]" }))
      }
    }
    for (const key of ["monkey", "statusCode", "exitCode", "tokenCount", "client_assertion_type", "clientAssertionType", "code_challenge", "code_challenge_method", "codeVerifierLength", "assertionCount", "SAMLResponseStatus", "ClientID", "access_token_value_count", "client_secret_value_type", "code_verifier_value_length", "signing_key_method", "primary_key_value", "tokenizer_value", "statusCodeValue", "exit_code_value", "auth_type", "authentication_method", "credential_count", "credentials_length", "credentials_status", "creds_type", "passphrase_length", "jwt_method", "authorName", "username", "session", "account_id", "content_hash"]) {
      assert.equal(isSensitiveCredentialKey(key), false)
      assert.equal(redactSensitiveText(`${key}=useful`), `${key}=useful`)
    }
    for (const source of [JWT, SLACK_REFRESH_TOKEN, BEARER_TOKEN, GITHUB_TOKEN, "password=short", "https://user:short@host.invalid/path?token=short"]) {
      assert.equal(redactSensitiveText(source), redactedSensitiveResponseString(source))
      assert.notEqual(redactSensitiveText(source), source)
    }
    for (const redact of [redactSensitiveText, redactedSensitiveResponseString]) {
      for (const source of ['process.stdout.write({error:"intentional failure token=short"})', 'log {"details":"password=short"}']) {
        const clean = redact(source)
        assert.ok(!clean.includes("short"))
        assert.equal(redact(clean), clean)
      }
    }
    const sha = "0123456789abcdef".repeat(2) + "01234567"
    const uuid = "12345678-1234-4123-8123-123456789012"
    const image = "data:image/png;base64," + Buffer.from("synthetic-image-bytes".repeat(6)).toString("base64")
    for (const source of [sha, uuid, image]) assert.equal(redactSensitiveText(source), source)
    assert.equal(redactedSensitiveResponseString(sha), "[redacted]")
    assert.notEqual(redactedSensitiveResponseString(image), image)
    assert.equal(redactSensitiveText("token=[redacted:openai-api-key]"), "token=[redacted:openai-api-key]")
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
