import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  automationRunnerWorkResponseSchema,
  effectiveRemoteSessionAccess,
  remoteSessionAttachAssignmentSchema,
  runnerSessionReportResponseSchema,
  runnerSessionReportSchema,
  unchosenRemoteSessionAccess,
} from "@openwork/types/automations"
import { collectRunnerSessions, createDesktopAutomationRunner, selectRunnableWorkItem } from "../electron/automation-runner.mjs"
import { createSessionAccessStore, effectiveSessionAccess, parseSessionAccess, sessionAccessKey } from "../electron/session-access.mjs"
import { desktopSessionRunnerPartition } from "../electron/session-runner-journal.mjs"

const denBaseUrl = "https://runner.invalid"
const account = { organizationId: "org_fixture", memberId: "member_fixture", runnerId: "runner_fixture" }
const journalCapabilities = ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1"]
/** What Den signs for this app where the organization offers sessions started here: the owner's choice and session access. */
const accessCapabilities = [...journalCapabilities, "remote_session_access_v1", "remote_session_choice_v1"]
/** An organization without sessions started here, and a Den from before the owner's choice. */
const choiceOnlyCapabilities = [...journalCapabilities, "remote_session_choice_v1"]
const accessOnlyCapabilities = [...journalCapabilities, "remote_session_access_v1"]
const token = (capabilities, nonce = "first") => `${Buffer.from(JSON.stringify({
  v: 2, a: denBaseUrl, o: account.organizationId, m: account.memberId, r: account.runnerId, c: capabilities, nonce,
})).toString("base64url")}.signature`
/** The stored choice's key for the fixture organization, and for another one on the same Den. */
const accessKey = sessionAccessKey(denBaseUrl, account.organizationId)
const otherKey = sessionAccessKey(denBaseUrl, "org_other")
const accessFile = (root) => join(root, "access.json")
const storedChoices = async (root) => JSON.parse(await readFile(accessFile(root), "utf8"))
/** The owner's choice for the fixture organization, as it is on disk before the app starts. */
const storeChoice = (root, mode) => writeFile(accessFile(root), JSON.stringify({ version: 2, choices: { [accessKey]: mode } }), "utf8")
const attachAssignment = (commandId = "attach_fixture") => remoteSessionAttachAssignmentSchema.parse({
  commandId, kind: "remote_session_attach", title: "Local fixture", prompt: null, model: null,
  workspaceId: "workspace_a", sessionId: "session_local", expiresAt: Date.now() + 60_000,
})

async function eventually(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

const removeDirectory = (root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

async function privateDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "openwork-session-access-"))
  t.after(() => removeDirectory(root))
  return root
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

/** The local OpenWork server: workspaces, the chat engine in use and each engine's sessions per workspace. */
function localFixture() {
  const calls = []
  const writes = []
  const local = {
    calls,
    writes,
    routing: "v2",
    workspaces: ["workspace_a"],
    v1: {},
    v2: {},
    running: { v1: {}, v2: {} },
    failing: new Set(),
    /** While set, the workspace list waits for it. */
    hold: null,
    pageSize: 200,
    getLocalRuntime: async () => ({ baseUrl: "http://localhost:8787", token: "local-credential" }),
    fetchImpl: async (input, init = {}) => {
      const url = new URL(String(input))
      calls.push(`${url.pathname}${url.search}`)
      if ((init.method ?? "GET") !== "GET") writes.push(url.pathname)
      if (local.failing.has(url.pathname)) return json({ message: "engine stopped" }, 500)
      if (url.pathname === "/workspaces") await local.hold
      if (url.pathname === "/workspaces") return json({ activeId: local.workspaces[0], items: local.workspaces.map((id) => ({ id })) })
      if (url.pathname === "/experimental/engine-v2-preview/status") {
        return json({ enabled: local.routing !== "v1-only", chatRouting: local.routing === "v2" })
      }
      const match = /^\/workspace\/([^/]+)\/(opencode2\/api|opencode)\/session(\/active|\/status)?$/.exec(url.pathname)
      if (!match) return json({ message: "unexpected local path" }, 404)
      const [, workspaceId, mount, suffix] = match
      const engine = mount === "opencode" ? "v1" : "v2"
      if (suffix) {
        const running = local.running[engine][workspaceId] ?? {}
        return json(engine === "v2" ? { data: running } : running)
      }
      const rows = local[engine][workspaceId] ?? []
      if (engine === "v1") {
        assert.equal(url.searchParams.get("roots"), "true")
        return json(rows.filter((row) => !row.parentID).slice(0, Number(url.searchParams.get("limit"))))
      }
      const start = Number(url.searchParams.get("cursor") ?? 0)
      const end = start + Math.min(local.pageSize, Number(url.searchParams.get("limit")))
      return json({ data: rows.slice(start, end), ...(end < rows.length ? { cursor: { next: String(end) } } : {}) })
    },
  }
  return local
}

/**
 * Den: queued work, the organization's ceiling on every work response and the
 * session report route. Everything crossing the wire is held to the shared contract.
 */
function denFixture(local) {
  const calls = []
  const den = {
    calls,
    work: [],
    assignments: new Map(),
    policy: { ceiling: "all" },
    /** While set, work polls wait for it. */
    hold: null,
    reportStatus: 200,
    reportCeiling: null,
    /** A report route that answers with the ceiling alone. */
    reportOmitsOptIn: false,
    /** Reports the shared contract does not accept; always empty. */
    rejected: [],
    reports: () => calls.filter((call) => call.path === "/v1/session-runners/sessions").map((call) => call.body),
    completions: () => calls.filter((call) => call.path.endsWith("/complete")),
    workPolls: () => calls.filter((call) => call.path === "/v1/automation-runner/work").length,
    fetchImpl: async (input, init = {}) => {
      const url = new URL(String(input))
      if (url.origin !== denBaseUrl) return local.fetchImpl(input, init)
      const body = init.body ? JSON.parse(init.body) : null
      calls.push({ path: url.pathname, method: init.method ?? "GET", body })
      if (url.pathname === "/v1/automation-runner/work") {
        await den.hold
        return json(automationRunnerWorkResponseSchema.parse({ items: den.work, ...(den.policy ? { sessionAccess: den.policy } : {}) }))
      }
      if (url.pathname === "/v1/session-runners/sessions") {
        if (!runnerSessionReportSchema.safeParse(body).success) {
          den.rejected.push(body)
          return json({ error: "invalid_request" }, 400)
        }
        if (den.reportStatus !== 200) return json({ error: "feature_disabled" }, den.reportStatus)
        return json(runnerSessionReportResponseSchema.parse({
          ok: true, updatedAt: 1,
          sessionAccess: { ...(den.reportOmitsOptIn ? {} : den.policy), ceiling: den.reportCeiling ?? den.policy.ceiling },
        }))
      }
      if (url.pathname === "/v1/remote-session-requests/pending") return json({ items: [] })
      if (url.pathname.endsWith("/claim")) {
        const id = url.pathname.split("/").at(-2)
        den.work = den.work.filter((item) => item.commandId !== id)
        return json({ assignment: den.assignments.get(id) })
      }
      return json({ accepted: true })
    },
  }
  return den
}

