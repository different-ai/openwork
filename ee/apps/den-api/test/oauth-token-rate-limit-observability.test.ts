import assert from "node:assert/strict"
import { test } from "node:test"
import { createAppLogger } from "../src/observability/logger.js"
import {
  getOAuthTokenFailureLogFields,
  getOAuthTokenRateLimitLogFields,
  MCP_SESSION_REVOKED_GRANT_DESCRIPTION,
  readBasicAuthClientId,
  readOAuthTokenErrorLogFields,
  type OAuthTokenLimitAttribution,
} from "../src/oauth-token-rate-limit-observability.js"

const TOKEN_URL = "https://den.example.test/api/auth/oauth2/token"
const CLIENT_ID = "synthetic-client"
const CLIENT_SECRET = "synthetic-client-secret-0123456789"
const REFRESH_TOKEN = "synthetic-refresh-token-0123456789"
const BODY_CLIENT_ID = "synthetic-body-client-must-not-win"
const COOKIE = "synthetic-session-cookie-0123456789"
const API_KEY = "synthetic-api-key-0123456789"
const BUCKET_KEY = "oauth-token:client:0123456789abcdef0123456789abcdef"
const SECRETS = [CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, BODY_CLIENT_ID, COOKIE, API_KEY, BUCKET_KEY]
/** sha256 of CLIENT_ID, first 16 hex characters. */
const CLIENT_FINGERPRINT = "sha256:223208350d10e594"

function refreshRequest(url = TOKEN_URL) {
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      cookie: `session=${COOKIE}`,
      "user-agent": "OpenWork Desktop/1.2.3",
      "x-api-key": API_KEY,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN, client_id: BODY_CLIENT_ID }),
  })
}

function tokenError(status: number, body: unknown) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } })
}

function assertNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value)
  for (const secret of SECRETS) {
    assert.ok(!serialized.includes(secret), `serialized fields must not contain ${secret}`)
  }
}

test("reads a client ID from valid Basic authentication only", () => {
  assert.equal(readBasicAuthClientId(new Headers({ authorization: `Basic ${btoa("desktop-client:secret")}` })), "desktop-client")
  assert.equal(readBasicAuthClientId(new Headers({ authorization: "Basic not-base64!" })), null)
  assert.equal(readBasicAuthClientId(new Headers({ authorization: `Bearer ${btoa("desktop-client:secret")}` })), null)
})

test("attributes a Den admission 429 to every bucket that blocked it", async () => {
  const response = new Response(null, { status: 429, headers: { "retry-after": "240" } })
  const fields = await getOAuthTokenRateLimitLogFields(refreshRequest(), response, {
    layer: "den_admission",
    blocked: [
      { bucket: "failure_refresh_token", retryAfterSeconds: 240 },
      { bucket: "failure_ip", retryAfterSeconds: 12 },
    ],
    clientIpSource: "header",
  })

  assert.deepEqual(fields, {
    grant_type: "refresh_token",
    client_id_fingerprint: CLIENT_FINGERPRINT,
    user_agent_category: "openwork",
    retry_after: "240",
    limit_layer: "den_admission",
    client_ip_source: "header",
    bucket: "failure_refresh_token",
    blocked_buckets: [
      { bucket: "failure_refresh_token", retry_after_seconds: 240 },
      { bucket: "failure_ip", retry_after_seconds: 12 },
    ],
  })
  assertNoSecrets(fields)
})

test("separates a 429 from inside the auth handler from Den's admission limits", async () => {
  // Better Auth's own limiter answers with X-Retry-After and no bucket attribution.
  const response = new Response(JSON.stringify({ message: "Too many requests. Please try again later." }), {
    status: 429,
    headers: { "x-retry-after": "17" },
  })
  const fields = await getOAuthTokenRateLimitLogFields(refreshRequest(), response, { layer: "auth_handler", clientIpSource: "none" })

  assert.equal(fields?.limit_layer, "auth_handler")
  assert.equal(fields?.retry_after, "17")
  assert.equal(fields?.bucket, undefined)
  assert.equal(fields?.blocked_buckets, undefined)
  assert.equal(fields?.client_ip_source, "none")
  assertNoSecrets(fields)
})

test("only rate-limited token requests are observed", async () => {
  const limited = new Response(null, { status: 429, headers: { "retry-after": "5" } })
  const attribution: OAuthTokenLimitAttribution = { layer: "den_admission", clientIpSource: "signed" }
  assert.equal(await getOAuthTokenRateLimitLogFields(refreshRequest(), new Response(null, { status: 400 }), attribution), null)
  assert.equal(await getOAuthTokenRateLimitLogFields(refreshRequest("https://den.example.test/api/auth/oauth2/authorize"), limited, attribution), null)
  assert.equal(await getOAuthTokenRateLimitLogFields(new Request(TOKEN_URL), limited, attribution), null)
  assert.notEqual(await getOAuthTokenRateLimitLogFields(refreshRequest(`${TOKEN_URL}/`), limited, attribution), null)
})

test("never logs a bucket key or a malformed wait as a bucket", async () => {
  const fields = await getOAuthTokenRateLimitLogFields(refreshRequest(), new Response(null, { status: 429 }), {
    layer: "den_admission",
    blocked: [
      { bucket: BUCKET_KEY, retryAfterSeconds: 30 },
      { bucket: "client", retryAfterSeconds: Number.NaN },
      { bucket: "anonymous", retryAfterSeconds: 2.5 },
    ],
    clientIpSource: "header",
  })

  assert.equal(fields?.bucket, "other")
  assert.deepEqual(fields?.blocked_buckets, [{ bucket: "other", retry_after_seconds: 30 }])
  assertNoSecrets(fields)
})

