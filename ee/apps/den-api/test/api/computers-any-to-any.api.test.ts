import assert from "node:assert/strict"
import { after, test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AutomationRunnerTable, ComputerCommandTable, MemberTable, RemoteDeviceEventTable, RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import { workbotSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { computerActionForToolCall } from "@openwork/computers"
import { computerInventoryDetailResponseSchema } from "@openwork/types/den/computer-inventory"
import {
  COMPUTER_COMMAND_PICKUP_MS, COMPUTER_SHELL_RUNNER_CAPABILITY, computerAuthorizeResponseSchema, computerCommandClaimResponseSchema,
  computerCommandListResponseSchema, computerExecutionSchema, computerRunnerAccessResponseSchema, computerSourceListResponseSchema,
  type ComputerAccessReport, type ComputerToolCall,
} from "@openwork/types/den/computers"
import { REMOTE_DEVICE_ONLINE_WINDOW_MS, remoteDeviceDetailResponseSchema, remoteDeviceListResponseSchema, remoteDeviceResponseSchema, type RemoteDeviceRegisterableProvider } from "@openwork/types/den/remote-devices"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"
import { bootDen, field, summary, text, type Call, type Member, type Method } from "./harness.js"

const restoreCatalog = stubPublicModelCatalog()
const den = await bootDen({ http: true, env: { ...gatewayFixtureEnv, DEN_WORKBOT_URL: "http://localhost:3020" } })
after(async () => { await den.close(); restoreCatalog() })
const { db } = await import("../../src/db.js")
const { automationRunnerRowId } = await import("../../src/automations/repository.js")
const { orgId, owner: priya } = await den.createOrg(await den.signUp("Priya Raman"), "Cedar Workshop")
const maya = await den.newMember(priya, orgId, "Maya Okafor")
const asAdmin = den.as(priya, orgId)
const asMaya = den.as(maya, orgId)
const offOrg = await den.createOrg(maya, "Willow Workshop")

function ok(call: Call, status = 200) {
  assert.equal(call.status, status, summary(call))
  return call.body
}

ok(await den.setFeature(orgId, "computers", true))
const access = "/v1/computer-runners/access"
const pending = "/v1/computer-runners/commands"
const sources = "/v1/computer-sources/computers"
const commandPath = (id: string) => `${sources}/${id}/commands`
const authorizePath = (id: string) => `${sources}/${id}/authorize`
const followPath = (id: string) => `/v1/computer-sources/commands/${id}`
const claimPath = (id: string) => `/v1/computer-commands/${id}/claim`
const completePath = (id: string) => `/v1/computer-commands/${id}/complete`
const read = { tool: "read", input: { path: "/notes/meeting.txt", offset: 1, limit: 10 } } satisfies ComputerToolCall
const shell = { tool: "shell", input: { command: "printf 'fixture'", cwd: "/notes", timeoutMs: 5_000 } } satisfies ComputerToolCall
const write = { tool: "write", input: { path: "/drafts/meeting.txt", content: "private fixture content" } } satisfies ComputerToolCall
const done = { status: "done", exitCode: 0, output: "fixture result", truncated: false }

async function reportDesktop(request: typeof asMaya, installId: string, label: string) {
  return remoteDeviceResponseSchema.parse(ok(await request("PUT", "/v1/remote-devices/this-computer", { installId, label, platform: "darwin", appVersion: "1.7.0" }))).device
}

async function desktop(person: Member, runnerId: string, label: string, { organization = orgId, sandbox = true, runnerOnly = false } = {}) {
  const request = den.as(person, organization)
  const device = runnerOnly ? null : await reportDesktop(request, runnerId, label)
  const minted = await request("POST", "/v1/session-runners/token", {
    runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.7.0", platform: "darwin", concurrency: 1,
    capabilities: sandbox ? [COMPUTER_SHELL_RUNNER_CAPABILITY] : [],
  })
  const token = text(field(ok(minted), "token"), "runner token")
  const call = (method: Method, path: string, body?: unknown) => den.request(token, method, path, { body })
  if (runnerOnly) ok(await call("PUT", "/v1/session-runners/inventory", { computer: { label, platform: "darwin", appVersion: "1.7.0" }, workspaces: [] }))
  const id = normalizeDenTypeId("remoteDevice", device?.id ?? text(computerSourceListResponseSchema.parse(ok(await call("GET", sources))).self?.id, "desktop id"))
  const rowId = automationRunnerRowId({ organizationId: organization, ownerMemberId: person.memberId, runnerId })
  return { id, call, rowId, label, runnerId }
}

const studio = await desktop(maya, "studio-mac", "Studio Mac")
const travel = await desktop(maya, "travel-mac", "Travel MacBook")
const other = await desktop(priya, "field-mac", "Field Mac", { sandbox: false, runnerOnly: true })
const old = await desktop(maya, "older-mac", "Older Mac", { sandbox: false })
const offlineAt = new Date(Date.now() - REMOTE_DEVICE_ONLINE_WINDOW_MS - 60_000)
const folders = ["/notes", "/drafts"]
const writableFolders = ["/drafts"]
const travelGrant = { source: { kind: "computer", id: travel.id }, folders, writableFolders } satisfies ComputerAccessReport["grants"][number]
const workbotGrant = { source: { kind: "workbot" }, folders, writableFolders } satisfies ComputerAccessReport["grants"][number]
const report = async (choice: ComputerAccessReport["choice"], grants: ComputerAccessReport["grants"]) => ok(await studio.call("PUT", access, { choice, grants }))
const accessView = async () => computerRunnerAccessResponseSchema.parse(ok(await studio.call("GET", access)))
const detail = async (id: string) => computerInventoryDetailResponseSchema.parse(ok(await asMaya("GET", `/v1/computers/inventory/${id}`)))
const rule = async (runCode: boolean) => ok(await asAdmin("PATCH", "/v1/org/computer-rules", { runCode }))
const execute = async (source = travel, target = studio.id, call: ComputerToolCall = read, waitMs = 0) =>
  computerExecutionSchema.parse(ok(await source.call("POST", commandPath(target), { call, waitMs })))
const follow = async (id: string, waitMs = 0, source = travel) => computerExecutionSchema.parse(ok(await source.call("GET", `${followPath(id)}?waitMs=${waitMs}`)))
const claim = async (id: string, target = studio) => computerCommandClaimResponseSchema.parse(ok(await target.call("POST", claimPath(id)))).assignment
const complete = async (id: string, target = studio) => ok(await target.call("POST", completePath(id), done))
const queued = async (call: ComputerToolCall = read) => {
  const result = await execute(travel, studio.id, call)
  assert.equal(result.state, "running")
  return normalizeDenTypeId("computerCommand", result.id)
}
const refuse = async (code: string, source = travel, target = studio.id, call: ComputerToolCall = read) => {
  const result = await execute(source, target, call)
  assert.equal(result.state, "refused")
  assert.equal(result.code, code)
}
const inventory = async (id = studio.id) => (await detail(id)).runCode.value
const commandRows = () => db.$primary.select({ id: ComputerCommandTable.id }).from(ComputerCommandTable).where(eq(ComputerCommandTable.targetDeviceId, studio.id))

await rule(true)

test("Verified desktops list exact reach; a waiting target picks up read, shell and write and the source follows each result", async () => {
  await report("allow", [travelGrant])
  const listed = computerSourceListResponseSchema.parse(ok(await travel.call("GET", sources)))
  assert.equal(listed.self?.id, travel.id)
  assert.equal(listed.computers.find(({ id }) => id === travel.id)?.reach.outcome, "allow")
  assert.deepEqual(listed.computers.find(({ id }) => id === studio.id)?.reach, { outcome: "allow", route: "checked", scope: { surface: "sandbox", folders, writableFolders } })
  assert.equal(listed.computers.some(({ id }) => id === other.id), false)
  const withoutCapability = computerSourceListResponseSchema.parse(ok(await other.call("GET", sources)))
  assert.equal(withoutCapability.self?.id, other.id)
  assert.equal((await other.call("GET", access)).status, 403)
  assert.equal((await asMaya("GET", sources)).status, 401)
  assert.equal((await studio.call("GET", `${pending}?waitMs=25001`)).status, 400)
  assert.equal((await travel.call("GET", `${followPath(createDenTypeId("computerCommand"))}?waitMs=20001`)).status, 400)
  assert.equal((await travel.call("POST", commandPath(studio.id), { call: read, action: { type: "list" } })).status, 400)
  const mayaToken = await den.mintMcpToken(maya, orgId)
  for (const call of [read, shell, write]) {
    const polling = studio.call("GET", `${pending}?waitMs=5000`)
    await delay(100)
    const start = performance.now()
    const id = await queued(call)
    const items = computerCommandListResponseSchema.parse(ok(await polling)).items
    assert.ok(performance.now() - start < 1_000, "waiting runner responds within a second of enqueue")
    assert.deepEqual(items.map((item) => item.id), [id])
    const assignment = await claim(id)
    assert.equal(assignment.source.id, travel.id)
    assert.deepEqual(assignment.call, call)
    assert.deepEqual(assignment.action, computerActionForToolCall(call))
    assert.deepEqual(assignment.scope, { surface: "sandbox", folders, writableFolders })
    assert.equal((await studio.call("GET", followPath(id))).status, 404)
    assert.equal((await other.call("GET", followPath(id))).status, 404)
    assert.equal(field((await den.callMcpTool(mayaToken, "execute_capability", { name: "computers:read", body: { id, waitMs: 0 } })).structured, "error"), "unknown_command")
    const following = follow(id, 5000)
    await complete(id)
    assert.deepEqual(await following, { state: "done", id, exitCode: 0, output: done.output, truncated: false })
  }
  const accepted = (await detail(studio.id)).activity.filter(({ type }) => type === "computer_work_accepted").map(({ message }) => message)
  assert.deepEqual(accepted.sort(), [
    "Travel MacBook was allowed to change a file in /drafts on Studio Mac for Maya Okafor",
    "Travel MacBook was allowed to read a file in /notes on Studio Mac for Maya Okafor",
    "Travel MacBook was allowed to run a command in /notes on Studio Mac for Maya Okafor",
  ])
  assert.doesNotMatch(await den.auditStorageText(), /private fixture content|fixture result|printf/)
})

test("A private target is indistinguishable from an unknown computer", async () => {
  const before = await commandRows()
  assert.deepEqual(await execute(other), await execute(other, createDenTypeId("remoteDevice")))
  assert.deepEqual(await execute(other), { state: "unsupported", message: "That computer isn't available to your account." })
  assert.deepEqual(await commandRows(), before)
})

test("Refusals distinguish organization, choice, exact grant, folders and capability", async () => {
  const before = await commandRows()
  await report("off", [])
  await rule(false)
  await refuse("organization_off")
  assert.equal((await accessView()).organizationAllows, false)
  await rule(true)
  await refuse("computer_not_allowed")
  await report("allow", [workbotGrant])
  await refuse("source_not_allowed")
  await report("allow", [{ ...travelGrant, folders: [], writableFolders: [] }])
  await refuse("nothing_shared", travel, studio.id, write)
  await report("allow", [travelGrant])
  await refuse("folder_not_shared", travel, studio.id, { tool: "write", input: { path: "/outside/file", content: "" } })
  await refuse("folder_read_only", travel, studio.id, { tool: "write", input: { path: read.input.path, content: "" } })
  await refuse("sandbox_unavailable", travel, old.id)
  assert.deepEqual(await commandRows(), before)
})

test("Owner and admin revocations refuse both new and pending work until the owner restores access", async () => {
  const path = `/v1/computers/${studio.id}/sources/${travel.id}`
  for (const revoke of [() => asMaya("DELETE", path), () => asAdmin("DELETE", `/v1/org/computers/${studio.id}/sources/${travel.id}`)]) {
    const id = await queued()
    const source = field(ok(await revoke()), "source")
    assert.equal(field(source, "label"), travel.label)
    assert.deepEqual(field(source, "writableFolders"), writableFolders)
    await report("allow", [])
    await report("allow", [travelGrant])
    assert.deepEqual((await accessView()).grants, [{ ...travelGrant, revokedAt: field(source, "revokedAt") }])
    await refuse("source_not_allowed")
    assert.equal(field(ok(await studio.call("POST", claimPath(id)), 409), "error"), "command_refused")
    assert.equal(field(await follow(id), "code"), "source_not_allowed")
    ok(await asMaya("POST", `${path}/restore`))
    assert.equal((await accessView()).grants[0]?.revokedAt, null)
    const restored = await queued()
    await claim(restored)
    await complete(restored)
  }
})

test("A desktop with an old poll or report answers offline promptly, and polling revives it without repeated touches or activity", async () => {
  const before = await commandRows()
  const lastPoll = new Date(Date.now() - 50_000)
  const byId = eq(RemoteDeviceTable.id, studio.id)
  const readSeen = async () => (await db.$primary.select({ lastSeenAt: RemoteDeviceTable.lastSeenAt }).from(RemoteDeviceTable).where(byId))[0]?.lastSeenAt
  const events = () => db.$primary.select({ id: RemoteDeviceEventTable.id }).from(RemoteDeviceEventTable).where(eq(RemoteDeviceEventTable.deviceId, studio.id))
  const activityBefore = await events()
  await db.update(RemoteDeviceTable).set({ lastSeenAt: lastPoll }).where(byId)
  await db.update(AutomationRunnerTable).set({ last_seen_at: new Date() }).where(eq(AutomationRunnerTable.id, studio.rowId))
  const start = performance.now()
  const stale = await execute(travel, studio.id, read, 15_000)
  assert.ok(performance.now() - start < 750, "a stale target must not wait for pickup")
  assert.equal(stale.state, "offline")
  assert.equal(stale.lastSeenAt, lastPoll.toISOString())
  assert.match(stale.message, /Studio Mac is offline, last seen .* Nothing ran there\./)
  assert.deepEqual(await commandRows(), before)
  ok(await studio.call("GET", `${pending}?waitMs=10`))
  const refreshed = await readSeen()
  assert.ok(refreshed && refreshed.getTime() > lastPoll.getTime())
  await delay(15)
  ok(await studio.call("GET", pending))
  assert.deepEqual(await readSeen(), refreshed)
  assert.deepEqual(await events(), activityBefore)
  const id = await queued()
  await claim(id)
  await complete(id)
})

test("Offline and same-computer requests queue nothing; two-way commands are independent", async () => {
  const before = await commandRows()
  const setContact = async (time: Date) => {
    await db.update(AutomationRunnerTable).set({ last_seen_at: time }).where(eq(AutomationRunnerTable.id, studio.rowId))
    await db.update(RemoteDeviceTable).set({ lastSeenAt: time }).where(eq(RemoteDeviceTable.id, studio.id))
  }
  await setContact(offlineAt)
  try {
    const offline = await execute()
    assert.equal(offline.state, "offline")
    assert.equal(offline.lastSeenAt, offlineAt.toISOString())
    assert.match(offline.message, /Studio Mac is offline, last seen .* Nothing ran there\./)
  } finally { await setContact(new Date()) }
  assert.deepEqual(await execute(studio), { state: "unsupported", message: "Use this chat's own tools to work on this computer." })
  assert.deepEqual(await commandRows(), before)
  ok(await travel.call("PUT", access, { choice: "allow", grants: [{ ...travelGrant, source: { kind: "computer", id: studio.id } }] }))
  ok(await travel.call("GET", pending))
  const [left, right] = await Promise.all([queued(), execute(studio, travel.id)])
  assert.equal(right.state, "running")
  const [onStudio, onTravel] = await Promise.all([claim(left), claim(right.id, travel)])
  assert.deepEqual([onStudio.source.id, onTravel.source.id], [travel.id, studio.id])
  await Promise.all([complete(left), complete(right.id, travel)])
  assert.equal((await follow(right.id, 0, studio)).state, "done")
})

test("Only a command that was handed over can have an unknown outcome; late results still arrive", async () => {
  const unclaimed = await queued()
  await db.update(ComputerCommandTable).set({ createdAt: new Date(Date.now() - COMPUTER_COMMAND_PICKUP_MS - 1_000) }).where(eq(ComputerCommandTable.id, unclaimed))
  assert.deepEqual(computerCommandListResponseSchema.parse(ok(await studio.call("GET", pending))).items, [])
  const missed = await follow(unclaimed)
  assert.equal(missed.state, "failed")
  assert.equal(missed.error.code, "not_picked_up")
  assert.match(missed.error.message, /Studio Mac didn't respond.*Nothing ran\./)
  assert.equal(field(ok(await studio.call("POST", claimPath(unclaimed)), 409), "error"), "command_conflict")
  assert.deepEqual(await db.$primary.select({ status: ComputerCommandTable.status }).from(ComputerCommandTable).where(eq(ComputerCommandTable.id, unclaimed)), [{ status: "expired" }])
  const claimed = await queued()
  await claim(claimed)
  await db.update(ComputerCommandTable).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(ComputerCommandTable.id, claimed))
  const unknown = await follow(claimed)
  assert.equal(unknown.state, "unknown")
  assert.match(unknown.message, /It may have run.*before running it again\./)
  await complete(claimed)
  assert.equal((await follow(claimed)).state, "done")
})

test("Workbot can send shell and file tools, but only Workbot matches its grant", async () => {
  await report("allow", [workbotGrant])
  await refuse("source_not_allowed")
  const token = await den.mintMcpToken(maya, orgId)
  const models = await grantGatewayModels(den, priya, orgId, [maya])
  const sessionId = workbotSessionId(orgId, maya.memberId)
  ok(await den.request(token, "POST", "/v1/workbot/devices/computer", { body: { sessionId, chat: "main", event: "resumed" } }), 204)
  const minted = ok(await den.request(token, "POST", "/v1/workbot/run-token", { body: { sessionId, messageId: "computer-fixture-turn", model: models["gpt-6-luna"] } }))
  const runToken = text(field(minted, "token"), "Workbot run token")
  for (const call of [shell, read, write, { tool: "edit", input: { path: "/drafts/meeting.txt", oldString: "before", newString: "after" } },
    { tool: "glob", input: { path: "/notes", pattern: "*.txt" } }, { tool: "grep", input: { path: "/notes", pattern: "meeting" } }] satisfies ComputerToolCall[]) {
    const tool = (body: object) => den.callMcpTool(runToken, "execute_capability", { name: `computers:${call.tool}`, body })
    const response = await tool({ computerId: studio.id, ...call.input, waitMs: 0 })
    assert.equal(response.isError, false, response.raw)
    const execution = computerExecutionSchema.parse(response.structured)
    assert.equal(execution.state, "running")
    const assignment = await claim(execution.id)
    assert.equal(assignment.source.provider, "workbot")
    assert.deepEqual(assignment.call, call)
    await complete(execution.id)
    assert.equal(field((await tool({ id: execution.id, waitMs: 0 })).structured, "state"), "done")
  }
  await report("allow", [travelGrant])
  const denied = await den.callMcpTool(runToken, "execute_capability", { name: "computers:read", body: { computerId: studio.id, ...read.input, waitMs: 0 } })
  assert.equal(field(denied.structured, "code"), "source_not_allowed")
})

test("Access reports validate sources and write permissions, and inventory shows each reason", async () => {
  const foreign = await desktop(offOrg.owner, "off-mac-fixture", "Off Mac", { organization: offOrg.orgId })
  for (const id of [other.id, foreign.id, studio.id, createDenTypeId("remoteDevice")]) {
    const invalid = await studio.call("PUT", access, { choice: "allow", grants: [{ ...travelGrant, source: { kind: "computer", id } }] })
    assert.equal(field(ok(invalid, 400), "message"), "Choose another desktop that you own in this organization.")
  }
  assert.equal((await studio.call("PUT", access, { choice: "allow", grants: [{ ...travelGrant, writableFolders: ["/outside"] }] })).status, 400)
  assert.deepEqual(await inventory(old.id), { value: "no", reason: "sandbox_unavailable" })
  await rule(false)
  assert.deepEqual(await inventory(), { value: "no", reason: "organization" })
  await rule(true)
  for (const [choice, reason] of [[null, "not_chosen"], ["off", "owner"], ["allow", "nothing_shared"]] satisfies [ComputerAccessReport["choice"], string][]) {
    await report(choice, [])
    assert.deepEqual(await inventory(), { value: "no", reason })
  }
  await report("allow", [{ ...travelGrant, folders: [], writableFolders: [] }])
  assert.deepEqual(await inventory(), { value: "no", reason: "nothing_shared" })
  await report("allow", [travelGrant, workbotGrant])
  assert.deepEqual(await inventory(), { value: "sandbox", folders: 2 })
  for (const key of [travel.id, "workbot"]) ok(await asMaya("DELETE", `/v1/computers/${studio.id}/sources/${key}`))
  assert.deepEqual(await inventory(), { value: "no", reason: "revoked" })
  for (const [method, path] of [["GET", sources], ["POST", authorizePath(foreign.id)], ["POST", commandPath(foreign.id)], ["GET", followPath(createDenTypeId("computerCommand"))], ["GET", access]] satisfies [Method, string][]) {
    assert.deepEqual(ok(await foreign.call(method, path), 404), { error: "feature_disabled", feature: "computers" })
  }
})

test("Executable virtual computers return direct connections and activity coalesces by source", async () => {
  const action = computerActionForToolCall(read)
  const authorize = async (id: string, source = travel) => computerAuthorizeResponseSchema.parse(ok(await source.call("POST", authorizePath(id), { action })))
  for (const provider of ["daytona", "freestyle", "other", "mac_host"] satisfies RemoteDeviceRegisterableProvider[]) {
    const externalId = `fixture-${provider}`
    const { id } = remoteDeviceResponseSchema.parse(ok(await asMaya("POST", "/v1/remote-devices", { label: `${provider} build box`, provider, platform: "linux", externalId }), 201)).device
    const setting = await asMaya("PUT", `/v1/computers/${id}/access`, { choice: "allow", scope: "whole_vm", folders: ["/work"] })
    if (provider === "other" || provider === "mac_host") {
      assert.equal(field(ok(setting, 409), "error"), "not_configurable")
      assert.equal(field((await authorize(id)).decision, "code"), "not_available_yet")
      assert.deepEqual((await detail(id)).runCode.value, { value: "not_available" })
      continue
    }
    ok(setting)
    for (const source of [travel, travel, studio]) assert.deepEqual((await authorize(id, source)).connection, { provider, externalId })
    assert.deepEqual(computerAuthorizeResponseSchema.parse(ok(await asMaya("POST", `/v1/computers/${id}/authorize`, { action }))).connection, { provider, externalId })
    assert.deepEqual((await detail(id)).runCode.value, { value: "whole_computer" })
    const accepted = (await detail(id)).activity.filter(({ type }) => type === "computer_work_accepted").map(({ message }) => message)
    assert.deepEqual(accepted.sort(), ["Maya Okafor's OpenWork app", "Studio Mac", "Travel MacBook"].map((who) => `${who} was allowed to read a file in /notes on ${provider} build box for Maya Okafor`))
    assert.equal((await execute(travel, normalizeDenTypeId("remoteDevice", id))).state, "unsupported")
  }
})

test("Desktop names are owner-chosen, unique among live peers and unchanged when the flag is off", async () => {
  const rename = `/v1/remote-devices/${studio.id}`
  assert.equal(field(ok(await asMaya("PATCH", rename, { label: "travel macbook" }), 409), "error"), "name_taken")
  assert.equal((await asAdmin("PATCH", rename, { label: "Not mine" })).status, 404)
  const teamDetail = async (id: string) => computerInventoryDetailResponseSchema.parse(ok(await asAdmin("GET", `/v1/org/computers/inventory/${id}`)))
  assert.equal((await teamDetail(studio.id)).computer.canRename, false)
  assert.equal((await teamDetail(other.id)).computer.canRename, true)
  const renamed = remoteDeviceResponseSchema.parse(ok(await asMaya("PATCH", rename, { label: "Studio Desk" }))).device
  assert.equal(renamed.canRename, true)
  assert.equal((await reportDesktop(asMaya, studio.runnerId, "OS default name")).label, "Studio Desk")
  assert.equal((await detail(studio.id)).computer.canRename, true)
  assert.equal(remoteDeviceDetailResponseSchema.parse(ok(await asMaya("GET", rename))).device.canRename, true)
  assert.equal(remoteDeviceListResponseSchema.parse(ok(await asMaya("GET", "/v1/remote-devices"))).devices.find(({ id }) => id === studio.id)?.canRename, true)
  const twins = await Promise.all([reportDesktop(asMaya, "packing-twin-a", "Packing Mac"), reportDesktop(asMaya, "packing-twin-b", "Packing Mac")])
  assert.deepEqual(twins.map(({ label }) => label).sort(), ["Packing Mac", "Packing Mac (2)"])
  const ids = ["packing-twin-a", "packing-twin-b"]
  const suffixedSlot = twins.findIndex(({ label }) => label === "Packing Mac (2)")
  await db.update(RemoteDeviceTable).set({ lastSeenAt: offlineAt }).where(eq(RemoteDeviceTable.id, normalizeDenTypeId("remoteDevice", text(twins[1 - suffixedSlot]?.id, "other twin"))))
  assert.equal((await reportDesktop(asMaya, text(ids[suffixedSlot], "suffixed install"), "Packing Mac")).label, "Packing Mac (2)")
  assert.equal((await reportDesktop(asMaya, text(ids[suffixedSlot], "suffixed install"), "Renamed in macOS")).label, "Renamed in macOS")
  const asOff = den.as(offOrg.owner, offOrg.orgId)
  const first = await reportDesktop(asOff, "off-first", "Same Name")
  assert.equal((await reportDesktop(asOff, "off-second", "Same Name")).label, "Same Name")
  assert.equal(first.canRename, false)
  assert.equal(field(ok(await asOff("PATCH", `/v1/remote-devices/${first.id}`, { label: "Changed" }), 403), "message"), "This computer names itself.")
  assert.equal((await reportDesktop(asOff, "off-first", "Different Name")).label, "Different Name")
})

test("A removed member's runner no longer identifies a source", async () => {
  await db.update(MemberTable).set({ removedAt: new Date() }).where(eq(MemberTable.id, normalizeDenTypeId("member", maya.memberId)))
  assert.equal((await travel.call("GET", sources)).status, 401)
})