function desktopRunner(den, local, root, options = {}) {
  return createDesktopAutomationRunner({
    fetchImpl: den.fetchImpl, getLocalRuntime: local.getLocalRuntime, getJournalRoot: () => root,
    remoteSessionRequestPoll: { pollMs: 10 },
    // Nothing waits for real: after its first poll the runner checks for work only when woken.
    waitBeforeReconnect: (_ms, signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    ...options,
  })
}

function configure(runner, capabilities = accessCapabilities, nonce = "first") {
  return runner.configure({ baseUrl: denBaseUrl, runnerId: account.runnerId, token: token(capabilities, nonce) })
}

/** Signs the same computer in to another organization on the same Den. */
function configureOther(runner, nonce = "other") {
  return runner.configure({
    baseUrl: denBaseUrl, runnerId: account.runnerId,
    token: `${Buffer.from(JSON.stringify({
      v: 2, a: denBaseUrl, o: "org_other", m: "member_other", r: account.runnerId, c: accessCapabilities, nonce,
    })).toString("base64url")}.signature`,
  })
}

/** One more work poll, and time for what it started. A poll already under way is not counted. */
async function poll(runner, den) {
  const before = den.workPolls()
  await eventually(() => {
    runner.wake()
    return den.workPolls() > before
  }, "the woken runner polls for work")
  await settle()
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "openwork-session-access-"))
  const local = localFixture()
  const den = denFixture(local)
  const runner = desktopRunner(den, local, root, options)
  // The runner stops before its journal folder goes, so a late save cannot land in a folder being removed.
  t.after(async () => {
    runner.stop()
    await removeDirectory(root)
    assert.deepEqual(den.rejected, [], "every session report satisfies the shared contract")
  })
  return { root, local, den, runner }
}

test("a choice is kept per organization, survives a restart and never applies to another organization", async (t) => {
  const root = await privateDirectory(t)
  const store = createSessionAccessStore(() => root)
  assert.equal(store.read(accessKey), null, "nobody has chosen yet")
  await store.write(accessKey, "all")
  assert.deepEqual(await storedChoices(root), { version: 2, choices: { [accessKey]: "all" } })
  assert.equal(store.read(accessKey), "all")
  assert.equal(store.read(otherKey), null, "another organization has not chosen")
  assert.deepEqual(await readdir(root), ["access.json"], "no temporary file is left behind")
  if (process.platform !== "win32") assert.equal((await stat(accessFile(root))).mode & 0o777, 0o600)

  await store.write(otherKey, "off")
  await store.write(accessKey, "created")
  assert.deepEqual(await storedChoices(root), { version: 2, choices: { [accessKey]: "created", [otherKey]: "off" } })
  const restarted = createSessionAccessStore(() => root)
  assert.equal(restarted.read(accessKey), "created")
  assert.equal(restarted.read(otherKey), "off")
  assert.equal(restarted.read(sessionAccessKey("https://other-den.invalid", account.organizationId)), null, "nor the same organization id on another Den")

  await assert.rejects(store.write(accessKey, "everything"))
  await assert.rejects(store.write("", "off"))
  await assert.rejects(store.write(null, "off"))
  assert.equal(store.read(accessKey), "created")
  assert.equal(sessionAccessKey(denBaseUrl, ""), null)
  assert.equal(sessionAccessKey("", "org_fixture"), null)
  assert.equal(sessionAccessKey(denBaseUrl, undefined), null)
})

test("narrowing applies before it is saved, widening only once it is", async (t) => {
  const root = await privateDirectory(t)
  const store = createSessionAccessStore(() => root)
  const allowing = store.write(accessKey, "created")
  assert.equal(store.read(accessKey), null, "allowing tasks waits for the save")
  await allowing
  assert.equal(store.read(accessKey), "created")
  const widening = store.write(accessKey, "all")
  assert.equal(store.read(accessKey), "created")
  await widening
  assert.equal(store.read(accessKey), "all")
  const narrowing = store.write(accessKey, "created")
  assert.equal(store.read(accessKey), "created", "narrowing does not wait")
  const off = store.write(accessKey, "off")
  assert.equal(store.read(accessKey), "off")
  await Promise.all([narrowing, off])
  assert.deepEqual(await storedChoices(root), { version: 2, choices: { [accessKey]: "off" } }, "saves land in the order they were asked for")
  const first = store.write(otherKey, "off")
  assert.equal(store.read(otherKey), "off", "turning a computer off before any choice does not wait either")
  await first

  // A wider choice still being saved never undoes a narrower one asked for after it.
  await store.write(accessKey, "created")
  const wider = store.write(accessKey, "all")
  const narrower = store.write(accessKey, "off")
  assert.equal(store.read(accessKey), "off")
  await wider
  assert.equal(store.read(accessKey), "off", "the earlier save finishing changes nothing")
  await narrower
  assert.equal(store.read(accessKey), "off")
  assert.deepEqual(await storedChoices(root), { version: 2, choices: { [accessKey]: "off", [otherKey]: "off" } })

  // A save that fails: the narrower choice stays in force for this run, the wider one never applies.
  const blocked = await privateDirectory(t)
  await mkdir(join(blocked, "access.json", "in-the-way"), { recursive: true })
  const unsaved = createSessionAccessStore(() => blocked)
  await assert.rejects(unsaved.write(accessKey, "all"))
  assert.equal(unsaved.read(accessKey), null)
  await assert.rejects(unsaved.write(otherKey, "off"))
  assert.equal(unsaved.read(otherKey), "off")
  // Once saving works again, the wide choice that failed is not written along with a later one.
  await rm(join(blocked, "access.json"), { recursive: true })
  await unsaved.write(otherKey, "created")
  assert.deepEqual(await storedChoices(blocked), { version: 2, choices: { [otherKey]: "created" } })
  assert.equal(unsaved.read(accessKey), null)
})

