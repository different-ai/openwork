import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AutomationRunnerTable, ComputerGrantTable, MemberTable, OrganizationTable, RemoteDeviceTable, WorkerTable } from "@openwork-ee/den-db/schema"
import { workbotSessionId, workbotSideChatSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { COMPUTER_INVENTORY_PAGE_SIZE, computerInventoryDetailResponseSchema, myComputerInventoryResponseSchema, organizationComputerInventoryResponseSchema, readOrganizationComputerRules } from "@openwork/types/den/computer-inventory"
import { COMPUTER_SHELL_RUNNER_CAPABILITY } from "@openwork/types/den/computers"
import { organizationComputerListResponseSchema, remoteDeviceListResponseSchema, remoteDeviceResponseSchema } from "@openwork/types/den/remote-devices"
import { deviceInventoryStatus, groupComputerSignIns, type InventorySignIn } from "../../src/computers/inventory.js"
import { bootDen, field, summary, type Call } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")
const { automationRunnerRowId } = await import("../../src/automations/repository.js")
const { replaceComputerAccess } = await import("../../src/computers/store.js")
const { orgId, owner } = await den.createOrg(await den.signUp("Priya Nair"), "Northwind Labs")
const maya = await den.newMember(owner, orgId, "Maya Okafor")
const tomas = await den.newMember(owner, orgId, "Tomas Rivera")
const jonas = await den.newMember(owner, orgId, "Jonas Weber")
const off = await den.createOrg(owner, "Clearwater Labs")
const asOwner = den.as(owner, orgId)
const asMaya = den.as(maya, orgId)
const asTomas = den.as(tomas, orgId)
const asJonas = den.as(jonas, orgId)
const asOff = den.as(off.owner, off.orgId)
const enabled = await den.setFeature(orgId, "computers", true)
assert.equal(enabled.status, 200, summary(enabled))

const personal = "/v1/computers/inventory"
const team = "/v1/org/computers/inventory"
const day = 86_400_000
const organizationId = normalizeDenTypeId("organization", orgId)
const mayaId = normalizeDenTypeId("member", maya.memberId)
const hardwareHash = "a1".repeat(32)
const storedHash = (tenant: string) => createHash("sha256").update(`${tenant}\n${hardwareHash}`).digest("hex")
const inventoryBody = (call: Call) => {
  assert.equal(call.status, 200, summary(call))
  assert.equal(call.headers.get("cache-control"), "no-store")
  const body = JSON.stringify(call.body)
  assert.doesNotMatch(body, /machineKey|machine_key/)
  assert.equal(body.includes(hardwareHash) || body.includes(storedHash(orgId)), false)
  return call.body
}
const list = async (request = asMaya) => myComputerInventoryResponseSchema.parse(inventoryBody(await request("GET", personal)))
const detail = async (id: string, request = asMaya, path = personal) => computerInventoryDetailResponseSchema.parse(inventoryBody(await request("GET", `${path}/${id}`)))
const tab = async (query = "", request = asOwner) => organizationComputerInventoryResponseSchema.parse(inventoryBody(await request("GET", team + query)))

async function report(request: typeof asMaya, installId: string, fields: Record<string, unknown> = {}) {
  const call = await request("PUT", "/v1/remote-devices/this-computer", { installId, label: "Field Mac", platform: "darwin", appVersion: "1.4.0", ...fields })
  return normalizeDenTypeId("remoteDevice", remoteDeviceResponseSchema.parse(inventoryBody(call)).device.id)
}

async function register(request: typeof asMaya, label: string, externalId: string, shared = false) {
  const call = await request("POST", "/v1/remote-devices", { provider: "daytona", platform: "linux", label, externalId, shared })
  assert.equal(call.status, 201, summary(call))
  return normalizeDenTypeId("remoteDevice", remoteDeviceResponseSchema.parse(call.body).device.id)
}

test("five sign-ins resolve to one Mac without altering the legacy device list or exposing the machine key", async () => {
  const ids = []
  for (let install = 0; install < 5; install++) ids.push(await report(asMaya, `field-mac-${install}`, { machineKey: hardwareHash, label: `Field Mac ${install}` }))
  const [first] = ids
  const newest = ids.at(-1)
  assert.ok(first && newest)
  await db.update(RemoteDeviceTable).set({ lastSeenAt: new Date() }).where(eq(RemoteDeviceTable.id, newest))
  const inventory = await list()
  assert.deepEqual(inventory.computers.map(({ id, mergedSignIns, runCode }) => ({ id, mergedSignIns, runCode })), [{ id: newest, mergedSignIns: 4, runCode: { value: "no", reason: "sandbox_unavailable" } }])
  assert.deepEqual(inventory.mergedSignIns.map(({ id }) => id).sort(), ids.slice(0, 4).sort())
  assert.ok(inventory.mergedSignIns.every((signIn) => signIn.computerId === newest && !signIn.canRemove))
  assert.deepEqual((await detail(newest)).installed.mergedSignIns, inventory.mergedSignIns)
  assert.deepEqual((await detail(newest)).activity.map(({ type }) => type), ["registered"])
  assert.equal((await asMaya("GET", `${personal}/${first}`)).status, 404)
  const legacy = remoteDeviceListResponseSchema.parse(inventoryBody(await asMaya("GET", "/v1/remote-devices")))
  assert.deepEqual(legacy.devices.map(({ id }) => id).sort(), [...ids].sort())
  const legacyAdmin = organizationComputerListResponseSchema.parse(inventoryBody(await asOwner("GET", "/v1/org/computers")))
  assert.deepEqual(legacyAdmin.devices.map(({ id }) => id).sort(), [...ids].sort())
  const stored = await db.select({ key: RemoteDeviceTable.machineKey }).from(RemoteDeviceTable).where(eq(RemoteDeviceTable.organizationId, organizationId))
  assert.deepEqual(new Set(stored.map(({ key }) => key)), new Set([storedHash(orgId)]))
  assert.equal((await asTomas("GET", `${personal}/${newest}`)).status, 404)
  assert.deepEqual((await list(asTomas)).computers, [])
  assert.equal((await asMaya("GET", team)).status, 403)
  assert.equal((await asMaya("GET", `${team}/${newest}`)).status, 403)
  const other = await report(asTomas, "field-mac-0", { machineKey: hardwareHash, label: "Field Mac 4" })
  assert.deepEqual((await tab()).computers.map(({ id }) => id).sort(), [newest, other].sort())
})

test("keyless historical sign-ins fold but overlapping same-name Macs and different owners stay separate", async () => {
  const old = await report(asMaya, "legacy-office-1", { label: "  Office MAC " })
  await db.update(RemoteDeviceTable).set({ createdAt: new Date(Date.now() - 42 * day), lastSeenAt: new Date(Date.now() - 40 * day) }).where(eq(RemoteDeviceTable.id, old))
  const current = await report(asMaya, "legacy-office-2", { label: "Office Mac" })
  const sameNameOtherOwner = await report(asTomas, "legacy-office-2", { label: "Office Mac" })
  const folded = await list()
  assert.equal(folded.computers.find(({ id }) => id === current)?.mergedSignIns, 1)
  assert.deepEqual(folded.mergedSignIns.find(({ id }) => id === old)?.canRemove, true)
  const another = await report(asMaya, "legacy-office-3", { label: "Office Mac" })
  const yesterday = new Date(Date.now() - day)
  for (const id of [current, another]) {
    await db.update(RemoteDeviceTable).set({ createdAt: yesterday }).where(eq(RemoteDeviceTable.id, id))
  }
  const sameName = (await tab("?search=OFFICE%20MAC&older=include")).computers
  assert.ok(sameName.some(({ id }) => id === current) && sameName.some(({ id }) => id === another))
  assert.ok(sameName.some(({ id }) => id === sameNameOtherOwner))
  assert.equal(sameName.filter(({ status }) => status.state === "online").length, 3)
})

test("one Workbot row uses the latest conversation report, not permissions or image setup as provider failures", async () => {
  const token = await den.mintMcpToken(maya, orgId)
  const send = async (chat: string, event: string, code?: string) => {
    const sessionId = chat === "main" ? workbotSessionId(orgId, maya.memberId) : workbotSideChatSessionId(orgId, maya.memberId, chat)
    const call = await den.request(token, "POST", "/v1/workbot/devices/computer", { body: { sessionId, chat, event, code } })
    assert.equal(call.status, 204, summary(call))
  }
  await send("main", "resumed")
  await send("first-chat", "resumed")
  await send("last-chat", "failed", "desktop_outdated")
  const workbotRows = (await list()).computers.filter(({ kind }) => kind === "workbot")
  const [row] = workbotRows
  assert.equal(workbotRows.length, 1)
  assert.ok(row)
  assert.deepEqual([row.label, row.kindLabel, row.mergedSignIns, row.status.state], ["Workbot's computer", "Cloud computer", 0, "starts_when_needed"])
  assert.deepEqual(row.notes, [{ code: "update_required", message: "Workbot's computer needs an update" }])
  await send("last-chat", "failed", "desktop_unresponsive")
  assert.deepEqual((await detail(row.id)).computer.notes, [{ code: "provider_problem", message: "Could not be reached" }])
  assert.equal((await detail(row.id)).computer.status.state, "has_a_problem")
})

test("desktop permissions are a note, while a registered Daytona computer can run code without a reachability report", async () => {
  const desktop = await report(asMaya, "needs-permissions", { label: "Permissions Mac", computerUse: {
    enabled: true, remoteEnabled: false, selectedId: "local",
    computers: [{ id: "local", label: "This Mac", placement: "local", readiness: "setup-required", detail: "Screen Recording is off" }],
    permissions: { accessibility: true, screenRecording: false },
  } })
  const listed = (await detail(desktop)).computer
  assert.equal(listed.status.state, "online")
  assert.deepEqual(listed.notes, [{ code: "computer_use_permissions", message: "Computer Use needs permissions" }])
  const cloud = await register(asMaya, "Build computer", "build-daytona")
  assert.deepEqual((await detail(cloud)).computer.status, { state: "starts_when_needed", lastSeenAt: null })
  const allow = await asMaya("PUT", `/v1/computers/${cloud}/access`, { choice: "allow", scope: "whole_vm", folders: ["/workspace"] })
  assert.equal(allow.status, 200, summary(allow))
  const own = await detail(cloud)
  assert.deepEqual(own.runCode, { value: { value: "whole_computer" }, sources: [{ key: "owner_whole_vm", label: "Maya Okafor's OpenWork apps", scope: "whole_computer", folders: ["/workspace"], writableFolders: [], revokedAt: null, revokedBy: null }], canChange: true, canRevoke: true, canRestore: true })
  const admin = await detail(cloud, asOwner, team)
  assert.deepEqual([admin.callerIsOwner, admin.runCode.canChange, admin.runCode.canRevoke, admin.runCode.canRestore], [false, false, true, false])
  const revokedAt = new Date()
  const revokerId = normalizeDenTypeId("member", owner.memberId)
  await db.update(ComputerGrantTable).set({ revokedAt, revokedByMemberId: revokerId }).where(eq(ComputerGrantTable.targetDeviceId, cloud))
  const revoked = await detail(cloud)
  assert.deepEqual(revoked.runCode.value, { value: "no", reason: "revoked" })
  assert.deepEqual((await tab("?tab=cloud")).computers.find(({ id }) => id === cloud)?.runCode, revoked.runCode.value)
  assert.deepEqual(revoked.runCode.sources.map(({ revokedAt, revokedBy }) => [revokedAt, revokedBy]), [[revokedAt.toISOString(), owner.name]])
  await db.update(ComputerGrantTable).set({ revokedByMemberId: normalizeDenTypeId("member", off.owner.memberId) }).where(eq(ComputerGrantTable.targetDeviceId, cloud))
  assert.deepEqual((await detail(cloud)).runCode.sources.map(({ revokedBy }) => revokedBy), [null])
})

test("a capable runner supplies effective contact and remote session access, and only active sandbox folders count", async () => {
  const installId = "capable-runner-test"
  const id = await report(asMaya, installId, { label: "Runner Mac" })
  const token = await asMaya("POST", "/v1/session-runners/token", {
    runnerId: installId, protocolVersion: 1, supportedExecutionTargets: ["desktop"],
    capabilities: [COMPUTER_SHELL_RUNNER_CAPABILITY, "remote_session_v1"], appVersion: "1.5.0", platform: "darwin", concurrency: 1,
  })
  assert.equal(token.status, 200, summary(token))
  const runner = automationRunnerRowId({ organizationId, ownerMemberId: mayaId, runnerId: installId })
  const seenAt = new Date()
  await db.update(AutomationRunnerTable).set({ last_seen_at: seenAt }).where(eq(AutomationRunnerTable.id, runner))
  await db.update(RemoteDeviceTable).set({ lastSeenAt: new Date(Date.now() - day) }).where(eq(RemoteDeviceTable.id, id))
  const [device] = await db.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.id, id)).limit(1)
  assert.ok(device)
  assert.deepEqual((await detail(id)).runCode.value, { value: "no", reason: "not_chosen" })
  await replaceComputerAccess(device, runner, { choice: "allow", grants: [
    { source: { kind: "workbot" }, folders: ["/notes", "/work"] },
    { source: { kind: "owner" }, folders: ["/notes", "/other"] },
  ] })
  await db.insert(ComputerGrantTable).values({ id: createDenTypeId("computerGrant"), organizationId, targetDeviceId: id, sourceKey: "owner", folders: ["/notes", "/other"], revokedAt: new Date() })
  const item = await detail(id)
  assert.deepEqual(item.computer.status, { state: "online", lastSeenAt: seenAt.toISOString() })
  assert.deepEqual(item.sessions, { sendTasks: true, readSessions: "started_by_them", access: { effective: "created", chosen: false, reason: null } })
  assert.deepEqual(item.runCode.value, { value: "sandbox", folders: 2 })
  assert.deepEqual(item.runCode.sources.map(({ label }) => label), ["Maya Okafor's OpenWork apps", "Workbot"])
  const revoked = await asOwner("DELETE", `/v1/org/computers/${id}/sources/workbot`)
  assert.equal(revoked.status, 200, summary(revoked))
  const allRevoked = { value: "no", reason: "revoked" }
  assert.deepEqual((await detail(id)).runCode.value, allRevoked)
  assert.deepEqual((await list()).computers.find((computer) => computer.id === id)?.runCode, allRevoked)
  await db.update(OrganizationTable).set({ metadata: { computers: { runCode: false } } }).where(eq(OrganizationTable.id, organizationId))
  assert.deepEqual((await detail(id)).runCode.value, { value: "no", reason: "organization" })
})

