/**
 * The /setup administrator signs up with an operator-configured email and the
 * one-time setup code, so Den records the email as verified. Without that, the
 * SSO connection test's account linking treats the account as unproven,
 * deletes its password and signs it out (see account-linking-policy.ts).
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary, text } from "./harness.js"

const email = "setup-sso-operator@example.test"
const code = "email-verified-one-time-setup-code-not-production"
const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "self_hosted",
  DEN_BOOTSTRAP_ADMIN_EMAILS: "",
  DEN_SINGLE_ORG_OWNER_EMAILS: email,
  DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: code,
  DEN_REQUIRE_EMAIL_VERIFICATION: "false",
} })
after(() => den.close())

async function emailVerified(userId: string) {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("emailVerified needs MySQL mode")
  const [rows] = await client.query("SELECT email_verified FROM user WHERE id = ?", [userId])
  return Array.isArray(rows) ? Boolean(field(rows[0], "email_verified")) : null
}

test("real MySQL: the /setup administrator's email is verified; an ordinary sign-up's is not", async () => {
  const verified = await den.request(null, "POST", "/v1/auth/bootstrap/verify", { body: { email, code } })
  assert.equal(verified.status, 200, summary(verified))
  const signedUp = await den.request(null, "POST", "/api/auth/sign-up/email", { body: {
    email, name: "Setup SSO Operator", password: den.password, bootstrapGrant: text(field(verified.body, "grant"), "bootstrap grant"),
  } })
  assert.equal(signedUp.status, 200, summary(signedUp))
  assert.equal(await emailVerified(text(field(signedUp.body, "user", "id"), "setup user id")), true)

  const ordinary = await den.signUp("Ordinary Member")
  assert.equal(await emailVerified(ordinary.userId), false)
})