test("a missing, corrupt, unknown or substituted file holds no choice, never a wide one", async (t) => {
  const root = await privateDirectory(t)
  const wide = { version: 2, choices: { [accessKey]: "all" } }
  for (const text of ["{corrupt", "", "null", "[]", JSON.stringify("all"), JSON.stringify({ mode: "all" }),
    JSON.stringify({ version: 3, choices: wide.choices }), JSON.stringify({ version: 2, mode: "all" }),
    JSON.stringify({ version: 2, choices: [accessKey] }), JSON.stringify({ version: 2, choices: null }),
    JSON.stringify({ version: 2, choices: { [accessKey]: "everything" } }), JSON.stringify({ version: 2, choices: { [accessKey]: true } })]) {
    assert.deepEqual(parseSessionAccess(text), { choices: {} }, text)
    await writeFile(accessFile(root), text, "utf8")
    assert.equal(createSessionAccessStore(() => root).read(accessKey), null, text)
  }
  assert.deepEqual(parseSessionAccess(JSON.stringify(wide)), { choices: wide.choices })
  assert.deepEqual(parseSessionAccess(JSON.stringify({ version: 2, choices: { [accessKey]: "off", [otherKey]: "sometimes", "": "all" } })),
    { choices: { [accessKey]: "off" } }, "one unknown entry does not lose the others")
  await writeFile(accessFile(root), JSON.stringify({ ...wide, padding: "x".repeat(300 * 1024) }), "utf8")
  assert.equal(createSessionAccessStore(() => root).read(accessKey), null, "a file too large to be this one is not read")
  assert.equal(createSessionAccessStore(() => join(root, "missing")).read(accessKey), null)
  if (process.platform !== "win32") {
    const elsewhere = await privateDirectory(t)
    await writeFile(join(elsewhere, "wide.json"), JSON.stringify(wide), "utf8")
    await rm(accessFile(root))
    await symlink(join(elsewhere, "wide.json"), accessFile(root))
    assert.equal(createSessionAccessStore(() => root).read(accessKey), null, "a symlinked file is never followed")
  }
})

test("a choice of all sessions from before choices were per organization goes to the first organization only", async (t) => {
  assert.deepEqual(parseSessionAccess(JSON.stringify({ version: 1, mode: "all" })), { choices: {}, legacy: "all" })
  assert.deepEqual(parseSessionAccess(JSON.stringify({ version: 1, mode: "created" })), { choices: {}, legacy: null })
  assert.deepEqual(parseSessionAccess(JSON.stringify({ version: 1, mode: "everything" })), { choices: {}, legacy: null })

  const root = await privateDirectory(t)
  await writeFile(accessFile(root), JSON.stringify({ version: 1, mode: "all" }), "utf8")
  const store = createSessionAccessStore(() => root)
  assert.equal(store.read(accessKey), null, "it belongs to no organization until one is connected")
  assert.equal(await store.adoptLegacy(null), false, "and is kept for the first organization")
  const adopting = store.adoptLegacy(accessKey)
  assert.equal(store.read(accessKey), null, "the wide choice applies only once it is saved")
  // A second organization configured in the same moment gets nothing.
  assert.equal(await store.adoptLegacy(otherKey), false)
  assert.equal(await adopting, true)
  assert.equal(store.read(accessKey), "all")
  assert.equal(store.read(otherKey), null)
  assert.deepEqual(await storedChoices(root), { version: 2, choices: { [accessKey]: "all" } })

  const restarted = createSessionAccessStore(() => root)
  assert.equal(await restarted.adoptLegacy(otherKey), false, "nor after a restart")
  assert.equal(restarted.read(otherKey), null)
  assert.equal(restarted.read(accessKey), "all")
})

test("the old default from before choices were per organization migrates as not chosen", async (t) => {
  const root = await privateDirectory(t)
  await writeFile(accessFile(root), JSON.stringify({ version: 1, mode: "created" }), "utf8")
  const store = createSessionAccessStore(() => root)
  assert.equal(await store.adoptLegacy(accessKey), false)
  assert.equal(store.read(accessKey), null, "so the organization's opt-in can apply")
  assert.deepEqual(await storedChoices(root), { version: 2, choices: {} }, "and the file is rewritten")
  assert.equal(await store.adoptLegacy(otherKey), false)
  assert.equal(store.read(otherKey), null)

  // A migration that cannot be saved hands out nothing wide in this run.
  const blocked = await privateDirectory(t)
  const legacy = createSessionAccessStore(() => blocked)
  await writeFile(accessFile(blocked), JSON.stringify({ version: 1, mode: "all" }), "utf8")
  assert.equal(legacy.read(accessKey), null)
  await rm(accessFile(blocked))
  await mkdir(join(blocked, "access.json", "in-the-way"), { recursive: true })
  await assert.rejects(legacy.adoptLegacy(accessKey))
  assert.equal(legacy.read(accessKey), null)
  assert.equal(await legacy.adoptLegacy(otherKey), false)
})

const modes = ["off", "created", "all"]

