import assert from "node:assert/strict"
import { test } from "node:test"
import { createSlackRunner, type HeadlessDeps } from "../src/slack-assistant/headless.js"
import { createLiveFeeds, parseServerSentEvents } from "../src/slack-assistant/live.js"
import {
  BOT_SCOPES,
  buildSlackEnvelope,
  REQUIRED_BOT_SCOPES,
  SLACK_ASSISTANT_INSTRUCTIONS,
  SLACK_RUN_INSTRUCTIONS,
  SLACK_WORKBOT_INSTRUCTIONS,
  slackManifest,
  slackReactionName,
} from "../src/slack-assistant/protocol.js"
import { createSlackEventLoop } from "../src/slack-assistant/queue.js"
import {
  advanceSlackRun,
  advanceSlackWatch,
  catchUpText,
  checkpointSchema,
  STREAM_CONTINUED_LINE,
  STREAM_ROTATE_AFTER_MS,
  WATCH_MAX_MS,
  type Checkpoint,
} from "../src/slack-assistant/run.js"
import { CLAIMABLE_STATUSES, THREAD_ACTIVE_STATUSES } from "../src/slack-assistant/statuses.js"
import { fakeClock, fakeLive, fakeRunner, fakeSlack, idle, runToEnd, snapshot } from "./slack-fakes.js"

const settings = { instructions: SLACK_WORKBOT_INSTRUCTIONS, reactions: true, tasks: true }
const workbotCp = (input: Partial<Checkpoint> = {}) =>
  checkpointSchema.parse({ phase: "create", prompt: "{}", channel: "C1", threadTs: "1.0", live: false, workbot: true, reactTo: { channel: "C1", ts: "1.0" }, recipientUserId: "U0ABC", ...input })

// --- Session setup ---------------------------------------------------------------------------------------------------

test("instructions live in the session, keep every safety rule, and never change between messages", () => {
  for (const rule of [SLACK_ASSISTANT_INSTRUCTIONS, SLACK_RUN_INSTRUCTIONS]) assert.ok(SLACK_WORKBOT_INSTRUCTIONS.includes(rule))
  for (const phrase of ["start_task", "react", "one short sentence", "Never mention tools", "untrusted"]) assert.ok(SLACK_WORKBOT_INSTRUCTIONS.includes(phrase), phrase)
  assert.ok(!/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/.test(SLACK_WORKBOT_INSTRUCTIONS), "no dates or times in cached instructions")
  const envelope = buildSlackEnvelope({ event: { type: "app_mention", user: "U1", text: "<@B1> hi --private", channel: "C1", ts: "1.0" }, teamId: "T1", botUserId: "B1", context: { messages: [] }, privateReply: true })
  assert.ok(!envelope.includes("OpenWork assistant in Slack"), "the per-message prompt carries no instructions")
  const parsed: unknown = JSON.parse(envelope)
  assert.deepEqual(parsed, {
    source: "slack",
    asked_by: "U1",
    audience: "invoker only",
    invocation: { text: "hi" },
    team_id: "T1",
    channel_id: "C1",
    thread_ts: "1.0",
    untrusted_context: '{"messages":[]}',
  })
})

test("the adapter creates and refreshes the session with Slack's instructions, reactions and tasks", async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const deps: HeadlessDeps = {
    config: { url: "http://headless-runner:8795", token: "t".repeat(40) },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname
      calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (init?.method === "POST" && path === "/v1/sessions") return new Response(JSON.stringify({ id: "hs_abcdefgh" }), { status: 201 })
      if (init?.method === "PUT") return new Response(JSON.stringify({ id: "hs_abcdefgh" }), { status: 200 })
      return new Response(JSON.stringify({ state: "accepted" }), { status: 202 })
    },
    mintToken: async () => ({ token: "ow_mcp_at_run_1" }),
    maxTokenTtlMs: 3_600_000,
  }
  const runner = createSlackRunner({ userId: "usr_1", organizationId: "org_1" }, deps)
  await runner.create({ title: "C1 · hi", settings })
  const sent = await runner.send({ sessionId: "hs_abcdefgh", messageId: "msg_1", prompt: "{}", settings })
  assert.deepEqual(sent, { ok: true, accepted: true })
  const repeats = { maxWaitingMs: 600_000, maxIdenticalFailures: 3 }
  assert.deepEqual(calls[0], { method: "POST", path: "/v1/sessions", body: { title: "C1 · hi", instructions: SLACK_WORKBOT_INSTRUCTIONS, repeats, reactions: true, tasks: true } })
  assert.deepEqual(calls[1], { method: "PUT", path: "/v1/sessions/hs_abcdefgh", body: { instructions: SLACK_WORKBOT_INSTRUCTIONS, repeats, reactions: true, tasks: true } })
  assert.deepEqual(calls[2]?.path, "/v1/sessions/hs_abcdefgh/turns")
})

