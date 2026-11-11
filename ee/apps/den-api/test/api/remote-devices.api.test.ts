import assert from "node:assert/strict"
import { after, test } from "node:test"
import { desc, eq } from "@openwork-ee/den-db/drizzle"
import { AutomationRunnerTable, HeadlessSessionIndexTable, RemoteDeviceEventTable, RemoteDeviceTable, WorkerTable, CloudRuntimeInstanceTable } from "@openwork-ee/den-db/schema"
import { workbotSessionId, workbotSideChatSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  REMOTE_DEVICE_AVAILABILITIES,
  REMOTE_DEVICE_EVENT_LIMIT,
  REMOTE_DEVICE_ONLINE_WINDOW_MS,
  organizationComputerDetailResponseSchema,
  organizationComputerInstanceDetailResponseSchema,
  organizationComputerListResponseSchema,
  remoteDeviceAvailability,
  remoteDeviceDetailResponseSchema,
  remoteDeviceListResponseSchema,
} from "@openwork/types/den/remote-devices"
import { bootDen, field, list, summary, text } from "./harness.js"

/**
 * Devices (feature `remoteDevices`): what a member, Workbot and an organization admin
 * see of the same registry, through the real routes and a real database.
 */
const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")
const { pruneRemoteDeviceEvents } = await import("../../src/remote-devices.js")

const { orgId, owner } = await den.createOrg(await den.signUp("Dana Owner"), "Devices organization")
const member = await den.newMember(owner, orgId, "Milo Member")
const other = await den.newMember(owner, orgId, "Olive Other")
const asOwner = den.as(owner, orgId)
const asMember = den.as(member, orgId)
const asOther = den.as(other, orgId)
const admin = await den.newMember(owner, orgId, "Ari Org Admin", "admin")
const asAdmin = den.as(admin, orgId)
const elsewhere = await den.createOrg(await den.signUp("Zed Elsewhere"), "Another organization")
const asElsewhere = den.as(elsewhere.owner, elsewhere.orgId)

const desktopReport = (overrides: Record<string, unknown> = {}) => ({
  installId: "install-milo-macbook",
  label: "Milo's MacBook Pro",
  platform: "darwin",
  appVersion: "1.4.0",
  osVersion: "25.1.0",
  arch: "arm64",
  computerUse: {
    enabled: true,
    remoteEnabled: false,
    selectedId: "this-mac",
    computers: [{ id: "this-mac", label: "This Mac", placement: "local", readiness: "ready", detail: null }],
    permissions: { accessibility: true, screenRecording: true },
  },
  ...overrides,
})

const devicesOf = (call: { body: unknown }) => remoteDeviceListResponseSchema.parse(call.body).devices
const deviceId = (call: { body: unknown }) => text(field(call.body, "device", "id"), "device id")

async function eventsOf(as: typeof asMember, id: string) {
  const detail = await as("GET", `/v1/remote-devices/${id}`)
  assert.equal(detail.status, 200, summary(detail))
  return remoteDeviceDetailResponseSchema.parse(detail.body).events
}

test("every member route answers as if it did not exist while the feature is off", async () => {
  for (const [method, path, body] of [
    ["GET", "/v1/org/computers", undefined],
    ["GET", "/v1/org/computers/rdv_01h2xcejqtf2nbrexx3vqjhp41", undefined],
    ["GET", "/v1/org/computers/instances/wrk_01h2xcejqtf2nbrexx3vqjhp41", undefined],
    ["POST", "/v1/org/computers/rdv_01h2xcejqtf2nbrexx3vqjhp41/disconnect", undefined],
    ["DELETE", "/v1/org/computers/rdv_01h2xcejqtf2nbrexx3vqjhp41", undefined],
    ["POST", "/v1/remote-devices/rdv_01h2xcejqtf2nbrexx3vqjhp41/disconnect", undefined],
    ["GET", "/v1/remote-devices", undefined],
    ["POST", "/v1/remote-devices", { label: "VM", provider: "freestyle", platform: "linux", externalId: "vm-1" }],
    ["PUT", "/v1/remote-devices/this-computer", desktopReport()],
  ] as const) {
    const call = await asMember(method, path, body)
    assert.equal(call.status, 404, `${method} ${path}: ${summary(call)}`)
    assert.equal(field(call.body, "error"), "feature_disabled")
  }
  assert.equal((await db.select().from(RemoteDeviceTable)).length, 0, "nothing is stored while the feature is off")
})

