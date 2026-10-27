import assert from "node:assert/strict"
import test from "node:test"
import {
  LAST_SIGN_IN_METHOD_COOKIE,
  LAST_SIGN_IN_METHOD_MAX_AGE_SECONDS,
  lastSignInCookieChange,
  lastSignInCookieWrites,
} from "../src/last-sign-in-method.js"

test("password and social sign-ins are remembered, SSO sign-ins forget", () => {
  assert.deepEqual(lastSignInCookieChange({ path: "/sign-in/email", provider: null, signedIn: true }), { type: "remember", method: "password" })
  assert.deepEqual(lastSignInCookieChange({ path: "/sign-up/email", provider: null, signedIn: true }), { type: "remember", method: "password" })
  assert.deepEqual(lastSignInCookieChange({ path: "/callback/:id", provider: "google", signedIn: true }), { type: "remember", method: "google" })
  assert.deepEqual(lastSignInCookieChange({ path: "/callback/:id", provider: "GitHub", signedIn: true }), { type: "remember", method: "github" })
  assert.deepEqual(lastSignInCookieChange({ path: "/sign-in/social", provider: "google", signedIn: true }), { type: "remember", method: "google" })
  assert.deepEqual(lastSignInCookieChange({ path: "/sso/callback/:providerId", provider: null, signedIn: true }), { type: "forget" })
  assert.deepEqual(lastSignInCookieChange({ path: "/sso/saml2/sp/acs/:providerId", provider: null, signedIn: true }), { type: "forget" })
})

test("nothing changes without a new session or for other providers and paths", () => {
  assert.equal(lastSignInCookieChange({ path: "/sign-in/email", provider: null, signedIn: false }), null, "a failed password attempt")
  assert.equal(lastSignInCookieChange({ path: "/sso/callback/:providerId", provider: null, signedIn: false }), null, "a failed SSO attempt keeps the cookie")
  assert.equal(lastSignInCookieChange({ path: "/callback/:id", provider: "microsoft", signedIn: true }), null)
  assert.equal(lastSignInCookieChange({ path: "/callback/:id", provider: null, signedIn: true }), null)
  assert.equal(lastSignInCookieChange({ path: "/get-session", provider: null, signedIn: true }), null)
})

test("remembering writes one long-lived cookie the browser can read", () => {
  assert.deepEqual(lastSignInCookieWrites({ type: "remember", method: "github" }, { secure: true, cookieDomain: ".OpenWork.example" }), [{
    name: LAST_SIGN_IN_METHOD_COOKIE,
    value: "github",
    options: { path: "/", sameSite: "lax", secure: true, httpOnly: false, maxAge: LAST_SIGN_IN_METHOD_MAX_AGE_SECONDS, domain: "openwork.example" },
  }])
  const [hostOnly] = lastSignInCookieWrites({ type: "remember", method: "password" }, { secure: false, cookieDomain: null })
  assert.equal(hostOnly?.options.domain, undefined)
  assert.equal(hostOnly?.options.secure, false)
})

test("forgetting expires the host-only and the shared-domain cookie", () => {
  const writes = lastSignInCookieWrites({ type: "forget" }, { secure: true, cookieDomain: "openwork.example" })
  assert.equal(writes.length, 2)
  assert.ok(writes.every((write) => write.name === LAST_SIGN_IN_METHOD_COOKIE && write.value === "" && write.options.maxAge === 0))
  assert.deepEqual(writes.map((write) => write.options.domain), [undefined, "openwork.example"])
  assert.equal(lastSignInCookieWrites({ type: "forget" }, { secure: true }).length, 1)
})
