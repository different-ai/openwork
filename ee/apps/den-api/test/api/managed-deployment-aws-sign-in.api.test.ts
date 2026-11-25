import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { ManagedDeploymentAwsSignInTable, ManagedDeploymentTable } from "@openwork-ee/den-db/schema"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "cloud", DEN_MANAGED_DEPLOYMENT_AWS_VERSION: "1.0.2",
  DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: "https://releases.example.test/template.json",
  DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: "https://releases.example.test/bundle.tar.gz",
  DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: "a".repeat(64),
} })
after(() => den.close())
const org = await den.createOrg(await den.signUp("Deployment Owner"), "AWS sign-in workspace")
const member = await den.newMember(org.owner, org.orgId, "Deployment Member")
const foreign = await den.createOrg(await den.signUp("Other Owner"), "Other AWS sign-in workspace")
const owner = den.as(org.owner, org.orgId)
const other = den.as(foreign.owner, foreign.orgId)
for (const id of [org.orgId, foreign.orgId]) assert.equal((await den.setFeature(id, "managedDeployments", true)).status, 200)
const { db } = await import("../../src/db.js")
const SIGN_IN_PATH = "/v1/managed-deployments/aws-sign-in"
const signIn = { portalUrl: "https://acme.awsapps.com/start", roleName: "AdministratorAccess" }
const input = { provider: "aws", name: "Managed deployment", domainName: "openwork.example.test", ownerEmail: "admin@example.test", target: { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST", runtimeProfile: "legacy" } }

async function create(as = owner) {
  const call = await as("POST", "/v1/managed-deployments", input)
  assert.equal(call.status, 200, summary(call))
  return text(field(call.body, "id"), "deployment ID")
}
async function savedSignIn(as = owner) {
  const call = await as("GET", "/v1/managed-deployments/configuration")
  assert.equal(call.status, 200, summary(call))
  return field(call.body, "awsSignIn")
}
/** What the access portal is asked to open, and for which account and role. */
function portalRequest(url: string) {
  assert.ok(url.startsWith("https://acme.awsapps.com/start/#/console?"), url)
  const params = new URLSearchParams(url.slice(url.indexOf("?") + 1))
  return { account: params.get("account_id"), role: params.get("role_name"), destination: params.get("destination") ?? "" }
}

test("with the feature off the sign-in cannot be saved and AWS links are the plain console links", async () => {
  const refused = await owner("PUT", SIGN_IN_PATH, { awsSignIn: signIn })
  assert.equal(refused.status, 404, summary(refused))
  assert.equal(await savedSignIn(), null)
  const id = await create()
  const launch = await owner("POST", `/v1/managed-deployments/${id}/launch`, { kind: "install" })
  assert.equal(launch.status, 200, summary(launch))
  assert.ok(text(field(launch.body, "approvalUrl"), "approval URL").startsWith("https://us-east-1.console.aws.amazon.com/cloudformation/"))
  assert.equal(field(launch.body, "handoff", "directUrl"), null)
})

test("only someone who can manage deployments saves a sign-in, and only an AWS access portal is accepted", async () => {
  assert.equal((await den.setFeature(org.orgId, "managedDeploymentAwsSignIn", true)).status, 200)
  const denied = await den.as(member, org.orgId)("PUT", SIGN_IN_PATH, { awsSignIn: signIn })
  assert.equal(denied.status, 403, summary(denied))
  for (const awsSignIn of [
    { ...signIn, portalUrl: "https://acme.example.com/start" },
    { ...signIn, portalUrl: "https://acme.awsapps.com.example.com/start" },
    { ...signIn, portalUrl: "http://acme.awsapps.com/start" },
    { ...signIn, roleName: "Administrator Access" },
    { ...signIn, roleName: "Admin/Access" },
    { ...signIn, roleName: "a".repeat(65) },
  ]) {
    const invalid = await owner("PUT", SIGN_IN_PATH, { awsSignIn })
    assert.equal(invalid.status, 400, summary(invalid))
  }
  assert.equal(await savedSignIn(), null)
})

test("a saved sign-in opens the approval link, CloudShell and the stack through the portal in the deployment's account", async () => {
  const id = await create()
  const path = `/v1/managed-deployments/${id}/launch`
  const before = await owner("POST", path, { kind: "install" })
  assert.equal(before.status, 200, summary(before))
  const plain = text(field(before.body, "approvalUrl"), "plain approval URL")

  const saved = await owner("PUT", SIGN_IN_PATH, { awsSignIn: { portalUrl: " https://acme.awsapps.com/start/ ", roleName: signIn.roleName } })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "awsSignIn"), signIn)
  assert.deepEqual(await savedSignIn(), signIn)

  // Reopening the prepared approval is the same run, now through the portal.
  const reopened = await owner("POST", path, { kind: "install" })
  assert.equal(reopened.status, 200, summary(reopened))
  assert.equal(field(reopened.body, "deployment", "run", "id"), field(before.body, "deployment", "run", "id"))
  const approval = portalRequest(text(field(reopened.body, "approvalUrl"), "portal approval URL"))
  assert.deepEqual({ account: approval.account, role: approval.role }, { account: "123456789012", role: "AdministratorAccess" })
  assert.equal(approval.destination, plain)
  assert.equal(field(reopened.body, "handoff", "directUrl"), plain)
  assert.equal(field(reopened.body, "handoff", "url"), field(reopened.body, "approvalUrl"))
  assert.ok(text(field(reopened.body, "handoff", "instructions"), "instructions").includes("through your access portal as AdministratorAccess"))
  assert.ok(portalRequest(text(field(reopened.body, "deployment", "consoleUrl"), "stack URL")).destination.includes("/cloudformation/"))

  const listed = await owner("GET", "/v1/managed-deployments")
  assert.equal(listed.status, 200, summary(listed))
  const deployments = list(field(listed.body, "deployments"))
  assert.ok(deployments.length > 0)
  for (const deployment of deployments) assert.equal(portalRequest(text(field(deployment, "consoleUrl"), "listed stack URL")).account, "123456789012")

  // An installed deployment's update command runs in CloudShell, opened the same way.
  await db.update(ManagedDeploymentTable).set({ installed_version: "1.0.1", active_run_id: null }).where(eq(ManagedDeploymentTable.id, id))
  const update = await owner("POST", path, { kind: "update" })
  assert.equal(update.status, 200, summary(update))
  assert.equal(portalRequest(text(field(update.body, "handoff", "url"), "CloudShell URL")).destination, "https://us-east-1.console.aws.amazon.com/cloudshell/home?region=us-east-1")
  assert.equal(field(update.body, "handoff", "directUrl"), "https://us-east-1.console.aws.amazon.com/cloudshell/home?region=us-east-1")
})