test("a desktop reports itself, and what changes afterwards is recorded once", async () => {
  assert.equal((await den.setFeature(orgId, "remoteDevices", true)).status, 200)
  assert.deepEqual(devicesOf(await asMember("GET", "/v1/remote-devices")), [])

  const first = await asMember("PUT", "/v1/remote-devices/this-computer", desktopReport())
  assert.equal(first.status, 200, summary(first))
  assert.equal(field(first.body, "reportAfterSeconds"), 300)
  const id = deviceId(first)
  const [listed] = devicesOf(await asMember("GET", "/v1/remote-devices"))
  assert.ok(listed)
  assert.deepEqual(
    { id: listed.id, kind: listed.kind, provider: listed.provider, label: listed.label, access: listed.access, availability: listed.availability, appVersion: listed.appVersion, canRename: listed.canRename },
    { id, kind: "desktop", provider: "openwork_desktop", label: "Milo's MacBook Pro", access: "mine", availability: "online", appVersion: "1.4.0", canRename: false },
  )
  // A signed-in desktop would only report itself back, so it is disconnected, not removed.
  assert.deepEqual([listed.canRemove, listed.canDisconnect, listed.disconnectedAt], [false, true, null])
  assert.equal(listed.computerId, null, "a desktop without a runner takes no remote tasks")

  // The same report again changes nothing and records nothing.
  assert.equal((await asMember("PUT", "/v1/remote-devices/this-computer", desktopReport())).status, 200)
  assert.deepEqual((await eventsOf(asMember, id)).map((event) => event.type), ["registered"])

  // Screen Recording goes missing: the desktop is still online, and says what it needs.
  const needsSetup = await asMember("PUT", "/v1/remote-devices/this-computer", desktopReport({
    appVersion: "1.5.0",
    computerUse: {
      enabled: true, remoteEnabled: false, selectedId: "this-mac",
      computers: [{ id: "this-mac", label: "This Mac", placement: "local", readiness: "setup-required", detail: "Screen Recording is off" }],
      permissions: { accessibility: true, screenRecording: false },
    },
  }))
  assert.equal(field(needsSetup.body, "device", "availability"), "needs_setup")
  assert.equal(field(needsSetup.body, "device", "statusDetail"), "Screen Recording is off")
  const events = await eventsOf(asMember, id)
  assert.deepEqual(events.map((event) => [event.type, event.level]).sort(), [["app_updated", "info"], ["registered", "info"], ["state_changed", "warning"]])
  assert.ok(events.some((event) => event.message === "Needs setup: Screen Recording is off"))
  assert.ok(events.some((event) => event.message === "Updated OpenWork from 1.4.0 to 1.5.0"))

  // A member's computers are their own: nobody else in the organization, and nobody outside it, sees or reaches them.
  assert.deepEqual(devicesOf(await asOther("GET", "/v1/remote-devices")), [])
  assert.equal((await asOther("GET", `/v1/remote-devices/${id}`)).status, 404)
  assert.equal((await asOwner("DELETE", `/v1/remote-devices/${id}`)).status, 404, "an admin does not manage someone's own computer")
  assert.equal((await asElsewhere("GET", `/v1/remote-devices/${id}`)).status, 404)

  // Desktops name themselves.
  const rename = await asMember("PATCH", `/v1/remote-devices/${id}`, { label: "Renamed" })
  assert.equal(rename.status, 403, summary(rename))
})

test("the desktop and its runner are one computer, and a desktop that only registered a runner is listed too", async () => {
  // The same install registers its runner: the entry gains the id remote sessions target it by.
  const minted = await asMember("POST", "/v1/session-runners/token", {
    runnerId: "install-milo-macbook", protocolVersion: 1, supportedExecutionTargets: ["desktop"], capabilities: ["remote_session_v1"],
    appVersion: "1.5.0", platform: "darwin", concurrency: 1,
  })
  assert.equal(minted.status, 200, summary(minted))
  // A second desktop, on an app version that predates Devices: it only ever registers a runner.
  const older = await asMember("POST", "/v1/session-runners/token", {
    runnerId: "install-milo-studio", protocolVersion: 1, supportedExecutionTargets: ["desktop"], capabilities: [],
    appVersion: "1.2.0", platform: "darwin", concurrency: 1,
  })
  assert.equal(older.status, 200, summary(older))

  const devices = devicesOf(await asMember("GET", "/v1/remote-devices"))
  assert.equal(devices.length, 2, JSON.stringify(devices))
  const macbook = devices.find((device) => device.label === "Milo's MacBook Pro")
  assert.match(macbook?.computerId ?? "", /^rnr_[a-f0-9]{64}$/)
  const studio = devices.find((device) => device.id !== macbook?.id)
  assert.deepEqual([studio?.kind, studio?.label, studio?.availability, studio?.appVersion, studio?.computerId], ["desktop", "Mac", "online", "1.2.0", null])
  // Listing again copies nothing twice.
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).length, 2)

  // A runner that goes quiet takes its desktop offline, and after a month off the list.
  const runnerRow = (await db.select({ id: AutomationRunnerTable.id }).from(AutomationRunnerTable)).find((row) => row.id !== macbook?.computerId)
  assert.ok(runnerRow && studio)
  const set = async (ageMs: number) => {
    const seen = new Date(Date.now() - ageMs)
    await db.update(AutomationRunnerTable).set({ last_seen_at: seen }).where(eq(AutomationRunnerTable.id, runnerRow.id))
    await db.update(RemoteDeviceTable).set({ lastSeenAt: seen }).where(eq(RemoteDeviceTable.id, normalizeDenTypeId("remoteDevice", studio.id)))
  }
  await set(REMOTE_DEVICE_ONLINE_WINDOW_MS + 60_000)
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).find((device) => device.id === studio.id)?.availability, "offline")
  await set(31 * 24 * 60 * 60_000)
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).some((device) => device.id === studio.id), false)
  for (const as of [asOwner, asAdmin]) {
    // The team list leaves a desktop nobody has heard from for 30 days out, says how many, and lists it when asked.
    const listed = organizationComputerListResponseSchema.parse((await as("GET", "/v1/org/computers")).body)
    assert.equal(listed.devices.some((device) => device.id === studio.id), false)
    assert.deepEqual([listed.staleHidden, listed.total], [1, listed.devices.length])
    const inventory = organizationComputerListResponseSchema.parse((await as("GET", "/v1/org/computers?stale=include")).body)
    assert.deepEqual([inventory.staleHidden, inventory.total], [0, listed.total + 1])
    const stale = inventory.devices.find((device) => device.id === studio.id)
    assert.equal(stale?.availability, "offline", "team inventory retains registered offline computers")
    assert.equal(stale?.appVersion, "1.2.0")
    assert.ok(stale?.lastSeenAt && Date.parse(stale.lastSeenAt) < Date.now() - 30 * 24 * 60 * 60_000)
    assert.deepEqual([stale.canRemove, stale.canDisconnect], [true, true], "a desktop that has been quiet for a month can be taken off the list")
  }
  // A retained old runner that never had a registry row must be imported for team inventory too.
  const retained = await asMember("POST", "/v1/session-runners/token", {
    runnerId: "install-retained-before-devices", protocolVersion: 1, supportedExecutionTargets: ["desktop"], capabilities: [],
    appVersion: "0.9.0", platform: "darwin", concurrency: 1,
  })
  assert.equal(retained.status, 200, summary(retained))
  const retainedRunner = (await db.select().from(AutomationRunnerTable)).find((runner) => runner.app_version === "0.9.0")!
  await db.update(AutomationRunnerTable).set({ last_seen_at: new Date(Date.now() - 40 * 24 * 60 * 60_000) }).where(eq(AutomationRunnerTable.id, retainedRunner.id))
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).some((device) => device.appVersion === "0.9.0"), false)
  const inventory = organizationComputerListResponseSchema.parse((await asAdmin("GET", "/v1/org/computers?stale=include")).body)
  assert.equal(inventory.devices.find((device) => device.appVersion === "0.9.0")?.availability, "offline")
  assert.equal(organizationComputerListResponseSchema.parse((await asAdmin("GET", "/v1/org/computers")).body).staleHidden, 2)
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).some((device) => device.appVersion === "0.9.0"), false)
})

