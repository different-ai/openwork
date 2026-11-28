import assert from "node:assert/strict"
import { after, test } from "node:test"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ComputerCommandTable, OrganizationTable, RemoteDeviceEventTable, RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import { workbotSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { computerInventoryDetailResponseSchema, computerSourceAccessSchema, organizationComputerRulesResponseSchema } from "@openwork/types/den/computer-inventory"
import { COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY, COMPUTER_SHELL_RUNNER_CAPABILITY, computerAuthorizeResponseSchema, type ComputerAction } from "@openwork/types/den/computers"
import { COMPUTER_ACTIVITY_EVENT_TYPES, organizationComputerDetailResponseSchema, organizationComputerListResponseSchema, remoteDeviceDetailResponseSchema, remoteDeviceEventSchema, remoteDeviceResponseSchema } from "@openwork/types/den/remote-devices"
import { z } from "zod"
import { bootDen, field, summary, text, type Call } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")
const { enqueueComputerCommand } = await import("../../src/computers/store.js")
const { orgId, owner } = await den.createOrg(await den.signUp("Priya Nair"), "Northwind Labs")
const maya = await den.newMember(owner, orgId, "Maya Okafor")
const off = await den.createOrg(owner, "Clearwater Labs")
const asOwner = den.as(owner, orgId)
const asMaya = den.as(maya, orgId)
const asOff = den.as(off.owner, off.orgId)
assert.equal((await den.setFeature(orgId, "computers", true)).status, 200)
const identity = { organizationId: normalizeDenTypeId("organization", orgId), memberId: normalizeDenTypeId("member", maya.memberId) }
const settingsPath = "/v1/org/computer-rules"
const accessPath = (id: string) => `/v1/computers/${id}/access`
const authorizePath = (id: string) => `/v1/computers/${id}/authorize`
const sourcesPath = (id: string, key: string, admin = false) => `/v1/${admin ? "org/" : ""}computers/${id}/sources/${key}`
const detailPath = (id: string) => `/v1/computers/inventory/${id}`
const shell = { type: "shell", command: "private command text", cwd: "/workspace/logs" } satisfies ComputerAction
const whole = { choice: "allow", scope: "whole_vm", folders: ["/workspace"] }

function successful(call: Call, status = 200) {
  assert.equal(call.status, status, summary(call))
  return call.body
}

async function register(label: string, externalId: string) {
  const res = await asMaya("POST", "/v1/remote-devices", { provider: "daytona", platform: "linux", label, externalId })
  return remoteDeviceResponseSchema.parse(successful(res, 201)).device.id
}

async function detail(id: string) {
  return computerInventoryDetailResponseSchema.parse(successful(await asMaya("GET", detailPath(id))))
}

async function authorize(id: string, action: ComputerAction = shell) {
  return computerAuthorizeResponseSchema.parse(successful(await asMaya("POST", authorizePath(id), { action }))).decision
}

async function runner() {
  const runnerId = "policy-fixture-mac"
  const report = await asMaya("PUT", "/v1/remote-devices/this-computer", { installId: runnerId, label: "Workshop Mac", platform: "darwin", appVersion: "1.4.0" })
  const id = normalizeDenTypeId("remoteDevice", remoteDeviceResponseSchema.parse(successful(report)).device.id)
  const tokens = await asMaya("POST", "/v1/session-runners/token", {
    runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.4.0", platform: "darwin", concurrency: 1,
    capabilities: [COMPUTER_SHELL_RUNNER_CAPABILITY, "remote_session_v1"],
  })
  const token = text(field(successful(tokens), "token"), "runner token")
  return { id, token }
}

const desktop = await runner()
const cloud = await register("Build computer", "build-computer")
const parsedRule = (call: Call) => organizationComputerRulesResponseSchema.parse(successful(call))
const parsedSource = (call: Call) => z.object({ source: computerSourceAccessSchema }).parse(successful(call)).source

async function remoteTasks(access: "off" | "created") {
  successful(await asOwner("PATCH", "/v1/org/remote-session-settings", { access }))
}

function shownRule(sessions: "off" | "created", runCode: boolean, runCodeChosen: boolean) {
  return { rules: { sessions, runCode, requireSandboxOnPersonal: true }, runCodeChosen }
}

function refusal(decision: Awaited<ReturnType<typeof authorize>>, code: string) {
  assert.equal(decision.outcome, "refuse")
  if (decision.outcome === "refuse") assert.equal(decision.code, code)
}

test("the independent computer rule inherits until chosen, never changes sessions, and cannot disable the sandbox", async () => {
  successful(await asMaya("PUT", accessPath(cloud), whole))
  assert.deepEqual(parsedRule(await asMaya("GET", settingsPath)), shownRule("created", true, false))
  assert.deepEqual(parsedRule(await asOwner("PATCH", settingsPath, { requireSandboxOnPersonal: true })), shownRule("created", true, false))
  await remoteTasks("off")
  assert.deepEqual(parsedRule(await asMaya("GET", settingsPath)), shownRule("off", false, false))
  refusal(await authorize(cloud), "organization_off")
  await remoteTasks("created")
  const sessions = (await detail(desktop.id)).sessions
  assert.equal(sessions.sendTasks, true)
  assert.equal((await asMaya("PATCH", settingsPath, { runCode: false })).status, 403)
  assert.deepEqual(parsedRule(await asOwner("PATCH", settingsPath, { runCode: false })), shownRule("created", false, true))
  refusal(await authorize(cloud), "organization_off")
  assert.deepEqual((await detail(desktop.id)).sessions, sessions)
  const disabledSandbox = await asOwner("PATCH", settingsPath, { runCode: true, requireSandboxOnPersonal: false })
  assert.equal(disabledSandbox.status, 409, summary(disabledSandbox))
  assert.equal(field(disabledSandbox.body, "error"), "sandbox_required")
  assert.deepEqual(parsedRule(await asMaya("GET", settingsPath)), shownRule("created", false, true))
  assert.deepEqual(parsedRule(await asOwner("PATCH", settingsPath, { runCode: null })), shownRule("created", true, false))
  assert.deepEqual(parsedRule(await asMaya("GET", settingsPath)), shownRule("created", true, false))
  const [saved] = await db.$primary.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, identity.organizationId)).limit(1)
  assert.deepEqual(field(saved?.metadata, "computers"), { requireSandboxOnPersonal: true })
  assert.equal((await authorize(cloud)).outcome, "allow")
  await remoteTasks("off")
  assert.deepEqual(parsedRule(await asMaya("GET", settingsPath)), shownRule("off", false, false))
  refusal(await authorize(cloud), "organization_off")
  assert.deepEqual(parsedRule(await asOwner("PATCH", settingsPath, { runCode: true })), shownRule("off", true, true))
  assert.equal((await authorize(cloud)).outcome, "allow")
  assert.equal((await detail(desktop.id)).sessions.sendTasks, false)
  assert.equal((await asOff("GET", settingsPath)).status, 404)
  assert.equal((await asOff("PATCH", settingsPath, { runCode: false })).status, 404)
})