test("what applies: off always wins, then the choice or the default, capped by the organization and the runner's capability", () => {
  const policies = [null, undefined]
  for (const ceiling of [...modes, "everything", undefined]) {
    for (const optIn of [true, false, undefined, "yes"]) policies.push({ ceiling, ...(optIn === undefined ? {} : { optIn }) })
  }
  let cases = 0
  for (const choice of [...modes, null, undefined, "everything"]) {
    for (const policy of policies) {
      for (const capable of [true, false, undefined, "yes"]) {
        // The shared contract's own rules, with this app's two additions: no policy caps at `created`, and `all` needs the capability.
        const base = modes.includes(choice) ? choice : unchosenRemoteSessionAccess(policy?.optIn === true)
        const cap = policy ? (modes.includes(policy.ceiling) ? policy.ceiling : "off") : "created"
        const narrower = effectiveRemoteSessionAccess(cap, base)
        const expected = choice === "off" ? "off" : narrower === "all" && capable !== true ? "created" : narrower
        assert.equal(effectiveSessionAccess({ choice, policy, capable }), expected, JSON.stringify({ choice, policy, capable }))
        cases += 1
      }
    }
  }
  assert.equal(cases, 6 * 22 * 4)

  const applies = (choice, policy, capable = true) => effectiveSessionAccess({ choice, policy, capable })
  // Not chosen.
  assert.equal(applies(null, null), "created", "no policy from Den: as before the choice existed")
  assert.equal(applies(null, { ceiling: "all" }), "created")
  assert.equal(applies(null, { ceiling: "all", optIn: false }), "created")
  assert.equal(applies(null, { ceiling: "all", optIn: true }), "off", "the opt-in: nothing until the owner allows it")
  assert.equal(applies(null, { ceiling: "off", optIn: false }), "off")
  // Chosen.
  assert.equal(applies("created", { ceiling: "all", optIn: true }), "created", "an owner who allowed tasks is past the opt-in")
  assert.equal(applies("created", { ceiling: "off", optIn: true }), "off", "the organization turned it off")
  assert.equal(applies("all", { ceiling: "all", optIn: true }), "all")
  assert.equal(applies("all", { ceiling: "all" }, false), "created", "all needs the runner's capability")
  assert.equal(applies("all", { ceiling: "created" }), "created")
  assert.equal(applies("all", null), "created", "nothing wide before Den says what the organization allows")
  assert.equal(applies("all", { ceiling: "off" }), "off")
  for (const policy of [null, { ceiling: "all" }, { ceiling: "all", optIn: false }, { ceiling: "created", optIn: true }]) {
    for (const capable of [true, false]) assert.equal(applies("off", policy, capable), "off", "off needs nothing from Den")
  }
})

/** What the page is told while no runner is connected to an organization. */
const notConnected = { mode: null, ceiling: null, effective: "created", supported: false, optIn: false, connected: false }

test("the runner reports the choice, the organization's policy and what is in force", async (t) => {
  const { root, den, runner } = await fixture(t)
  assert.deepEqual(runner.getSessionAccess(), notConnected)
  await assert.rejects(runner.setSessionAccess("everything"))
  await assert.rejects(runner.setSessionAccess("off"), /Connect this computer to your organization/, "a choice belongs to an organization")
  assert.deepEqual(await readdir(root), [], "and nothing was stored")

  den.policy = { ceiling: "created" }
  configure(runner)
  const connected = { mode: null, ceiling: null, effective: "created", supported: true, optIn: false, connected: true }
  assert.deepEqual(runner.getSessionAccess(), connected, "nothing wider applies before Den says what the organization allows")
  await assert.rejects(runner.setSessionAccess("everything"))
  await eventually(() => runner.getSessionAccess().ceiling === "created")
  assert.deepEqual(await runner.setSessionAccess("all"), { ...connected, mode: "all", ceiling: "created" })
  assert.deepEqual(await storedChoices(root), { version: 2, choices: { [accessKey]: "all" } })

  den.policy = { ceiling: "all" }
  await poll(runner, den)
  assert.deepEqual(runner.getSessionAccess(), { ...connected, mode: "all", ceiling: "all", effective: "all" })

  den.policy = null
  await poll(runner, den)
  assert.deepEqual(runner.getSessionAccess(), { ...connected, mode: "all" }, "a Den that stops sending the policy allows nothing wide")

  den.policy = { ceiling: "all", optIn: true }
  await poll(runner, den)
  assert.deepEqual(runner.getSessionAccess(), { ...connected, mode: "all", ceiling: "all", effective: "all", optIn: true })
  assert.deepEqual(await runner.setSessionAccess("off"), { ...connected, mode: "off", ceiling: "all", effective: "off", optIn: true })
  assert.deepEqual(await runner.setSessionAccess("created"), { ...connected, mode: "created", ceiling: "all", effective: "created", optIn: true })

  den.policy = { ceiling: "off", optIn: true }
  await poll(runner, den)
  assert.deepEqual(runner.getSessionAccess(), { ...connected, mode: "created", ceiling: "off", effective: "off", optIn: true },
    "the organization's ceiling can turn it off")
})

test("a computer whose owner has not chosen takes nothing under the organization's opt-in, and tasks without it", async (t) => {
  const { den, runner } = await fixture(t)
  den.policy = { ceiling: "all", optIn: true }
  configure(runner)
  await eventually(() => runner.getSessionAccess().ceiling === "all")
  assert.deepEqual(runner.getSessionAccess(), { mode: null, ceiling: "all", effective: "off", supported: true, optIn: true, connected: true })
  den.policy = { ceiling: "all", optIn: false }
  await poll(runner, den)
  assert.deepEqual(runner.getSessionAccess(), { mode: null, ceiling: "all", effective: "created", supported: true, optIn: false, connected: true })
  den.policy = { ceiling: "all", optIn: true }
  await poll(runner, den)
  assert.equal((await runner.setSessionAccess("created")).effective, "created", "allowing tasks is a choice")
})

test("a choice made in one organization is not this computer's choice in another", async (t) => {
  const { root, den, runner } = await fixture(t)
  configure(runner)
  await eventually(() => runner.getSessionAccess().ceiling === "all")
  await runner.setSessionAccess("all")
  assert.equal(runner.getSessionAccess().effective, "all")

  configureOther(runner)
  await eventually(() => runner.getSessionAccess().ceiling === "all")
  assert.deepEqual(runner.getSessionAccess(), { mode: null, ceiling: "all", effective: "created", supported: true, optIn: false, connected: true })
  await runner.setSessionAccess("off")
  assert.deepEqual(await storedChoices(root), { version: 2, choices: { [accessKey]: "all", [otherKey]: "off" } })

  configure(runner, accessCapabilities, "back")
  await eventually(() => runner.getSessionAccess().ceiling === "all")
  assert.equal(runner.getSessionAccess().mode, "all", "and the first organization still has its own")
})

test("a choice of all sessions saved by an earlier version applies to the organization signed in first, and to no other", async (t) => {
  const { root, den, runner } = await fixture(t)
  await writeFile(accessFile(root), JSON.stringify({ version: 1, mode: "all" }), "utf8")
  configure(runner)
  await eventually(() => runner.getSessionAccess().effective === "all")
  assert.deepEqual(await storedChoices(root), { version: 2, choices: { [accessKey]: "all" } })
  await eventually(() => den.reports().at(-1)?.access === "all", "and it is reported once it applies")

  configureOther(runner)
  await eventually(() => runner.getSessionAccess().ceiling === "all")
  await settle()
  assert.equal(runner.getSessionAccess().mode, null)
  assert.equal(runner.getSessionAccess().effective, "created")
})

