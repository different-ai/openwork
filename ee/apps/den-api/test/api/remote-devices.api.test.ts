import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AutomationRunnerTable, RemoteDeviceEventTable, RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  REMOTE_DEVICE_AVAILABILITIES,
  REMOTE_DEVICE_EVENT_LIMIT,
  REMOTE_DEVICE_ONLINE_WINDOW_MS,
  adminRemoteDeviceDetailResponseSchema,
  adminRemoteDeviceListResponseSchema,
  remoteDeviceAvailability,
  remoteDeviceDetailResponseSchema,
  remoteDeviceListResponseSchema,
} from "@openwork/types/den/remote-devices"
import { bootDen, field, list, summary, text } from "./harness.js"

/**
 * Devices (feature `remoteDevices`): what a member, Workbot and a platform admin
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
    { id: listed.id, kind: listed.kind, provider: listed.provider, label: listed.label, access: listed.access, availability: listed.availability, appVersion: listed.appVersion, canRename: listed.canRename, canRemove: listed.canRemove },
    { id, kind: "desktop", provider: "openwork_desktop", label: "Milo's MacBook Pro", access: "mine", availability: "online", appVersion: "1.4.0", canRename: false, canRemove: true },
  )
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
  const sessionId = "hs_wb_0123456789abcdef0123456789abcdef01234567"
  const token = await den.mintMcpToken(member, orgId)
  const report = (body: Record<string, unknown>, bearer = token) => den.request(bearer, "POST", "/v1/workbot/devices/computer", { body: { sessionId, chat: "main", ...body } })

  const session = await den.request(token, "GET", "/v1/workbot/session")
  assert.equal(field(session.body, "devices"), true, summary(session))
  const before = devicesOf(await den.request(token, "GET", "/v1/workbot/devices"))
  assert.deepEqual(before.map((device) => device.id).sort(), devicesOf(await asMember("GET", "/v1/remote-devices")).map((device) => device.id).sort())
  assert.ok(before.filter((device) => device.access === "shared").every((device) => !device.canRename && !device.canRemove), "Workbot never manages shared computers")

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

  // Idle for longer than the runner's pause: shown paused without anyone having said so.
  await db.update(RemoteDeviceTable).set({ lastSeenAt: new Date(Date.now() - REMOTE_DEVICE_ONLINE_WINDOW_MS - 60_000) }).where(eq(RemoteDeviceTable.id, normalizeDenTypeId("remoteDevice", computer.id)))
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).find((device) => device.id === computer.id)?.availability, "paused")

  // Fixed codes only, and only for the member's own conversations.
  assert.equal((await report({ event: "failed", code: "Error: connect ECONNREFUSED 10.0.0.4" })).status, 400)
  assert.equal((await report({ event: "exploded" })).status, 400)
  const otherToken = await den.mintMcpToken(other, orgId)
  assert.equal((await report({ event: "paused" }, otherToken)).status, 204)
  assert.equal(devicesOf(await asOther("GET", "/v1/remote-devices")).some((device) => device.provider === "workbot"), false)
  const readOnly = text(field((await den.request(member.token, "POST", "/v1/mcp/token", { orgId, body: { scopes: ["mcp:read"] } })).body, "token"), "read token")
  assert.equal((await report({ event: "paused" }, readOnly)).status, 403)
  assert.equal((await den.request("forged-token", "GET", "/v1/workbot/devices")).status, 401)

  // Deleting the chat takes its computer off the list.
  assert.equal((await report({ event: "removed" })).status, 204)
  assert.equal(devicesOf(await asMember("GET", "/v1/remote-devices")).some((device) => device.id === computer.id), false)
})

test("a platform admin sees every device with what explains its state, and nobody else does", async () => {
  for (const as of [asOwner, asMember]) {
    assert.equal((await as("GET", "/v1/admin/remote-devices")).status, 403)
    assert.equal((await as("GET", "/v1/admin/remote-devices/rdv_01h2xcejqtf2nbrexx3vqjhp41")).status, 403)
  }
  const all = await den.asPlatformAdmin("GET", "/v1/admin/remote-devices")
  assert.equal(all.status, 200, summary(all))
  const page = adminRemoteDeviceListResponseSchema.parse(all.body)
  assert.equal(page.total, page.devices.length)
  assert.equal(page.summary.total, page.total)
  assert.deepEqual([...new Set(page.devices.map((device) => device.organization.name))].sort(), ["Another organization", "Devices organization"])

  const scoped = adminRemoteDeviceListResponseSchema.parse((await den.asPlatformAdmin("GET", `/v1/admin/remote-devices?organizationId=${orgId}`)).body)
  assert.ok(scoped.devices.every((device) => device.organization.id === orgId))
  const macbook = scoped.devices.find((device) => device.label === "Milo's MacBook Pro")
  assert.ok(macbook)
  assert.deepEqual([macbook.owner?.email, macbook.shared, macbook.availability], [member.email, false, "online"])
  assert.ok(macbook.recentProblems >= 1, "the Screen Recording warning counts as a recent problem")
  assert.equal(scoped.devices.find((device) => device.label === "Mac sandbox")?.owner, null)

  // The availability filter and count are computed in SQL; they must agree with what each row says.
  for (const availability of REMOTE_DEVICE_AVAILABILITIES) {
    const filtered = adminRemoteDeviceListResponseSchema.parse((await den.asPlatformAdmin("GET", `/v1/admin/remote-devices?organizationId=${orgId}&availability=${availability}`)).body)
    assert.deepEqual(filtered.devices.map((device) => device.id).sort(), scoped.devices.filter((device) => device.availability === availability).map((device) => device.id).sort(), availability)
  }
  assert.equal(page.summary.online, page.devices.filter((device) => device.availability === "online").length)
  const problems = adminRemoteDeviceListResponseSchema.parse((await den.asPlatformAdmin("GET", "/v1/admin/remote-devices?problems=true")).body)
  assert.deepEqual(problems.devices.map((device) => device.id).sort(), page.devices.filter((device) => device.recentProblems > 0).map((device) => device.id).sort())
  assert.equal(page.summary.withProblems, problems.total)
  const searched = adminRemoteDeviceListResponseSchema.parse((await den.asPlatformAdmin("GET", `/v1/admin/remote-devices?search=${encodeURIComponent(member.email)}`)).body)
  assert.ok(searched.devices.length > 0 && searched.devices.every((device) => device.owner?.email === member.email))
  assert.equal(adminRemoteDeviceListResponseSchema.parse((await den.asPlatformAdmin("GET", "/v1/admin/remote-devices?kind=vm&provider=mac_host")).body).devices.length, 1)
  assert.equal((await den.asPlatformAdmin("GET", "/v1/admin/remote-devices?organizationId=nope")).status, 400)
  assert.equal((await den.asPlatformAdmin("GET", "/v1/admin/remote-devices?availability=sleepy")).status, 400)

  const detailCall = await den.asPlatformAdmin("GET", `/v1/admin/remote-devices/${macbook.id}`)
  assert.equal(detailCall.status, 200, summary(detailCall))
  const detail = adminRemoteDeviceDetailResponseSchema.parse(detailCall.body)
  assert.equal(detail.diagnostics?.osVersion, "25.1.0")
  assert.deepEqual(detail.diagnostics?.computerUse?.computers.map((computer) => computer.id), ["this-mac", "freestyle-vm", "daytona-sandbox"])
  assert.equal(detail.runner?.computerId, macbook.computerId)
  assert.ok(detail.runner?.capabilities.includes("remote_session_v1"))
  assert.equal(detail.features.remoteDevices, true)
  assert.equal(detail.features.computerUse, false)
  assert.ok(detail.events.some((event) => event.type === "app_updated" && event.data?.to === "1.5.0"))
  assert.equal(detail.session, null)

  // A removed device is still readable by id, with its removal and its conversation's index row.
  const removed = (await db.select({ id: RemoteDeviceTable.id }).from(RemoteDeviceTable).where(eq(RemoteDeviceTable.provider, "workbot")))[0]
  assert.ok(removed)
  const removedDetail = adminRemoteDeviceDetailResponseSchema.parse((await den.asPlatformAdmin("GET", `/v1/admin/remote-devices/${removed.id}`)).body)
  assert.equal(typeof removedDetail.device.removedAt, "string")
  assert.equal(removedDetail.events[0]?.message, "Removed with its chat")
  assert.equal(page.devices.some((device) => device.id === removed.id), false, "removed devices leave the list")
  assert.equal((await den.asPlatformAdmin("GET", "/v1/admin/remote-devices/rdv_01h2xcejqtf2nbrexx3vqjhp41")).status, 404)
  assert.equal((await den.asPlatformAdmin("GET", "/v1/admin/remote-devices/not-an-id")).status, 400)

  // The SQL availability and the shared function are the same rule.
  const now = Date.now()
  for (const device of page.devices) {
    assert.equal(device.availability, remoteDeviceAvailability({ kind: device.kind, provider: device.provider, state: device.state, lastSeenAt: device.lastSeenAt ? Date.parse(device.lastSeenAt) : null, now }), device.label)
  }
})

test("the admin MCP tools answer the same questions for an agent, for platform admins only", async () => {
  const call = (token: string, name: string, args: Record<string, unknown>) => den.request(token, "POST", "/mcp/admin", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  })
  const result = (response: Awaited<ReturnType<typeof call>>): unknown => {
    const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
    const envelope: unknown = line ? JSON.parse(line.slice(5)) : response.body
    assert.notEqual(field(envelope, "result", "isError"), true, response.text)
    const content = field(envelope, "result", "content")
    assert.ok(Array.isArray(content))
    return JSON.parse(text(field(content[0], "text"), "tool result"))
  }
  const forbidden = await call(await den.mintMcpToken(owner, orgId), "den_devices_list", {})
  assert.equal(forbidden.status, 403, summary(forbidden))

  const adminEmail = `platform-admin+${den.stamp}@example.test`
  const signedIn = await den.signIn(adminEmail)
  assert.equal(signedIn.status, 200, summary(signedIn))
  const admin = { token: text(field(signedIn.body, "token"), "admin token"), cookie: "", email: adminEmail, name: "Platform Admin", userId: text(field(signedIn.body, "user", "id"), "admin id") }
  const adminToken = await den.mintMcpToken(admin, (await den.createOrg(admin, "Admin workspace")).orgId)

  const listed = adminRemoteDeviceListResponseSchema.parse(result(await call(adminToken, "den_devices_list", { org: "Devices organization", kind: "desktop" })))
  // The desktop nobody has heard from in a month is gone here too.
  assert.deepEqual(listed.devices.map((device) => device.label).sort(), ["Milo's MacBook Pro", "Olive's laptop"])
  const macbook = listed.devices.find((device) => device.label === "Milo's MacBook Pro")
  assert.ok(macbook)
  const detail = adminRemoteDeviceDetailResponseSchema.parse(result(await call(adminToken, "den_device_detail", { deviceId: macbook.id })))
  assert.equal(detail.device.owner?.email, member.email)
  assert.ok(detail.events.length > 0)
  const missing = await call(adminToken, "den_device_detail", { deviceId: "nope" })
  assert.match(missing.text, /Invalid device id/)
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
  await pruneRemoteDeviceEvents(device.id)
  const kept = await db.select({ message: RemoteDeviceEventTable.message }).from(RemoteDeviceEventTable).where(eq(RemoteDeviceEventTable.deviceId, device.id))
  assert.equal(kept.length, REMOTE_DEVICE_EVENT_LIMIT)
  assert.equal(kept.some((event) => event.message === "Long ago"), false)

  const stored = (await db.select().from(RemoteDeviceTable)).length
  assert.equal((await den.setFeature(orgId, "remoteDevices", false)).status, 200)
  assert.equal((await asMember("GET", "/v1/remote-devices")).status, 404)
  assert.equal((await asMember("PUT", "/v1/remote-devices/this-computer", desktopReport())).status, 404)
  const token = await den.mintMcpToken(member, orgId)
  assert.equal(field((await den.request(token, "GET", "/v1/workbot/session")).body, "devices"), false)
  assert.equal((await den.request(token, "GET", "/v1/workbot/devices")).status, 404)
  assert.equal((await db.select().from(RemoteDeviceTable)).length, stored)
  // /admin keeps working: it is how the feature is debugged, on or off.
  assert.equal((await den.asPlatformAdmin("GET", `/v1/admin/remote-devices?organizationId=${orgId}`)).status, 200)

  // Deleting an organization takes its devices and their events with it.
  assert.equal(list(field((await den.asPlatformAdmin("GET", `/v1/admin/remote-devices?organizationId=${elsewhere.orgId}`)).body, "devices")).length, 1)
  const deleted = await asElsewhere("DELETE", "/v1/org", { confirmation: "Another organization" })
  assert.ok(deleted.status < 300, summary(deleted))
  const elsewhereId = normalizeDenTypeId("organization", elsewhere.orgId)
  assert.equal((await db.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.organizationId, elsewhereId))).length, 0)
  assert.equal((await db.select().from(RemoteDeviceEventTable).where(eq(RemoteDeviceEventTable.organizationId, elsewhereId))).length, 0)
})