test("organization tabs count matching grouped rows, hide older machines, and keep former members and instances separate", async () => {
  const stale = await report(asTomas, "quiet-mac-fixture", { label: "Inventory Probe" })
  await db.update(RemoteDeviceTable).set({ createdAt: new Date(Date.now() - 10 * day), lastSeenAt: new Date(Date.now() - 8 * day) }).where(eq(RemoteDeviceTable.id, stale))
  const fresh = await report(asTomas, "current-mac-fixture", { label: "Inventory Probe 2" })
  const former = await register(asJonas, "Inventory Probe 3", "former-daytona")
  const shared = await register(asOwner, "Inventory Probe 4", "shared-daytona", true)
  await db.update(RemoteDeviceTable).set({ state: "unavailable", lastSeenAt: new Date() }).where(eq(RemoteDeviceTable.id, shared))
  await db.update(RemoteDeviceTable).set({ state: "unavailable", lastSeenAt: new Date() }).where(eq(RemoteDeviceTable.id, former))
  const instance = createDenTypeId("worker")
  await db.insert(WorkerTable).values({ id: instance, org_id: organizationId, name: "Inventory Probe 5", status: "failed", destination: "cloud", last_heartbeat_at: new Date() })
  await db.update(MemberTable).set({ removedAt: new Date() }).where(eq(MemberTable.id, normalizeDenTypeId("member", jonas.memberId)))
  const query = "search=inVEntory%20PROBE"
  const desktop = await tab(`?${query}`)
  assert.deepEqual(desktop.counts, { desktops: 2, cloud: 2, attention: 1, former: 1 })
  assert.deepEqual([desktop.olderHidden, desktop.total, desktop.page, desktop.pageSize], [1, 1, 1, COMPUTER_INVENTORY_PAGE_SIZE])
  assert.deepEqual(desktop.computers.map(({ id }) => id), [fresh])
  const older = await tab(`?${query}&older=include`)
  assert.deepEqual([older.olderHidden, older.total, ...older.computers.map(({ id }) => id)], [0, 2, fresh, stale])
  assert.deepEqual((await tab(`?${query}&older=include&page=2`)).computers, [])
  assert.deepEqual((await tab(`?${query}&tab=cloud`)).computers.map(({ id }) => id).sort(), [shared, instance].sort())
  assert.deepEqual((await tab(`?${query}&tab=former`)).computers.map(({ id, owner }) => [id, owner?.former]), [[former, true]])
  assert.equal((await detail(former, asOwner, team)).runCode.canRestore, false)
  assert.deepEqual((await tab(`?${query}&tab=attention`)).computers.map(({ id, shared }) => [id, shared]), [[shared, true]])
  assert.ok((await tab("?tab=attention")).computers.some(({ label }) => label === "Permissions Mac"))
  assert.deepEqual((await tab(`?search=${encodeURIComponent(tomas.email.toUpperCase())}`)).counts, { desktops: 4, cloud: 0, attention: 0, former: 0 })
  assert.equal((await tab("?search=jonas%20weber")).counts.former, 1)
  const worker = (await detail(instance, asOwner, team)).computer
  assert.equal(worker.kind, "instance")
  assert.deepEqual(worker.notes, [{ code: "provider_problem", message: "Could not be reached" }])
  assert.deepEqual((await detail(shared)).computer.notes, worker.notes)
  assert.equal((await list()).computers.find(({ id }) => id === shared)?.shared, true)
  assert.equal((await list()).computers.some(({ id }) => id === instance || id === former), false)
})

