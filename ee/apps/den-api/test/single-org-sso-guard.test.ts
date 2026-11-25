import assert from "node:assert/strict"
import { test } from "node:test"
import { isBetterAuthEmailOtpSignInRequest, isBetterAuthEmailPasswordRequest } from "../src/routes/auth/request-matchers.js"

/** In single_org mode with SSO required, the guard must recognize every sign-in that issues a session. */

function post(path: string) {
  return new Request(`http://den.local/api/auth${path}`, { method: "POST" })
}

test("recognizes email OTP sign-in requests", () => {
  assert.equal(isBetterAuthEmailOtpSignInRequest(post("/sign-in/email-otp")), true)
  assert.equal(isBetterAuthEmailOtpSignInRequest(post("/sign-in/email")), false)
  assert.equal(isBetterAuthEmailOtpSignInRequest(new Request("http://den.local/api/auth/sign-in/email-otp", { method: "GET" })), false)
})

test("still recognizes email/password sign-in, not email OTP", () => {
  assert.equal(isBetterAuthEmailPasswordRequest(post("/sign-in/email")), true)
  assert.equal(isBetterAuthEmailPasswordRequest(post("/sign-in/email-otp")), false)
})
