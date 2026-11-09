import assert from "node:assert/strict"
import { test } from "node:test"
import type { RunnerMessage, RunnerSnapshot } from "@openwork-ee/headless-protocol"
import { buildWorkbotTurns, connectorStep, type WorkbotConnectors } from "@openwork-ee/workbot-server"
import { workbotActivity } from "../../../packages/workbot-ui/src/activity.js"
import { connectorSummary } from "../../../packages/workbot-ui/src/connector-activity.js"
import type { WorkbotTurn } from "../../../packages/workbot-ui/src/data.js"
import { createConnectorCache } from "../src/server/routes.js"
import { OPENWORK_CONNECTORS, openworkAt, openworkSnapshot } from "../test-fixtures/chat-screen-scenarios.js"

/** Nothing internal ever reaches the page: no connection, capability or tool ids. */
const RAW = /mcp:|emc_|plg_|cfg_|execute_capability|search_capabilities|web_search_exa|remote-session:|native:|admin:|start_task|get_skill|createCloudAutomation/

const EXA = "mcp:emc_01kexa7q2m:web_search_exa"

/** Ben's request of Nov 8, 7:33, as the runner stores it: Workbot says what it will do, then searches Exa twice. */
function exaSnapshot(stage: "first" | "second" | "reading" | "answered"): RunnerSnapshot {
  const messages: RunnerMessage[] = [
    { messageId: "wb_x1", role: "user", text: "could you use exa to search about best ux practices and skills" },
    { messageId: "wb_x1", role: "assistant", text: "I'll search Exa for best UX practices and skills, then I'll come back with the useful bits.", createdAt: 110, toolCalls: [{ id: "s1", name: "search_capabilities", input: { query: "exa web search" } }, { id: "e1", name: "execute_capability", input: { name: EXA, body: { query: "best UX practices" } } }] },
    { messageId: "wb_x1", role: "tool", callId: "s1", name: "search_capabilities", isError: false, createdAt: 112 },
  ]
  if (stage !== "first") {
    messages.push({ messageId: "wb_x1", role: "tool", callId: "e1", name: "execute_capability", isError: false, createdAt: 120 })
    messages.push({ messageId: "wb_x1", role: "assistant", text: "", createdAt: 130, toolCalls: [{ id: "e2", name: "execute_capability", input: { name: EXA, body: { query: "UX skills" } } }] })
  }
  if (stage === "reading" || stage === "answered") messages.push({ messageId: "wb_x1", role: "tool", callId: "e2", name: "execute_capability", isError: false, createdAt: 140 })
  if (stage === "answered") messages.push({ messageId: "wb_x1", role: "assistant", text: "Here's what stands out: keep feedback immediate.", createdAt: 150, toolCalls: [] })
  const done = stage === "answered"
  return { status: done ? "idle" : "busy", finalAssistantText: "", hasEarlier: false, turns: [{ messageId: "wb_x1", status: done ? "completed" : "running", createdAt: 100, updatedAt: done ? 160 : 140, error: null }], messages }
}

const turnsOf = (snapshot: RunnerSnapshot, connectors?: WorkbotConnectors) => buildWorkbotTurns(snapshot, new Map(), connectors) as WorkbotTurn[]

test("a connection's own tool is named for its app, with what it did and its site, never its ids", () => {
  assert.deepEqual(connectorStep("execute_capability", { name: EXA }), { app: "Exa", label: "Searching Exa", detail: "Web search", site: "exa.ai" })
  // Den's name for the connection wins over a guess from the tool, and its site over the guessed one.
  const den: WorkbotConnectors = new Map([["emc_01kexa7q2m", { name: "Exa Search", site: "exa.ai" }], ["emc_lin", { name: "Linear", site: "linear.app" }]])
  assert.deepEqual(connectorStep("execute_capability", { name: EXA }, den), { app: "Exa Search", label: "Searching Exa Search", detail: "Web search", site: "exa.ai" })
  assert.deepEqual(connectorStep("execute_capability", { name: "mcp:emc_lin:list_issues" }, den), { app: "Linear", label: "Checking Linear", detail: "List issues", site: "linear.app" })
  // A connection nobody named and whose tools say nothing: a connected app, never "mcp:emc_…".
  const unknown = connectorStep("execute_capability", { name: "mcp:emc_zz9:run_query" })
  assert.deepEqual(unknown, { app: null, label: "Using a connected app", detail: "Run query" })
  assert.equal(connectorStep("execute_capability", { name: "mcp:emc_ps:planetscale_list_databases" })?.label, "Checking PlanetScale")
  // Built-in apps keep their names.
  assert.equal(connectorStep("execute_capability", { name: "gmail:searchMessages" })?.label, "Searching Gmail")
})

