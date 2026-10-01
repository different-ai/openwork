import "./headless-test-env.js"
import { describe, expect, test } from "bun:test"
import { createHeadlessRunnerClient, type RunnerSnapshot } from "../src/headless-runner/client.js"
import { buildWorkbotTurns, createdAutomationId } from "../src/workbot/thread.js"
import {
  readWorkbotThread,
  sendWorkbotMessage,
  stopWorkbot,
  workbotEnabled,
  workbotInstructions,
  workbotName,
  workbotSessionId,
  type WorkbotActor,
  type WorkbotDeps,
} from "../src/workbot/service.js"

const actor: WorkbotActor = {
  organizationId: "org_1",
  organizationName: "Acme Robotics",
  organizationMetadata: { capabilities: { workbot: true } },
  memberId: "member_1",
  userId: "usr_1",
  firstName: "Maya",
}

const automationResult = JSON.stringify({ automation: { id: "atm_1", name: "What you missed in #launch" }, revision: { id: "rev_1" } })

const snapshot: RunnerSnapshot = {
  turns: [
    { messageId: "wb_first", status: "completed", error: null, createdAt: 1_000, updatedAt: 9_000 },
    { messageId: "slack_other", status: "completed", error: null },
    { messageId: "wb_second", status: "running", error: null, createdAt: 10_000, updatedAt: 11_000 },
    { messageId: "wb_queued", status: "queued", error: null, createdAt: 12_000 },
    { messageId: "wb_failed", status: "failed", error: "model_http_529", createdAt: 13_000, updatedAt: 14_000 },
  ],
  finalAssistantText: "",
  messages: [
    { messageId: "wb_first", role: "user", text: "Every Monday at 8, tell me what I missed in #launch" },
    { messageId: "wb_first", role: "assistant", text: "Setting that up.", toolCalls: [
      { id: "c1", name: "search_capabilities", input: { query: "create automation" } },
    ] },
    { messageId: "wb_first", role: "tool", callId: "c1", name: "search_capabilities", output: "[]", isError: false },
    { messageId: "wb_first", role: "assistant", text: "", toolCalls: [
      { id: "c2", name: "execute_capability", input: { name: "den:createCloudAutomation" } },
      { id: "c3", name: "write_file", input: { path: "drafts/launch.md" } },
    ] },
    { messageId: "wb_first", role: "tool", callId: "c2", name: "execute_capability", output: JSON.stringify({ result: automationResult }), isError: false },
    { messageId: "wb_first", role: "tool", callId: "c3", name: "write_file", output: "ok", isError: false },
    { messageId: "wb_first", role: "assistant", text: "Done. It runs in the cloud, so your laptop can stay closed.", toolCalls: [] },
    { messageId: "wb_second", role: "user", text: "Take Oct 15–16 off for me in Gusto" },
    { messageId: "wb_second", role: "assistant", text: "", toolCalls: [{ id: "c4", name: "browser_open", input: { url: "https://app.gusto.com/login" } }] },
    { messageId: "slack_other", role: "user", text: "not Workbot" },
    { messageId: "wb_failed", role: "user", text: "Summarize my inbox" },
  ],
}