test("virtual computers are registered by hand: for me, or by an admin for everyone", async () => {
  const created = await asMember("POST", "/v1/remote-devices", { label: "Build VM", provider: "freestyle", platform: "linux", externalId: "vm-build-01" })
  assert.equal(created.status, 201, summary(created))
  const id = deviceId(created)
  assert.deepEqual(
    [field(created.body, "device", "kind"), field(created.body, "device", "availability"), field(created.body, "device", "canRename"), field(created.body, "device", "access")],
    ["vm", "unknown", true, "mine"],
  )
  // One row per organization and provider id, whoever asks.
  for (const as of [asMember, asOther]) {
    const again = await as("POST", "/v1/remote-devices", { label: "Again", provider: "freestyle", platform: "linux", externalId: "vm-build-01" })
    assert.equal(again.status, 409, summary(again))
    assert.equal(field(again.body, "error"), "remote_device_exists")
  }
  // Another organization has its own namespace.
  assert.equal((await den.setFeature(elsewhere.orgId, "remoteDevices", true)).status, 200)
  assert.equal((await asElsewhere("POST", "/v1/remote-devices", { label: "Theirs", provider: "freestyle", platform: "linux", externalId: "vm-build-01" })).status, 201)

  for (const body of [
    { label: "", provider: "freestyle", platform: "linux", externalId: "vm" },
    { label: "VM", provider: "workbot", platform: "linux", externalId: "vm" },
    { label: "VM", provider: "freestyle", platform: "linux", externalId: "has space" },
    { label: "VM", provider: "freestyle", platform: "linux", externalId: "vm", apiKey: "secret" },
  ]) assert.equal((await asMember("POST", "/v1/remote-devices", body)).status, 400, JSON.stringify(body))

  const renamed = await asMember("PATCH", `/v1/remote-devices/${id}`, { label: "Build VM (west)" })
  assert.equal(field(renamed.body, "device", "label"), "Build VM (west)")
  assert.equal((await asOther("PATCH", `/v1/remote-devices/${id}`, { label: "Mine now" })).status, 404)

  // Sharing with everyone is an admin's call.
  const refused = await asMember("POST", "/v1/remote-devices", { label: "Mac sandbox", provider: "mac_host", platform: "darwin", externalId: "local:shared-sandbox", shared: true })
  assert.equal(refused.status, 403, summary(refused))
  const shared = await asOwner("POST", "/v1/remote-devices", { label: "Mac sandbox", provider: "mac_host", platform: "darwin", externalId: "local:shared-sandbox", shared: true })
  assert.equal(shared.status, 201, summary(shared))
  const sharedId = deviceId(shared)
  const seenByMember = devicesOf(await asMember("GET", "/v1/remote-devices")).find((device) => device.id === sharedId)
  assert.deepEqual([seenByMember?.access, seenByMember?.canRename, seenByMember?.canRemove], ["shared", false, false])
  assert.equal((await asMember("DELETE", `/v1/remote-devices/${sharedId}`)).status, 403)
  assert.equal((await asMember("PATCH", `/v1/remote-devices/${sharedId}`, { label: "Mine" })).status, 403)
  const seenByOwner = devicesOf(await asOwner("GET", "/v1/remote-devices")).find((device) => device.id === sharedId)
  assert.deepEqual([seenByOwner?.canRename, seenByOwner?.canRemove], [true, true])

  // Removing takes it off the list; registering it again brings the same entry back.
  assert.equal((await asMember("DELETE", `/v1/remote-devices/${id}`)).status, 204)
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).some((device) => device.id === id), false)
  assert.equal((await asMember("GET", `/v1/remote-devices/${id}`)).status, 404)
  const back = await asMember("POST", "/v1/remote-devices", { label: "Build VM", provider: "freestyle", platform: "linux", externalId: "vm-build-01" })
  assert.equal(back.status, 201, summary(back))
  assert.equal(deviceId(back), id)
})

