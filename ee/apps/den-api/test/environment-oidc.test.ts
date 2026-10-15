import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { once } from "node:events"
import { generateKeyPair, exportJWK, SignJWT } from "jose"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { readEnvironmentOidcConfig, discoverEnvironmentOidc } from "../src/environment-oidc-config.js"
import { environmentOidcPlugin } from "../src/environment-oidc.js"

const configured = {
  OIDC_CLIENT_ID: "fixture-client", OIDC_CLIENT_SECRET: "fixture-secret", OIDC_ISSUER_URL: "https://identity.example.test/realm",
}

test("OIDC is unconfigured by default and partial credentials fail closed without exposing secrets", () => {
  assert.equal(readEnvironmentOidcConfig({}), null)
  assert.throws(() => readEnvironmentOidcConfig({ OIDC_CLIENT_SECRET: "private-value" }), /^Error: OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_ISSUER_URL must be configured together$/)
})

test("OIDC identifiers are namespaced and PKCE, verified email scopes and secret auth default securely", () => {
  const config = readEnvironmentOidcConfig(configured)
  assert.ok(config)
  assert.equal(config.providerId, "env-oidc-oidc")
  assert.equal(config.pkce, true)
  assert.deepEqual(config.scopes, ["openid", "email", "profile"])
  assert.equal(config.authentication, "client_secret_basic")
  assert.equal(config.discoveryUrl, "https://identity.example.test/realm/.well-known/openid-configuration")
})

test("OIDC refuses malformed identifiers, unsafe endpoints, missing scopes and partial explicit metadata", () => {
  for (const override of [
    { OIDC_PROVIDER_ID: "../google" }, { OIDC_PROVIDER_NAME: "SSO\nInjected" },
    { OIDC_ISSUER_URL: "http://identity.example.test" }, { OIDC_ISSUER_URL: "https://user:secret@identity.example.test" },
    { OIDC_ISSUER_URL: "https://identity.example.test/#fragment" }, { OIDC_SCOPES: "profile" },
    { OIDC_PKCE: "maybe" }, { OIDC_TOKEN_AUTH_METHOD: "none" },
    { OIDC_TOKEN_ENDPOINT: "https://identity.example.test/token" },
  ]) assert.throws(() => readEnvironmentOidcConfig({ ...configured, ...override }))
  assert.throws(() => readEnvironmentOidcConfig({ ...configured, OIDC_ISSUER_URL: "http://127.0.0.1:9876" }))
  assert.ok(readEnvironmentOidcConfig({ ...configured, OIDC_ISSUER_URL: "http://127.0.0.1:9876" }, true))
  assert.throws(() => readEnvironmentOidcConfig({ ...configured, OIDC_ISSUER_URL: "http://private.example.test" }, true))
})

