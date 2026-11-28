import assert from "node:assert/strict"
import { after, test } from "node:test"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { AutomationRunnerTable, ComputerCommandTable, RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { workbotSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { decide } from "@openwork/computers"
import {
  COMPUTER_COMMAND_RETENTION_MS, COMPUTER_SHELL_RUNNER_CAPABILITY, computerCommandClaimResponseSchema, computerCommandListResponseSchema, computerDecisionSchema,
  computerExecutionSchema, computerSchema, type ComputerAccessReport, type ComputerCommandAssignment, type ComputerCommandCompleteRequest,
} from "@openwork/types/den/computers"
import { remoteDeviceResponseSchema } from "@openwork/types/den/remote-devices"
import { z } from "zod"
import { bootDen, field, list, summary, text, type McpToolResult, type Member } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const restoreCatalog = stubPublicModelCatalog()
const den = await bootDen({ env: { ...gatewayFixtureEnv, DEN_WORKBOT_URL: "http://localhost:3020" } })
after(async () => { await den.close(); restoreCatalog() })
const { db } = await import("../../src/db.js")
const { automationRunnerRowId } = await import("../../src/automations/repository.js")
const { orgId, owner: ada } = await den.createOrg(await den.signUp("Ada"), "Computer fixtures")
const sam = await den.newMember(ada, orgId, "Sam")
const adaToken = await den.mintMcpToken(ada, orgId)
const samToken = await den.mintMcpToken(sam, orgId)
const models = await grantGatewayModels(den, ada, orgId, [ada, sam])
const listSchema = z.object({ self: computerSchema.nullable(), computers: z.array(computerSchema.extend({ reach: computerDecisionSchema.nullable() })) })
const accessPath = "/v1/computer-runners/access"
const listPath = "/v1/computer-runners/commands"
const claimPath = (id: string) => `/v1/computer-commands/${id}/claim`
const completePath = (id: string) => `/v1/computer-commands/${id}/complete`
const logs = ["/workspace/logs"]
const grant: ComputerAccessReport = { choice: "allow", grants: [{ source: { kind: "workbot" }, folders: logs }] }
const canned: ComputerCommandCompleteRequest = { status: "done", exitCode: 0, output: "simulated logs\n", truncated: false }

async function workbot(person: Member, token: string) {
  const sessionId = workbotSessionId(orgId, person.memberId)
  const reported = await den.request(token, "POST", "/v1/workbot/devices/computer", { body: { sessionId, chat: "main", event: "resumed" } })
  assert.equal(reported.status, 204, summary(reported))
  const minted = await den.request(token, "POST", "/v1/workbot/run-token", { body: { sessionId, messageId: "fixture-turn", model: models["gpt-6-luna"] } })
  assert.equal(minted.status, 200, summary(minted))
  return text(field(minted.body, "token"), "Workbot run token")
}

async function simulatedComputer(person: Member, runnerId: string, label: string, supported = true, runnerOrgId = orgId) {
  const minted = await den.as(person, runnerOrgId)("POST", "/v1/session-runners/token", {
    runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.7.0", platform: "darwin", concurrency: 1,
    capabilities: supported ? [COMPUTER_SHELL_RUNNER_CAPABILITY] : [],
  })
  assert.equal(minted.status, 200, summary(minted))
  const token = text(field(minted.body, "token"), "desktop runner token")
  const runnerRowId = automationRunnerRowId({ organizationId: runnerOrgId, ownerMemberId: person.memberId, runnerId })
  const call = (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => den.request(token, method, path, body === undefined ? {} : { body })
  const inventory = await call("PUT", "/v1/session-runners/inventory", { computer: { label, platform: "darwin", appVersion: "1.7.0" }, workspaces: [] })
  assert.equal(inventory.status, 200, summary(inventory))
  let local: ComputerAccessReport = { choice: null, grants: [] }
  async function report(body: ComputerAccessReport) {
    const saved = await call("PUT", accessPath, body)
    assert.equal(saved.status, 200, summary(saved))
    assert.deepEqual(saved.body, { ok: true })
    local = structuredClone(body)
  }
  async function finish(assignment: ComputerCommandAssignment, localPolicy = local) {
    const target = computerSchema.parse({ id: assignmentScopeTarget, label, kind: "member_machine", provider: "openwork_desktop", ownerMemberId: person.memberId, availability: "online" })
    const verdict = decide(assignment.source, target, assignment.action, {
      organization: { allowed: true, requireSandboxOnPersonal: true }, owner: { choice: localPolicy.choice }, grants: localPolicy.grants.map(({ source, folders }) => ({ source, targetId: target.id, scope: { surface: "sandbox", folders } })),
    })
    if (verdict.outcome === "allow") assert.deepEqual(verdict.scope, assignment.scope)
    const body = verdict.outcome === "refuse" ? { status: "refused", layer: verdict.layer, code: verdict.code } : canned
    const completed = await call("POST", completePath(assignment.id), body)
    assert.equal(completed.status, 200, summary(completed))
    return completed.body
  }
  let assignmentScopeTarget = ""
  async function id() {
    const [row] = await db.$primary.select({ id: RemoteDeviceTable.id }).from(RemoteDeviceTable).where(and(eq(RemoteDeviceTable.organizationId, normalizeDenTypeId("organization", runnerOrgId)), eq(RemoteDeviceTable.externalId, runnerRowId))).limit(1)
    assert.ok(row)
    assignmentScopeTarget = row.id
    return row.id
  }
  return { call, report, id, finish, runnerRowId, label }
}

const desktop = await simulatedComputer(ada, "ada-laptop", "Ada's MacBook")
const shell = (token: string, body: Record<string, unknown>) => den.callMcpTool(token, "execute_capability", { name: "computers:shell", body })
const listComputers = (token: string) => den.callMcpTool(token, "execute_capability", { name: "computers:list", body: {} })
async function matches(token: string) {
  const found = await den.callMcpTool(token, "search_capabilities", { query: "computers shell list", limit: 20, type: "api" })
  assert.equal(found.isError, false, found.raw)
  return list(field(found.body, "matches")).map((row) => row.name).filter((name) => typeof name === "string" && name.startsWith("computers:"))
}
function refusal(result: McpToolResult, layer: string, code: string, message: string, changeableBy = "computer_owner") {
  assert.equal(result.isError, true, result.raw)
  assert.deepEqual(result.structured, { state: "refused", layer, code, message, changeableBy })
  assert.deepEqual(result.body, result.structured)
}
const computerOff = "Ada's MacBook isn't set to take work from other computers. Its owner decides whether to allow it."
const notShared = "Nothing on Ada's MacBook is shared with me. Its owner decides what to share."
const enabled = await den.asPlatformAdmin("PUT", `/v1/admin/organizations/${orgId}/capabilities`, { capabilities: { computers: true, remoteSessionAccess: true } })
assert.equal(enabled.status, 200, summary(enabled))
const adaRun = await workbot(ada, adaToken)
const samRun = await workbot(sam, samToken)
await desktop.report(grant)
const computerId = await desktop.id()
const run = (cwd = "/workspace/logs") => shell(adaRun, { computerId, command: "fixture command", cwd, waitMs: 0 })
async function ceiling(access: "off" | "created") {
  const updated = await den.as(ada, orgId)("PATCH", "/v1/org/remote-session-settings", { access })
  assert.equal(updated.status, 200, summary(updated))
}

async function queued() {
  const response = await run()
  assert.equal(response.isError, false, response.raw)
  const execution = computerExecutionSchema.parse(response.structured)
  assert.equal(execution.state, "running")
  return execution
}

test("With Computers off neither capability is visible or executable and all four runner routes are disabled", async () => {
  const off = await den.createOrg(await den.signUp("Pat"), "Computers off fixtures")
  const token = await den.mintMcpToken(off.owner, off.orgId)
  const runner = await simulatedComputer(off.owner, "pat-laptop", "Pat's MacBook", true, off.orgId)
  assert.deepEqual(await matches(token), [])
  for (const result of [await listComputers(token), await shell(token, { computerId: "unknown", command: "fixture command" })]) {
    assert.equal(result.isError, true, result.raw)
    assert.equal(field(result.structured, "error"), "unknown_capability")
  }
  const absent = createDenTypeId("computerCommand")
  for (const response of [await runner.call("PUT", accessPath, {}), await runner.call("GET", listPath), await runner.call("POST", claimPath(absent)), await runner.call("POST", completePath(absent), {})]) {
    assert.equal(response.status, 404, summary(response))
    assert.deepEqual(response.body, { error: "feature_disabled", feature: "computers" })
  }
})

test("The computer list discovers both capabilities and shows Workbot, the member's desktop and its reach", async () => {
  assert.deepEqual((await matches(adaRun)).sort(), ["computers:list", "computers:shell"])
  const result = await listComputers(adaRun)
  assert.equal(result.isError, false, result.raw)
  const listed = listSchema.parse(result.structured)
  assert.equal(listed.self?.kind, "cloud_sandbox")
  assert.equal(listed.self?.ownerMemberId, ada.memberId)
  assert.deepEqual(listed.computers.find(({ id }) => id === computerId), {
    id: computerId, label: desktop.label, provider: "openwork_desktop", kind: "member_machine", ownerMemberId: ada.memberId,
    availability: "online", reach: { outcome: "allow", route: "checked", scope: { surface: "sandbox", folders: logs } },
  })
  assert.equal(listed.computers.some(({ ownerMemberId }) => ownerMemberId === sam.memberId), false)
  assert.equal(listSchema.parse((await listComputers(adaToken)).structured).self, null)
})

test("The organization ceiling refuses work even when the owner and grant allow it", async () => {
  await ceiling("off")
  try {
    refusal(await run(), "organization", "organization_off", "I can't do that. Your admin has turned this off for the organization.", "organization_admin")
  } finally { await ceiling("created") }
})

test("An unchosen or off desktop refuses work even with a grant", async () => {
  try {
    for (const choice of [null, "off"] satisfies ComputerAccessReport["choice"][]) {
      await desktop.report({ ...grant, choice })
      refusal(await run(), "computer", "computer_not_allowed", computerOff)
    }
  } finally { await desktop.report(grant) }
})

test("An allowed desktop refuses a source with nothing shared", async () => {
  await desktop.report({ choice: "allow", grants: [] })
  try {
    refusal(await run(), "source", "nothing_shared", notShared)
  } finally { await desktop.report(grant) }
})

test("A sibling path outside the shared folder is refused", async () => {
  refusal(await run(`/workspace/logs2/${computerId}`), "source", "folder_not_shared", "The folder I need on Ada's MacBook isn't shared with me. Its owner decides which folders to share.")
})

test("A simulated desktop claims the current folders, runs no real shell, and returns output to a waiting follower", async () => {
  const { id, expiresAt } = await queued()
  await desktop.report({ choice: "allow", grants: [{ source: { kind: "workbot" }, folders: [...logs, "/workspace/archive"] }] })
  try {
    const pending = await desktop.call("GET", listPath)
    assert.equal(pending.status, 200, summary(pending))
    assert.deepEqual(computerCommandListResponseSchema.parse(pending.body).items, [{ id, expiresAt }])
    const claim = await desktop.call("POST", claimPath(id))
    assert.equal(claim.status, 200, summary(claim))
    const { assignment } = computerCommandClaimResponseSchema.parse(claim.body)
    assert.deepEqual(assignment.scope, { surface: "sandbox", folders: [...logs, "/workspace/archive"] })
    assert.deepEqual(assignment.action, { type: "shell", cwd: "/workspace/logs", command: "fixture command" })
    assert.equal(assignment.source.ownerMemberId, ada.memberId)
    const following = shell(adaRun, { id, waitMs: 2_000 })
    assert.deepEqual(await desktop.finish(assignment), { command: { id, status: "done" } })
    const done = await following
    assert.equal(done.isError, false, done.raw)
    assert.deepEqual(done.structured, { state: "done", id, exitCode: 0, output: "simulated logs\n", truncated: false })
    assert.equal((await desktop.call("POST", completePath(id), canned)).status, 200)
    assert.equal((await desktop.call("POST", completePath(id), { ...canned, output: "changed" })).status, 409)
  } finally { await desktop.report(grant) }
})

test("An offline computer answers immediately and creates no command", async () => {
  const targetId = normalizeDenTypeId("remoteDevice", computerId)
  const old = new Date(Date.now() - 24 * 60 * 60_000)
  const before = await db.select({ id: ComputerCommandTable.id }).from(ComputerCommandTable).where(eq(ComputerCommandTable.targetDeviceId, targetId))
  await db.update(AutomationRunnerTable).set({ last_seen_at: old }).where(eq(AutomationRunnerTable.id, desktop.runnerRowId))
  await db.update(RemoteDeviceTable).set({ lastSeenAt: old }).where(eq(RemoteDeviceTable.id, targetId))
  try {
    const start = Date.now()
    const result = await shell(adaRun, { computerId, command: "fixture command", waitMs: 20_000 })
    assert.ok(Date.now() - start < 5_000, "offline does not wait for a runner")
    assert.equal(result.isError, true, result.raw)
    assert.deepEqual(result.structured, { state: "offline", message: "Ada's MacBook is offline. Try again when it is back online.", retryable: true })
    assert.deepEqual(await db.select({ id: ComputerCommandTable.id }).from(ComputerCommandTable).where(eq(ComputerCommandTable.targetDeviceId, targetId)), before)
  } finally {
    await db.update(AutomationRunnerTable).set({ last_seen_at: new Date() }).where(eq(AutomationRunnerTable.id, desktop.runnerRowId))
    await db.update(RemoteDeviceTable).set({ lastSeenAt: new Date() }).where(eq(RemoteDeviceTable.id, targetId))
  }
})

test("A desktop without the shell runner capability can't take work on either MCP tool", async () => {
  const laptop = await simulatedComputer(ada, "ada-personal", "Ada's other Mac", false)
  const initialList = listSchema.parse((await listComputers(adaRun)).structured)
  const computer = initialList.computers.find((item) => item.label === laptop.label)
  assert.ok(computer)
  const id = normalizeDenTypeId("remoteDevice", computer.id)
  const reach = { outcome: "refuse", layer: "computer", code: "not_available_yet", changeableBy: "no_one", message: "Ada's other Mac can't take work from other computers yet." }
  for (const token of [adaRun, adaToken]) {
    const listed = listSchema.parse((await listComputers(token)).structured)
    assert.deepEqual(listed.computers.find((item) => item.id === id)?.reach, reach)
    refusal(await shell(token, { computerId: id, command: "fixture command", waitMs: 0 }), reach.layer, reach.code, reach.message, reach.changeableBy)
  }
  assert.deepEqual(await db.$primary.select({ id: ComputerCommandTable.id }).from(ComputerCommandTable).where(eq(ComputerCommandTable.targetDeviceId, id)), [])
})

test("Workbot cannot use a registered cloud computer even when its owner allows access", async () => {
  const asAda = den.as(ada, orgId)
  const vm = await asAda("POST", "/v1/remote-devices", { provider: "daytona", platform: "linux", label: "Build box", externalId: "test-provider-computer" })
  assert.equal(vm.status, 201, summary(vm))
  const { id } = remoteDeviceResponseSchema.parse(vm.body).device
  const reach = { outcome: "refuse", layer: "source", code: "owner_app_only", changeableBy: "no_one", message: "Build box only takes work from its owner's own OpenWork apps." }
  for (const setting of [{ choice: "off" }, { choice: "allow", scope: "whole_vm", folders: ["/workspace"] }]) {
    const saved = await asAda("PUT", `/v1/computers/${id}/access`, setting)
    assert.equal(saved.status, 200, summary(saved))
    const listed = listSchema.parse((await listComputers(adaRun)).structured)
    assert.deepEqual(listed.computers.find((item) => item.id === id)?.reach, reach)
    refusal(await shell(adaRun, { computerId: id, command: "fixture command", waitMs: 0 }), reach.layer, reach.code, reach.message, reach.changeableBy)
  }
})

test("Another member's Workbot cannot use the owner's private desktop or its Workbot grant", async () => {
  const result = await shell(samRun, { computerId, command: "fixture command", waitMs: 0 })
  assert.equal(result.isError, true, result.raw)
  assert.deepEqual(result.structured, { error: "unknown_computer", message: "That computer isn't available to your account.", retryable: false })
})

test("Narrowing the owner's choice after enqueue prevents claim and settles the command as refused", async () => {
  const { id } = await queued()
  await desktop.report({ ...grant, choice: "off" })
  try {
    const claim = await desktop.call("POST", claimPath(id))
    assert.equal(claim.status, 409, summary(claim))
    assert.deepEqual(claim.body, { error: "command_refused", message: "The current access settings don't allow this command." })
  } finally { await desktop.report(grant) }
  refusal(await shell(adaRun, { id, waitMs: 0 }), "computer", "computer_not_allowed", computerOff)
})

test("A regular MCP caller cannot pass itself off as Workbot's computer", async () => {
  const result = await shell(adaToken, { computerId, command: "fixture command", waitMs: 0 })
  assert.equal(result.isError, true, result.raw)
  assert.deepEqual(result.structured, { error: "source_unverified", message: "This tool only accepts new commands from a Workbot chat.", retryable: false })
})

test("An unclaimed command past its deadline says nothing ran, disappears from the runner list, and cannot be claimed", async () => {
  const { id } = await queued()
  const before = await desktop.call("GET", listPath)
  assert.ok(computerCommandListResponseSchema.parse(before.body).items.some((item) => item.id === id))
  await db.update(ComputerCommandTable).set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(ComputerCommandTable.id, normalizeDenTypeId("computerCommand", id)))
  const expired = await shell(adaRun, { id, waitMs: 0 })
  assert.equal(expired.isError, true, expired.raw)
  assert.deepEqual(expired.structured, { state: "failed", id, error: { code: "not_picked_up", message: "Ada's MacBook didn't pick this up in time. Nothing ran." } })
  const after = await desktop.call("GET", listPath)
  assert.equal(after.status, 200, summary(after))
  assert.equal(computerCommandListResponseSchema.parse(after.body).items.some((item) => item.id === id), false)
  const claim = await desktop.call("POST", claimPath(id))
  assert.equal(claim.status, 409, summary(claim))
  assert.deepEqual(claim.body, { error: "command_conflict", message: "This computer can't pick up the command." })
})

test("Only the claiming runner can resolve the unknown outcome after the deadline, and can repeat the completion", async () => {
  const { id } = await queued()
  const earlyCompletion = await desktop.call("POST", completePath(id), canned)
  assert.equal(earlyCompletion.status, 409, summary(earlyCompletion))
  const first = await desktop.call("POST", claimPath(id))
  assert.equal(first.status, 200, summary(first))
  const { assignment } = computerCommandClaimResponseSchema.parse(first.body)
  const repeated = await desktop.call("POST", claimPath(id))
  assert.equal(repeated.status, 409, summary(repeated))
  assert.deepEqual(repeated.body, { error: "command_conflict", message: "This computer can't pick up the command." })
  await db.update(ComputerCommandTable).set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(ComputerCommandTable.id, normalizeDenTypeId("computerCommand", id)))
  const unknown = await shell(adaRun, { id, waitMs: 20_000 })
  assert.equal(unknown.isError, true, unknown.raw)
  assert.deepEqual(computerExecutionSchema.parse(unknown.structured), {
    state: "unknown", id, message: "Ada's MacBook started handling this command but hasn't reported back. It may have run. Ask again later with this command's ID, or check on that computer before running it again.",
  })
  assert.doesNotMatch(unknown.raw, /expired/i)
  const other = await simulatedComputer(ada, "ada-third", "Ada's third Mac")
  await other.report(grant)
  const wrongRunner = await other.call("POST", completePath(id), canned)
  assert.equal(wrongRunner.status, 404, summary(wrongRunner))
  assert.deepEqual(wrongRunner.body, { error: "command_not_found" })
  assert.deepEqual(await desktop.finish(assignment), { command: { id, status: "done" } })
  const done = await shell(adaRun, { id, waitMs: 0 })
  assert.equal(done.isError, false, done.raw)
  assert.deepEqual(done.structured, { state: "done", id, exitCode: 0, output: "simulated logs\n", truncated: false })
  const repeat = await desktop.call("POST", completePath(id), canned)
  assert.equal(repeat.status, 200, summary(repeat))
  const changed = await desktop.call("POST", completePath(id), { ...canned, output: "changed" })
  assert.equal(changed.status, 409, summary(changed))
  assert.deepEqual(changed.body, { error: "command_conflict", message: "This computer can't report that result for this command." })
})

test("A late failure or refusal replaces the unknown outcome", async () => {
  const failure = { status: "failed", error: { code: "runner_failed", message: "The shared drive isn't connected. Reconnect it and try again." } } satisfies ComputerCommandCompleteRequest
  const denied = { status: "refused", layer: "source", code: "nothing_shared" } satisfies ComputerCommandCompleteRequest
  for (const completion of [failure, denied]) {
    const { id } = await queued()
    const claim = await desktop.call("POST", claimPath(id))
    assert.equal(claim.status, 200, summary(claim))
    await db.update(ComputerCommandTable).set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(ComputerCommandTable.id, normalizeDenTypeId("computerCommand", id)))
    assert.equal(field((await shell(adaRun, { id, waitMs: 0 })).structured, "state"), "unknown")
    const reported = await desktop.call("POST", completePath(id), completion)
    assert.equal(reported.status, 200, summary(reported))
    const result = await shell(adaRun, { id, waitMs: 0 })
    if (completion.status === "failed") {
      assert.equal(result.isError, true, result.raw)
      assert.deepEqual(result.structured, { state: "failed", id, error: failure.error })
    } else {
      refusal(result, "source", "nothing_shared", notShared)
    }
  }
})