test("removed devices cannot be claimed by another owner or downgraded from shared", async () => {
  const body = { label: "Private restore", provider: "freestyle", platform: "linux", externalId: "restore-private" }
  const created = await asMember("POST", "/v1/remote-devices", body)
  const id = deviceId(created)
  assert.equal((await asMember("DELETE", `/v1/remote-devices/${id}`)).status, 204)
  for (const as of [asOther, asOwner]) assert.equal((await as("POST", "/v1/remote-devices", body)).status, 403)
  assert.equal((await asOwner("POST", "/v1/remote-devices", { ...body, shared: true })).status, 403)
  assert.equal((await asMember("POST", "/v1/remote-devices", body)).status, 201)

  const sharedBody = { ...body, externalId: "restore-shared", label: "Shared restore", shared: true }
  const sharedId = deviceId(await asOwner("POST", "/v1/remote-devices", sharedBody))
  const report = desktopReport({ computerUse: { enabled: true, remoteEnabled: true, selectedId: "shared", permissions: null,
    computers: [{ id: "shared", label: "Shared", placement: "remote", provider: "freestyle", externalId: "restore-shared", readiness: "unavailable", detail: "Forged failure" }],
  } })
  const read = async () => (await db.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.id, normalizeDenTypeId("remoteDevice", sharedId))))[0]!
  const before = await read()
  assert.equal((await asMember("PUT", "/v1/remote-devices/this-computer", report)).status, 200)
  assert.deepEqual(await read(), before, "a member cannot change a live shared VM through a desktop report")
  assert.equal((await asOwner("DELETE", `/v1/remote-devices/${sharedId}`)).status, 204)
  const removed = await read()
  assert.equal((await asMember("PUT", "/v1/remote-devices/this-computer", report)).status, 200)
  assert.deepEqual(await read(), removed, "a member cannot restore a removed shared VM")
  assert.equal((await asMember("POST", "/v1/remote-devices", { ...sharedBody, shared: false })).status, 403)
  assert.equal((await asOwner("POST", "/v1/remote-devices", { ...sharedBody, shared: false })).status, 403)
  assert.equal((await asOwner("POST", "/v1/remote-devices", sharedBody)).status, 201)
  // Keep existing downstream inventory assertions isolated from these security fixtures.
  assert.equal((await asOwner("DELETE", `/v1/remote-devices/${sharedId}`)).status, 204)
  assert.equal((await asMember("DELETE", `/v1/remote-devices/${id}`)).status, 204)
})

test("concurrent first registrations resolve to one row, not raw database errors", async () => {
  const body = { label: "Race", provider: "freestyle", platform: "linux", externalId: "register-race" }
  const calls = await Promise.all([asMember("POST", "/v1/remote-devices", body), asOther("POST", "/v1/remote-devices", body)])
  assert.deepEqual(calls.map((call) => call.status).sort(), [201, 409], calls.map(summary).join("\n"))
  const winner = calls[0]!.status === 201 ? asMember : asOther
  await winner("DELETE", `/v1/remote-devices/${deviceId(calls.find((call) => call.status === 201)!)}`)
  const raceReport = desktopReport({ installId: "install-race", label: "Race desktop", computerUse: {
    enabled: true, remoteEnabled: true, selectedId: "race-vm", permissions: null,
    computers: [{ id: "race-vm", label: "Race VM", placement: "remote", readiness: "ready", detail: null, provider: "daytona", externalId: "race-vm" }],
  } })
  const desktops = await Promise.all(Array.from({ length: 3 }, () => asMember("PUT", "/v1/remote-devices/this-computer", raceReport)))
  assert.ok(desktops.every((call) => call.status === 200), desktops.map(summary).join("\n"))
  assert.equal(new Set(desktops.map(deviceId)).size, 1)
  const vms = await db.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.externalId, "race-vm"))
  assert.equal(vms.length, 1)
  await asMember("DELETE", `/v1/remote-devices/${vms[0]!.id}`)
  await asMember("DELETE", `/v1/remote-devices/${deviceId(desktops[0]!)}`)
})

test("a desktop's report covers the VMs it is configured to reach, never someone else's", async () => {
  const vm = (readiness: string | null, detail: string | null = null) => desktopReport({
    appVersion: "1.5.0",
    computerUse: {
      enabled: true, remoteEnabled: true, selectedId: "freestyle-vm",
      computers: [
        { id: "this-mac", label: "This Mac", placement: "local", readiness: "ready", detail: null },
        { id: "freestyle-vm", label: "Freestyle VM", placement: "remote", readiness, detail, provider: "freestyle", externalId: "vm-build-01" },
        { id: "daytona-sandbox", label: "Daytona sandbox", placement: "remote", readiness: null, detail: null, provider: "daytona", externalId: "sandbox-77" },
      ],
      permissions: null,
    },
  })
  assert.equal((await asMember("PUT", "/v1/remote-devices/this-computer", vm("setup-required", "This VM needs xdotool"))).status, 200)
  const devices = devicesOf(await asMember("GET", "/v1/remote-devices"))
  const build = devices.find((device) => device.label === "Build VM")
  assert.deepEqual([build?.availability, build?.statusDetail], ["needs_setup", "This VM needs xdotool"])
  // A VM seen for the first time is registered for the member; one that was not probed stays "not checked yet".
  const sandbox = devices.find((device) => device.provider === "daytona")
  assert.deepEqual([sandbox?.label, sandbox?.kind, sandbox?.source, sandbox?.availability, sandbox?.access], ["Daytona sandbox", "vm", "desktop_app", "unknown", "mine"])

  assert.equal((await asMember("PUT", "/v1/remote-devices/this-computer", vm("ready"))).status, 200)
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).find((device) => device.label === "Build VM")?.availability, "online")

  // Another member's desktop naming the same VM id changes nothing about it and gains no access to it.
  const intruder = await asOther("PUT", "/v1/remote-devices/this-computer", { ...vm("unavailable", "Could not reach this VM"), installId: "install-olive-laptop", label: "Olive's laptop" })
  assert.equal(intruder.status, 200, summary(intruder))
  assert.deepEqual(devicesOf(await asOther("GET", "/v1/remote-devices")).filter((device) => device.kind === "vm").map((device) => device.label).sort(), ["Mac sandbox"])
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).find((device) => device.label === "Build VM")?.availability, "online")
})

