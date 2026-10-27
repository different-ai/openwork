import assert from "node:assert/strict"
import { after, test } from "node:test"
import { orgDiagnosticsSchema } from "@openwork/types/den/diagnostics"
import { bootDen, field, summary, text, type Session } from "./harness.js"

const email = "ordinary-single-org-owner@example.test"
const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "self_hosted",
  DEN_ORG_MODE: "single_org",
  DEN_SINGLE_ORG_OWNER_EMAILS: email,
  DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true",
  DEN_BOOTSTRAP_ADMIN_EMAILS: "",
  DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: "",
} })
after(() => den.close())

test("real MySQL: ordinary single-org owner bootstrap and org admin never acquire installation authority", async () => {
  const deployment = await den.request(null, "GET", "/v1/features")
  assert.equal(deployment.status, 200, summary(deployment))
  assert.equal(field(deployment.body, "deployment"), "self_hosted")

  // Deliberately use ordinary signup: no /setup verification or bootstrapGrant.
  const signedUp = await den.request(null, "POST", "/api/auth/sign-up/email", { body: {
    email, name: "Ordinary Singleton Owner", password: den.password,
  } })
  assert.equal(signedUp.status, 200, summary(signedUp))
  const signedIn = await den.signIn(email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  const owner: Session = {
    email, name: "Ordinary Singleton Owner",
    token: text(field(signedIn.body, "token"), "owner session token"),
    cookie: signedIn.headers.get("set-cookie")?.split(";")[0] ?? "",
    userId: text(field(signedIn.body, "user", "id"), "owner user id"),
  }
  const singleton = await den.request(owner.token, "GET", "/v1/org")
  assert.equal(singleton.status, 200, summary(singleton))
  const orgId = text(field(singleton.body, "organization", "id"), "singleton organization id")
  assert.equal(field(singleton.body, "currentMember", "role"), "owner", "eligible ordinary account bootstraps the singleton owner")

  // Single-org signup joins the existing singleton; promote through the real API.
  const admin = await den.signUp("Ordinary Singleton Admin")
  const memberId = await den.memberIdOf(owner, orgId, admin.email)
  const promoted = await den.as(owner, orgId)("POST", `/v1/members/${memberId}/role`, { role: "admin" })
  assert.equal(promoted.status, 200, summary(promoted))
  const adminSignIn = await den.signIn(admin.email)
  assert.equal(adminSignIn.status, 200, summary(adminSignIn))
  admin.token = text(field(adminSignIn.body, "token"), "fresh admin session token")
  admin.cookie = adminSignIn.headers.get("set-cookie")?.split(";")[0] ?? ""

  for (const [person, role] of [[owner, "owner"], [admin, "admin"]] as const) {
    const context = await den.as(person, orgId)("GET", "/v1/org")
    assert.equal(context.status, 200, summary(context))
    assert.equal(field(context.body, "currentMember", "role"), role)
    assert.equal(field(context.body, "canManageDeploymentServices"), false, `${role} is not a local installation operator`)
    const read = await den.as(person, orgId)("GET", "/v1/org/diagnostics")
    assert.equal(read.status, 200, summary(read))
    const body = orgDiagnosticsSchema.parse(read.body)
    assert.deepEqual(body.installation, { access: "locked", reason: "installation_admin_required" }, `${role}: organization roles never grant installation authority`)
    assert.equal(body.desktop.access, "granted", `${role} still sees organization sections`)
    const check = await den.as(person, orgId)("POST", "/v1/org/diagnostics/check")
    assert.ok(check.status === 202 || check.status === 429, summary(check))
    assert.equal(orgDiagnosticsSchema.parse(check.body).installation.access, "locked")
    const platform = await den.request(person.token, "GET", "/v1/admin/services")
    assert.equal(platform.status, 403, `${role} did not gain installation allowlist authority: ${summary(platform)}`)
  }
})