test("My Computers groups desktops, cloud, Workbot and shared computers without changing the admin order", async () => {
  const olderDesktop = await report(asOwner, "sort-older-desktop", { label: "Sort fixture older desktop" })
  const recentDesktop = await report(asOwner, "sort-recent-desktop", { label: "Sort fixture recent desktop" })
  const offlineDesktop = await report(asOwner, "sort-offline-desktop", { label: "Sort fixture offline desktop" })
  const readyCloud = await register(asOwner, "Sort fixture ready cloud", "sort-ready-cloud")
  const failedCloud = await register(asOwner, "Sort fixture failed cloud", "sort-failed-cloud")
  const sharedCloud = await register(asOwner, "Sort fixture shared cloud", "sort-shared-cloud", true)
  const token = await den.mintMcpToken(owner, orgId)
  const call = await den.request(token, "POST", "/v1/workbot/devices/computer", {
    body: { sessionId: workbotSessionId(orgId, owner.memberId), chat: "main", event: "resumed" },
  })
  assert.equal(call.status, 204, summary(call))
  const now = Date.now()
  for (const [id, age] of [[olderDesktop, 120_000], [recentDesktop, 60_000], [offlineDesktop, day]] satisfies [typeof olderDesktop, number][]) {
    await db.update(RemoteDeviceTable).set({ lastSeenAt: new Date(now - age) }).where(eq(RemoteDeviceTable.id, id))
  }
  await db.update(RemoteDeviceTable).set({ state: "ready", lastSeenAt: new Date(now - 30_000) }).where(eq(RemoteDeviceTable.id, readyCloud))
  await db.update(RemoteDeviceTable).set({ state: "unavailable", lastSeenAt: new Date(now) }).where(eq(RemoteDeviceTable.id, failedCloud))
  await db.update(RemoteDeviceTable).set({ state: "ready", lastSeenAt: new Date(now) }).where(eq(RemoteDeviceTable.id, sharedCloud))

  const { computers } = await list(asOwner)
  const workbot = computers.find(({ kind }) => kind === "workbot")
  assert.ok(workbot)
  assert.deepEqual(computers.filter(({ label, kind }) => label.startsWith("Sort fixture") || kind === "workbot").map(({ id }) => id), [
    recentDesktop, olderDesktop, offlineDesktop, readyCloud, failedCloud, workbot.id, sharedCloud,
  ])
  assert.deepEqual((await tab("?tab=cloud&search=Sort%20fixture")).computers.map(({ id }) => id), [sharedCloud, readyCloud, failedCloud])
})