test("native activity coalesces concurrent and repeated work in the same folder, and omits refused commands and file names", async () => {
  const id = await register("Activity computer", "activity-computer")
  refusal(await authorize(id), "computer_not_allowed")
  assert.equal((await detail(id)).activity.some(({ type }) => type === "computer_work_accepted"), false)
  successful(await asMaya("PUT", accessPath(id), whole))
  const decisions = await Promise.all([authorize(id, { type: "shell", command: "private command one" }), authorize(id, { type: "shell", command: "private command two", cwd: "/workspace" })])
  assert.ok(decisions.every(({ outcome }) => outcome === "allow"))
  const accepted = async () => (await detail(id)).activity.filter(({ type }) => type === "computer_work_accepted")
  assert.deepEqual((await accepted()).map(({ message }) => message), ["Maya Okafor's OpenWork app ran a command in /workspace for Maya Okafor"])
  assert.equal((await authorize(id, { type: "write", path: "/workspace/private-filename.txt" })).outcome, "allow")
  assert.equal((await authorize(id, { type: "write", path: "/workspace/different-filename.txt" })).outcome, "allow")
  assert.equal((await authorizedRead(id)).outcome, "allow")
  const messages = (await accepted()).map(({ message }) => message)
  assert.equal(messages.length, 3)
  assert.ok(messages.includes("Maya Okafor's OpenWork app changed a file in /workspace for Maya Okafor"))
  assert.ok(messages.includes("Maya Okafor's OpenWork app read a file in /workspace/src for Maya Okafor"))
  assert.doesNotMatch(JSON.stringify(messages), /private command|private-filename|different-filename|private-read/)
})