test("OpenWork's own features read as OpenWork, in plain words; finding tools and notes stay out of sight", () => {
  const own = (name: string, input: Record<string, unknown> = {}) => connectorStep(name, input)
  // A remote task on another of the person's computers is OpenWork's feature: its logo, still said as a remote task.
  assert.deepEqual(own("execute_capability", { name: "remote-session:create", body: { target: "desktop" } }), { app: "OpenWork", site: "openworklabs.com", openwork: true, label: "Starting a remote task", detail: "Remote task", remote: true })
  assert.equal(own("execute_capability", { name: "remote-session:status" })?.label, "Checking the remote task")
  assert.deepEqual(own("start_task", { title: "Q3 board deck", brief: "…" }), { app: "OpenWork", site: "openworklabs.com", openwork: true, label: "Starting a background task", detail: "Q3 board deck" })
  assert.equal(own("get_skill", { name: "plan-my-day-k8xecmqp" })?.detail, "Plan my day", "a skill by its name, without its id suffix")
  assert.equal(own("execute_capability", { name: "skill:create-skill" })?.detail, "Create skill")
  assert.deepEqual(own("execute_capability", { name: "plugin:plg_01k9:cfg_01k9" }), { app: "OpenWork", site: "openworklabs.com", openwork: true, label: "Using OpenWork", detail: "Workflow or skill" })
  assert.equal(own("execute_capability", { name: "createCloudAutomation" })?.label, "Setting up an automation")
  assert.equal(own("execute_capability", { name: "listAutomations" })?.label, "Checking automations")
  assert.equal(own("execute_capability", { name: "putMeAgent" })?.detail, "Your agent")
  assert.equal(own("execute_capability", { name: "admin:den_sandbox_create" })?.label, "Using OpenWork admin tools")
  assert.equal(own("create_app")?.label, "Building an app")
  assert.equal(own("execute_capability", { name: "getMe" })?.app, "OpenWork")
  for (const name of ["start_task", "get_skill", "list_skills", "create_app", "update_app", "read_app", "request_check"]) assert.equal(own(name)?.openwork, true, name)
  // Den's built-in Google tools are Google, not OpenWork.
  assert.equal(own("execute_capability", { name: "native:google-workspace:searchGoogleDriveFiles" })?.app, "Google Drive")
  assert.equal(own("execute_capability", { name: "native:google-workspace:findGoogleChatDirectMessage" })?.app, "Google Chat")
  assert.equal(own("execute_capability", { name: "native:google-workspace:getGoogleDocumentOutline" })?.app, "Google Drive")
  assert.equal(own("execute_capability", { name: "postCapabilitiesMicrosoft365CalendarEvents" })?.app, "Outlook Calendar")
  // Plumbing stays out of sight.
  assert.equal(own("search_capabilities", { query: "exa" }), null)
  assert.equal(own("memory_search"), null)
  assert.equal(own("write_file", { path: "notes.md" }), null)
  assert.equal(own("execute_capability", { name: "something:else" }), null)
  for (const step of [own("get_skill", { name: "emc_01kexa7q2m" }), own("execute_capability", { name: "plugin:plg_01k9:cfg_01k9" })]) assert.doesNotMatch(JSON.stringify(step), /emc_|plg_|cfg_/)
})