test("Workbot lists the same computers and reports what happens to its own", async () => {
  const sessionId = workbotSessionId(orgId, member.memberId)
  const token = await den.mintMcpToken(member, orgId)
  const report = (body: Record<string, unknown>, bearer = token) => den.request(bearer, "POST", "/v1/workbot/devices/computer", { body: { sessionId, chat: "main", ...body } })

  const session = await den.request(token, "GET", "/v1/workbot/session")
  assert.equal(field(session.body, "devices"), true, summary(session))
  const before = devicesOf(await den.request(token, "GET", "/v1/workbot/devices"))
  assert.deepEqual(before.map((device) => device.id).sort(), devicesOf(await asMember("GET", "/v1/remote-devices")).map((device) => device.id).sort())
  assert.ok(before.filter((device) => device.access === "shared").every((device) => !device.canRename && !device.canRemove), "Workbot never manages shared computers")
  assert.ok(before.every((device) => device.disconnectedAt === null && typeof device.canDisconnect === "boolean"), "the same fields as the member's own list")

  assert.equal((await report({ event: "viewer_opened", view: "computer" })).status, 204)
  const computer = devicesOf(await den.request(token, "GET", "/v1/workbot/devices")).find((device) => device.provider === "workbot")
  assert.ok(computer)
  assert.deepEqual([computer.label, computer.kind, computer.availability, computer.workbotChat, computer.access], ["Workbot's computer", "vm", "online", "main", "mine"])

  // A live viewer renews every 45 seconds: one event per sitting.
  for (let index = 0; index < 3; index += 1) assert.equal((await report({ event: "viewer_opened", view: "computer" })).status, 204)
  assert.equal((await report({ event: "viewer_opened", view: "computer", control: true })).status, 204)
  assert.equal((await report({ event: "paused" })).status, 204)
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).find((device) => device.id === computer.id)?.availability, "paused")
  assert.equal((await report({ event: "failed", code: "desktop_unavailable" })).status, 204)
  const failed = devicesOf(await asMember("GET", "/v1/remote-devices")).find((device) => device.id === computer.id)
  assert.deepEqual([failed?.availability, failed?.statusDetail], ["offline", "Did not respond"])
  assert.equal((await report({ event: "rebuilt" })).status, 204)
  assert.deepEqual(
    (await eventsOf(asMember, computer.id)).map((event) => [event.type, event.level, event.message]),
    [
      ["rebuilt", "info", "Rebuilt from a fresh image"],
      ["failed", "error", "Did not respond"],
      ["paused", "info", "Paused"],
      ["viewer_opened", "info", "Took control in the Computer view"],
      ["viewer_opened", "info", "Opened the Computer view"],
      ["registered", "info", "Workbot started using this computer"],
    ],
  )

  // A stale report cannot prove that the computer paused.
  await db.update(RemoteDeviceTable).set({ lastSeenAt: new Date(Date.now() - REMOTE_DEVICE_ONLINE_WINDOW_MS - 60_000) }).where(eq(RemoteDeviceTable.id, normalizeDenTypeId("remoteDevice", computer.id)))
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).find((device) => device.id === computer.id)?.availability, "unknown")

  // Fixed codes only, and only for the member's own conversations.
  assert.equal((await report({ event: "failed", code: "Error: connect ECONNREFUSED 10.0.0.4" })).status, 400)
  assert.equal((await report({ event: "exploded" })).status, 400)
  const otherToken = await den.mintMcpToken(other, orgId)
  assert.equal((await report({ event: "paused" }, otherToken)).status, 403)
  assert.equal(devicesOf(await asOther("GET", "/v1/remote-devices")).some((device) => device.provider === "workbot"), false)
  const readOnly = text(field((await den.request(member.token, "POST", "/v1/mcp/token", { orgId, body: { scopes: ["mcp:read"] } })).body, "token"), "read token")
  assert.equal((await report({ event: "paused" }, readOnly)).status, 403)
  assert.equal((await den.request("forged-token", "GET", "/v1/workbot/devices")).status, 401)

  // Deleting the chat takes its computer off the list.
  assert.equal((await report({ event: "removed" })).status, 204)
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).some((device) => device.id === computer.id), false)
})

test("Workbot cannot preclaim sessions or disclose another owner or tenant's title", async () => {
  const token = await den.mintMcpToken(member, orgId)
  const otherToken = await den.mintMcpToken(other, orgId)
  const report = (sessionId: string, chat: string, bearer = token) => den.request(bearer, "POST", "/v1/workbot/devices/computer", { body: { sessionId, chat, event: "resumed" } })
  const cell = "hs_c_0123456789abcdef0123456789abcdef01234567"
  const now = new Date()
  assert.equal((await report(cell, "main")).status, 403, "an arbitrary unindexed cell cannot be preclaimed")
  assert.equal((await report(workbotSessionId(orgId, other.memberId), "main")).status, 403)
  const chat = "0123456789abcdef"
  assert.equal((await report(workbotSideChatSessionId(orgId, other.memberId, chat), chat)).status, 403)
  const side = workbotSideChatSessionId(orgId, member.memberId, chat)
  assert.equal((await report(side, chat)).status, 204, "derived legacy side chats work without an index")
  const sideRow = (await db.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.externalId, side)))[0]!
  await asMember("DELETE", `/v1/remote-devices/${sideRow.id}`)

  await db.insert(HeadlessSessionIndexTable).values({ sessionId: cell, organizationId: normalizeDenTypeId("organization", orgId), memberId: normalizeDenTypeId("member", member.memberId),
    kind: "workbot", title: "Private cell title", version: 1, createdAt: now, updatedAt: now, lastReportedAt: now })
  assert.equal((await report(cell, chat, otherToken)).status, 403, "indexed cells require matching membership")
  assert.equal((await report(cell, chat)).status, 204, "real indexed Workbot cells are accepted")
  const cellRow = (await db.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.externalId, cell)))[0]!
  assert.match(devicesOf(await asMember("GET", "/v1/remote-devices")).find((device) => device.id === cellRow.id)!.label, /Private cell title/)

  // Simulate a historical poisoned registry row. Reads must independently fence title enrichment.
  await db.update(HeadlessSessionIndexTable).set({ memberId: normalizeDenTypeId("member", other.memberId) }).where(eq(HeadlessSessionIndexTable.sessionId, cell))
  assert.equal((await report(cell, chat)).status, 403)
  const detail = await asMember("GET", `/v1/remote-devices/${cellRow.id}`)
  assert.equal(field(detail.body, "device", "label"), "Workbot's computer")
  assert.equal(JSON.stringify((await asMember("GET", "/v1/remote-devices")).body).includes("Private cell title"), false)
  await db.update(HeadlessSessionIndexTable).set({ organizationId: normalizeDenTypeId("organization", elsewhere.orgId), memberId: normalizeDenTypeId("member", member.memberId) }).where(eq(HeadlessSessionIndexTable.sessionId, cell))
  assert.equal((await report(cell, chat)).status, 403)
  assert.equal(JSON.stringify((await asMember("GET", "/v1/remote-devices")).body).includes("Private cell title"), false)
  await asMember("DELETE", `/v1/remote-devices/${cellRow.id}`)
})