test("the old default saved by an earlier version leaves the organization's opt-in in charge", async (t) => {
  const { root, den, runner } = await fixture(t)
  await writeFile(accessFile(root), JSON.stringify({ version: 1, mode: "created" }), "utf8")
  den.policy = { ceiling: "all", optIn: true }
  configure(runner)
  await eventually(() => runner.getSessionAccess().ceiling === "all")
  await settle()
  assert.deepEqual(runner.getSessionAccess(), { mode: null, ceiling: "all", effective: "off", supported: true, optIn: true, connected: true })
  assert.deepEqual(await storedChoices(root), { version: 2, choices: {} })
})

test("a runner Den did not accept for session access never applies all sessions", async (t) => {
  const { root, den, runner } = await fixture(t)
  await storeChoice(root, "all")
  configure(runner, journalCapabilities)
  await eventually(() => den.workPolls() >= 1)
  await settle()
  assert.deepEqual(runner.getSessionAccess(), { mode: "all", ceiling: "all", effective: "created", supported: false, optIn: false, connected: true })
  assert.deepEqual(den.reports(), [], "and it reports no sessions")
  assert.equal((await runner.setSessionAccess("off")).effective, "off", "but it can always be turned off")
})

test("the organization's policy is forgotten when the runner is reconfigured, signed out or stopped", async (t) => {
  const { root, den, runner } = await fixture(t)
  await storeChoice(root, "all")
  den.policy = { ceiling: "all", optIn: true }
  configure(runner)
  await eventually(() => runner.getSessionAccess().effective === "all")
  assert.equal(runner.getSessionAccess().optIn, true)

  let release
  den.hold = new Promise((resolve) => { release = resolve })
  configure(runner, accessCapabilities, "second")
  const beforeDenAnswers = { mode: "all", ceiling: null, effective: "created", supported: true, optIn: false, connected: true }
  assert.deepEqual(runner.getSessionAccess(), beforeDenAnswers, "a new credential forgets the ceiling and the opt-in at once")
  await settle()
  assert.deepEqual(runner.getSessionAccess(), beforeDenAnswers, "and nothing wider applies until Den answers")
  den.hold = null
  release()
  await eventually(() => runner.getSessionAccess().effective === "all")
  assert.equal(runner.getSessionAccess().optIn, true)

  runner.configure(null)
  assert.deepEqual(runner.getSessionAccess(), notConnected)
  configure(runner, accessCapabilities, "third")
  await eventually(() => runner.getSessionAccess().effective === "all")
  runner.stop()
  assert.deepEqual(runner.getSessionAccess(), notConnected)
  await assert.rejects(runner.setSessionAccess("off"))
})

test("an attach is claimed like a create and handed to the journalled runner, which asks for the access in force", async (t) => {
  const { root, local, den, runner } = await fixture(t)
  assert.deepEqual(await selectRunnableWorkItem([{ kind: "remote_session_attach", commandId: "attach_fixture" }], async () => null),
    { kind: "remote_session_attach", commandId: "attach_fixture" })
  assert.equal(await selectRunnableWorkItem([{ kind: "remote_session_dismiss", commandId: "unknown_kind" }], async () => null), null)
  const journalPath = join(root, desktopSessionRunnerPartition(denBaseUrl, account), "journal.json")
  const journalled = async () => JSON.parse(await readFile(journalPath, "utf8")).commands.map((entry) => entry.command)
  const completion = (id) => den.completions().find((call) => call.path === `/v1/remote-session-commands/${id}/complete`)?.body

  // The owner allows only sessions started remotely: the journalled runner refuses.
  den.assignments.set("attach_denied", attachAssignment("attach_denied"))
  den.work = [{ kind: "remote_session_attach", commandId: "attach_denied" }]
  configure(runner)
  await eventually(() => completion("attach_denied"), "the refused attach is completed")
  assert.ok(den.calls.some((call) => call.path === "/v1/remote-session-commands/attach_denied/claim" && call.method === "POST"))
  assert.equal(completion("attach_denied").status, "failed")
  assert.equal(completion("attach_denied").error.code, "session_access_denied")
  assert.deepEqual((await journalled()).map((command) => [command.commandId, command.kind]), [["attach_denied", "remote_session_attach"]])

  // Once the owner allows all sessions the same runner is asked again and no longer refuses for access.
  await runner.setSessionAccess("all")
  den.assignments.set("attach_allowed", attachAssignment("attach_allowed"))
  den.work = [{ kind: "remote_session_attach", commandId: "attach_allowed" }]
  await poll(runner, den)
  await eventually(() => completion("attach_allowed"), "the allowed attach reaches the journalled runner")
  assert.notEqual(completion("attach_allowed").error?.code, "session_access_denied")
  assert.deepEqual((await journalled()).map((command) => command.commandId), ["attach_denied", "attach_allowed"])

  // Narrowing applies to the very next attach, without a restart or a poll in between.
  await runner.setSessionAccess("created")
  den.assignments.set("attach_narrowed", { ...attachAssignment("attach_narrowed"), sessionId: "session_other" })
  den.work = [{ kind: "remote_session_attach", commandId: "attach_narrowed" }]
  await poll(runner, den)
  await eventually(() => completion("attach_narrowed"), "the narrowed attach is completed")
  assert.equal(completion("attach_narrowed").error.code, "session_access_denied")
  assert.deepEqual(local.writes, [], "no session is created or changed for an attach")
})

test("without the durable journal an attach is refused and never run as a create", async (t) => {
  const { root, local, den, runner } = await fixture(t)
  await storeChoice(root, "all")
  const legacy = ["remote_session_v1", "remote_session_control_v1", "remote_session_access_v1"]
  den.assignments.set("attach_legacy", attachAssignment("attach_legacy"))
  // A work item that hides an attach behind a create is refused as well.
  den.assignments.set("attach_disguised", attachAssignment("attach_disguised"))
  den.work = [
    { kind: "remote_session_attach", commandId: "attach_legacy" },
    { kind: "remote_session_create", commandId: "attach_disguised" },
  ]
  configure(runner, legacy)
  await eventually(() => den.completions().length === 2, "both attaches are completed")
  for (const id of ["attach_legacy", "attach_disguised"]) {
    assert.ok(den.calls.some((call) => call.path === `/v1/remote-session-commands/${id}/claim`))
    const body = den.completions().find((call) => call.path === `/v1/remote-session-commands/${id}/complete`).body
    assert.equal(body.status, "failed")
    assert.equal(body.error.code, "attach_unsupported")
  }
  assert.deepEqual(local.writes, [], "the local runtime is never asked to create or open a session")
  assert.deepEqual((await readdir(root)).sort(), ["access.json", "attached.json"], "and no journal is created")
  assert.deepEqual(JSON.parse(await readFile(join(root, "attached.json"), "utf8")), { version: 1, commands: ["attach_legacy", "attach_disguised"] },
    "both are remembered as attaches")
})