/** An answer that used connectors and several OpenWork features, as the runner stores it. */
function mixedSnapshot(live: boolean): RunnerSnapshot {
  const calls: Array<[string, string, Record<string, unknown>]> = [
    ["a", "execute_capability", { name: EXA }],
    ["b", "execute_capability", { name: "remote-session:create" }],
    ["c", "execute_capability", { name: "native:google-workspace:searchGoogleDriveFiles" }],
    ["d", "get_skill", { name: "weekly-digest" }],
    ["e", "execute_capability", { name: "mcp:emc_lin:list_issues" }],
    ["f", "execute_capability", { name: "createCloudAutomation" }],
    ["g", "start_task", { title: "Draft the digest", brief: "…" }],
  ]
  const messages: RunnerMessage[] = [{ messageId: "wb_ow", role: "user", text: "Make my weekly digest" }]
  calls.forEach(([id, name, input], index) => {
    messages.push({ messageId: "wb_ow", role: "assistant", text: "", createdAt: 110 + index * 10, toolCalls: [{ id, name, input }] })
    if (!(live && id === "g")) messages.push({ messageId: "wb_ow", role: "tool", callId: id, name, isError: false, createdAt: 115 + index * 10 })
  })
  if (!live) messages.push({ messageId: "wb_ow", role: "assistant", text: "Done.", createdAt: 200, toolCalls: [] })
  return { status: live ? "busy" : "idle", finalAssistantText: "", hasEarlier: false, turns: [{ messageId: "wb_ow", status: live ? "running" : "completed", createdAt: 100, updatedAt: 210, error: null }], messages }
}

test("one OpenWork logo per answer however many OpenWork features ran, in first-use order, and the same after a reload", () => {
  const den: WorkbotConnectors = new Map([["emc_lin", { name: "Linear", site: "linear.app" }]])
  const [answered] = turnsOf(mixedSnapshot(false), den)
  assert.ok(answered)
  assert.doesNotMatch(JSON.stringify(answered), RAW)
  const summary = connectorSummary(answered, null)
  assert.deepEqual(summary?.apps.map((app) => app.name), ["Exa", "OpenWork", "Google Drive", "Linear"])
  assert.equal(summary?.apps.filter((app) => app.openwork).length, 1)
  assert.equal(summary?.label, "Used Exa, OpenWork, Google Drive and Linear")
  assert.deepEqual(summary?.rows.filter((row) => row.app.openwork).map((row) => row.detail), ["Remote task", "Weekly digest", "Automations", "Draft the digest"])
  // The page rebuilds the answer from the runner's stored transcript on every read: a reload shows the same logos.
  const [reloaded] = turnsOf(mixedSnapshot(false), den)
  assert.deepEqual(reloaded && connectorSummary(reloaded, null), summary)

  // While an OpenWork feature runs, its logo is the one that pulses, and the header shows it too.
  const [live] = turnsOf(mixedSnapshot(true), den)
  assert.ok(live)
  const running = connectorSummary(live, null)
  assert.equal(running?.live, true)
  assert.equal(running?.active?.openwork, true)
  const activity = workbotActivity([live], {}, 200)
  assert.equal(activity.label, "Starting a background task")
  assert.equal(activity.openwork, true)
})

test("the browser fixture's OpenWork answer is exactly what workbot-server builds from the runner's transcript", () => {
  for (const live of [false, true]) {
    const sent = 1_000_000
    const built = turnsOf(openworkSnapshot(live, sent), OPENWORK_CONNECTORS).at(-1)
    const fixture = openworkAt(live, sent).turns.at(-1)
    assert.ok(built && fixture)
    assert.deepEqual(fixture.parts, built.parts, live ? "live" : "done")
    assert.equal(fixture.status, built.status)
    assert.doesNotMatch(JSON.stringify(built), RAW)
  }
})

test("while Workbot searches Exa, one live line under its answer says so, and the header says the same", () => {
  const [first] = turnsOf(exaSnapshot("first"))
  assert.ok(first)
  assert.doesNotMatch(JSON.stringify(first), RAW)
  const live = connectorSummary(first, null)
  assert.deepEqual(live && { live: live.live, label: live.label, count: live.count }, { live: true, label: "Searching Exa", count: null })
  assert.equal(live?.latest.site, "exa.ai")
  assert.equal(workbotActivity([first], {}, 200).label, "Searching Exa")

  // A second search collapses into the same line, counted.
  const [second] = turnsOf(exaSnapshot("second"))
  const again = second && connectorSummary(second, null)
  assert.deepEqual(again && { live: again.live, label: again.label, count: again.count }, { live: true, label: "Searching Exa", count: "2 searches" })

  // Both done, still reading what it found: the line and the header keep saying it, rather than going quiet.
  const [reading] = turnsOf(exaSnapshot("reading"))
  assert.ok(reading)
  assert.equal(connectorSummary(reading, null)?.live, true)
  assert.equal(connectorSummary(reading, null)?.active, null, "logos stop pulsing as soon as the calls return")
  assert.equal(workbotActivity([reading], {}, 200).label, "Searching Exa")
  // Once its words start streaming, the line becomes the footnote and the header says it is writing.
  const streaming = { step: reading.modelSteps, text: "Here's what" }
  assert.equal(connectorSummary(reading, streaming)?.live, false)
  assert.equal(workbotActivity([reading], { [reading.id]: streaming }, 200).label, "Writing")
})