test("owners and regular org admins inspect all members and shared computers, never other organizations", async () => {
  const macbookRunner = devicesOf(await asMember("GET", "/v1/remote-devices")).find((device) => device.label === "Milo's MacBook Pro")!.computerId!
  await db.update(AutomationRunnerTable).set({ inventory: {
    computer: { label: "Milo's MacBook Pro", platform: "darwin", appVersion: "1.5.0" },
    workspaces: [{ workspaceId: "private-workspace-id", name: "Private customer project", active: true, engine: "v2", defaultModel: null, models: [] }],
  }, inventory_updated_at: new Date() }).where(eq(AutomationRunnerTable.id, macbookRunner))
  for (const as of [asOwner, asAdmin]) {
    const all = await as("GET", "/v1/org/computers")
    assert.equal(all.status, 200, summary(all))
    const page = organizationComputerListResponseSchema.parse(all.body)
    assert.equal(page.total, page.devices.length)
    assert.equal(page.online, page.devices.filter((device) => device.availability === "online" || device.availability === "needs_setup").length)
    assert.ok(page.staleHidden >= 1, "desktops nobody has heard from for a month are counted, not listed")
    assert.equal(field(all.body, "summary"), undefined, "no deployment aggregates")
    assert.ok(page.devices.every((device) => device.organization.id === orgId))
    assert.ok(page.devices.some((device) => device.owner?.email === member.email))
    assert.ok(page.devices.some((device) => device.owner?.email === other.email))
    const macbook = page.devices.find((device) => device.label === "Milo's MacBook Pro")!
    assert.ok(macbook)
    assert.deepEqual([macbook.owner?.email, macbook.shared, macbook.availability], [member.email, false, "online"])
    // Both hold Disconnect team computers: a live desktop is disconnected, never just removed.
    assert.deepEqual([macbook.owner?.former, macbook.disconnectedAt, macbook.canDisconnect, macbook.canRemove], [false, null, true, false])
    const sandbox = page.devices.find((device) => device.label === "Mac sandbox")
    assert.deepEqual([sandbox?.canDisconnect, sandbox?.canRemove], [false, true], "a computer registered by hand can be taken off the list")
    const workbot = organizationComputerListResponseSchema.parse((await as("GET", "/v1/org/computers?provider=workbot")).body).devices
    assert.ok(workbot.every((device) => !device.canDisconnect && !device.canRemove), "Workbot's computers are neither disconnected nor removed here")
    assert.ok(macbook.recentProblems >= 1)
    assert.equal(page.devices.find((device) => device.label === "Mac sandbox")?.owner, null)
    for (const availability of REMOTE_DEVICE_AVAILABILITIES) {
      const filtered = organizationComputerListResponseSchema.parse((await as("GET", `/v1/org/computers?availability=${availability}`)).body)
      assert.deepEqual(filtered.devices.map((device) => device.id).sort(), page.devices.filter((device) => device.availability === availability).map((device) => device.id).sort())
    }
    const searched = organizationComputerListResponseSchema.parse((await as("GET", `/v1/org/computers?search=${encodeURIComponent(member.email)}`)).body)
    assert.ok(searched.devices.length > 0 && searched.devices.every((device) => device.owner?.email === member.email))
    assert.equal(organizationComputerListResponseSchema.parse((await as("GET", "/v1/org/computers?kind=vm&provider=mac_host")).body).devices.length, 1)
    assert.equal((await as("GET", "/v1/org/computers?availability=sleepy")).status, 400)
    const detail = organizationComputerDetailResponseSchema.parse((await as("GET", `/v1/org/computers/${macbook.id}`)).body)
    assert.equal(detail.diagnostics?.osVersion, "25.1.0")
    assert.equal(detail.diagnostics?.arch, "arm64")
    assert.deepEqual(detail.diagnostics?.computerUse?.computers.map((computer) => computer.id), ["this-mac", "freestyle-vm", "daytona-sandbox"])
    assert.ok(detail.runner?.capabilities.includes("remote_session_v1"))
    assert.equal(detail.runner?.workspaces, 1)
    assert.equal(JSON.stringify(detail).includes("Private customer project"), false)
    assert.equal(JSON.stringify(detail).includes("private-workspace-id"), false)
    assert.equal(detail.features.remoteDevices, true)
    assert.equal(detail.features.computerUse, false)
    assert.ok(detail.events.some((event) => event.type === "app_updated" && event.data?.to === "1.5.0"))
    const removed = (await db.select({ id: RemoteDeviceTable.id }).from(RemoteDeviceTable).where(eq(RemoteDeviceTable.externalId, workbotSessionId(orgId, member.memberId))))[0]!
    const removedDetail = organizationComputerDetailResponseSchema.parse((await as("GET", `/v1/org/computers/${removed.id}`)).body)
    assert.equal(typeof removedDetail.device.removedAt, "string")
    assert.equal(field(removedDetail, "session", "title"), undefined)
    assert.equal(JSON.stringify(removedDetail).includes("Private cell title"), false)
    const forged = await as("GET", `/v1/org/computers?organizationId=${elsewhere.orgId}&orgId=${elsewhere.orgId}`, undefined, { "x-organization-id": elsewhere.orgId, "x-org-id": elsewhere.orgId })
    assert.equal(forged.status, 200, summary(forged))
    assert.ok(organizationComputerListResponseSchema.parse(forged.body).devices.every((device) => device.organization.id === orgId))
    const foreign = devicesOf(await asElsewhere("GET", "/v1/remote-devices"))[0]!
    assert.equal((await as("GET", `/v1/org/computers/${foreign.id}`)).status, 404)
    assert.equal((await as("GET", "/v1/org/computers/rdv_01h2xcejqtf2nbrexx3vqjhp41")).status, 404)
    assert.equal((await as("GET", "/v1/org/computers/not-an-id")).status, 400)
    for (const device of page.devices) assert.equal(device.availability, remoteDeviceAvailability({ kind: device.kind, provider: device.provider, state: device.state, lastSeenAt: device.lastSeenAt ? Date.parse(device.lastSeenAt) : null, now: Date.now() }))
  }
  assert.equal((await asMember("GET", "/v1/org/computers")).status, 403)
  const otherDesktop = devicesOf(await asOther("GET", "/v1/remote-devices")).find((device) => device.label === "Olive's laptop")!
  assert.ok(otherDesktop)
  assert.equal((await asMember("GET", `/v1/org/computers/${otherDesktop.id}`)).status, 403)
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).some((device) => device.id === otherDesktop.id), false)
  assert.equal((await asMember("GET", `/v1/remote-devices/${otherDesktop.id}`)).status, 404)
  const forgedHeader = await den.request(owner.token, "GET", "/v1/org/computers", { orgId: elsewhere.orgId })
  assert.equal(forgedHeader.status, 404, "an unverified organization header cannot select another tenant")
  assert.equal((await den.asPlatformAdmin("GET", "/v1/admin/remote-devices")).status, 404)
})

