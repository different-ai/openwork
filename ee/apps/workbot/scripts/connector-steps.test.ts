import assert from "node:assert/strict"
import { test } from "node:test"
import type { RunnerMessage, RunnerSnapshot } from "@openwork-ee/headless-protocol"
import { buildWorkbotTurns, connectorStep, type WorkbotConnectors } from "@openwork-ee/workbot-server"
import { workbotActivity } from "../../../packages/workbot-ui/src/activity.js"
import { connectorSummary } from "../../../packages/workbot-ui/src/connector-activity.js"
import type { WorkbotTurn } from "../../../packages/workbot-ui/src/data.js"
import { createConnectorCache } from "../src/server/routes.js"

/** Nothing internal ever reaches the page: no connection, capability or tool ids. */
const RAW = /mcp:|emc_|execute_capability|search_capabilities|web_search_exa|remote-session:/

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

test("work on the person's other computers reads as a remote task; Workbot's own tools stay out of sight", () => {
  assert.deepEqual(connectorStep("execute_capability", { name: "remote-session:create", body: { target: "desktop" } }), { app: "Remote computer", label: "Starting a remote task", detail: "Starting a remote task", remote: true })
  assert.equal(connectorStep("execute_capability", { name: "remote-session:status" })?.label, "Checking the remote task")
  assert.equal(connectorStep("execute_capability", { name: "getMe" }), null)
  assert.equal(connectorStep("search_capabilities", { query: "exa" }), null)
  assert.equal(connectorStep("memory_search", {}), null)
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
  assert.equal(summary?.label, "Used Gmail, Linear and a remote computer")
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