test("only inventory detail exposes computer work and source changes; legacy limits apply after filtering", async () => {
  const label = "Legacy Activity computer"
  const id = normalizeDenTypeId("remoteDevice", await register(label, "legacy-activity-computer"))
  const start = Date.now() - 60_000
  await db.insert(RemoteDeviceEventTable).values(Array.from({ length: 101 }, (_, index): typeof RemoteDeviceEventTable.$inferInsert => ({
    id: createDenTypeId("remoteDeviceEvent"), organizationId: identity.organizationId, deviceId: id,
    type: "state_changed", level: "info", message: `Report ${index}`, actor: "device", createdAt: new Date(start + index),
  })))
  successful(await asMaya("PUT", accessPath(id), whole))
  assert.equal((await authorize(id)).outcome, "allow")
  const path = sourcesPath(id, COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY)
  successful(await asMaya("DELETE", path))
  successful(await asMaya("POST", `${path}/restore`))

  const member = remoteDeviceDetailResponseSchema.parse(successful(await asMaya("GET", `/v1/remote-devices/${id}`)))
  const team = organizationComputerDetailResponseSchema.parse(successful(await asOwner("GET", `/v1/org/computers/${id}`)))
  const list = organizationComputerListResponseSchema.parse(successful(await asOwner("GET", `/v1/org/computers?search=${encodeURIComponent(label)}`)))
  assert.equal(member.events.length, 20)
  assert.equal(team.events.length, 100)
  assert.deepEqual(member.events.map(({ id }) => id), team.events.slice(0, 20).map(({ id }) => id))
  assert.equal(member.events[0]?.type, "registered")
  assert.equal(team.device.lastEvent?.id, member.events[0]?.id)
  assert.equal(list.devices.find((row) => row.id === id)?.lastEvent?.id, member.events[0]?.id)

  const inventory = await detail(id)
  assert.equal(inventory.activity.length, 20)
  const newer = inventory.activity.filter((event) => !remoteDeviceEventSchema.safeParse(event).success)
  assert.deepEqual(newer.map(({ type }) => type).sort(), [...COMPUTER_ACTIVITY_EVENT_TYPES].sort())
})

function authorizedRead(id: string) {
  return authorize(id, { type: "read", path: "/workspace/src/private-read.txt" })
}

test("only the owner can restore a source, and explicit whole-computer consent also clears revocation", async () => {
  const ownPath = sourcesPath(cloud, COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY)
  const adminPath = sourcesPath(cloud, COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY, true)
  assert.equal((await asOwner("DELETE", ownPath)).status, 404)
  assert.equal((await asOwner("POST", `${ownPath}/restore`)).status, 404)
  assert.equal((await asMaya("DELETE", adminPath)).status, 403)
  assert.equal((await asMaya("DELETE", sourcesPath(cloud, "not-a-source"))).status, 400)
  assert.equal((await asMaya("DELETE", sourcesPath(cloud, "workbot"))).status, 404)
  assert.equal((await asOff("DELETE", ownPath)).status, 404)
  assert.equal((await asOff("DELETE", adminPath)).status, 404)
  assert.equal((await asOff("POST", `${ownPath}/restore`)).status, 404)
  const revoked = parsedSource(await asOwner("DELETE", adminPath))
  assert.equal(revoked.revokedBy, owner.name)
  assert.ok(revoked.revokedAt)
  assert.deepEqual(parsedSource(await asMaya("DELETE", ownPath)), revoked)
  refusal(await authorize(cloud), "computer_not_allowed")
  assert.equal(parsedSource(await asMaya("POST", `${ownPath}/restore`)).revokedAt, null)
  assert.equal((await authorize(cloud)).outcome, "allow")
  assert.equal(parsedSource(await asMaya("DELETE", ownPath)).revokedBy, maya.name)
  successful(await asMaya("PUT", accessPath(cloud), whole))
  assert.equal((await authorize(cloud)).outcome, "allow")
  const item = await detail(cloud)
  assert.equal(item.runCode.sources[0]?.revokedBy, null)
  assert.deepEqual(item.activity.filter(({ type }) => type.startsWith("computer_source_")).map(({ message }) => message), [
    "Maya Okafor revoked access for Maya Okafor's OpenWork apps",
    "Maya Okafor restored access for Maya Okafor's OpenWork apps",
    "Priya Nair revoked access for Maya Okafor's OpenWork apps",
  ])
})