test("once answered it is a footnote that lists what ran, and a reload reads the same", () => {
  const [answered] = turnsOf(exaSnapshot("answered"))
  assert.ok(answered)
  const footnote = connectorSummary(answered, null)
  assert.deepEqual(footnote && { live: footnote.live, label: footnote.label, count: footnote.count }, { live: false, label: "Used Exa", count: "2 searches" })
  assert.deepEqual(footnote?.rows.map((row) => [row.label, row.detail, row.times]), [["Searching Exa", "Web search", 2]])
  // The page reads the conversation from the runner each time: a reload builds the very same footnote.
  const [reloaded] = turnsOf(exaSnapshot("answered"))
  assert.deepEqual(reloaded && connectorSummary(reloaded, null), footnote)
  assert.equal(workbotActivity([answered], {}, 200).working, false)
})

test("work in several apps sums up as actions, naming each app once", () => {
  const snapshot: RunnerSnapshot = {
    status: "idle", finalAssistantText: "", hasEarlier: false,
    turns: [{ messageId: "wb_m", status: "completed", createdAt: 100, updatedAt: 200, error: null }],
    messages: [
      { messageId: "wb_m", role: "user", text: "Catch me up" },
      { messageId: "wb_m", role: "assistant", text: "", createdAt: 110, toolCalls: [{ id: "a", name: "execute_capability", input: { name: "gmail:searchMessages" } }, { id: "b", name: "execute_capability", input: { name: "mcp:emc_lin:list_issues" } }, { id: "c", name: "execute_capability", input: { name: "remote-session:status" } }] },
      { messageId: "wb_m", role: "tool", callId: "a", name: "execute_capability", isError: false, createdAt: 120 },
      { messageId: "wb_m", role: "tool", callId: "b", name: "execute_capability", isError: false, createdAt: 120 },
      { messageId: "wb_m", role: "tool", callId: "c", name: "execute_capability", isError: false, createdAt: 120 },
      { messageId: "wb_m", role: "assistant", text: "Here is your catch-up.", createdAt: 130, toolCalls: [] },
    ],
  }
  const [turn] = turnsOf(snapshot, new Map([["emc_lin", { name: "Linear", site: "linear.app" }]]))
  assert.ok(turn)
  const summary = connectorSummary(turn, null)
  assert.equal(summary?.label, "Used Gmail, Linear and OpenWork")
  assert.equal(summary?.count, "3 actions")
  assert.doesNotMatch(JSON.stringify(turn), RAW)
})

test("connected app names are read from Den once per person, kept a while, and a failure is retried soon", async () => {
  let reads = 0
  let fail = false
  let clock = 0
  const cache = createConnectorCache(async (token) => {
    reads += 1
    if (fail) throw new Error("den down")
    return [{ id: `emc_${token}`, name: "Exa", site: "exa.ai" }]
  }, () => clock)
  assert.deepEqual([...(await cache("org:a", "a")).entries()], [["emc_a", { name: "Exa", site: "exa.ai" }]])
  await cache("org:a", "a")
  assert.equal(reads, 1, "one read per person within the TTL")
  assert.deepEqual([...(await cache("org:b", "b")).keys()], ["emc_b"], "never another person's apps")
  assert.equal(reads, 2)
  clock += 5 * 60_000
  fail = true
  assert.equal((await cache("org:a", "a")).size, 0, "a failing Den leaves the names out, never the chat")
  clock += 31_000
  fail = false
  assert.equal((await cache("org:a", "a")).size, 1, "retried soon after a failure")
})