test("a portal URL alone saves a null role and every AWS link leaves role selection to the portal", async () => {
  for (const awsSignIn of [
    { portalUrl: signIn.portalUrl },
    { portalUrl: signIn.portalUrl, roleName: "" },
    { portalUrl: signIn.portalUrl, roleName: " \t " },
    { portalUrl: signIn.portalUrl, roleName: null },
  ]) {
    const saved = await owner("PUT", SIGN_IN_PATH, { awsSignIn })
    assert.equal(saved.status, 200, summary(saved))
    assert.deepEqual(field(saved.body, "awsSignIn"), { portalUrl: signIn.portalUrl, roleName: null })
    assert.deepEqual(await savedSignIn(), { portalUrl: signIn.portalUrl, roleName: null })
    const [row] = await db.select().from(ManagedDeploymentAwsSignInTable).where(eq(ManagedDeploymentAwsSignInTable.org_id, org.orgId))
    assert.equal(row?.role_name, "")
  }

  const id = await create()
  const path = `/v1/managed-deployments/${id}/launch`
  const install = await owner("POST", path, { kind: "install" })
  assert.equal(install.status, 200, summary(install))
  const approval = portalRequest(text(field(install.body, "approvalUrl"), "approval URL"))
  assert.deepEqual({ account: approval.account, role: approval.role }, { account: "123456789012", role: null })
  assert.ok(approval.destination.startsWith("https://us-east-1.console.aws.amazon.com/cloudformation/"))
  assert.equal(field(install.body, "handoff", "directUrl"), approval.destination)
  assert.ok(text(field(install.body, "handoff", "instructions"), "instructions").includes("through your access portal, where you choose your role, then opens the installer"))

  const listed = await owner("GET", "/v1/managed-deployments")
  assert.equal(listed.status, 200, summary(listed))
  for (const deployment of list(field(listed.body, "deployments"))) {
    const stack = portalRequest(text(field(deployment, "consoleUrl"), "stack URL"))
    assert.equal(stack.role, null)
    assert.equal(stack.account, "123456789012")
    assert.ok(stack.destination.includes("/cloudformation/"))
  }

  await db.update(ManagedDeploymentTable).set({ installed_version: "1.0.1", active_run_id: null }).where(eq(ManagedDeploymentTable.id, id))
  const update = await owner("POST", path, { kind: "update" })
  assert.equal(update.status, 200, summary(update))
  const shell = portalRequest(text(field(update.body, "handoff", "url"), "CloudShell URL"))
  assert.deepEqual(shell, { account: "123456789012", role: null, destination: "https://us-east-1.console.aws.amazon.com/cloudshell/home?region=us-east-1" })
  assert.equal(field(update.body, "handoff", "directUrl"), shell.destination)
  assert.ok(text(field(update.body, "handoff", "instructions"), "instructions").includes("where you choose your role"))
  assert.equal((await owner("PUT", SIGN_IN_PATH, { awsSignIn: signIn })).status, 200)
})

test("the sign-in belongs to one organization, stops applying when the feature is off, and can be removed", async () => {
  assert.equal(await savedSignIn(other), null)
  const foreignId = await create(other)
  const foreignLaunch = await other("POST", `/v1/managed-deployments/${foreignId}/launch`, { kind: "install" })
  assert.ok(text(field(foreignLaunch.body, "approvalUrl"), "other organization's approval URL").startsWith("https://us-east-1.console.aws.amazon.com/"))

  assert.equal((await den.setFeature(org.orgId, "managedDeploymentAwsSignIn", false)).status, 200)
  assert.equal(await savedSignIn(), null)
  const offId = await create()
  const offLaunch = await owner("POST", `/v1/managed-deployments/${offId}/launch`, { kind: "install" })
  assert.equal(offLaunch.status, 200, summary(offLaunch))
  assert.equal(field(offLaunch.body, "handoff", "directUrl"), null)
  assert.ok(text(field(offLaunch.body, "approvalUrl"), "feature-off approval URL").startsWith("https://us-east-1.console.aws.amazon.com/cloudformation/"))
  const off = await owner("GET", "/v1/managed-deployments")
  for (const deployment of list(field(off.body, "deployments"))) assert.ok(text(field(deployment, "consoleUrl"), "stack URL").startsWith("https://us-east-1.console.aws.amazon.com/"))

  assert.equal((await den.setFeature(org.orgId, "managedDeploymentAwsSignIn", true)).status, 200)
  assert.deepEqual(await savedSignIn(), signIn)
  const removed = await owner("PUT", SIGN_IN_PATH, { awsSignIn: null })
  assert.equal(removed.status, 200, summary(removed))
  assert.equal(await savedSignIn(), null)
})