describe("the Workbot thread", () => {
  const turns = buildWorkbotTurns(snapshot)

  test("shows only this person's Workbot turns, in order, once they have started", () => {
    expect(turns.map((turn) => turn.id)).toEqual(["first", "second", "failed"])
  })

  test("a finished turn has its answer, steps, drafts and the schedule it created", () => {
    expect(turns[0]).toMatchObject({
      text: "Every Monday at 8, tell me what I missed in #launch",
      status: "done",
      reply: "Done. It runs in the cloud, so your laptop can stay closed.",
      activity: null,
      files: ["drafts/launch.md"],
      automationIds: ["atm_1"],
      sentAt: 1_000,
      finishedAt: 9_000,
    })
    expect(turns[0].steps).toEqual([
      { label: "Finding the right tool", status: "done" },
      { label: "Setting up the schedule", status: "done" },
      { label: "Writing Launch", status: "done" },
    ])
  })

  test("a working turn says what it is doing and has no answer yet", () => {
    expect(turns[1]).toMatchObject({ status: "working", reply: "", activity: "Opening app.gusto.com", browser: { used: true, handedOff: false, site: "app.gusto.com" } })
  })

  test("a hand-off to sign in is the last browser step, with the site it opened", () => {
    const handoff = buildWorkbotTurns({
      finalAssistantText: "",
      turns: [{ messageId: "wb_gusto", status: "completed", error: null, createdAt: 1, updatedAt: 2 }],
      messages: [
        { messageId: "wb_gusto", role: "user", text: "Take Oct 15–16 off in Gusto" },
        { messageId: "wb_gusto", role: "assistant", text: "", toolCalls: [{ id: "b1", name: "browser_open", input: { url: "https://app.gusto.com/login" } }] },
        { messageId: "wb_gusto", role: "tool", callId: "b1", name: "browser_open", output: "{}", isError: false },
        { messageId: "wb_gusto", role: "assistant", text: "", toolCalls: [{ id: "b2", name: "browser_handoff", input: { reason: "sign_in" } }] },
        { messageId: "wb_gusto", role: "tool", callId: "b2", name: "browser_handoff", output: "{}", isError: false },
        { messageId: "wb_gusto", role: "assistant", text: "Gusto isn't connected, so I opened it here. Sign in once and I'll remember.", toolCalls: [] },
      ],
    })
    expect(handoff[0]).toMatchObject({ status: "done", browser: { used: true, handedOff: true, site: "app.gusto.com" } })
    expect(handoff[0].steps.map((step) => step.label)).toEqual(["Opening app.gusto.com", "Waiting for you to sign in"])
  })

  test("a failed turn explains itself in plain words, never with a code", () => {
    expect(turns[2]).toMatchObject({ status: "failed", error: "I couldn't reach the AI model just now. Try again in a moment." })
  })

  test("the created Automation is found however the result is wrapped", () => {
    expect(createdAutomationId(automationResult)).toBe("atm_1")
    expect(createdAutomationId(JSON.stringify({ content: [{ type: "text", text: automationResult }] }))).toBe("atm_1")
    expect(createdAutomationId(`Created: {"automation": {"id": "atm_2"`)).toBe("atm_2")
    expect(createdAutomationId("nothing")).toBeNull()
  })
})

describe("Workbot setup", () => {
  test("needs the capability and a runner", () => {
    const env = { DEN_HEADLESS_RUNNER_URL: "http://headless-runner:8795", DEN_HEADLESS_RUNNER_TOKEN: "t".repeat(40) }
    expect(workbotEnabled({ capabilities: { workbot: true } }, env)).toBe(true)
    expect(workbotEnabled({ capabilities: { workbot: true } }, {})).toBe(false)
    expect(workbotEnabled({}, env)).toBe(false)
  })

  test("one stable thread per member, named after the organization's app when it has one", () => {
    expect(workbotSessionId("org_1", "member_1")).toBe(workbotSessionId("org_1", "member_1"))
    expect(workbotSessionId("org_1", "member_1")).not.toBe(workbotSessionId("org_1", "member_2"))
    expect(workbotSessionId("org_1", "member_1")).toMatch(/^hs_wb_[0-9a-f]{40}$/)
    expect(workbotName({ brandAppName: "Scout" })).toBe("Scout")
    expect(workbotName({ brandAppName: "OpenWork" })).toBe("Workbot")
    expect(workbotName(null)).toBe("Workbot")
  })

  test("instructions only offer what this organization can do", () => {
    const base = { name: "Scout", organizationName: "Acme Robotics", firstName: "Maya", timeZone: "America/Los_Angeles" }
    const full = workbotInstructions({ ...base, canSchedule: true, canBrowse: true, now: new Date("2026-10-01T06:55:00Z") })
    expect(full).toContain("Wednesday, September 30, 2026 at 11:55 PM")
    expect(full).toContain("createCloudAutomation")
    expect(full).toContain('"providerId":"openwork-cloud","modelId":"default"')
    expect(full).toContain("browser_handoff")
    expect(full).toContain("America/Los_Angeles")
    const plain = workbotInstructions({ ...base, canSchedule: false, canBrowse: false })
    expect(plain).not.toContain("createCloudAutomation")
    expect(plain).not.toContain("browser_")
    expect(plain).toContain("cannot schedule")
  })
})

