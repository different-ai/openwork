import assert from "node:assert/strict"
import { test } from "node:test"
import { createSlackRunner, type HeadlessDeps } from "../src/slack-assistant/headless.js"
import { buildSlackPrompt, SLACK_RUN_INSTRUCTIONS } from "../src/slack-assistant/protocol.js"
import { checkpointSchema, RemoteSessionUnavailableError } from "../src/slack-assistant/run.js"
import { fakeLive, fakeRunner, fakeSlack, idle, runToEnd, snapshot } from "./slack-fakes.js"

test("a thread whose saved session is gone on the runner runs the same message in a fresh session", async () => {
  const { slack, text } = fakeSlack()
  const { runner, sent } = fakeRunner([idle("Here you go.")], {
    send: async (input) => {
      sent.push(input)
      return input.sessionId === "ses_from_openwork_web" ? { ok: false, error: "unknown_session", retryable: false } : { ok: true, accepted: true }
    },
  })
  const cp = checkpointSchema.parse({ phase: "create", sessionId: "ses_from_openwork_web", prompt: "envelope", channel: "C1", threadTs: "1.0", live: true })
  const { saved, cleared } = await runToEnd({ checkpoint: cp, runner, slack })
  assert.equal(cleared(), 1)
  assert.deepEqual(saved, ["hs_new1"])
  assert.deepEqual(
    sent.map((entry) => [entry.sessionId, entry.prompt]),
    [
      ["ses_from_openwork_web", "envelope"],
      ["hs_new1", "envelope"],
    ],
  )
  assert.equal(text(), "Here you go.")
  assert.equal(cp.prompt, undefined, "the prompt is dropped once the run ends")
})

test("a session lost mid-run starts over once; a second loss stops the run", async () => {
  const { slack } = fakeSlack()
  let reads = 0
  const { runner } = fakeRunner([], {
    read: async () => (++reads <= 2 ? { ok: false, error: "unknown_session", retryable: false } : { ok: true, snapshot: idle("x") }),
  })
  const cp = checkpointSchema.parse({ phase: "read", sessionId: "hs_old", prompt: "envelope", channel: "C1", threadTs: "1.0" })
  await assert.rejects(runToEnd({ checkpoint: cp, runner, slack }), RemoteSessionUnavailableError)
  assert.equal(cp.sessionResets, 1)
})

const runnerDeps = (handler: (method: string, path: string, body: unknown) => { status: number; body: unknown }) => {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const deps: HeadlessDeps = {
    config: { url: "http://headless-runner:8795", token: "t".repeat(40) },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method: init?.method ?? "GET", path, body })
      const answer = handler(init?.method ?? "GET", path, body)
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    },
    mintToken: async () => ({ token: "ow_mcp_at_run_1" }),
    maxTokenTtlMs: 3_600_000,
  }
  return { deps, calls }
}

test("the runner adapter reports a missing session as unknown_session", async () => {
  const { deps } = runnerDeps(() => ({ status: 404, body: { error: "unknown_session" } }))
  const runner = createSlackRunner({ userId: "usr_1", organizationId: "org_1" }, deps)
  assert.deepEqual(await runner.send({ sessionId: "hs_x", messageId: "msg_1", prompt: "p" }), { ok: false, error: "unknown_session", retryable: false })
  assert.deepEqual(await runner.read({ sessionId: "hs_x", messageId: "msg_1" }), { ok: false, error: "unknown_session", retryable: false })
})

test("an old OpenWork Web session id the runner refuses counts as a missing session", async () => {
  const { deps } = runnerDeps((method) => (method === "PUT" ? { status: 400, body: { error: "invalid_session_id" } } : { status: 202, body: {} }))
  const runner = createSlackRunner({ userId: "usr_1", organizationId: "org_1" }, deps)
  const sent = await runner.send({ sessionId: "ses_web", messageId: "msg_1", prompt: "p", settings: { instructions: "", reactions: false, tasks: false } })
  assert.deepEqual(sent, { ok: false, error: "unknown_session", retryable: false })
})

test("without a runner every call fails without retrying", async () => {
  const runner = createSlackRunner({ userId: "usr_1", organizationId: "org_1" }, null)
  const created = await runner.create({ title: "t" })
  assert.equal(created.ok, false)
  assert.equal(created.ok === false && created.retryable, false)
})

test("flag off: instructions travel in each message, the reply follows stored messages, no reactions or watching", async () => {
  const prompt = buildSlackPrompt({ event: { type: "app_mention", user: "U1", text: "<@B1> hi", channel: "C1", ts: "1.0" }, teamId: "T1", botUserId: "B1", context: {}, privateReply: false })
  assert.ok(prompt.startsWith(SLACK_RUN_INSTRUCTIONS))
  const { slack, methods, text } = fakeSlack()
  const live = fakeLive()
  const { runner, sent, created } = fakeRunner([
    snapshot({ finalAssistantText: "Looking", assistantTexts: ["Looking"] }),
    idle("Looking now.", {
      reaction: { emoji: "👍", final: false },
      tasks: [{ id: "msg_1.t1", title: "Deck", status: "running" }],
    }),
  ])
  const settings = { instructions: "", reactions: false, tasks: false }
  const cp = checkpointSchema.parse({ phase: "create", prompt, channel: "C1", threadTs: "1.0", live: true, reactTo: { channel: "C1", ts: "1.0" } })
  const { result } = await runToEnd({ checkpoint: cp, runner, slack, settings, live: live.source })
  assert.equal(result.watch, undefined)
  assert.deepEqual(created, [{ title: "C1 · hi" }], "a new session gets the runner's defaults")
  assert.deepEqual(sent[0]?.settings, settings, "existing sessions are reset to no instructions, reactions or tasks")
  assert.equal(sent[0]?.prompt, prompt)
  assert.ok(!methods().includes("reactions.add"))
  assert.equal(text(), "Looking now.")
  assert.equal(live.tokens.length, 0, "no live events are used")
})