test("with all sessions allowed the runner reports its root sessions, newest first, across workspaces and engines", async (t) => {
  const { root, local, den, runner } = await fixture(t)
  local.workspaces = ["workspace_a", "workspace_b"]
  local.v2.workspace_a = [
    { id: "ses_imported", title: "Imported", time: { created: 10, updated: 100 } },
    { info: { id: "ses_new", title: `  ${"t".repeat(300)}`, time: { created: 20, updated: 300.9 } } },
    { id: "ses_child", parentID: "ses_new", title: "Subagent", time: { updated: 400 } },
    { id: "ses_archived", title: "Archived", time: { updated: 500, archived: 5 } },
  ]
  local.v1.workspace_a = [
    { id: "ses_imported", title: "Imported before the move", time: { updated: 90 } },
    { id: "ses_old", title: "Old", time: { created: 50 } },
    { id: "ses_v1_archived", title: "Archived", time: { updated: 600, archived: 7 } },
  ]
  local.v2.workspace_b = [{ id: "ses_b", time: { updated: 200 } }]
  local.running.v2.workspace_a = { ses_new: { type: "running" } }
  local.running.v1.workspace_a = { ses_old: { type: "busy" }, ses_imported: { type: "idle" } }
  local.failing.add("/workspace/workspace_b/opencode2/api/session/active")
  local.failing.add("/workspace/workspace_b/opencode/session")
  await storeChoice(root, "all")
  configure(runner)
  await eventually(() => den.reports().length === 1, "the sessions are reported on connect")
  assert.deepEqual(den.reports()[0], {
    access: "all",
    chosen: true,
    sessions: [
      { workspaceId: "workspace_a", sessionId: "ses_new", title: "t".repeat(240), engine: "v2", updatedAt: 300, working: true },
      { workspaceId: "workspace_b", sessionId: "ses_b", title: "", engine: "v2", updatedAt: 200 },
      { workspaceId: "workspace_a", sessionId: "ses_imported", title: "Imported", engine: "v2", updatedAt: 100, working: false },
      { workspaceId: "workspace_a", sessionId: "ses_old", title: "Old", engine: "v1", updatedAt: 50, working: true },
    ],
  })
  assert.equal(den.calls.find((call) => call.path === "/v1/session-runners/sessions").method, "PUT")
})

test("a report holds the hundred most recently changed sessions, read page by page", async () => {
  const local = localFixture()
  local.pageSize = 60
  local.v2.workspace_a = Array.from({ length: 150 }, (_, index) => ({ id: `ses_${index}`, title: `Session ${index}`, time: { updated: index } }))
  const sessions = await collectRunnerSessions({ getLocalRuntime: local.getLocalRuntime, fetchImpl: local.fetchImpl })
  assert.equal(sessions.length, 100)
  assert.deepEqual(sessions.slice(0, 2).map((session) => session.sessionId), ["ses_149", "ses_148"])
  assert.equal(sessions.at(-1).sessionId, "ses_50")
  assert.equal(local.calls.filter((path) => path.startsWith("/workspace/workspace_a/opencode2/api/session?")).length, 3)

  local.routing = "v1-only"
  local.v1.workspace_a = [{ id: "ses_v1", title: "Only engine", time: { updated: 1 } }]
  local.calls.length = 0
  assert.deepEqual(await collectRunnerSessions({ getLocalRuntime: local.getLocalRuntime, fetchImpl: local.fetchImpl }),
    [{ workspaceId: "workspace_a", sessionId: "ses_v1", title: "Only engine", engine: "v1", updatedAt: 1, working: false }])
  assert.equal(local.calls.some((path) => path.includes("/opencode2/")), false, "a stopped engine is not asked")
  assert.equal(await collectRunnerSessions({ getLocalRuntime: async () => null, fetchImpl: local.fetchImpl }), null)
})

test("with only remote sessions allowed the runner sends one empty report and reads no sessions", async (t) => {
  const { local, den, runner } = await fixture(t, { sessionReportMinIntervalMs: 0 })
  local.v2.workspace_a = [{ id: "ses_local", time: { updated: 1 } }]
  configure(runner)
  await eventually(() => den.reports().length === 1, "the empty report is sent on connect")
  assert.deepEqual(den.reports(), [{ access: "created", chosen: false, sessions: [] }])
  await poll(runner, den)
  await poll(runner, den)
  assert.equal(den.reports().length, 1, "nothing more is sent until the access changes")
  assert.deepEqual(local.calls, [], "the computer's sessions are not even read")
})

test("with nothing allowed the runner says so once and reads no sessions", async (t) => {
  const { root, local, den, runner } = await fixture(t, { sessionReportMinIntervalMs: 0 })
  local.v2.workspace_a = [{ id: "ses_local", time: { updated: 1 } }]
  await storeChoice(root, "off")
  den.policy = { ceiling: "all", optIn: false }
  configure(runner)
  await eventually(() => den.reports().length === 1, "off is reported on connect")
  assert.deepEqual(den.reports(), [{ access: "off", chosen: true, sessions: [] }])
  await poll(runner, den)
  await poll(runner, den)
  assert.equal(den.reports().length, 1, "nothing more is sent until the access changes")
  assert.deepEqual(local.calls, [], "the computer's sessions are not even read")
  assert.ok(den.workPolls() >= 3, "and the runner keeps asking for work: it needs the policy, and Automations use the same channel")
})