function fakeRunner(reads: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const client = createHeadlessRunnerClient({
    config: { url: "http://headless-runner:8795", token: "t".repeat(40) },
    fetch: async (input, init) => {
      const url = new URL(String(input))
      calls.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (init?.method === "PUT") return new Response(JSON.stringify({ id: url.pathname.split("/").pop() }), { status: 201 })
      if (url.pathname.endsWith("/turns")) return new Response(JSON.stringify({ state: "accepted" }), { status: 202 })
      if (url.pathname.endsWith("/abort")) return new Response(JSON.stringify({ accepted: true }), { status: 200 })
      const next = reads.shift() ?? { status: 404, body: { error: "unknown_session" } }
      return new Response(JSON.stringify(next.body), { status: next.status })
    },
    mintToken: async () => ({ token: "ow_mcp_at_member" }),
  })
  const deps: WorkbotDeps = {
    client,
    cloudRuntime: async () => "headless",
    automations: {
      get: async () => null,
      listRuns: async () => ({ items: [] }),
    },
    canBrowse: () => false,
  }
  return { calls, deps }
}

describe("Workbot on the runner", () => {
  test("the first visit is an empty thread, created only when the first message is sent", async () => {
    const { calls, deps } = fakeRunner([])
    expect(await readWorkbotThread(actor, deps)).toEqual({ name: "Workbot", organizationName: "Acme Robotics", status: "idle", turns: [], automations: [] })
    expect(calls.map((call) => call.method)).toEqual(["GET"])
  })

  test("sending saves the thread's instructions, then the message under the page's own id", async () => {
    const { calls, deps } = fakeRunner([])
    expect(await sendWorkbotMessage(actor, { id: "msg-1234-abcd", text: "Catch me up on #launch", timeZone: "Europe/Berlin" }, deps)).toEqual({ ok: true })
    const sessionPath = `/v1/sessions/${workbotSessionId("org_1", "member_1")}`
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`PUT ${sessionPath}`, `POST ${sessionPath}/turns`])
    expect(JSON.stringify(calls[0].body)).toContain("Europe/Berlin")
    expect(calls[1].body).toEqual({ messageId: "wb_msg-1234-abcd", prompt: "Catch me up on #launch", credentials: { mcpToken: "ow_mcp_at_member" } })
  })

  test("an unknown time zone falls back to UTC", async () => {
    const { calls, deps } = fakeRunner([])
    await sendWorkbotMessage(actor, { id: "msg-1234-abcd", text: "hi", timeZone: "Mars/Olympus" }, deps)
    expect(JSON.stringify(calls[0].body)).toContain("Their time zone is UTC")
  })

  test("a turn the runner restarted is resumed on the next read", async () => {
    const { calls, deps } = fakeRunner([{ status: 200, body: { turns: [{ messageId: "wb_a", status: "interrupted", error: "runner_restarted" }], messages: [{ messageId: "wb_a", role: "user", text: "hi" }], finalAssistantText: "" } }])
    const thread = await readWorkbotThread(actor, deps)
    expect(thread.status).toBe("busy")
    expect(thread.turns[0]).toMatchObject({ id: "a", status: "working" })
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { messageId: "wb_a", prompt: "resume" } })
  })

  test("stop stops everything in the thread", async () => {
    const { calls, deps } = fakeRunner([])
    expect(await stopWorkbot(actor, deps)).toEqual({ stopped: true })
    expect(calls[0]).toMatchObject({ method: "POST", body: {} })
  })
})
