import assert from "node:assert/strict"
import { after, test } from "node:test"
import { orgDiagnosticsSchema } from "@openwork/types/den/diagnostics"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud" } })
after(() => den.close())

test("real MySQL: hosted Den shows installation as managed for every role, including allowlisted platform admins and spoofed deployment headers", async () => {
  const platformAdmin = await den.signUp("Hosted Diagnostics Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
  const { orgId, owner } = await den.createOrg(await den.signUp("Hosted Diagnostics Owner"), "Hosted diagnostics org")
  const member = await den.newMember(owner, orgId, "Hosted Diagnostics Member")
  const admin = await den.newMember(owner, orgId, "Hosted Diagnostics Admin", "admin")
  const allowlistedMember = await den.join(owner, orgId, platformAdmin)
  const spoofed = { "x-den-deployment": "self_hosted", "x-openwork-deployment": "self_hosted", "x-forwarded-host": "self-hosted.example.test" }
  for (const person of [owner, member, admin, allowlistedMember]) {
    const context = await den.as(person, orgId)("GET", "/v1/org")
    assert.equal(context.status, 200, summary(context))
    assert.equal(field(context.body, "canManageDeploymentServices"), false)
    const read = await den.as(person, orgId)("GET", "/v1/org/diagnostics", undefined, spoofed)
    assert.equal(read.status, 200, `${person.name}: ${summary(read)}`)
    const body = orgDiagnosticsSchema.parse(read.body)
    assert.equal(body.deployment, "cloud")
    assert.deepEqual(body.installation, { access: "managed" }, `${person.name}: OpenWork operates hosted infrastructure`)
    assert.ok(!body.attention.some((item) => item.section === "installation"))
    const check = await den.as(person, orgId)("POST", "/v1/org/diagnostics/check", undefined, spoofed)
    assert.ok(check.status === 202 || check.status === 429, `${person.name}: ${summary(check)}`)
    assert.deepEqual(orgDiagnosticsSchema.parse(check.body).installation, { access: "managed" })
  }
  const ownerView = orgDiagnosticsSchema.parse((await den.as(owner, orgId)("GET", "/v1/org/diagnostics")).body)
  assert.equal(ownerView.providers.access, "granted")
  assert.equal(orgDiagnosticsSchema.parse((await den.as(member, orgId)("GET", "/v1/org/diagnostics")).body).providers.access, "locked")
  // The platform admin surface remains available on cloud; nothing was widened or restricted.
  assert.equal((await den.request(platformAdmin.token, "GET", "/v1/admin/services")).status, 200)
  assert.equal((await den.as(member, orgId)("GET", "/v1/org/service-readiness")).status, 200)
})
