/**
 * The public login preflight may offer Google alongside a password, but only
 * with a deployment rollout and a configured Google provider. This is a UI
 * hint, never permission to link accounts: account-linking-policy.test.ts
 * separately proves Google refuses an unverified password account.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen({ env: {
  GOOGLE_CLIENT_ID: "synthetic-google-client",
  GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
  DEN_FEATURE_PASSWORD_SIGN_IN_GOOGLE: "",
} })
after(() => den.close())

const { env } = await import("../../src/env.js")
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("needs MySQL mode")

const person = await den.signUp("Password Person")
const { orgId } = await den.createOrg(person, "Password sign-in workspace")
let ipCounter = 0

async function loginOptions(email = person.email) {
  ipCounter += 1
  const response = await den.request(null, "GET", `/v1/auth/login-options?${new URLSearchParams({ email })}`, {
    headers: { "x-forwarded-for": `203.0.113.${ipCounter}` },
  })
  assert.equal(response.status, 200, summary(response))
  return response.body
}

async function rollout(body: { enabled?: boolean; killed?: boolean }) {
  const response = await den.asPlatformAdmin("PUT", "/v1/admin/features/passwordSignInGoogle", body)
  assert.equal(response.status, 200, summary(response))
}

function noGoogleOffer(body: unknown) {
  const offered = field(body, "offerGoogleOnPassword")
  assert.ok(offered === undefined || offered === false, "Google must not be offered")
}

test("default off: an organization override cannot offer Google on the public password step", async () => {
  const baseline = await loginOptions()
  assert.equal(field(baseline, "nextStep"), "password")
  noGoogleOffer(baseline)

  const changed = await den.setFeature(orgId, "passwordSignInGoogle", true)
  assert.equal(changed.status, 200, summary(changed))
  noGoogleOffer(await loginOptions())
})

test("deployment rollout offers Google on password even when the organization override is off", async () => {
  const changed = await den.setFeature(orgId, "passwordSignInGoogle", false)
  assert.equal(changed.status, 200, summary(changed))
  await rollout({ enabled: true, killed: false })

  const options = await loginOptions()
  assert.equal(field(options, "nextStep"), "password")
  assert.equal(field(options, "offerGoogleOnPassword"), true)
})

test("the deployment kill switch removes the offer immediately and can restore it", async () => {
  await rollout({ enabled: true, killed: true })
  const killed = await loginOptions()
  assert.equal(field(killed, "nextStep"), "password")
  noGoogleOffer(killed)

  await rollout({ killed: false })
  assert.equal(field(await loginOptions(), "offerGoogleOnPassword"), true)
})

test("both Google credentials are needed before the password step offers Google", async () => {
  await rollout({ enabled: true, killed: false })
  const original = { ...env.google }
  try {
    for (const missing of ["clientId", "clientSecret"]) {
      Object.assign(env.google, original, { [missing]: undefined })
      const options = await loginOptions()
      assert.equal(field(options, "nextStep"), "password")
      noGoogleOffer(options)
    }
  } finally {
    Object.assign(env.google, original)
  }
})

test("Google-linked accounts keep Google priority, and a new email keeps new-account routing", async () => {
  await rollout({ enabled: true, killed: false })
  const linked = await den.signUp("Google Linked")
  // ARRANGE ONLY: a password account that previously linked Google successfully.
  await client.execute(
    "INSERT INTO account (id, user_id, account_id, provider_id) VALUES (?, ?, ?, 'google')",
    [createDenTypeId("account"), linked.userId, `synthetic-google-${den.stamp}`],
  )
  const google = await loginOptions(linked.email)
  assert.equal(field(google, "nextStep"), "google")
  noGoogleOffer(google)

  const fresh = await loginOptions(`new-${den.stamp}@example.test`)
  assert.equal(field(fresh, "nextStep"), "new_account")
  noGoogleOffer(fresh)
})

test("offering Google does not verify or link an unverified password account", async () => {
  await rollout({ enabled: true, killed: false })
  const [before] = await client.query("SELECT email_verified FROM user WHERE id = ?", [person.userId])
  assert.equal(Array.isArray(before) && Boolean(field(before[0], "email_verified")), false)

  assert.equal(field(await loginOptions(), "offerGoogleOnPassword"), true)

  const [after] = await client.query("SELECT email_verified FROM user WHERE id = ?", [person.userId])
  assert.deepEqual(after, before)
  const [accounts] = await client.query("SELECT provider_id FROM account WHERE user_id = ?", [person.userId])
  assert.ok(Array.isArray(accounts))
  assert.deepEqual(accounts.map((row) => field(row, "provider_id")), ["credential"])
  const signedIn = await den.signIn(person.email)
  assert.equal(signedIn.status, 200, summary(signedIn))
})

test("Google authorization carries the submitted email as login_hint", async () => {
  const started = await den.request(null, "POST", "/api/auth/sign-in/social", {
    body: { provider: "google", loginHint: person.email, callbackURL: "http://localhost:3005/" },
  })
  assert.equal(started.status, 200, summary(started))
  const authorization = new URL(text(field(started.body, "url"), "Google authorization URL"))
  assert.equal(authorization.origin, "https://accounts.google.com")
  assert.equal(authorization.searchParams.get("login_hint"), person.email)
})

test("SSO responses stay unchanged, including when password is the SSO alternative", async () => {
  const domain = `sso-${den.stamp}.example`
  const member = await den.signUp("Sso Password", `member-${den.stamp}@${domain}`)
  const providerId = `sso-${createDenTypeId("ssoProvider")}`
  // ARRANGE ONLY: an enabled connection on a verified domain, not an OAuth callback.
  await client.execute(
    "INSERT INTO sso_provider (id, issuer, domain, user_id, provider_id, organization_id, domain_verified) VALUES (?, ?, ?, ?, ?, ?, 1)",
    [createDenTypeId("ssoProvider"), "https://idp.example.test", domain, person.userId, providerId, orgId],
  )
  await client.execute(
    "INSERT INTO sso_connection (id, organization_id, provider_id, kind, issuer, domain, status, sign_in_path) VALUES (?, ?, ?, 'oidc', ?, ?, 'enabled', ?)",
    [createDenTypeId("ssoConnection"), orgId, providerId, "https://idp.example.test", domain, `/sso/test-${den.stamp}`],
  )
  for (const perOrganization of [false, true]) {
    const changed = await den.setFeature(orgId, "ssoPerOrganization", perOrganization)
    assert.equal(changed.status, 200, summary(changed))
    await rollout({ enabled: false, killed: false })
    const before = await loginOptions(member.email)
    assert.equal(field(before, "nextStep"), "sso")
    if (perOrganization) assert.equal(field(before, "alternativeStep"), "password")

    await rollout({ enabled: true })
    const after = await loginOptions(member.email)
    assert.deepEqual(after, before)
    noGoogleOffer(after)
  }
})