test("flag-off inventory answers feature disabled and ignores machine keys, with distinct keys across enabled organizations", async () => {
  const id = await report(asOff, "off-field-mac", { machineKey: hardwareHash })
  for (const path of [personal, `${personal}/${id}`, team, `${team}/${id}`]) {
    const call = await asOff("GET", path)
    assert.equal(call.status, 404, summary(call))
    assert.equal(field(call.body, "error"), "feature_disabled")
    assert.equal(call.headers.get("cache-control"), "no-store")
  }
  const readKey = async () => (await db.select({ key: RemoteDeviceTable.machineKey }).from(RemoteDeviceTable).where(eq(RemoteDeviceTable.id, id)))[0]?.key
  assert.equal(await readKey(), null)
  const toggle = await den.setFeature(off.orgId, "computers", true)
  assert.equal(toggle.status, 200, summary(toggle))
  assert.equal(await report(asOff, "off-field-mac", { machineKey: hardwareHash }), id)
  assert.equal(await readKey(), storedHash(off.orgId))
  assert.notEqual(await readKey(), storedHash(orgId))
  assert.equal((await asOwner("GET", `${team}/${id}`)).status, 404)
})

const base = Date.parse("2026-01-01T00:00:00Z")
const minute = 60_000
let fixtureNumber = 0
function signIn(created: number, seen: number | null, fields: Partial<InventorySignIn> = {}): InventorySignIn {
  return {
    id: normalizeDenTypeId("remoteDevice", `rdv_${String(++fixtureNumber).padStart(26, "0")}`), organizationId, ownerMemberId: mayaId,
    kind: "desktop", provider: "openwork_desktop", label: "Studio Mac", platform: "darwin", machineKey: null,
    createdAt: new Date(base + created * minute), lastSeenAt: seen === null ? null : new Date(base + seen * minute), disconnectedAt: null, removedAt: null,
    ...fields,
  }
}