test("a computer nobody has allowed yet reports off under the opt-in, and each choice after that at once", async (t) => {
  const { local, den, runner } = await fixture(t)
  local.v2.workspace_a = [{ id: "ses_local", title: "Local", time: { updated: 1 } }]
  den.policy = { ceiling: "all", optIn: true }
  configure(runner)
  await eventually(() => den.reports().length === 1)
  assert.deepEqual(den.reports()[0], { access: "off", chosen: false, sessions: [] })
  const polls = den.workPolls()

  await runner.setSessionAccess("created")
  await eventually(() => den.reports().length === 2, "allowing tasks is reported without waiting for a poll")
  assert.deepEqual(den.reports()[1], { access: "created", chosen: true, sessions: [] })
  await runner.setSessionAccess("all")
  await eventually(() => den.reports().length === 3)
  assert.equal(den.reports()[2].access, "all")
  assert.deepEqual(den.reports()[2].sessions.map((session) => session.sessionId), ["ses_local"])
  await runner.setSessionAccess("off")
  await eventually(() => den.reports().length === 4, "turning the computer off is reported without waiting for a poll")
  assert.deepEqual(den.reports()[3], { access: "off", chosen: true, sessions: [] })
  assert.equal(den.workPolls(), polls, "no report waited for a work poll")
})

test("a report answered with the ceiling alone never lifts the opt-in", async (t) => {
  const { den, runner } = await fixture(t)
  den.policy = { ceiling: "all", optIn: true }
  den.reportOmitsOptIn = true
  configure(runner)
  await eventually(() => den.reports().length === 1)
  await settle()
  assert.deepEqual(runner.getSessionAccess(), { mode: null, ceiling: "all", effective: "off", supported: true, optIn: true, connected: true })
  assert.deepEqual(den.reports(), [{ access: "off", chosen: false, sessions: [] }])
})

test("choosing what already applies is reported at once: Den hears that the owner chose", async (t) => {
  const { den, runner } = await fixture(t)
  den.policy = { ceiling: "all", optIn: false }
  configure(runner)
  await eventually(() => den.reports().length === 1)
  assert.deepEqual(den.reports()[0], { access: "created", chosen: false, sessions: [] })
  const polls = den.workPolls()
  await runner.setSessionAccess("created")
  await eventually(() => den.reports().length === 2, "the choice is reported without waiting for a poll")
  assert.deepEqual(den.reports()[1], { access: "created", chosen: true, sessions: [] })
  assert.equal(den.workPolls(), polls)
})

test("a runner accepted only for the owner's choice reports and enforces off and created, never all", async (t) => {
  const { local, den, runner } = await fixture(t)
  local.v2.workspace_a = [{ id: "ses_local", title: "Local", time: { updated: 1 } }]
  den.policy = { ceiling: "all", optIn: true }
  configure(runner, choiceOnlyCapabilities)
  await eventually(() => den.reports().length === 1, "it reports though it was not accepted for sessions started here")
  assert.deepEqual(den.reports()[0], { access: "off", chosen: false, sessions: [] })
  assert.deepEqual(runner.getSessionAccess(), { mode: null, ceiling: "all", effective: "off", supported: false, optIn: true, connected: true })

  assert.equal((await runner.setSessionAccess("created")).effective, "created")
  await eventually(() => den.reports().length === 2)
  assert.deepEqual(den.reports()[1], { access: "created", chosen: true, sessions: [] })

  assert.deepEqual(await runner.setSessionAccess("all"), { mode: "all", ceiling: "all", effective: "created", supported: false, optIn: true, connected: true })
  await settle()
  assert.equal(den.reports().length, 2, "all sessions never apply, so nothing new is reported")
  assert.deepEqual(local.calls, [], "and the computer's sessions are never read")

  // An attach reaches the journalled runner, which is told only tasks started remotely are allowed.
  den.assignments.set("attach_choice_only", attachAssignment("attach_choice_only"))
  den.work = [{ kind: "remote_session_attach", commandId: "attach_choice_only" }]
  await poll(runner, den)
  const completion = () => den.completions().find((call) => call.path === "/v1/remote-session-commands/attach_choice_only/complete")?.body
  await eventually(completion, "the attach is completed")
  assert.equal(completion().error.code, "session_access_denied")

  assert.equal((await runner.setSessionAccess("off")).effective, "off")
  await eventually(() => den.reports().length === 3)
  assert.deepEqual(den.reports()[2], { access: "off", chosen: true, sessions: [] })
  den.assignments.set("attach_off", attachAssignment("attach_off"))
  den.work = [{ kind: "remote_session_attach", commandId: "attach_off" }]
  await poll(runner, den)
  const refused = () => den.completions().find((call) => call.path === "/v1/remote-session-commands/attach_off/complete")?.body
  await eventually(refused, "the attach is completed")
  assert.equal(refused().error.code, "remote_access_off")
  assert.deepEqual(local.writes, [])
})

test("a runner accepted for session access by a Den from before the owner's choice still says whether the owner chose", async (t) => {
  const { root, local, den, runner } = await fixture(t)
  local.v2.workspace_a = [{ id: "ses_local", title: "Local", time: { updated: 1 } }]
  configure(runner, accessOnlyCapabilities)
  await eventually(() => den.reports().length === 1)
  assert.deepEqual(den.reports()[0], { access: "created", chosen: false, sessions: [] })
  await runner.setSessionAccess("all")
  await eventually(() => den.reports().length === 2)
  assert.equal(den.reports()[1].access, "all")
  assert.equal(den.reports()[1].chosen, true)
  assert.deepEqual(den.reports()[1].sessions.map((session) => session.sessionId), ["ses_local"])
  assert.equal(runner.getSessionAccess().supported, true)
  assert.deepEqual(await storedChoices(root), { version: 2, choices: { [accessKey]: "all" } })
})

test("an organization that turns it off is reported as off, whatever the owner chose", async (t) => {
  const { root, den, runner } = await fixture(t)
  await storeChoice(root, "all")
  configure(runner)
  await eventually(() => den.reports().length === 1)
  assert.equal(den.reports()[0].access, "all")
  den.policy = { ceiling: "off", optIn: false }
  await poll(runner, den)
  await eventually(() => den.reports().length === 2)
  assert.deepEqual(den.reports()[1], { access: "off", chosen: true, sessions: [] })
  assert.equal(runner.getSessionAccess().mode, "all", "the owner's choice is kept for when the organization allows it again")
})

test("a Den from before off existed is told created, and this computer still takes nothing", async (t) => {
  const { root, den, runner } = await fixture(t)
  await storeChoice(root, "off")
  // No `optIn` in the policy: this Den's report route knows only created and all.
  den.policy = { ceiling: "all" }
  configure(runner)
  await eventually(() => den.reports().length === 1)
  assert.deepEqual(den.reports(), [{ access: "created", chosen: true, sessions: [] }])
  assert.equal(runner.getSessionAccess().effective, "off")
  await runner.setSessionAccess("created")
  await settle()
  assert.equal(runner.getSessionAccess().effective, "created")
  assert.equal(den.reports().length, 1, "the same report is not sent twice")
})