// --- Live text -------------------------------------------------------------------------------------------------------

test("live text streams as written, batched once a second, and the stored answer adds only what is missing", async () => {
  const clock = fakeClock()
  const live = fakeLive()
  const { slack, appends, text } = fakeSlack()
  let step = 0
  const { runner } = fakeRunner([], {
    read: async () => {
      step += 1
      // The first read sees nothing stored; later the first step is stored and a tool runs; then the turn ends.
      if (step === 1) return { ok: true, snapshot: snapshot() }
      if (step === 2) return { ok: true, snapshot: snapshot({ finalAssistantText: "Sure, let me check.", assistantTexts: ["Sure, let me check."] }) }
      return { ok: true, snapshot: idle("Sure, let me check.\n\nYou have 2 meetings.", { assistantTexts: ["Sure, let me check.", "You have 2 meetings."] }) }
    },
  })
  const cp = workbotCp()
  // create, then send (which streams right away)
  await advanceSlackRun({ checkpoint: cp, runner, slack, messageId: "msg_1", title: "t", saveSession: async () => {}, clearSession: async () => {}, settings, live: live.source })
  assert.equal(cp.phase, "send")
  const result = await advanceSlackRun({ checkpoint: cp, runner, slack, messageId: "msg_1", title: "t", saveSession: async () => {}, clearSession: async () => {}, settings, live: live.source, now: clock.now, sleep: async (ms) => {
    clock.advance(ms)
    const at = clock.now() - 1_000_000
    if (at === 1_000) live.push({ type: "text", messageId: "msg_1", step: 0, delta: "Sure, " }, { type: "text", messageId: "msg_1", step: 0, delta: "let me" })
    if (at === 2_000) live.push({ type: "text", messageId: "msg_1", step: 0, delta: " check." }, { type: "text", messageId: "other", step: 0, delta: "not ours" })
    if (at === 3_000) live.push({ type: "changed", messageId: "msg_1" })
    if (at === 4_000) live.push({ type: "text", messageId: "msg_1", step: 1, delta: "You have" })
    if (at === 5_000) live.push({ type: "changed", messageId: "msg_1", status: "completed" })
  } })
  assert.equal(cp.phase, "finish")
  assert.equal(result.delayMs, 0)
  assert.deepEqual(appends(), ["Sure, let me", " check.", "\n\nYou have", " 2 meetings."])
  assert.equal(text(), "Sure, let me check.\n\nYou have 2 meetings.")
  assert.equal(cp.sentText, "Sure, let me check.\n\nYou have 2 meetings.")
})

test("a retried step that streamed different words still ends with the whole answer", () => {
  assert.equal(catchUpText("Sure, give me", "Sure, give me a sec."), " a sec.")
  assert.equal(catchUpText("Intro.\n\nYou have thr", "Intro.\n\nYou have 2 meetings."), "\n\nYou have 2 meetings.")
  assert.equal(catchUpText("Hello", "Hello"), "")
})

test("a reset drops the step's live text until it is written again", async () => {
  const clock = fakeClock()
  const { slack, text } = fakeSlack()
  let reads = 0
  const { runner } = fakeRunner([], {
    read: async () => (++reads < 4 ? { ok: true, snapshot: snapshot() } : { ok: true, snapshot: idle("Checking now.", { assistantTexts: ["Checking now."] }) }),
  })
  const cp = workbotCp({ phase: "read", sessionId: "hs_1", liveStep: 0 })
  const events = [
    [{ type: "text" as const, messageId: "msg_1", step: 0, delta: "Chec" }],
    [{ type: "text" as const, messageId: "msg_1", step: 0, delta: "", reset: true }, { type: "text" as const, messageId: "msg_1", step: 0, delta: "Checking" }],
    [{ type: "text" as const, messageId: "msg_1", step: 0, delta: " now." }],
  ]
  const source = { acquire: async () => ({ fresh: false, closed: false, take: () => events.shift() ?? [], release: () => {} }) }
  await advanceSlackRun({ checkpoint: cp, runner, slack, messageId: "msg_1", title: "t", saveSession: async () => {}, clearSession: async () => {}, live: source, now: clock.now, sleep: clock.sleep })
  assert.equal(text(), "Checking now.")
})

