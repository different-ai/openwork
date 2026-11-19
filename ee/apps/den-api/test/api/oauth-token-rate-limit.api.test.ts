/**
 * The OAuth token endpoint's limits, through /api/auth/oauth2/token with the
 * real database limiter: callers replaying dead refresh tokens are refused
 * after their own failure budgets, while another person signed in with the
 * same client ID keeps renewing, from the same address or another one.
 */
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { after, before, test } from "node:test"
import { bootDen, field, summary, text, type Call } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const { DEN_MCP_OAUTH_RESOURCE } = await import("../../src/auth.js")

const SCOPE = "openid profile email mcp:read mcp:write offline_access"
const REDIRECT_URI = "http://127.0.0.1:9/callback"
const OFFICE = "198.51.100.30"
const HOME = "203.0.113.30"

let clientId = ""

function form(values: Record<string, string>, ip: string) {
  return {
    headers: { "content-type": "application/x-www-form-urlencoded", "x-real-ip": ip },
    rawBody: new URLSearchParams(values).toString(),
  }
}

function tokenRequest(values: Record<string, string>, ip: string): Promise<Call> {
  return den.request(null, "POST", "/api/auth/oauth2/token", form({ client_id: clientId, resource: DEN_MCP_OAUTH_RESOURCE, ...values }, ip))
}

function refresh(refreshToken: string, ip: string) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, ip)
}

/** A person signs in, picks their workspace and authorizes the shared client, as an MCP client's browser hand-off does. */
async function signedInRefreshToken(name: string): Promise<string> {
  const person = await den.signUp(name)
  const { orgId } = await den.createOrg(person, `${name}'s workspace`)
  const headers = { cookie: person.cookie }
  const active = await den.request(person.token, "POST", "/api/auth/organization/set-active", { headers, body: { organizationId: orgId } })
  assert.equal(active.status, 200, summary(active))

  const verifier = randomBytes(32).toString("base64url")
  const authorize = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    resource: DEN_MCP_OAUTH_RESOURCE,
    state: randomBytes(8).toString("hex"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  })
  const consentPage = await den.request(person.token, "GET", `/api/auth/oauth2/authorize?${authorize}`, { headers })
  const consentLocation = new URL(text(consentPage.headers.get("location"), `consent redirect (${summary(consentPage)})`))
  const consented = await den.request(person.token, "POST", "/api/auth/oauth2/consent", {
    headers,
    body: { accept: true, scope: SCOPE, oauth_query: consentLocation.search.slice(1) },
  })
  assert.equal(consented.status, 200, summary(consented))
  const code = new URL(text(field(consented.body, "url"), "consent redirect")).searchParams.get("code")
  assert.ok(code, summary(consented))

  const exchanged = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT_URI }, HOME)
  assert.equal(exchanged.status, 200, summary(exchanged))
  return text(field(exchanged.body, "refresh_token"), "refresh token")
}

before(async () => {
  const registered = await den.request(null, "POST", "/api/auth/oauth2/register", {
    body: {
      client_name: "Shared MCP client",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
    },
  })
  assert.equal(registered.status, 201, summary(registered))
  clientId = text(field(registered.body, "client_id"), "client id")
})

async function rateLimitKeys(): Promise<string[]> {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("this check needs MySQL mode")
  const [rows] = await client.query("SELECT `key` FROM rate_limit WHERE `key` LIKE 'oauth-token:%'")
  return Array.isArray(rows) ? rows.map((row) => String(field(row, "key"))) : []
}

test("callers replaying dead refresh tokens do not stop another person using the same client at their address from renewing", async () => {
  let renewal = await signedInRefreshToken("Bea Renewer")

  // Five callers at one address with dead tokens: more failures than the
  // address ceiling holds. A second client ID keeps the shared client under
  // its per-minute attempt budget.
  const otherClient = `synthetic-client-${den.stamp}`
  const deadCallers = [
    { client: clientId, failures: 15 },
    { client: clientId, failures: 15 },
    { client: otherClient, failures: 15 },
    { client: otherClient, failures: 15 },
    { client: otherClient, failures: 5 },
  ].map((caller) => ({ ...caller, token: `ow_mcp_rt_${randomBytes(24).toString("base64url")}` }))
  for (const caller of deadCallers) {
    for (let attempt = 0; attempt < caller.failures; attempt += 1) {
      const failed = await tokenRequest({ grant_type: "refresh_token", refresh_token: caller.token, client_id: caller.client }, OFFICE)
      assert.equal(failed.status, 400, summary(failed))
      assert.equal(field(failed.body, "error"), "invalid_grant")
    }
  }
  const [first] = deadCallers
  assert.ok(first)
  for (let retry = 0; retry < 5; retry += 1) {
    const refused = await refresh(first.token, OFFICE)
    assert.equal(refused.status, 429, summary(refused))
    assert.equal(field(refused.body, "error"), "rate_limited")
    assert.ok(Number(refused.headers.get("retry-after")) > 0)
  }
  assert.deepEqual((await rateLimitKeys()).filter((key) => key.startsWith("oauth-token:fail:ip:")), [], "invalid_grant refusals never charge the address")

  // The same client ID, the same address, a different grant: renewed, then again from elsewhere.
  for (const ip of [OFFICE, HOME]) {
    const renewed = await refresh(renewal, ip)
    assert.equal(renewed.status, 200, `renewal from ${ip}: ${summary(renewed)}`)
    renewal = text(field(renewed.body, "refresh_token"), "rotated refresh token")
  }
  assert.equal((await refresh(first.token, HOME)).status, 429, "the dead token stays refused from any address")
})

test("stored limiter keys carry no token, client ID or address", async () => {
  const keys = await rateLimitKeys()
  assert.ok(keys.length > 0)
  for (const key of keys) {
    assert.match(key, /^oauth-token:[a-z:]+:[A-Za-z0-9_-]{32}$/)
    for (const raw of [clientId, OFFICE, HOME, "ow_mcp_rt_"]) assert.ok(!key.includes(raw), key)
  }
})