test("Only the creating user can follow the command and only the target runner can claim it", async () => {
  const { id } = await queued()
  const otherUser = await shell(samRun, { id, waitMs: 0 })
  assert.equal(otherUser.isError, true, otherUser.raw)
  assert.equal(field(otherUser.structured, "error"), "unknown_command")
  assert.equal(field((await shell(adaToken, { id, waitMs: 0 })).structured, "state"), "running")
  for (const other of [await simulatedComputer(ada, "ada-second", "Ada's second Mac"), await simulatedComputer(sam, "sam-first", "Sam's Mac")]) {
    await other.report(grant)
    assert.deepEqual((await other.call("GET", listPath)).body, { items: [] })
    assert.equal((await other.call("POST", claimPath(id))).status, 404)
    assert.equal((await other.call("POST", completePath(id), canned)).status, 404)
  }
  const claimed = computerCommandClaimResponseSchema.parse((await desktop.call("POST", claimPath(id))).body)
  const completed = await desktop.finish(claimed.assignment, { choice: "off", grants: [] })
  assert.deepEqual(completed, { command: { id, status: "refused" } })
  refusal(await shell(adaRun, { id, waitMs: 0 }), "computer", "computer_not_allowed", computerOff)
})

for (const trigger of ["runner list", "caller follow"]) {
  test(`The ${trigger} prunes old queued and settled commands but keeps a fresh result`, async () => {
    const [old, fresh, unattended] = [await queued(), await queued(), await queued()]
    const settle = async (id: string) => {
      const claim = await desktop.call("POST", claimPath(id))
      assert.equal(claim.status, 200, summary(claim))
      const complete = await desktop.call("POST", completePath(id), canned)
      assert.equal(complete.status, 200, summary(complete))
    }
    await settle(old.id)
    await settle(fresh.id)
    const oldTime = new Date(Date.now() - COMPUTER_COMMAND_RETENTION_MS - 60_000)
    const row = (id: string) => eq(ComputerCommandTable.id, normalizeDenTypeId("computerCommand", id))
    await db.update(ComputerCommandTable).set({ completedAt: oldTime }).where(row(old.id))
    await db.update(ComputerCommandTable).set({ expiresAt: oldTime }).where(row(fresh.id))
    await db.update(ComputerCommandTable).set({ expiresAt: oldTime }).where(row(unattended.id))
    const read = (id: string) => db.$primary.select({ id: ComputerCommandTable.id }).from(ComputerCommandTable).where(row(id))
    assert.deepEqual(await read(old.id), [{ id: old.id }])
    if (trigger === "runner list") {
      const response = await desktop.call("GET", listPath)
      assert.equal(response.status, 200, summary(response))
    } else {
      assert.equal(field((await shell(adaRun, { id: fresh.id, waitMs: 0 })).structured, "state"), "done")
    }
    assert.deepEqual(await read(old.id), [])
    assert.deepEqual(await read(unattended.id), [])
    assert.deepEqual(await read(fresh.id), [{ id: fresh.id }])
    const removed = await shell(adaRun, { id: old.id, waitMs: 0 })
    assert.equal(removed.isError, true, removed.raw)
    assert.deepEqual(removed.structured, { error: "unknown_command", message: "That computer command could not be found." })
  })
}
