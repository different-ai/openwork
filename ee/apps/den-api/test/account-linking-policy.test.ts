/**
 * Account linking through a real Better Auth instance with Den's account and
 * user options: password sign-up, Google id-token sign-in, and the SSO
 * plugin's real OIDC callback against a stand-in identity provider.
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { after, test } from "node:test"
import { sso } from "@better-auth/sso"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { DEN_ACCOUNT_CONFIG, DEN_USER_CONFIG } from "../src/account-linking-policy.js"

const BASE_URL = "http://localhost:3000"
const PASSWORD = "Correct-Horse-Battery-Staple-42!"
const SSO_PROVIDER_ID = "acme"

// The stand-in identity provider issues the authorization code as the access
// token and answers userinfo for the email the code names.
const idp = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://idp.local")
  if (request.method === "POST" && url.pathname === "/token") {
    let body = ""
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      const code = new URLSearchParams(body).get("code") ?? ""
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ access_token: code, token_type: "Bearer", expires_in: 3600 }))
    })
    return
  }
  if (url.pathname === "/userinfo") {
    const email = request.headers.authorization?.replace(/^Bearer /, "") ?? ""
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ sub: `sso-${email}`, email, email_verified: true, name: "Synthetic Person" }))
    return
  }
  response.writeHead(404).end()
})
await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve))
after(() => new Promise<void>((resolve) => idp.close(() => resolve())))
const address = idp.address()
if (!address || typeof address === "string") throw new Error("stand-in identity provider has no port")
const IDP_ORIGIN = `http://127.0.0.1:${address.port}`

const auth = betterAuth({
  baseURL: BASE_URL,
  secret: "synthetic-account-linking-test-secret-not-production",
  trustedOrigins: [IDP_ORIGIN],
  database: memoryAdapter({ user: [], session: [], account: [], verification: [], ssoProvider: [] }),
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: "synthetic-google-client",
      clientSecret: "synthetic-google-secret",
      verifyIdToken: async () => true,
      // The id token is the email Google vouches for.
      getUserInfo: async (token) => {
        const email = token.idToken ?? ""
        return { user: { id: `google-${email}`, email, emailVerified: true, name: "Synthetic Person" }, data: {} }
      },
    },
  },
  account: DEN_ACCOUNT_CONFIG,
  user: DEN_USER_CONFIG,
  plugins: [sso({ domainVerification: { enabled: true } })],
})
const context = await auth.$context
await context.adapter.create({
  model: "ssoProvider",
  data: {
    providerId: SSO_PROVIDER_ID,
    issuer: IDP_ORIGIN,
    domain: "acme.test",
    domainVerified: true,
    userId: "synthetic-sso-admin",
    oidcConfig: JSON.stringify({
      issuer: IDP_ORIGIN,
      clientId: "synthetic-acme-client",
      clientSecret: "synthetic-acme-secret",
      pkce: false,
      discoveryEndpoint: `${IDP_ORIGIN}/.well-known/openid-configuration`,
      authorizationEndpoint: `${IDP_ORIGIN}/authorize`,
      tokenEndpoint: `${IDP_ORIGIN}/token`,
      tokenEndpointAuthentication: "client_secret_post",
      userInfoEndpoint: `${IDP_ORIGIN}/userinfo`,
      jwksEndpoint: `${IDP_ORIGIN}/jwks`,
    }),
  },
})

function post(path: string, body: unknown, cookie?: string) {
  return auth.handler(new Request(`${BASE_URL}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }))
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

function stringField(value: unknown, key: string) {
  const entry = field(value, key)
  return typeof entry === "string" ? entry : null
}

async function signUpWithPassword(email: string) {
  const response = await post("/sign-up/email", { email, password: PASSWORD, name: "Synthetic Person" })
  assert.equal(response.status, 200)
  const body: unknown = await response.json()
  const token = stringField(body, "token")
  const userId = stringField(field(body, "user"), "id")
  assert.ok(token && userId)
  return { token, userId }
}

async function passwordSignInStatus(email: string) {
  return (await post("/sign-in/email", { email, password: PASSWORD })).status
}

async function signInWithGoogle(email: string) {
  const response = await post("/sign-in/social", { provider: "google", idToken: { token: email } })
  const body: unknown = await response.json()
  return { status: response.status, code: stringField(body, "code") }
}

/** Starts SSO sign-in, then completes the real OIDC callback; returns where it redirected. */
async function signInWithSso(email: string) {
  const started = await post("/sign-in/sso", { providerId: SSO_PROVIDER_ID, callbackURL: "/signed-in", errorCallbackURL: "/failed" })
  assert.equal(started.status, 200)
  const state = new URL(stringField(await started.json(), "url") ?? "").searchParams.get("state") ?? ""
  const cookie = started.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ")
  const callback = new URL(`${BASE_URL}/api/auth/sso/callback/${SSO_PROVIDER_ID}`)
  callback.search = new URLSearchParams({ code: email, state }).toString()
  const finished = await auth.handler(new Request(callback, { headers: { cookie } }))
  return new URL(finished.headers.get("location") ?? "", BASE_URL)
}

async function providerIds(userId: string) {
  return (await context.internalAdapter.findAccounts(userId)).map((account) => account.providerId).sort()
}

test("a Google sign-in never joins an unverified password account with the same email", async () => {
  const { userId } = await signUpWithPassword("pat@example.test")

  assert.deepEqual(await signInWithGoogle("pat@example.test"), { status: 403, code: "account_not_linked" })
  assert.deepEqual(await providerIds(userId), ["credential"])
  assert.equal((await context.internalAdapter.findUserById(userId))?.emailVerified, false)
})

test("a Google sign-in joins a password account whose email is verified", async () => {
  const { userId } = await signUpWithPassword("sam@example.test")
  await context.internalAdapter.updateUser(userId, { emailVerified: true })

  assert.equal((await signInWithGoogle("sam@example.test")).status, 200)
  assert.deepEqual(await providerIds(userId), ["credential", "google"])
})

test("a domain-verified SSO sign-in takes over an unverified password account: its password and sessions are gone", async () => {
  const { token, userId } = await signUpWithPassword("lee@acme.test")
  assert.equal(await passwordSignInStatus("lee@acme.test"), 200)

  const landed = await signInWithSso("lee@acme.test")
  assert.equal(landed.pathname, "/signed-in", landed.href)
  assert.deepEqual(await providerIds(userId), [SSO_PROVIDER_ID])
  assert.equal(await passwordSignInStatus("lee@acme.test"), 401)
  assert.equal(await context.internalAdapter.findSession(token), null)
  assert.equal((await context.internalAdapter.listSessions(userId)).length, 1, "only the SSO session remains")
})

test("a domain-verified SSO sign-in joins a verified password account and keeps its password", async () => {
  const { userId } = await signUpWithPassword("kim@acme.test")
  await context.internalAdapter.updateUser(userId, { emailVerified: true })

  assert.equal((await signInWithSso("kim@acme.test")).pathname, "/signed-in")
  assert.deepEqual(await providerIds(userId), [SSO_PROVIDER_ID, "credential"].sort())
  assert.equal(await passwordSignInStatus("kim@acme.test"), 200)
})

test("SSO never creates a user whose email is outside the provider's verified domain", async () => {
  const landed = await signInWithSso("outsider@other.test")
  assert.equal(landed.pathname, "/failed", landed.href)
  assert.equal(landed.searchParams.get("error"), "email_outside_sso_domain")
  assert.equal(await context.internalAdapter.findUserByEmail("outsider@other.test"), null)
})