test("a reply that streams past Slack's stream lifetime continues in a new message", async () => {
  const clock = fakeClock()
  const { slack, methods, text } = fakeSlack()
  const live = fakeLive()
  let reads = 0
  const { runner } = fakeRunner([], {
    read: async () => {
      reads += 1
      if (reads === 1) return { ok: true, snapshot: snapshot({ finalAssistantText: "Part one.", assistantTexts: ["Part one."] }) }
      clock.advance(STREAM_ROTATE_AFTER_MS)
      return { ok: true, snapshot: idle("Part one.\n\nPart two.", { assistantTexts: ["Part one.", "Part two."] }) }
    },
  })
  const cp = workbotCp({ phase: "read", sessionId: "hs_1", startedAt: clock.now(), liveStep: 0 })
  await advanceSlackRun({ checkpoint: cp, runner, slack, messageId: "msg_1", title: "t", saveSession: async () => {}, clearSession: async () => {}, live: live.source, now: clock.now, sleep: clock.sleep, quietAfterMs: Number.POSITIVE_INFINITY })
  assert.deepEqual(methods(), ["chat.startStream", "chat.stopStream", "chat.startStream"])
  assert.equal(text(), `Part one.${STREAM_CONTINUED_LINE}\n\nPart two.`)
  assert.equal(cp.sentText, "Part one.\n\nPart two.")
})

test("a streaming window hands the event back after about 20 seconds, and the next one continues the feed", async () => {
  const clock = fakeClock()
  const live = fakeLive()
  const { slack } = fakeSlack()
  const { runner } = fakeRunner([snapshot()])
  const cp = workbotCp({ phase: "read", sessionId: "hs_1", liveStep: 0 })
  const started = clock.now()
  const renewals: number[] = []
  const result = await advanceSlackRun({ checkpoint: cp, runner, slack, messageId: "msg_1", title: "t", saveSession: async () => {}, clearSession: async () => {}, live: live.source, now: clock.now, sleep: clock.sleep, renew: async () => {
    renewals.push(clock.now())
  } })
  assert.equal(result.delayMs, 0)
  assert.ok(clock.now() - started >= 20_000 && clock.now() - started < 22_000)
  assert.ok(renewals.length >= 1, "the lease is renewed while streaming")
  assert.deepEqual(live.tokens, [1])
  assert.equal(cp.liveWindow, 1)
})

// --- Reactions -------------------------------------------------------------------------------------------------------

test("reaction emoji map to Slack names; unknown ones are skipped", () => {
  assert.equal(slackReactionName("👍"), "thumbsup")
  assert.equal(slackReactionName("❤️"), "heart")
  assert.equal(slackReactionName("❤"), "heart")
  assert.equal(slackReactionName("‼️"), "bangbang")
  assert.equal(slackReactionName("💯"), "100")
  assert.equal(slackReactionName("🦄"), null)
  assert.ok(BOT_SCOPES.includes("reactions:write"))
  assert.ok(!REQUIRED_BOT_SCOPES.includes("reactions:write"), "installs without the new scope still work")
  assert.deepEqual(slackManifest("https://api.example.com", "emc_1").oauth_config.scopes.bot, BOT_SCOPES)
})

test("a reaction-only turn reacts once, posts no text, and closes Slack's status", async () => {
  const { slack, calls, methods } = fakeSlack()
  const { runner } = fakeRunner([idle("", { reaction: { emoji: "❤️", final: true } })])
  const cp = workbotCp({ phase: "read", sessionId: "hs_1" })
  const { result } = await runToEnd({ checkpoint: cp, runner, slack })
  assert.equal(result.watch, undefined)
  assert.deepEqual(methods(), ["reactions.add", "agents.sessions.setStatus"])
  assert.deepEqual(calls[0]?.body, { channel: "C1", timestamp: "1.0", name: "heart" })
  assert.deepEqual(calls[1]?.body, { channel_id: "C1", thread_ts: "1.0", status: "active" })
})