test("an unchanged session list is not sent again, and is read at most about once a minute", async (t) => {
  let clock = 1_000_000
  const { root, local, den, runner } = await fixture(t, { now: () => clock })
  local.v2.workspace_a = [{ id: "ses_local", title: "Local", time: { updated: 1 } }]
  await storeChoice(root, "all")
  configure(runner)
  await eventually(() => den.reports().length === 1)
  const reads = () => local.calls.filter((path) => path === "/workspaces").length
  assert.equal(reads(), 1)

  local.v2.workspace_a = [{ id: "ses_local", title: "Renamed", time: { updated: 2 } }]
  clock += 30_000
  await poll(runner, den)
  assert.equal(reads(), 1, "sessions are not read again within the minute")
  assert.equal(den.reports().length, 1)

  clock += 30_000
  await poll(runner, den)
  assert.equal(reads(), 2)
  assert.equal(den.reports().length, 2, "a changed list is sent")
  assert.equal(den.reports()[1].sessions[0].title, "Renamed")

  clock += 60_000
  await poll(runner, den)
  assert.equal(reads(), 3)
  assert.equal(den.reports().length, 2, "an unchanged list is read but not sent again")
})

test("the owner's choice is reported at once, in both directions", async (t) => {
  const { local, den, runner } = await fixture(t)
  local.v2.workspace_a = [{ id: "ses_local", title: "Local", time: { updated: 1 } }]
  configure(runner)
  await eventually(() => den.reports().length === 1)
  const polls = den.workPolls()

  await runner.setSessionAccess("all")
  await eventually(() => den.reports().length === 2, "widening is reported without waiting for a poll")
  assert.equal(den.reports()[1].access, "all")
  assert.deepEqual(den.reports()[1].sessions.map((session) => session.sessionId), ["ses_local"])

  await runner.setSessionAccess("created")
  await eventually(() => den.reports().length === 3, "narrowing is reported without waiting for a poll")
  assert.deepEqual(den.reports()[2], { access: "created", chosen: true, sessions: [] })
  assert.equal(den.workPolls(), polls, "neither report waited for a work poll")
})

test("sessions being read when the owner narrows the choice are never sent", async (t) => {
  const { local, den, runner } = await fixture(t)
  local.v2.workspace_a = [{ id: "ses_local", title: "Local", time: { updated: 1 } }]
  configure(runner)
  await eventually(() => den.reports().length === 1)
  let release
  local.hold = new Promise((resolve) => { release = resolve })
  await runner.setSessionAccess("all")
  await eventually(() => local.calls.includes("/workspaces"), "the sessions are being read")
  await runner.setSessionAccess("created")
  local.hold = null
  release()
  await settle()
  assert.deepEqual(den.reports(), [{ access: "created", chosen: false, sessions: [] }, { access: "created", chosen: true, sessions: [] }],
    "Den hears that the owner chose, never of sessions the owner no longer allows")
})

test("a ceiling the organization lowers stops the session reports at once", async (t) => {
  const { root, local, den, runner } = await fixture(t)
  local.v2.workspace_a = [{ id: "ses_local", title: "Local", time: { updated: 1 } }]
  await storeChoice(root, "all")
  configure(runner)
  await eventually(() => den.reports().length === 1)
  assert.equal(den.reports()[0].access, "all")

  den.policy = { ceiling: "created" }
  await poll(runner, den)
  await eventually(() => den.reports().length === 2, "the lowered ceiling is reported within the same poll")
  assert.deepEqual(den.reports()[1], { access: "created", chosen: true, sessions: [] })

  // The report's own answer carries the ceiling too, so a lowered one applies without a work poll.
  den.policy = { ceiling: "all" }
  await poll(runner, den)
  await eventually(() => den.reports().length === 3)
  assert.equal(den.reports()[2].access, "all")
  den.reportCeiling = "created"
  await runner.setSessionAccess("created")
  await eventually(() => den.reports().length === 4)
  await runner.setSessionAccess("all")
  await settle()
  assert.equal(runner.getSessionAccess().ceiling, "created", "the report's answer lowered the ceiling")
  assert.equal(den.reports().length, 4, "so the owner's wider choice changes nothing")
})

test("an older Den without session reporting is not retried for ten minutes after a 404", async (t) => {
  let clock = 1_000_000
  const { root, local, den, runner } = await fixture(t, { now: () => clock, sessionReportMinIntervalMs: 0 })
  local.v2.workspace_a = [{ id: "ses_local", time: { updated: 1 } }]
  await storeChoice(root, "all")
  den.policy = null
  configure(runner)
  await eventually(() => den.workPolls() >= 1)
  await settle()
  assert.deepEqual(den.reports(), [], "a work response without the policy means the feature is off")

  den.policy = { ceiling: "all" }
  den.reportStatus = 404
  await poll(runner, den)
  assert.equal(den.reports().length, 1)
  await poll(runner, den)
  await runner.setSessionAccess("created")
  await settle()
  assert.equal(den.reports().length, 1, "a 404 stops the reports")

  den.reportStatus = 200
  clock += 9 * 60_000
  await poll(runner, den)
  assert.equal(den.reports().length, 1)
  clock += 60_000
  await poll(runner, den)
  assert.equal(den.reports().length, 2, "and they resume ten minutes later")
  assert.deepEqual(den.reports()[1], { access: "created", chosen: true, sessions: [] })
})

test("a failing session report never stops the runner from finding work", async (t) => {
  const { root, local, den, runner } = await fixture(t, { sessionReportMinIntervalMs: 0 })
  local.failing.add("/workspaces")
  await storeChoice(root, "all")
  configure(runner)
  await eventually(() => den.workPolls() >= 1)
  await poll(runner, den)
  assert.deepEqual(den.reports(), [], "sessions that cannot be read are not reported")
  den.reportStatus = 500
  local.failing.clear()
  await poll(runner, den)
  assert.equal(den.reports().length, 1)
  den.reportStatus = 200
  await poll(runner, den)
  assert.equal(den.reports().length, 2, "a failed report is sent again")
  assert.ok(den.workPolls() >= 4)
})
