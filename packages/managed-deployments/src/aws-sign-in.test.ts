import assert from "node:assert/strict"
import { test } from "node:test"
import { cloudShellUrl, consoleUrl, throughAccessPortal } from "@openwork/managed-deployments/aws"
import { awsPortalBase, awsSignInInputSchema, awsSignInSchema } from "@openwork/managed-deployments/schema"

test("an access portal address is normalized to its sign-in base", () => {
  assert.equal(awsPortalBase("https://acme.awsapps.com/start"), "https://acme.awsapps.com/start")
  assert.equal(awsPortalBase(" https://acme.awsapps.com/start/ "), "https://acme.awsapps.com/start")
  assert.equal(awsPortalBase("https://acme.awsapps.com/start/#/"), "https://acme.awsapps.com/start")
  assert.equal(awsPortalBase("https://acme.awsapps.com"), "https://acme.awsapps.com/start")
  assert.equal(awsPortalBase("https://ssoins-1234abcd.portal.us-east-1.app.aws"), "https://ssoins-1234abcd.portal.us-east-1.app.aws")
})

test("only AWS-hosted portal addresses are accepted", () => {
  for (const value of [
    "http://acme.awsapps.com/start", "https://acme.example.com/start", "https://awsapps.com.example.com/start",
    "https://acme.awsapps.com.evil.test/start", "https://user@acme.awsapps.com/start", "https://acme.awsapps.com:8443/start",
    "https://acme.awsapps.com/start?next=https://example.com", "acme.awsapps.com/start", "",
  ]) assert.equal(awsPortalBase(value), null, value)
})

test("a saved sign-in keeps the normalized portal and rejects an unusable role", () => {
  assert.deepEqual(awsSignInSchema.parse({ portalUrl: "https://acme.awsapps.com/start/", roleName: " AdministratorAccess " }), {
    portalUrl: "https://acme.awsapps.com/start", roleName: "AdministratorAccess",
  })
  for (const roleName of ["Admin Access", "Admin/Access", "a".repeat(65)]) {
    assert.equal(awsSignInSchema.safeParse({ portalUrl: "https://acme.awsapps.com/start", roleName }).success, false)
  }
  assert.equal(awsSignInSchema.safeParse({ portalUrl: "https://example.com/start", roleName: "AdministratorAccess" }).success, false)
  assert.deepEqual(awsSignInInputSchema.parse({ awsSignIn: null }), { awsSignIn: null })
})

test("a sign-in needs only a portal URL and normalizes empty roles to null", () => {
  const portalUrl = "https://acme.awsapps.com/start"
  for (const awsSignIn of [{ portalUrl }, { portalUrl, roleName: "" }, { portalUrl, roleName: " \t " }, { portalUrl, roleName: null }]) {
    assert.deepEqual(awsSignInInputSchema.parse({ awsSignIn }), { awsSignIn: { portalUrl, roleName: null } })
  }
})

test("a portal link without a saved role asks AWS to choose it", () => {
  const destination = cloudShellUrl("us-east-1")
  const wrapped = throughAccessPortal(destination, "123456789012", { portalUrl: "https://acme.awsapps.com/start", roleName: null })
  const params = new URLSearchParams(wrapped.slice(wrapped.indexOf("?") + 1))
  assert.equal(params.has("role_name"), false)
  assert.equal(params.get("account_id"), "123456789012")
  assert.equal(params.get("destination"), destination)
})

test("an AWS link opens through the portal in the deployment's account, and unchanged without a sign-in", () => {
  const destination = consoleUrl("11111111-2222-4333-8444-555555555555", "us-east-1")
  assert.equal(throughAccessPortal(destination, "123456789012", null), destination)
  const wrapped = throughAccessPortal(destination, "123456789012", { portalUrl: "https://acme.awsapps.com/start", roleName: "AdministratorAccess" })
  assert.ok(wrapped.startsWith("https://acme.awsapps.com/start/#/console?"))
  const params = new URLSearchParams(wrapped.slice(wrapped.indexOf("?") + 1))
  assert.equal(params.get("account_id"), "123456789012")
  assert.equal(params.get("role_name"), "AdministratorAccess")
  assert.equal(params.get("destination"), destination)
  assert.equal(cloudShellUrl("eu-west-1"), "https://eu-west-1.console.aws.amazon.com/cloudshell/home?region=eu-west-1")
})
