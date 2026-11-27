import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { workbotSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { COMPUTER_SHELL_RUNNER_CAPABILITY, computerAuthorizeResponseSchema, computerListResponseSchema, listedComputerSchema, type ComputerAccessSetting, type ComputerAction, type ComputerRefusal } from "@openwork/types/den/computers"
import { remoteDeviceResponseSchema } from "@openwork/types/den/remote-devices"
import { bootDen, field, summary, text, type Call } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const adaAccount = await den.signUp("Ada")
const { orgId, owner: ada } = await den.createOrg(adaAccount, "Member computer fixtures")
const sam = await den.newMember(ada, orgId, "Sam")
const offOrg = await den.createOrg(adaAccount, "Computers off fixtures")
const asAda = den.as(ada, orgId)
const asSam = den.as(sam, orgId)
const asOff = den.as(offOrg.owner, offOrg.orgId)
type Request = typeof asAda
const enabled = await den.setFeature(orgId, "computers", true)
assert.equal(enabled.status, 200, summary(enabled))

const listPath = "/v1/computers"
const accessPath = (id: string) => `${listPath}/${id}/access`
const authorizePath = (id: string) => `${listPath}/${id}/authorize`
const devicePath = (id: string) => `/v1/remote-devices/${id}`
const sharedAccess: ComputerAccessSetting = { choice: "allow", folders: ["/workspace"] }
const checked = { outcome: "allow", route: "checked", scope: { surface: "sandbox", folders: ["/workspace"] } }
const shell: ComputerAction = { type: "shell", command: "true", cwd: "/workspace" }
const featureOff = { error: "feature_disabled", feature: "computers" }
const notFound = { error: "computer_not_found" }

let fixtureNumber = 0
async function registerVm(request = asAda, label = "Build box", shared = false) {
  const externalId = `build-box-${++fixtureNumber}`
  const registered = await request("POST", "/v1/remote-devices", { provider: "daytona", platform: "linux", label, externalId, shared })
  assert.equal(registered.status, 201, summary(registered))
  return { id: remoteDeviceResponseSchema.parse(registered.body).device.id, externalId }
}

async function listed(request = asAda) {
  const call = await request("GET", listPath)
  assert.equal(call.status, 200, summary(call))
  assert.equal(call.headers.get("cache-control"), "no-store")
  return computerListResponseSchema.parse(call.body).computers
}

async function setAccess(id: string, setting = sharedAccess) {
  const response = await asAda("PUT", accessPath(id), setting)
  assert.equal(response.status, 200, summary(response))
  const computer = field(response.body, "computer")
  assert.equal(field(computer, "externalId"), undefined)
  return listedComputerSchema.parse(computer)
}

async function authorize(id: string, action = shell, request = asAda) {
  const response = await request("POST", authorizePath(id), { action })
  assert.equal(response.status, 200, summary(response))
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal(field(response.body, "computer", "externalId"), undefined)
  return computerAuthorizeResponseSchema.parse(response.body)
}

function assertError(call: Call, status: number, body: object) {
  assert.equal(call.status, status, summary(call))
  assert.deepEqual(call.body, body)
}

async function assertRefusal(id: string, expected: Omit<ComputerRefusal, "outcome">, action = shell, request = asAda) {
  const { decision, connection } = await authorize(id, action, request)
  assert.deepEqual(decision, { outcome: "refuse", ...expected })
  assert.equal(connection, null)
}

const computerRefusal = {
  layer: "computer", code: "computer_not_allowed", changeableBy: "computer_owner",
  message: "I can't do that. Build box doesn't take work from other computers. Its owner can allow it in Settings > Devices on that computer.",
} satisfies Omit<ComputerRefusal, "outcome">

async function reportDesktop() {
  const call = await asAda("PUT", "/v1/remote-devices/this-computer", {
    installId: "ada-desktop", label: "Ada's desktop", platform: "darwin", appVersion: "1.7.0",
  })
  assert.equal(call.status, 200, summary(call))
  return remoteDeviceResponseSchema.parse(call.body).device.id
}

test("The list is disabled when Computers is off", async () => {
  assertError(await asOff("GET", listPath), 404, featureOff)
})

test("Saving access is disabled when Computers is off", async () => {
  const { id } = await registerVm(asOff)
  assertError(await asOff("PUT", accessPath(id), sharedAccess), 404, featureOff)
})

test("Authorizing an action is disabled when Computers is off", async () => {
  const { id } = await registerVm(asOff)
  assertError(await asOff("POST", authorizePath(id), { action: shell }), 404, featureOff)
})

test("Renaming still allows an already used name when Computers is off", async () => {
  await registerVm(asOff, "Existing box")
  const { id } = await registerVm(asOff, "Other box")
  const renamed = await asOff("PATCH", devicePath(id), { label: "EXISTING box" })
  assert.equal(renamed.status, 200, summary(renamed))
  assert.equal(remoteDeviceResponseSchema.parse(renamed.body).device.label, "EXISTING box")
})

test("A VM that has never reported starts when needed and the desktop is online", async () => {
  const { id } = await registerVm()
  const desktopId = await reportDesktop()
  const call = await asAda("GET", listPath)
  assert.equal(call.status, 200, summary(call))
  const { computers } = computerListResponseSchema.parse(call.body)
  assert.deepEqual(computers.find((computer) => computer.id === id), {
    id, kind: "registered_vm", provider: "daytona", label: "Build box", ownerMemberId: ada.memberId,
    availability: "unknown", state: "starts_when_needed", lastSeenAt: null,
    access: { choice: null, folders: [] }, reach: { outcome: "refuse", ...computerRefusal },
  })
  const desktop = computers.find((computer) => computer.id === desktopId)
  assert.ok(desktop?.lastSeenAt)
  assert.deepEqual([desktop.kind, desktop.state, desktop.access], ["member_machine", "online", null])
  assert.doesNotMatch(call.text, /"externalId"/)
})

const allowedActions = [
  shell,
  { type: "read", path: "/workspace/notes.txt" },
  { type: "write", path: "/workspace/notes.txt" },
  { type: "list", path: "/workspace" },
  { type: "search", path: "/workspace" },
] satisfies ComputerAction[]
for (const action of allowedActions) {
  test(`The owner can authorize a ${action.type} action inside the shared folder`, async () => {
    const { id, externalId } = await registerVm()
    const saved = await setAccess(id)
    assert.deepEqual(saved.access, sharedAccess)
    assert.deepEqual(saved.reach, checked)
    assert.deepEqual(await authorize(id, action), { computer: saved, decision: checked, connection: { provider: "daytona", externalId } })
  })
}

test("A sibling path outside the shared folder is refused at the source layer", async () => {
  const { id } = await registerVm()
  await setAccess(id)
  await assertRefusal(id, {
    layer: "source", code: "folder_not_shared", changeableBy: "computer_owner",
    message: "I can't see the workspace2 folder on Build box. It isn't shared with me. Its owner can share it in Settings > Devices on that computer.",
  }, { type: "read", path: "/workspace2" })
})

test("Turning off access refuses work at the computer layer without deleting its folders", async () => {
  const { id, externalId } = await registerVm()
  await setAccess(id)
  const setting: ComputerAccessSetting = { choice: "off", folders: ["/workspace"] }
  assert.deepEqual((await setAccess(id, setting)).access, setting)
  const stored = (await listed()).find((computer) => computer.id === id)?.access
  assert.deepEqual(stored, setting)
  await assertRefusal(id, computerRefusal)
  await setAccess(id, { choice: "allow", folders: stored.folders })
  assert.deepEqual((await authorize(id)).connection, { provider: "daytona", externalId })
})

test("Saving an empty folder list removes the old grant", async () => {
  const { id } = await registerVm()
  await setAccess(id)
  const setting: ComputerAccessSetting = { choice: "allow", folders: [] }
  assert.deepEqual((await setAccess(id, setting)).access, setting)
  await assertRefusal(id, {
    layer: "source", code: "nothing_shared", changeableBy: "computer_owner",
    message: "I can't use Build box. Nothing on it is shared with me. Its owner can share its sandbox and folders in Settings > Devices on that computer.",
  })
})

test("The organization ceiling refuses work even when the owner shares a folder", async () => {
  const { id } = await registerVm()
  await setAccess(id)
  const ceiling = (access: string) => asAda("PATCH", "/v1/org/remote-session-settings", { access })
  const off = await ceiling("off")
  assert.equal(off.status, 200, summary(off))
  try {
    await assertRefusal(id, {
      layer: "organization", code: "organization_off", changeableBy: "organization_admin",
      message: "I can't do that. Your admin has turned this off for the organization.",
    })
  } finally {
    const restored = await ceiling("created")
    assert.equal(restored.status, 200, summary(restored))
  }
})

test("Another member cannot see a private computer in the list", async () => {
  const { id } = await registerVm()
  assert.ok(!(await listed(asSam)).some((computer) => computer.id === id))
})

test("Another member cannot configure a private computer", async () => {
  const { id } = await registerVm()
  assertError(await asSam("PUT", accessPath(id), sharedAccess), 404, notFound)
})

test("Another member cannot authorize work on a private computer even when the owner allows it", async () => {
  const { id } = await registerVm()
  await setAccess(id)
  assertError(await asSam("POST", authorizePath(id), { action: shell }), 404, notFound)
})

test("An unknown computer returns not found", async () => {
  const id = createDenTypeId("remoteDevice")
  assertError(await asAda("POST", authorizePath(id), { action: shell }), 404, notFound)
})

test("A shared VM is visible but has no member access settings or owner grant", async () => {
  const { id } = await registerVm(asAda, "Build box", true)
  for (const request of [asAda, asSam]) {
    const shared = (await listed(request)).find((computer) => computer.id === id)
    assert.ok(shared)
    assert.deepEqual([shared.ownerMemberId, shared.access], [null, null])
    assertError(await request("PUT", accessPath(id), sharedAccess), 404, notFound)
    await assertRefusal(id, computerRefusal, shell, request)
  }
})

test("A desktop owner has to choose access on the desktop itself", async () => {
  const id = await reportDesktop()
  assertError(await asAda("PUT", accessPath(id), sharedAccess), 409, {
    error: "choose_on_that_computer", message: "That computer's owner chooses this on the computer itself.",
  })
})

test("Workbot computer access cannot be configured here", async () => {
  const token = await den.mintMcpToken(ada, orgId)
  const sessionId = workbotSessionId(orgId, ada.memberId)
  const report = await den.request(token, "POST", "/v1/workbot/devices/computer", { body: { sessionId, chat: "main", event: "resumed" } })
  assert.equal(report.status, 204, summary(report))
  const workbot = (await listed()).find((computer) => computer.kind === "cloud_sandbox")
  assert.ok(workbot)
  assert.equal(workbot.access, null)
  assertError(await asAda("PUT", accessPath(workbot.id), sharedAccess), 409, {
    error: "not_configurable", message: "That computer's access can't be set here.",
  })
})

test("An allowed desktop action does not return connection information", async () => {
  const minted = await asAda("POST", "/v1/session-runners/token", {
    runnerId: "ada-runner", protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.7.0",
    platform: "darwin", concurrency: 1, capabilities: [COMPUTER_SHELL_RUNNER_CAPABILITY],
  })
  assert.equal(minted.status, 200, summary(minted))
  const token = text(field(minted.body, "token"), "desktop runner token")
  const label = "Ada's runner desktop"
  const inventory = await den.request(token, "PUT", "/v1/session-runners/inventory", { body: { computer: { label, platform: "darwin", appVersion: "1.7.0" }, workspaces: [] } })
  assert.equal(inventory.status, 200, summary(inventory))
  const access = await den.request(token, "PUT", "/v1/computer-runners/access", { body: { choice: "allow", grants: [{ source: { kind: "owner" }, folders: ["/workspace"] }] } })
  assert.equal(access.status, 200, summary(access))
  const computer = (await listed()).find((item) => item.label === label)
  assert.ok(computer)
  const result = await authorize(computer.id)
  assert.deepEqual([result.decision, result.connection, result.computer.access], [checked, null, null])
})

test("Renaming to a different computer's name is refused regardless of case", async () => {
  await registerVm(asAda, "Ada's Build Box")
  const { id } = await registerVm(asAda, "Ada's other box")
  assertError(await asAda("PATCH", devicePath(id), { label: "ada's build box" }), 409, {
    error: "name_taken", message: "You already have a computer called that. Pick another name.",
  })
  assert.equal((await listed()).find((computer) => computer.id === id)?.label, "Ada's other box")
})

test("Renaming may reuse another member's name or change only its own capitalization", async () => {
  await registerVm(asSam, "Sam's box")
  const { id } = await registerVm(asAda, "Ada's box")
  for (const label of ["Sam's box", "SAM'S BOX"]) {
    const updated = await asAda("PATCH", devicePath(id), { label })
    assert.equal(updated.status, 200, summary(updated))
    assert.equal(remoteDeviceResponseSchema.parse(updated.body).device.label, label)
  }
})