test("a revoked Workbot grant survives runner reports, refuses an already queued claim, and logs each accepted claim once", async () => {
  const token = await den.mintMcpToken(maya, orgId)
  const sessionId = workbotSessionId(orgId, maya.memberId)
  successful(await den.request(token, "POST", "/v1/workbot/devices/computer", { body: { sessionId, chat: "main", event: "resumed" } }), 204)
  const [source] = await db.$primary.select({ id: RemoteDeviceTable.id }).from(RemoteDeviceTable).where(and(
    eq(RemoteDeviceTable.organizationId, identity.organizationId), eq(RemoteDeviceTable.provider, "workbot"), eq(RemoteDeviceTable.externalId, sessionId),
  )).limit(1)
  assert.ok(source)
  const report = async (folders: string[] | null) => successful(await den.request(desktop.token, "PUT", "/v1/computer-runners/access", {
    body: { choice: "allow", grants: folders ? [{ source: { kind: "workbot" }, folders }] : [] },
  }))
  const queue = () => enqueueComputerCommand({
    organizationId: identity.organizationId, createdByUserId: normalizeDenTypeId("user", maya.userId), sourceDeviceId: source.id,
    targetDeviceId: desktop.id, action: shell, scope: { surface: "sandbox", folders: ["/workspace"] },
  })
  const claim = (id: string) => den.request(desktop.token, "POST", `/v1/computer-commands/${id}/claim`)
  await report(["/workspace"])
  const pending = await queue()
  const path = sourcesPath(desktop.id, "workbot")
  const revoked = parsedSource(await asMaya("DELETE", path))
  await report(null)
  await report(["/workspace/logs"])
  assert.deepEqual((await detail(desktop.id)).runCode.sources, [{ ...revoked, folders: ["/workspace/logs"] }])
  const denied = await claim(pending.id)
  assert.equal(denied.status, 409, summary(denied))
  assert.equal(field(denied.body, "error"), "command_refused")
  const [row] = await db.$primary.select({ status: ComputerCommandTable.status, error: ComputerCommandTable.errorCode }).from(ComputerCommandTable).where(eq(ComputerCommandTable.id, pending.id)).limit(1)
  assert.deepEqual(row, { status: "refused", error: "nothing_shared" })
  const accepted = async () => (await detail(desktop.id)).activity.filter(({ type }) => type === "computer_work_accepted")
  assert.deepEqual(await accepted(), [])
  assert.equal(parsedSource(await asMaya("POST", `${path}/restore`)).revokedAt, null)
  const next = await queue()
  successful(await claim(next.id))
  assert.equal((await claim(next.id)).status, 409)
  assert.deepEqual((await accepted()).map(({ message }) => message), ["Workbot ran a command in /workspace/logs for Maya Okafor"])
  const rows = await db.$primary.select().from(RemoteDeviceEventTable).where(and(eq(RemoteDeviceEventTable.deviceId, desktop.id), eq(RemoteDeviceEventTable.type, "computer_work_accepted")))
  assert.equal(rows.length, 1)
  assert.doesNotMatch(JSON.stringify(rows), /private command text/)
  assert.equal((await asMaya("DELETE", sourcesPath(desktop.id, createDenTypeId("remoteDevice")))).status, 404)
})