test("grouping respects keys, disconnected representatives, removal, and pairwise contact windows", () => {
  const exact = signIn(50, 80, { machineKey: "key" })
  const renamed = signIn(60, 90, { machineKey: "key", label: "Renamed", disconnectedAt: new Date(base) })
  const older = signIn(0, 31, { label: " studio MAC " })
  const empty = signIn(55, null, { label: "Renamed" })
  const overlapping = signIn(20, 35)
  const otherPlatform = signIn(0, 10, { platform: "win32" })
  const removed = signIn(100, 103, { machineKey: "key", removedAt: new Date(base) })
  const differentKey = signIn(50, 70, { machineKey: "another", label: "Another computer" })
  const input = [renamed, exact, older, empty, overlapping, otherPlatform, removed, differentKey]
  const results = groupComputerSignIns(input)
  assert.deepEqual(groupComputerSignIns([...input].reverse()), results)
  assert.deepEqual(results.find(({ newest }) => newest.id === exact.id)?.merged.map(({ id }) => id), [renamed.id, overlapping.id, empty.id])
  assert.ok(results.some(({ newest }) => newest.id === older.id), "more than ten minutes of overlap stays separate")
  assert.ok(results.some(({ newest }) => newest.id === otherPlatform.id))
  assert.ok(results.some(({ newest }) => newest.id === differentKey.id))
  assert.ok(!results.some(({ newest, merged }) => newest.id === removed.id || merged.some(({ id }) => id === removed.id)))
})

