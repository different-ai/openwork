import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRemoteRunnerController } from "../../../../../packages/opencode-plugin/src/remote-runner.ts"
import { createNativeHost } from "../../../../../packages/opencode-plugin/src/test-native.ts"
import type { LocationSessionChoices } from "../../../../../packages/opencode-plugin/src/remote-access.ts"
import { bootDen, field, list, summary, text } from "./harness.js"

// Real Den auth, routes, runner protocol and isolated MySQL; only the native OpenCode host is a fixture.
const den = await bootDen()
const { orgId, owner } = await den.createOrg(await den.signUp("Headless Owner"), "Headless consent test")
const other = await den.newMember(owner, orgId, "Other Member")
const asOwner = den.as(owner, orgId)

const root = await realpath(await mkdtemp(join(tmpdir(), "openwork-headless-api-")))
const first = join(root, "first")
const second = join(root, "second")
await mkdir(first)
await mkdir(second)
const choices: LocationSessionChoices = { [first]: "created", [second]: "created" }

function runner(directory: string, sessionChoices: LocationSessionChoices = choices, host = createNativeHost(directory)) {
  host.credential = { type: "oauth", methodID: "code", access: owner.token, refresh: owner.token,
    expires: Date.now() + 3_600_000, metadata: { apiBaseUrl: "http://127.0.0.1:8790", orgId } }
  const controller = createRemoteRunnerController({ ctx: host.ctx, apiBaseUrl: "http://127.0.0.1:8790",
    sessionChoices, label: directory === root ? "Home" : directory === first ? "First" : "Second",
    fetch: (url, init) => den.app.request(url, init), acquireOwnership: async () => ({ release: async () => {} }) })
  return { host, controller }
}

const runners = [runner(first), runner(second), runner(root)]
after(async () => {
  try { for (const value of runners) await value.controller.close() }
  finally {
    await den.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function agent(capability: string, body: Record<string, unknown>, member = owner) {
  return den.callMcpTool(await den.mintMcpToken(member, orgId), "execute_capability", { name: `remote-session:${capability}`, body })
}
async function targets() {
  const result = await agent("targets", {})
  assert.equal(result.isError, false, result.raw)
  return list(field(result.body, "computers"))
}
const prompts = () => runners.flatMap(value => value.host.calls).filter(call => call.method === "session.prompt").length

test("the owner allows two headless Locations, not home or another member; revocation and organization limits still win", async () => {
  assert.equal((await den.setFeature(orgId, "remoteTasksOptIn", true)).status, 200)
  for (const value of runners) {
    await value.controller.poll()
    assert.equal(value.controller.inspectStatus().state, "connected")
  }
  const computers = await targets()
  assert.equal(computers.length, 3)
  const firstComputer = computers.find(value => value.label === "First")
  const secondComputer = computers.find(value => value.label === "Second")
  const homeComputer = computers.find(value => value.label === "Home")
  assert.equal(firstComputer?.access, "created")
  assert.equal(secondComputer?.access, "created")
  assert.equal(homeComputer?.access, "off")
  assert.equal(prompts(), 0)
  const computerId = text(firstComputer?.computerId, "first computer")
  const homeId = text(homeComputer?.computerId, "home computer")
  const home = await agent("create", { target: "registered", computerId: homeId, prompt: "Do not run" })
  assert.equal(field(home.body, "error"), "remote_access_off", home.raw)
  const foreign = await agent("targets", {}, other)
  assert.deepEqual(list(field(foreign.body, "computers")), [])

  const created = await agent("create", { target: "registered", computerId, prompt: "Review this workspace" })
  assert.equal(field(created.body, "state"), "queued", created.raw)
  await runners[0]!.controller.poll()
  assert.equal(prompts(), 1)
  assert.equal(runners[0]!.host.sessions.size, 1)
  assert.equal(runners[1]!.host.sessions.size, 0)
  assert.equal(runners[2]!.host.sessions.size, 0)

  // Orderly config reload withdraws the old report; an empty allowlist keeps the stable identity off.
  await runners[0]!.controller.close()
  const revoked = runner(first, {}, runners[0]!.host)
  runners[0] = revoked
  await revoked.controller.poll()
  assert.equal((await targets()).find(value => value.computerId === computerId)?.access, "off")
  const denied = await agent("create", { target: "registered", computerId, prompt: "Do not run after revocation" })
  assert.equal(field(denied.body, "error"), "remote_access_off", denied.raw)
  assert.equal(prompts(), 1)

  // Re-enabling one Location never grants local-session access or overrides the organization's ceiling.
  await revoked.controller.close()
  runners[0] = runner(first, choices, revoked.host)
  await runners[0]!.controller.poll()
  assert.equal((await targets()).find(value => value.computerId === computerId)?.access, "created")
  const capped = await asOwner("PATCH", "/v1/org/remote-session-settings", { access: "off" })
  assert.equal(capped.status, 200, summary(capped))
  const nativeBefore = runners[0]!.host.calls.length
  await runners[0]!.controller.poll()
  assert.ok(!runners[0]!.host.calls.slice(nativeBefore).some(call => call.method.startsWith("session.")))
  assert.ok((await targets()).every(value => value.access === "off"))
  assert.equal(prompts(), 1)
})
