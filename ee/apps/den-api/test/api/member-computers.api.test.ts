import assert from "node:assert/strict"
import { after, test } from "node:test"
import { ComputerAccessTable, ComputerGrantTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { workbotSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { COMPUTER_SHELL_RUNNER_CAPABILITY, computerAuthorizeResponseSchema, computerListResponseSchema, listedComputerSchema, type ComputerAccessSetting, type ComputerAction, type ComputerRefusal } from "@openwork/types/den/computers"
import { remoteDeviceResponseSchema } from "@openwork/types/den/remote-devices"
import { bootDen, field, summary, text, type Call } from "./harness.js"

const den = await bootDen()
const { db } = await import("../../src/db.js")
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
const wholeVmAccess: ComputerAccessSetting = { choice: "allow", scope: "whole_vm", folders: ["/workspace"] }
const checked = { outcome: "allow", route: "checked", scope: { surface: "whole_vm", folders: ["/workspace"] } }
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

async function setAccess(id: string, setting: ComputerAccessSetting = wholeVmAccess) {
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
  message: "I can't use Build box. Its owner can allow access to the entire computer in Settings > Devices.",
} satisfies Omit<ComputerRefusal, "outcome">
const unavailableDesktop = {
  layer: "computer", code: "sandbox_unavailable", changeableBy: "no_one",
  message: "Ada's desktop can't take work from other computers because it can't run the OpenWork sandbox.",
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
  assertError(await asOff("PUT", accessPath(id), wholeVmAccess), 404, featureOff)
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
  assert.deepEqual(desktop.reach, { outcome: "refuse", ...unavailableDesktop })
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
  test(`The owner can authorize a ${action.type} action with explicit whole-computer consent`, async () => {
    const { id, externalId } = await registerVm()
    const saved = await setAccess(id)
    assert.deepEqual(saved.access, wholeVmAccess)
    assert.deepEqual(saved.reach, checked)
    assert.deepEqual(await authorize(id, action), { computer: saved, decision: checked, connection: { provider: "daytona", externalId } })
  })
}

test("A legacy stored sandbox grant stays off and a legacy allow request cannot enable access", async () => {
  const { id } = await registerVm()
  const organizationId = normalizeDenTypeId("organization", orgId)
  const deviceId = normalizeDenTypeId("remoteDevice", id)
  await db.insert(ComputerAccessTable).values({ id: createDenTypeId("computerAccess"), organizationId, deviceId, ownerChoice: "allow", reportedByRunnerId: ada.memberId })
  await db.insert(ComputerGrantTable).values({ id: createDenTypeId("computerGrant"), organizationId, targetDeviceId: deviceId, sourceKey: "owner", folders: ["/workspace"] })
  const read: ComputerAction = { type: "read", path: "/workspace/notes.txt" }
  assert.deepEqual((await listed()).find((computer) => computer.id === id)?.access, { choice: "off", folders: [] })
  await assertRefusal(id, computerRefusal, read)
  const legacy = await asAda("PUT", accessPath(id), { choice: "allow", folders: ["/workspace"] })
  assert.equal(legacy.status, 400, summary(legacy))
  await assertRefusal(id, computerRefusal, read)
  await setAccess(id)
  assert.deepEqual((await authorize(id, read)).decision, checked)
})

test("Explicit consent permits ordinary paths outside the working folder", async () => {
  const { id } = await registerVm()
  await setAccess(id)
  assert.deepEqual((await authorize(id, { type: "read", path: "/project/notes.txt" })).decision, checked)
})

test("Turning off access revokes whole-VM consent, including from a legacy client", async () => {
  const { id } = await registerVm()
  for (const setting of [{ choice: "off", folders: ["/workspace"] }, { choice: "off" }] satisfies ComputerAccessSetting[]) {
    await setAccess(id)
    const off = { choice: "off", folders: [] }
    assert.deepEqual((await setAccess(id, setting)).access, off)
    assert.deepEqual((await listed()).find((computer) => computer.id === id)?.access, off)
    await assertRefusal(id, computerRefusal)
  }
})

test("The organization ceiling refuses work even with whole-computer consent", async () => {
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
  assertError(await asSam("PUT", accessPath(id), wholeVmAccess), 404, notFound)
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
    assertError(await request("PUT", accessPath(id), wholeVmAccess), 404, notFound)
    const ownerAppOnly = {
      layer: "source", code: "owner_app_only", changeableBy: "no_one",
      message: "Build box only takes work from its owner's own OpenWork apps.",
    } satisfies Omit<ComputerRefusal, "outcome">
    assert.deepEqual(shared.reach, { outcome: "refuse", ...ownerAppOnly })
    await assertRefusal(id, ownerAppOnly, shell, request)
  }
})

test("A personal computer without a shell runner can't take work even with a stored grant", async () => {
  const id = await reportDesktop()
  const organizationId = normalizeDenTypeId("organization", orgId)
  const deviceId = normalizeDenTypeId("remoteDevice", id)
  await db.insert(ComputerAccessTable).values({ id: createDenTypeId("computerAccess"), organizationId, deviceId, ownerChoice: "allow", reportedByRunnerId: ada.memberId })
  await db.insert(ComputerGrantTable).values({ id: createDenTypeId("computerGrant"), organizationId, targetDeviceId: deviceId, sourceKey: "owner", folders: ["/workspace"] })
  const expected = { outcome: "refuse", ...unavailableDesktop }
  assert.deepEqual((await listed()).find((computer) => computer.id === id)?.reach, expected)
  const { decision, computer, connection } = await authorize(id)
  assert.deepEqual({ decision, reach: computer.reach, connection }, { decision: expected, reach: expected, connection: null })
  assertError(await asAda("PUT", accessPath(id), wholeVmAccess), 409, {
    error: "choose_on_that_computer", message: "You can't change access to a personal computer here.",
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
  assertError(await asAda("PUT", accessPath(workbot.id), wholeVmAccess), 409, {
    error: "not_configurable", message: "You can't change access to this computer here.",
  })
})

test("A generic signed-in app cannot use an owner grant on a personal desktop", async () => {
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
  const reserved = await den.request(token, "PUT", "/v1/computer-runners/access", { body: { choice: "allow", grants: [{ source: { kind: "computer", id: "owner_whole_vm" }, folders: ["/workspace"] }] } })
  assert.equal(reserved.status, 400, summary(reserved))
  const duplicate = await den.request(token, "PUT", "/v1/computer-runners/access", { body: { choice: "allow", grants: [
    { source: { kind: "workbot" }, folders: ["/workspace"] }, { source: { kind: "workbot" }, folders: ["/workspace"] },
  ] } })
  assertError(duplicate, 400, { error: "invalid_request", message: "Choose Workbot only once." })
  const computer = (await listed()).find((item) => item.label === label)
  assert.ok(computer)
  const result = await authorize(computer.id)
  assert.equal(field(result.decision, "code"), "source_not_allowed")
  assert.deepEqual([result.connection, result.computer.access], [null, null])
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
