import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("document link resolution requires membership, all feature flags and a member-usable Drive connection", async () => {
  const member = await den.createOrg(await den.signUp("Alex Example"), "Document workspace")
  const outsider = await den.createOrg(await den.signUp("Robin Example"), "Another workspace")
  const path = "/v1/documents/google-drive/files/example_file/metadata"
  const call = den.as(member.owner, member.orgId)
  const disabled = await call("GET", path)
  assert.equal(disabled.status, 403, summary(disabled))
  for (const flag of ["workbot", "workbotDocuments"]) {
    const result = await den.setFeature(member.orgId, flag, true)
    assert.equal(result.status, 200, summary(result))
  }
  const assistantOff = await call("GET", path)
  assert.equal(assistantOff.status, 403, summary(assistantOff))
  assert.equal((await den.setFeature(member.orgId, "workbotWorkspaceAssistant", true)).status, 200)
  const noDrive = await call("GET", path)
  assert.equal(noDrive.status, 409, summary(noDrive))
  assert.ok(noDrive.text.includes("needs_connection"), noDrive.text)
  const crossOrg = await den.as(outsider.owner, member.orgId)("GET", path)
  assert.equal(crossOrg.status, 404, summary(crossOrg))
  assert.equal(crossOrg.text.includes("example_file"), false)
  const arbitraryConnection = await call("GET", `${path}?connectionId=other-member`)
  assert.equal(arbitraryConnection.status, 400, summary(arbitraryConnection))
  const unknownField = await call("GET", `${path}?download=https://private.example.test`)
  assert.equal(unknownField.status, 400, summary(unknownField))
  // A kill takes effect on the server, including after the other two features were enabled.
  assert.equal((await den.setFeature(member.orgId, "workbotWorkspaceAssistant", false)).status, 200)
  const killed = await call("GET", path)
  assert.equal(killed.status, 403, summary(killed))
})
