import assert from "node:assert/strict"
import test from "node:test"
import { LAST_SIGN_IN_METHOD_COOKIE, lastSignInCookieChange, lastSignInCookieWrites, readLastSignInMethod } from "../src/last-sign-in.js"

test("password and Google or GitHub sign-ins are remembered; SSO sign-ins forget", () => {
  assert.deepEqual(lastSignInCookieChange({ path: "/sign-in/email", provider: null, signedIn: true }), { type: "remember", method: "password" })
  assert.deepEqual(lastSignInCookieChange({ path: "/callback/:id", provider: " GitHub ", signedIn: true }), { type: "remember", method: "github" })
  assert.deepEqual(lastSignInCookieChange({ path: "/sso/saml2/sp/acs/:providerId", provider: null, signedIn: true }), { type: "forget" })
  assert.equal(lastSignInCookieChange({ path: "/sign-in/social", provider: "apple", signedIn: true }), null)
  assert.equal(lastSignInCookieChange({ path: "/sign-in/email", provider: null, signedIn: false }), null)
})

test("forgetting expires the cookie on the host and on the shared cookie domain", () => {
  const writes = lastSignInCookieWrites({ type: "forget" }, { secure: true, cookieDomain: ".OpenWork.example" })
  assert.deepEqual(writes.map((write) => [write.value, write.options.maxAge, write.options.domain]), [["", 0, undefined], ["", 0, "openwork.example"]])
  const [remember] = lastSignInCookieWrites({ type: "remember", method: "google" }, { secure: false })
  assert.equal(remember?.name, LAST_SIGN_IN_METHOD_COOKIE)
  assert.equal(remember?.options.httpOnly, false)
})

test("Den web reads only a known method from the cookie header", () => {
  assert.equal(readLastSignInMethod(`theme=dark; ${LAST_SIGN_IN_METHOD_COOKIE}=github; other=1`), "github")
  assert.equal(readLastSignInMethod(`${LAST_SIGN_IN_METHOD_COOKIE}=sso`), null)
  assert.equal(readLastSignInMethod(`x${LAST_SIGN_IN_METHOD_COOKIE}=google`), null)
  assert.equal(readLastSignInMethod(""), null)
})