test("categorizes token errors from an allowlist and never logs descriptions", async () => {
  for (const code of ["invalid_grant", "invalid_client", "invalid_request", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "invalid_target"]) {
    assert.deepEqual(await readOAuthTokenErrorLogFields(tokenError(400, { error: code, error_description: `echo ${REFRESH_TOKEN}` })), { oauth_error: code })
  }

  assert.deepEqual(await readOAuthTokenErrorLogFields(tokenError(400, { error: `custom_${REFRESH_TOKEN}` })), { oauth_error: "other" })
  assert.deepEqual(await readOAuthTokenErrorLogFields(tokenError(400, { message: "no OAuth error" })), { oauth_error: "missing" })
  assert.deepEqual(await readOAuthTokenErrorLogFields(new Response(`error=${REFRESH_TOKEN}`, { status: 400 })), { oauth_error: "missing" })
  assert.deepEqual(await readOAuthTokenErrorLogFields(new Response("{not json", { status: 400, headers: { "content-type": "application/json" } })), { oauth_error: "missing" })

  assert.deepEqual(await readOAuthTokenErrorLogFields(tokenError(400, { error: "invalid_grant", error_description: MCP_SESSION_REVOKED_GRANT_DESCRIPTION })), {
    oauth_error: "invalid_grant",
    oauth_error_reason: "mcp_session_revoked",
  })
  assert.deepEqual(await readOAuthTokenErrorLogFields(tokenError(400, { error: "invalid_grant", error_description: "invalid refresh token" })), {
    oauth_error: "invalid_grant",
    oauth_error_reason: "refresh_token_rejected",
  })
  assert.deepEqual(await readOAuthTokenErrorLogFields(tokenError(400, { error: "invalid_grant", error_description: "session not found" })), {
    oauth_error: "invalid_grant",
    oauth_error_reason: "refresh_token_unknown",
  })
})

test("reading the error leaves the token response intact for the caller", async () => {
  const response = tokenError(400, { error: "invalid_grant", error_description: "invalid refresh token" })
  await readOAuthTokenErrorLogFields(response)
  assert.deepEqual(await response.json(), { error: "invalid_grant", error_description: "invalid refresh token" })
})

test("describes the failure that exhausted a budget without secrets", async () => {
  const response = tokenError(400, { error: "invalid_grant", error_description: MCP_SESSION_REVOKED_GRANT_DESCRIPTION })
  const fields = await getOAuthTokenFailureLogFields(refreshRequest(), response, { bucket: "failure_refresh_token", retryAfterSeconds: 300 }, "header")

  assert.deepEqual(fields, {
    grant_type: "refresh_token",
    client_id_fingerprint: CLIENT_FINGERPRINT,
    user_agent_category: "openwork",
    oauth_error: "invalid_grant",
    oauth_error_reason: "mcp_session_revoked",
    limit_layer: "den_admission",
    bucket: "failure_refresh_token",
    retry_after_seconds: 300,
    http_status: 400,
    client_ip_source: "header",
  })
  assertNoSecrets(fields)

  assert.equal(await getOAuthTokenFailureLogFields(refreshRequest(), new Response(null, { status: 200 }), { bucket: "failure_client", retryAfterSeconds: 300 }, "header"), null)
  assert.equal(await getOAuthTokenFailureLogFields(refreshRequest(), new Response(null, { status: 429 }), { bucket: "failure_client", retryAfterSeconds: 300 }, "header"), null)
  assert.equal(
    (await getOAuthTokenFailureLogFields(refreshRequest(), new Response(null, { status: 401 }), { bucket: BUCKET_KEY, retryAfterSeconds: 300 }, "header"))?.bucket,
    "other",
  )
})

test("the structured logger keeps every field and still leaks nothing", async () => {
  const lines: string[] = []
  const logger = createAppLogger({ write: (line) => lines.push(line), emitProviderLog: () => {}, getTraceContext: () => undefined })
  const limited = await getOAuthTokenRateLimitLogFields(refreshRequest(), new Response(null, { status: 429, headers: { "retry-after": "60" } }), {
    layer: "den_admission",
    blocked: [{ bucket: "client", retryAfterSeconds: 60 }],
    clientIpSource: "header",
  })
  const failure = await getOAuthTokenFailureLogFields(
    refreshRequest(),
    tokenError(400, { error: "invalid_grant", error_description: "invalid refresh token" }),
    { bucket: "failure_refresh_token", retryAfterSeconds: 300 },
    "header",
  )
  logger.warn("oauth token request rate limited", limited ?? {})
  logger.warn("oauth token failure budget exhausted", failure ?? {})

  assert.equal(lines.length, 2)
  assert.ok(!lines.join("\n").includes("[redacted]"), "no field name may collide with the logger's redaction rules")
  for (const line of lines) {
    for (const expected of ['"limit_layer":"den_admission"', '"client_ip_source":"header"', '"grant_type":"refresh_token"', `"client_id_fingerprint":"${CLIENT_FINGERPRINT}"`]) {
      assert.ok(line.includes(expected), `${expected} in ${line}`)
    }
  }
  assert.ok(lines[0]?.includes('"blocked_buckets":[{"bucket":"client","retry_after_seconds":60}]'))
  assert.ok(lines[1]?.includes('"bucket":"failure_refresh_token"'), "a bucket named after tokens is a value, so it is not redacted")
  assert.ok(lines[1]?.includes('"oauth_error_reason":"refresh_token_rejected"'))
  assertNoSecrets(lines)
})
