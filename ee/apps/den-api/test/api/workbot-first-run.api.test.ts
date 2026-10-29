import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("the Workbot session follows the token workspace and needs no Workbot enable action", async () => {
  const workspace = await den.createOrg(await den.signUp("Example Owner"), "First workspace")
  const other = await den.createOrg(await den.signUp("Example Member"), "Other workspace")
  const token = await den.mintMcpToken(workspace.owner, workspace.orgId)
  const read = () => den.request(token, "GET", "/v1/workbot/session", { orgId: other.orgId })
  const session = await read()
  assert.equal(session.status, 200, summary(session))
  assert.equal(field(session.body, "organization", "id"), workspace.orgId)
  assert.equal(field(session.body, "enabled"), true)
  // A platform administrator (bootstrap admin email) gets no special Workbot
  // enable path either: they see the same always-on session as a member.
  const admin = await den.join(
    workspace.owner,
    workspace.orgId,
    await den.signUp("Platform Admin", `platform-admin+${den.stamp}@example.test`),
  )
  const adminToken = await den.mintMcpToken(admin, workspace.orgId)
  const adminSession = await den.request(adminToken, "GET", "/v1/workbot/session")
  assert.equal(adminSession.status, 200, summary(adminSession))
  assert.equal(field(adminSession.body, "enabled"), true)
  assert.equal((await den.request(null, "GET", "/v1/workbot/session")).status, 401)
})