test("Slack refusing the reaction (missing_scope on older installs) never fails the run", async () => {
  const { slack, text, methods } = fakeSlack({ "reactions.add": "missing_scope" })
  const logged: string[] = []
  const { runner } = fakeRunner([idle("Thanks, noted.", { reaction: { emoji: "👍", final: false } })])
  const cp = workbotCp({ phase: "read", sessionId: "hs_1" })
  await runToEnd({ checkpoint: cp, runner, slack, log: (message, fields) => logged.push(`${message}:${fields.code}`) })
  assert.equal(text(), "Thanks, noted.")
  assert.deepEqual(logged, ["slack_assistant_reaction_failed:missing_scope"])
  assert.equal(methods().filter((method) => method === "reactions.add").length, 1)
})

test("a private reply in a channel doesn't react on the channel message", async () => {
  const { slack, methods } = fakeSlack()
  const { runner } = fakeRunner([idle("ok", { reaction: { emoji: "👍", final: false } })])
  const cp = workbotCp({ phase: "read", sessionId: "hs_1", reactTo: undefined })
  await runToEnd({ checkpoint: cp, runner, slack })
  assert.ok(!methods().includes("reactions.add"))
})

// --- Background tasks ------------------------------------------------------------------------------------------------

test("a turn that started a background task ends its reply and is watched, releasing the thread", async () => {
  const { slack } = fakeSlack()
  const { runner } = fakeRunner([idle("On it, I'll post the deck here.", { tasks: [{ id: "msg_1.t1", title: "Q3 deck", status: "running" }] })])
  const cp = workbotCp({ phase: "read", sessionId: "hs_1" })
  const now = 5_000
  const { result } = await runToEnd({ checkpoint: cp, runner, slack, now: () => now })
  assert.equal(result.watch, true)
  assert.equal(cp.phase, "watch")
  assert.deepEqual(cp.taskIds, ["msg_1.t1"])
  assert.equal(cp.watchUntil, now + WATCH_MAX_MS)
  assert.ok(!CLAIMABLE_STATUSES.every((status) => THREAD_ACTIVE_STATUSES.includes(status)))
  assert.ok(CLAIMABLE_STATUSES.includes("watching"))
  assert.ok(!THREAD_ACTIVE_STATUSES.includes("watching"), "a watching event never makes newer messages wait, and Stop ignores it")
})

test("each report is posted once as a new reply mentioning the person; watching ends when every task reported", async () => {
  const { slack, calls } = fakeSlack()
  let state: "running" | "reported" = "running"
  const { runner } = fakeRunner([], {
    background: async () =>
      state === "running"
        ? { ok: true, tasks: [{ id: "msg_1.t1", title: "Q3 deck", status: "running" }, { id: "msg_1.t2", title: "Old", status: "aborted" }], reports: [] }
        : {
            ok: true,
            tasks: [{ id: "msg_1.t1", title: "Q3 deck", status: "completed" }, { id: "msg_1.t2", title: "Old", status: "aborted" }],
            reports: [{ id: "msg_1.t1.r", title: "Q3 deck", status: "completed", task: "msg_1.t1" }],
          },
    turnText: async () => ({ ok: true, text: "The **Q3 deck** is ready. <!channel> look" }),
  })
  const cp = workbotCp({ phase: "watch", sessionId: "hs_1", channel: "D1", threadTs: "9.0", watchUntil: Date.now() + 60_000 })
  const first = await advanceSlackWatch({ checkpoint: cp, runner, slack, messageId: "msg_1" })
  assert.equal(first.done, undefined)
  assert.equal(calls.length, 0)
  state = "reported"
  const second = await advanceSlackWatch({ checkpoint: cp, runner, slack, messageId: "msg_1" })
  assert.equal(second.done, true)
  const third = await advanceSlackWatch({ checkpoint: cp, runner, slack, messageId: "msg_1" })
  assert.equal(third.done, true)
  assert.equal(calls.length, 1, "posted once")
  const post = calls[0]
  assert.equal(post?.method, "chat.postMessage")
  assert.equal(post?.body.channel, "D1", "where the answer went (private replies stay private)")
  assert.equal(post?.body.thread_ts, "9.0")
  assert.ok(String(post?.body.text).startsWith("<@U0ABC> "))
  assert.deepEqual(post?.body.blocks, [
    { type: "section", text: { type: "mrkdwn", text: "<@U0ABC>" } },
    { type: "markdown", text: "The **Q3 deck** is ready. @\u200bchannel look" },
  ])
})

