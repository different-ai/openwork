import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("document reads require Documents, membership and a usable Drive connection", async () => {
  const member = await den.createOrg(await den.signUp("Alex Example"), "Document workspace")
  const outsider = await den.createOrg(await den.signUp("Robin Example"), "Another workspace")
  const path = "/v1/documents/google-drive/files/example_file/editor"
  const call = den.as(member.owner, member.orgId)
  assert.equal((await call("GET", path)).status, 403)
  assert.equal((await den.setFeature(member.orgId, "workbotDocuments", true)).status, 200)
  const changes = { kind: "text", connectionId: "google-workspace", revision: "v1", text: "Updated text" }
  const office = "/v1/documents/google-drive/files/example_file/office"
  assert.equal((await call("POST", path, changes)).status, 403, "editing is off by default")
  assert.equal((await call("POST", office, {})).status, 403, "opening an Office session is blocked before placement")
  assert.equal((await den.setFeature(member.orgId, "workbotDocumentEditing", true)).status, 200)
  assert.equal((await call("POST", path, changes)).status, 409, "enabling editing still requires a Drive connection")
  assert.equal((await den.setFeature(member.orgId, "workbotDocumentEditing", false)).status, 200)
  assert.equal((await call("POST", path, changes)).status, 403, "turning editing off immediately blocks saves")
  assert.equal((await call("POST", office, {})).status, 403, "turning editing off blocks editor startup")
  const noDrive = await call("GET", path)
  assert.equal(noDrive.status, 409, summary(noDrive))
  assert.ok(noDrive.text.includes("needs_connection"), noDrive.text)
  const crossOrg = await den.as(outsider.owner, member.orgId)("GET", path)
  assert.equal(crossOrg.status, 404, summary(crossOrg))
  assert.equal(crossOrg.text.includes("example_file"), false)
  assert.equal((await call("GET", `${path}?connectionId=other-member`)).status, 400)
  assert.equal((await den.setFeature(member.orgId, "workbotDocuments", false)).status, 200)
  assert.equal((await call("GET", path)).status, 403)
})
