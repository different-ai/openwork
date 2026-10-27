import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("new Workbot organizations get saved-step execution and session cells without rollout overrides", async () => {
  const workspace = await den.createOrg(await den.signUp("Example Owner"), "Example workspace")
  const token = await den.mintMcpToken(workspace.owner, workspace.orgId)
  const result = await den.request(token, "GET", "/v1/workbot/session")
  assert.equal(result.status, 200, summary(result))
  assert.deepEqual({ stepTurns: field(result.body, "stepTurns"), sessionCells: field(result.body, "sessionCells") }, { stepTurns: true, sessionCells: true })
})