test("a failed report gets one plain line; watching stops after a day", async () => {
  const { slack, calls } = fakeSlack()
  const { runner } = fakeRunner([], {
    background: async () => ({
      ok: true,
      tasks: [{ id: "msg_1.t1", title: "Inbox sweep", status: "failed" }],
      reports: [{ id: "msg_1.t1.r", title: "Inbox sweep", status: "failed", task: "msg_1.t1" }],
    }),
  })
  const cp = workbotCp({ phase: "watch", sessionId: "hs_1", watchUntil: Date.now() + 60_000 })
  assert.equal((await advanceSlackWatch({ checkpoint: cp, runner, slack, messageId: "msg_1" })).done, true)
  assert.equal(calls[0]?.body.text, `<@U0ABC> I couldn't bring back the result of "Inbox sweep". Ask me about it here.`)
  const expired = workbotCp({ phase: "watch", sessionId: "hs_1", watchUntil: 1 })
  assert.equal((await advanceSlackWatch({ checkpoint: expired, runner, slack, messageId: "msg_1" })).done, true)
})

// --- Worker ----------------------------------------------------------------------------------------------------------

test("the worker keeps claiming while long events run, up to its cap", async () => {
  const queue = Array.from({ length: 12 }, (_, index) => ({ id: `e${index}` }))
  const release: Array<() => void> = []
  const started: string[] = []
  const loop = createSlackEventLoop({
    claim: async () => queue.shift() ?? null,
    process: (event) =>
      new Promise<void>((resolve) => {
        started.push(event.id)
        release.push(resolve)
      }),
    claimPerTick: 4,
    maxInFlight: 6,
  })
  await loop.tick()
  assert.equal(started.length, 4, "the first tick doesn't wait for its events")
  await loop.tick()
  assert.equal(started.length, 6, "a second tick claims more while those still run, up to the cap")
  release.shift()?.()
  await new Promise((resolve) => setImmediate(resolve))
  await loop.tick()
  assert.equal(started.length, 7)
  for (const done of release) done()
  await loop.drain()
  assert.equal(loop.inFlight(), 0)
})

// --- Live feed plumbing ----------------------------------------------------------------------------------------------

test("server-sent events parse into runner events, keeping partial ones for later", () => {
  const parsed = parseServerSentEvents('event: ready\ndata: {}\n\ndata: {"type":"text","messageId":"m","step":0,"delta":"Hi"}\n\ndata: {"type":"chan')
  assert.equal(parsed.ready, true)
  assert.deepEqual(parsed.events, [{ type: "text", messageId: "m", step: 0, delta: "Hi" }])
  assert.equal(parsed.rest, 'data: {"type":"chan')
})

test("a feed continues only into the window right after its own; otherwise it starts fresh", async () => {
  const encoder = new TextEncoder()
  let opened = 0
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = []
  const feeds = createLiveFeeds({
    open: async () => {
      opened += 1
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller)
          controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"))
        },
      })
    },
    idleMs: 60_000,
  })
  const first = await feeds.acquire("hs_1", 0)
  assert.equal(first?.fresh, true)
  controllers[0]?.enqueue(encoder.encode('data: {"type":"changed","messageId":"m"}\n\n'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(first?.take(), [{ type: "changed", messageId: "m" }])
  first?.release(1)
  controllers[0]?.enqueue(encoder.encode('data: {"type":"text","messageId":"m","step":0,"delta":"between windows"}\n\n'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = await feeds.acquire("hs_1", 1)
  assert.equal(second?.fresh, false)
  assert.deepEqual(second?.take(), [{ type: "text", messageId: "m", step: 0, delta: "between windows" }], "nothing written between windows is lost")
  second?.release(2)
  const elsewhere = await feeds.acquire("hs_1", 5)
  assert.equal(elsewhere?.fresh, true, "another process ran windows 2-4: start over")
  assert.equal(opened, 2)
  elsewhere?.release(6)
})