test("member agents discover read-only Devices capabilities", async () => {
  const token = await den.mintMcpToken(member, orgId)
  const found = await den.callMcpTool(token, "search_capabilities", { query: "remote devices computers", limit: 20 })
  const matches = list(field(found.body, "matches"))
  assert.ok(matches.some((entry) => entry.path === "/v1/remote-devices" && entry.method === "GET"), found.raw)
  assert.ok(matches.some((entry) => entry.path === "/v1/remote-devices/{deviceId}" && entry.method === "GET"), found.raw)
  assert.ok(matches.filter((entry) => String(entry.path).startsWith("/v1/remote-devices")).every((entry) => entry.method === "GET"), found.raw)
  const ownerToken = await den.mintMcpToken(owner, orgId)
  const team = await den.callMcpTool(ownerToken, "search_capabilities", { query: "team computers inventory", limit: 20 })
  const teamMatches = list(field(team.body, "matches"))
  assert.ok(teamMatches.some((entry) => entry.path === "/v1/org/computers" && entry.method === "GET"), team.raw)
  assert.ok(teamMatches.some((entry) => entry.path === "/v1/org/computers/{deviceId}" && entry.method === "GET"), team.raw)
})

test("registered local and cloud OpenWork instances are bounded sanitized team inventory, never personal computers", async () => {
  const id = createDenTypeId("worker")
  const foreignId = createDenTypeId("worker")
  const cloudId = createDenTypeId("worker")
  const now = new Date()
  await db.insert(WorkerTable).values([
    { id, org_id: normalizeDenTypeId("organization", orgId), created_by_user_id: normalizeDenTypeId("user", member.userId), name: "Local registered instance", destination: "local", status: "healthy", workspace_path: "/private/member/files", image_version: "test-image", last_heartbeat_at: now },
    { id: cloudId, org_id: normalizeDenTypeId("organization", orgId), created_by_user_id: normalizeDenTypeId("user", other.userId), name: "Cloud registered instance", destination: "cloud", status: "provisioning" },
    { id: foreignId, org_id: normalizeDenTypeId("organization", elsewhere.orgId), name: "Foreign cloud instance", destination: "cloud", status: "stopped" },
  ])
  await db.insert(CloudRuntimeInstanceTable).values({ id: createDenTypeId("cloudRuntimeInstance"), worker_id: cloudId, provider_id: "test-provider", provider_ref: { secret: "DO-NOT-EXPOSE" }, workspace_volume_id: "private-volume", data_volume_id: "data-volume", endpoint_url: "https://private.invalid/secret", endpoint_expires_at: now, endpoint_kind: "test", region: "test-region" })
  for (const as of [asOwner, asAdmin]) {
    const response = await as("GET", `/v1/org/computers?organizationId=${elsewhere.orgId}`)
    const inventory = organizationComputerListResponseSchema.parse(response.body)
    assert.equal(inventory.instancesTotal, 2)
    assert.deepEqual(inventory.instances.map((instance) => instance.id).sort(), [id, cloudId].sort())
    const local = inventory.instances.find((instance) => instance.id === id)!
    const cloud = inventory.instances.find((instance) => instance.id === cloudId)!
    assert.equal(local.owner?.email, member.email)
    assert.equal(local.owner?.memberId, member.memberId)
    assert.equal(cloud.owner?.email, other.email)
    assert.equal(cloud.provider, "test-provider")
    assert.equal(local.status, "healthy")
    assert.equal(local.lastSeenAt, now.toISOString())
    assert.equal(field(local, "availability"), undefined, "healthy does not imply online")
    const detail = await as("GET", `/v1/org/computers/instances/${id}`)
    assert.deepEqual(organizationComputerInstanceDetailResponseSchema.parse(detail.body).instance, local)
    for (const secret of ["/private/member/files", "DO-NOT-EXPOSE", "private.invalid", "private-volume", "provider_ref", "workspace_path"]) {
      assert.equal(JSON.stringify(response.body).includes(secret), false)
      assert.equal(JSON.stringify(detail.body).includes(secret), false)
    }
    assert.equal((await as("GET", `/v1/org/computers/instances/${foreignId}`)).status, 404)
    assert.equal(organizationComputerListResponseSchema.parse((await as("GET", "/v1/org/computers?instancePage=2")).body).instances.length, 0)
    assert.equal(organizationComputerListResponseSchema.parse((await as("GET", "/v1/org/computers?instanceDestination=cloud")).body).instancesTotal, 1)
  }
  assert.equal((await asMember("GET", `/v1/org/computers/instances/${id}`)).status, 403)
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).some((device) => String(device.id) === String(id)), false)
  assert.equal((await db.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.externalId, id))).length, 0)
})

