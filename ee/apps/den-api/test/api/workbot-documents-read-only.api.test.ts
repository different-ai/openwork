import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen({ env: { DEN_WORKBOT_URL: "http://localhost:4200" } })
after(() => den.close())

test("Workbot still reads connected documents and gates link navigation, but never exposes editing routes", async () => {
  const { owner, orgId } = await den.createOrg(await den.signUp("Workspace Owner"), "Documents workspace")
  const browser = den.as(owner, orgId)
  const token = await den.mintMcpToken(owner, orgId)
  const workbot = (method: "GET" | "POST", path: string) => den.request(token, method, `/v1/workbot/documents${path}`)
  const drive = "/v1/documents/google-drive/files/file_example"
  const oneDrive = "/v1/documents/microsoft-365/files/file_example"
  const setting = await den.setFeature(orgId, "workbotDocuments", true)
  assert.equal(setting.status, 200, summary(setting))

  const session = await den.request(token, "GET", "/v1/workbot/session")
  assert.equal(session.status, 200, summary(session))
  assert.equal(field(session.body, "documents"), true)
  assert.equal(field(session.body, "documentEditing"), undefined)
  assert.equal(field(session.body, "sandboxGateway"), undefined)

  // No connector is configured: both read-only views must still reach connector authorization.
  for (const path of [drive, oneDrive]) {
    const preview = await workbot("GET", `${path}/editor`)
    assert.equal(preview.status, 409, summary(preview))
    assert.equal((await workbot("POST", `${path}/editor`)).status, 404)
    assert.equal((await browser("POST", `${path}/editor`, {})).status, 404)
  }
  const assistantOff = await den.setFeature(orgId, "workbotWorkspaceAssistant", false)
  assert.equal(assistantOff.status, 200, summary(assistantOff))
  const disabled = await workbot("GET", `${drive}/metadata`)
  assert.equal(disabled.status, 403, summary(disabled))
  assert.equal(field(disabled.body, "error"), "feature_disabled")
  const assistantOn = await den.setFeature(orgId, "workbotWorkspaceAssistant", true)
  assert.equal(assistantOn.status, 200, summary(assistantOn))
  const metadata = await workbot("GET", `${drive}/metadata`)
  assert.equal(metadata.status, 409, summary(metadata))

  const draft = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
  assert.equal((await workbot("POST", `${drive}/office`)).status, 404)
  assert.equal((await workbot("GET", `${drive}/office/${draft}`)).status, 404)
  assert.equal((await browser("POST", `${drive}/office/${draft}/save`, {})).status, 404)
  assert.equal((await browser("GET", `/v1/documents/wopi/files/${draft}`)).status, 404)
})
