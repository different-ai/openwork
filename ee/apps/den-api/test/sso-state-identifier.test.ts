/**
 * The SSO connection test finds its intent by reading the relay state Better
 * Auth stored when sign-in started. Starts a real Better Auth SSO sign-in and
 * checks the stored row is under the key Den looks up. OIDC and SAML share
 * Better Auth's generateGenericState, so this covers both.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { sso } from "@better-auth/sso"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { ssoStateVerificationIdentifier } from "../src/sso-state-identifier.js"

const BASE_URL = "http://localhost:3000"
const IDP_ORIGIN = "http://127.0.0.1:9"
const PROVIDER_ID = "acme"

const auth = betterAuth({
  baseURL: BASE_URL,
  secret: "synthetic-sso-state-test-secret-not-production",
  trustedOrigins: [IDP_ORIGIN],
  database: memoryAdapter({ user: [], session: [], account: [], verification: [], ssoProvider: [] }),
  plugins: [sso({ domainVerification: { enabled: true } })],
})
const context = await auth.$context
await context.adapter.create({
  model: "ssoProvider",
  data: {
    providerId: PROVIDER_ID,
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

test("Den looks up SSO relay state under the key Better Auth stores it with", async () => {
  const callbackURL = "/sso/test/complete?openworkSsoTest=synthetic-intent"
  const started = await auth.handler(new Request(`${BASE_URL}/api/auth/sign-in/sso`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({ providerId: PROVIDER_ID, callbackURL }),
  }))
  assert.equal(started.status, 200, await started.clone().text())
  const body: unknown = await started.json()
  const url = typeof body === "object" && body !== null ? Reflect.get(body, "url") : null
  const state = new URL(typeof url === "string" ? url : "").searchParams.get("state")
  assert.ok(state, "sign-in returned a state")

  const stored = await context.internalAdapter.findVerificationValue(ssoStateVerificationIdentifier(state))
  assert.ok(stored, "relay state is stored under ssoStateVerificationIdentifier(state)")
  assert.ok(stored.value.includes("openworkSsoTest=synthetic-intent"), "the stored state carries the test intent")
})