test("keyless sign-ins fold across a three-minute gap or overlap, but not a day of shared contact", () => {
  const old = signIn(0, 57)
  const overlapping = signIn(0, 63)
  const boundary = signIn(0, 70)
  const current = signIn(60, 1_500)
  const concurrent = signIn(120, 1_501)
  for (const previous of [old, overlapping, boundary]) {
    assert.deepEqual(groupComputerSignIns([previous, current]), [{ kind: "desktop", newest: current, merged: [previous] }])
  }
  assert.deepEqual(groupComputerSignIns([current, concurrent]).map(({ newest }) => newest.id), [concurrent.id, current.id])
})

test("organization rules recognize independently valid choices and do not treat Computer Use setup as a cloud provider problem", () => {
  assert.deepEqual(readOrganizationComputerRules("not JSON"), { rules: { sessions: "created", runCode: true, requireSandboxOnPersonal: true }, runCodeChosen: false })
  assert.deepEqual(readOrganizationComputerRules('{"remoteSessions":{"access":"off"},"computers":{"runCode":"true","requireSandboxOnPersonal":false}}'), { rules: { sessions: "off", runCode: false, requireSandboxOnPersonal: false }, runCodeChosen: false })
  assert.deepEqual(readOrganizationComputerRules({ remoteSessions: { access: "off" }, computers: { runCode: true } }), { rules: { sessions: "off", runCode: true, requireSandboxOnPersonal: true }, runCodeChosen: true })
  const seen = new Date(base)
  const result = deviceInventoryStatus({ state: "setup_required", platform: "linux", statusDetail: "This VM needs xdotool", disconnectedAt: null, lastSeenAt: seen }, "cloud", base, null)
  assert.equal(result.status.state, "ready")
  assert.deepEqual(result.notes, [{ code: "computer_use_permissions", message: "Computer Use needs setup" }])
})

test("desktop notes use short labels for disconnection, setup and updates", () => {
  const seen = new Date(base)
  const row = { state: "setup_required", platform: "linux", statusDetail: null, disconnectedAt: null, lastSeenAt: seen } satisfies Parameters<typeof deviceInventoryStatus>[0]
  const connected = deviceInventoryStatus(row, "desktop", base, { effective: "off", chosen: false, reason: "update_required" })
  assert.deepEqual(connected.notes, [
    { code: "computer_use_permissions", message: "Computer Use needs setup" },
    { code: "update_required", message: "Needs an OpenWork update" },
  ])
  const disconnected = deviceInventoryStatus({ ...row, state: "ready", disconnectedAt: seen }, "desktop", base, null)
  assert.deepEqual(disconnected.notes, [{ code: "disconnected", message: "Disconnected from this organization" }])
})