test("events are bounded per device, and turning the feature off hides everything and keeps what is stored", async () => {
  const [device] = await db.select({ id: RemoteDeviceTable.id, organizationId: RemoteDeviceTable.organizationId }).from(RemoteDeviceTable).where(eq(RemoteDeviceTable.label, "Milo's MacBook Pro"))
  assert.ok(device)
  const base = Date.now() - 60_000
  await db.insert(RemoteDeviceEventTable).values(Array.from({ length: REMOTE_DEVICE_EVENT_LIMIT + 40 }, (_, index) => ({
    id: createDenTypeId("remoteDeviceEvent"),
    organizationId: device.organizationId, deviceId: device.id, type: "state_changed" as const, level: "info" as const,
    message: `Ready ${index}`, actor: "device" as const, createdAt: new Date(base - index * 1000),
  })))
  await db.insert(RemoteDeviceEventTable).values({
    id: createDenTypeId("remoteDeviceEvent"), organizationId: device.organizationId, deviceId: device.id,
    type: "state_changed", level: "info", message: "Long ago", actor: "device", createdAt: new Date(Date.now() - 45 * 24 * 60 * 60_000),
  })
  // A normal event write deterministically prunes; no random branch or explicit cleanup needed.
  assert.equal((await asMember("PUT", "/v1/remote-devices/this-computer", desktopReport({ appVersion: "1.6.0" }))).status, 200)
  const kept = await db.select({ message: RemoteDeviceEventTable.message }).from(RemoteDeviceEventTable).where(eq(RemoteDeviceEventTable.deviceId, device.id))
  assert.equal(kept.length, REMOTE_DEVICE_EVENT_LIMIT)
  assert.equal(kept.some((event) => event.message === "Long ago"), false)

  const tiedAt = new Date()
  await db.update(RemoteDeviceEventTable).set({ createdAt: tiedAt }).where(eq(RemoteDeviceEventTable.deviceId, device.id))
  await db.insert(RemoteDeviceEventTable).values(Array.from({ length: 20 }, () => ({
    id: createDenTypeId("remoteDeviceEvent"), organizationId: device.organizationId, deviceId: device.id,
    type: "state_changed" as const, level: "info" as const, message: "Tied", actor: "device" as const, createdAt: tiedAt,
  })))
  const ordered = () => db.select({ id: RemoteDeviceEventTable.id }).from(RemoteDeviceEventTable).where(eq(RemoteDeviceEventTable.deviceId, device.id))
    .orderBy(desc(RemoteDeviceEventTable.createdAt), desc(RemoteDeviceEventTable.id))
  const expected = (await ordered()).slice(0, REMOTE_DEVICE_EVENT_LIMIT)
  await pruneRemoteDeviceEvents(device.id)
  assert.deepEqual(await ordered(), expected, "ties retain exactly the newest ids, in stable order")
  assert.deepEqual((await eventsOf(asMember, device.id)).map((event) => event.id), expected.slice(0, 20).map((event) => event.id))

  const stored = (await db.select().from(RemoteDeviceTable)).length
  assert.equal((await den.setFeature(orgId, "remoteDevices", false)).status, 200)
  assert.equal((await asMember("GET", "/v1/remote-devices")).status, 404)
  assert.equal((await asMember("PUT", "/v1/remote-devices/this-computer", desktopReport())).status, 404)
  const token = await den.mintMcpToken(member, orgId)
  assert.equal(field((await den.request(token, "GET", "/v1/workbot/session")).body, "devices"), false)
  assert.equal((await den.request(token, "GET", "/v1/workbot/devices")).status, 404)
  assert.equal((await db.select().from(RemoteDeviceTable)).length, stored)
  assert.equal((await asOwner("GET", "/v1/org/computers")).status, 404)
  assert.equal((await asAdmin("GET", `/v1/org/computers/${device.id}`)).status, 404)

  // Deleting an organization takes its devices and their events with it.
  assert.equal(devicesOf(await asElsewhere("GET", "/v1/remote-devices")).length, 1)
  const deleted = await asElsewhere("DELETE", "/v1/org", { confirmation: "Another organization" })
  assert.ok(deleted.status < 300, summary(deleted))
  const elsewhereId = normalizeDenTypeId("organization", elsewhere.orgId)
  assert.equal((await db.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.organizationId, elsewhereId))).length, 0)
  assert.equal((await db.select().from(RemoteDeviceEventTable).where(eq(RemoteDeviceEventTable.organizationId, elsewhereId))).length, 0)
})