test("real code callback validates discovery, signature, audience, issuer, expiry, nonce and verified email before creating accounts", async (t) => {
  const keys = await generateKeyPair("RS256")
  const attackerKeys = await generateKeyPair("RS256")
  const jwk = { ...await exportJWK(keys.publicKey), kid: "fixture-key", alg: "RS256", use: "sig" }
  let issuer = ""
  let discoveryIssuer: string | undefined
  let incompleteDiscovery = false
  let mode = "valid"
  let nonce = ""
  let subject = "fixture-subject"
  let email = "member@example.test"
  let identityAllowed = true
  let exchanges = 0
  let discoveries = 0
  let codeVerifierObserved = false
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url === "/.well-known/openid-configuration") {
      discoveries++
      response.end(JSON.stringify({ issuer: discoveryIssuer ?? issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        ...(incompleteDiscovery ? {} : { jwks_uri: `${issuer}/jwks`, id_token_signing_alg_values_supported: ["RS256"] }) }))
    } else if (request.url === "/jwks") response.end(JSON.stringify({ keys: [jwk] }))
    else if (request.url === "/token") {
      let body = ""
      for await (const chunk of request) body += chunk
      codeVerifierObserved = Boolean(new URLSearchParams(body).get("code_verifier"))
      exchanges++
      const builder = new SignJWT({ email, email_verified: mode === "unverified" ? false : mode === "string-verified" ? "true" : true,
        nonce: mode === "nonce" ? "wrong-nonce" : nonce, name: "Fixture Member",
        ...(mode === "azp" ? { azp: "wrong-party" } : {}) })
        .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
        .setSubject(subject).setIssuer(mode === "issuer" ? `${issuer}/wrong` : issuer)
        .setAudience(mode === "audience" ? "wrong-client" : mode === "multi-audience" ? ["fixture-client", "other-client"] : "fixture-client")
      if (mode !== "missing-iat") builder.setIssuedAt()
      if (mode !== "missing-exp") builder.setExpirationTime(mode === "expired" ? "-1h" : "5m")
      const token = await builder.sign(mode === "signature" ? attackerKeys.privateKey : keys.privateKey)
      response.end(JSON.stringify({ access_token: "fixture-access-token", token_type: "Bearer", expires_in: 300,
        ...(mode === "missing-token" ? {} : { id_token: token }) }))
    } else { response.statusCode = 404; response.end("{}") }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  issuer = `http://127.0.0.1:${address.port}`
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const config = readEnvironmentOidcConfig({ ...configured, OIDC_ISSUER_URL: issuer }, true)
  assert.ok(config)
  discoveryIssuer = `${issuer}/other`
  await assert.rejects(discoverEnvironmentOidc(config), /issuer does not match/)
  discoveryIssuer = undefined
  incompleteDiscovery = true
  await assert.rejects(discoverEnvironmentOidc(config))
  incompleteDiscovery = false
  discoveries = 0
  const data: Record<string, unknown[]> = { user: [], account: [], session: [], verification: [] }
  const auth = betterAuth({
    baseURL: "http://localhost:9987", secret: "test-only-secret-that-is-at-least-32-characters",
    database: memoryAdapter(data),
    plugins: [environmentOidcPlugin(config, async () => identityAllowed)],
    trustedOrigins: ["http://localhost:9987"],
  })
  await auth.$context
  assert.equal(discoveries, 0, "optional provider must not contact its IdP while booting or serving existing sessions")
  let replayRequest: Request | null = null
  async function callback() {
    const start = await auth.handler(new Request("http://localhost:9987/api/auth/sign-in/social", {
      method: "POST", headers: { origin: "http://localhost:9987", "content-type": "application/json" },
      body: JSON.stringify({ provider: config.providerId, callbackURL: "http://localhost:9987/done" }),
    }))
    assert.equal(start.status, 200)
    const startBody = await start.json()
    const url = new URL(startBody.url)
    assert.equal(url.searchParams.get("code_challenge_method"), "S256")
    assert.ok(url.searchParams.get("code_challenge"))
    nonce = url.searchParams.get("nonce") ?? ""
    assert.ok(nonce)
    const callbackUrl = new URL(url.searchParams.get("redirect_uri") ?? "")
    callbackUrl.searchParams.set("state", url.searchParams.get("state") ?? "")
    callbackUrl.searchParams.set("code", "fixture-code")
    const request = new Request(callbackUrl, { headers: { cookie: start.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ") } })
    replayRequest = request.clone()
    return auth.handler(request)
  }
  for (mode of ["signature", "audience", "issuer", "expired", "nonce", "unverified", "string-verified", "missing-token", "missing-exp", "missing-iat", "azp", "multi-audience"]) {
    const response = await callback()
    assert.equal(response.status, 302, mode)
    assert.equal(data.session.length, 0, mode)
    assert.equal(data.user.length, 0, mode)
    assert.equal(data.account.length, 0, mode)
  }
  mode = "valid"
  identityAllowed = false
  await callback()
  assert.equal(data.user.length, 0, "policy rejection must precede account mutation")
  identityAllowed = true
  const response = await callback()
  assert.equal(response.headers.get("location"), "http://localhost:9987/done")
  assert.equal(data.user.length, 1)
  assert.equal(data.account.length, 1)
  assert.equal(data.session.length, 1)
  assert.ok(response.headers.getSetCookie().some((entry) => entry.includes("session_token=")))
  assert.ok(replayRequest)
  await auth.handler(replayRequest)
  assert.equal(data.session.length, 1, "a consumed state must not issue another session")
  await callback()
  assert.equal(data.user.length, 1, "repeat sign-in must reuse the subject")
  assert.equal(data.account.length, 1)
  subject = "second-subject"
  email = "second@example.test"
  await callback()
  assert.equal(data.user.length, 2, "another subject creates a separate account")
  assert.equal(data.account.length, 2)
  subject = "third-subject"
  await callback()
  assert.equal(data.user.length, 2, "a matching verified local user links rather than duplicating the user")
  assert.equal(data.account.length, 3)
  assert.ok(codeVerifierObserved)
  assert.ok(exchanges >= 12)
  assert.equal(discoveries, 1, "validated metadata is reused across requests")
})
