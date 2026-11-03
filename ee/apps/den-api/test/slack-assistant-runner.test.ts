import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { serve } from "@hono/node-server"
// The real headless runner (its HTTP app, queue, store and live events) with a scripted model in place of a provider.
import { createApp } from "../../headless-runner/src/app.js"
import { SessionEvents } from "../../headless-runner/src/events.js"
import type { ModelClient, ModelRequest } from "../../headless-runner/src/model.js"
import { nodeSqlite } from "../../headless-runner/src/node-sqlite.js"
import { Runner } from "../../headless-runner/src/runner.js"
import { Store } from "../../headless-runner/src/store.js"
import { createSlackRunner, openSlackRunnerEvents, type HeadlessDeps } from "../src/slack-assistant/headless.js"
import { createLiveFeeds } from "../src/slack-assistant/live.js"
import { buildSlackEnvelope, slackClient, SLACK_WORKBOT_INSTRUCTIONS, type SlackEvent } from "../src/slack-assistant/protocol.js"
import { loadSlackContext } from "../src/slack-assistant/context.js"
import { advanceSlackRun, advanceSlackWatch, checkpointSchema } from "../src/slack-assistant/run.js"
import { fakeSlack } from "./slack-fakes.js"

const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Streams `text` word by word, the way a provider does. */
async function write(request: ModelRequest, text: string, gapMs: number) {
  for (const word of text.split(/(?<= )/)) {
    await sleep(gapMs)
    request.onText?.(word)
  }
  return text
}

test("a Slack message runs on the real runner: session instructions, live text, a reaction and a task's report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-runner-"))
  const systems: string[] = []
  const userTexts: string[] = []
  const model: ModelClient = {
    async complete(request) {
      systems.push(request.system)
      if (request.system.includes("# Your background task")) return { text: await write(request, "Deck ready: 12 slides.", 20), toolCalls: [], usage }
      if (request.system.includes("Only deliver the background task's result"))
        return { text: await write(request, "Your **Q3 deck** is ready: 12 slides.", 20), toolCalls: [], usage }
      const answered = request.messages.filter((message) => message.role === "assistant").length
      const last = request.messages.filter((message) => message.role === "user").at(-1)
      if (last?.role === "user") userTexts.push(last.text)
      if (answered === 0)
        return {
          text: await write(request, "Sure, give me a sec to put that together.", 250),
          toolCalls: [
            { id: "call_react", name: "react", input: { emoji: "👍" } },
            { id: "call_task", name: "start_task", input: { title: "Q3 deck", brief: "Make the Q3 deck for U0ABC." } },
          ],
          usage,
        }
      return { text: await write(request, "I'm on it and will post the deck here.", 30), toolCalls: [], usage }
    },
  }
  const store = new Store(nodeSqlite(join(directory, "runner.sqlite")))
  const events = new SessionEvents()
  const limits = { maxConcurrentTurns: 4, maxSteps: 10, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 100_000 }
  const runner = new Runner({ store, model, defaultModel: "test-model", defaultModelApiKey: "test-key", limits, events })
  const token = "r".repeat(40)
  const server = serve({ fetch: createApp({ store, runner, apiToken: token, events }).fetch, port: 0 })
  await new Promise((resolve) => server.once("listening", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  try {
    const deps: HeadlessDeps = {
      config: { url: `http://127.0.0.1:${port}`, token },
      fetch,
      mintToken: async () => ({ token: "ow_mcp_at_run_test" }),
      maxTokenTtlMs: 3_600_000,
    }
    const slackRunner = createSlackRunner({ userId: "usr_1", organizationId: "org_1" }, deps)
    const live = createLiveFeeds({ open: (sessionId, signal) => openSlackRunnerEvents(sessionId, signal, deps), idleMs: 5_000 })
    const { slack, calls, appends, text } = fakeSlack()
    const settings = { instructions: SLACK_WORKBOT_INSTRUCTIONS, reactions: true, tasks: true }
    // Exercise the production context loader and HTTP adapter before sending the envelope through the real runner.
    // Only Slack's external responses and the model are scripted; no live Slack workspace or credentials are used.
    const event: SlackEvent = { type: "app_mention", user: "U0ABC", text: "<@B1> make the Q3 deck", channel: "C1", ts: "2.0", thread_ts: "1.0" }
    const memberSlack = slackClient("member-context-token", async (url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer member-context-token")
      if (String(url).endsWith("users.info")) {
        const body: { user: string } = JSON.parse(String(init?.body))
        return Response.json({ ok: true, user: { id: body.user, profile: { display_name: "Example Colleague" } } })
      }
      assert.ok(String(url).endsWith("conversations.replies"))
      return Response.json({ ok: true, messages: [{ ts: "1.0", user: "U2", text: "Use the attached Q3 figures", files: [{ id: "F1", name: "figures.csv", filetype: "csv" }] }] })
    })
    const context = await loadSlackContext({ slack: memberSlack, event, channelId: "C1", log: () => assert.fail("context fetch failed") })
    const envelope = buildSlackEnvelope({ event, teamId: "T1", botUserId: "B1", context, privateReply: false })
    const messageId = `msg_${"a".repeat(64)}`
    const cp = checkpointSchema.parse({ phase: "create", prompt: envelope, channel: "C1", threadTs: "1.0", live: false, workbot: true, reactTo: { channel: "C1", ts: "2.0" }, recipientUserId: "U0ABC", startedAt: Date.now() })
    let done = false
    for (let i = 0; i < 20 && !done; i++) {
      const result = await advanceSlackRun({
        checkpoint: cp,
        runner: slackRunner,
        slack,
        messageId,
        title: "C1 · make the Q3 deck",
        saveSession: async () => {},
        clearSession: async () => {},
        settings,
        live,
        liveWindowMs: 4_000,
      })
      done = result.done === true
      if (done) assert.equal(result.watch, true)
    }
    assert.ok(done)
    // The instructions reached the model as the session's system prompt; the message itself is only the envelope.
    assert.ok(systems[0]?.includes(SLACK_WORKBOT_INSTRUCTIONS))
    assert.ok(userTexts[0]?.endsWith(envelope) && !userTexts[0].includes("OpenWork assistant in Slack"))
    const received: { asked_by: string; invocation: { text: string }; untrusted_context: string } = JSON.parse(userTexts[0]?.slice(-envelope.length) ?? "{}")
    assert.equal(received.asked_by, "U0ABC")
    assert.equal(received.invocation.text, "make the Q3 deck")
    assert.deepEqual(JSON.parse(received.untrusted_context), JSON.parse(JSON.stringify(context)))
    assert.ok(received.untrusted_context.includes("Use the attached Q3 figures"))
    assert.ok(received.untrusted_context.includes("Example Colleague"))
    assert.ok(received.untrusted_context.includes("figures.csv"))
    // Text arrived while it was being written: the first sentence came in more than one append.
    const firstSentence = "Sure, give me a sec to put that together."
    const pieces = appends().filter((piece) => firstSentence.includes(piece.trim()) && piece.trim())
    assert.ok(pieces.length >= 2, `streamed in pieces: ${JSON.stringify(appends())}`)
    assert.equal(text(), `${firstSentence}\n\nI'm on it and will post the deck here.`)
    assert.deepEqual(calls.find((call) => call.method === "reactions.add")?.body, { channel: "C1", timestamp: "2.0", name: "thumbsup" })
    assert.deepEqual(cp.taskIds, [`${messageId}.t1`])

    // The task runs, reports back, and the report is posted once in the thread.
    let watched = false
    for (let i = 0; i < 100 && !watched; i++) {
      const result = await advanceSlackWatch({ checkpoint: cp, runner: slackRunner, slack, messageId })
      watched = result.done === true
      if (!watched) await sleep(50)
    }
    assert.ok(watched)
    const reports = calls.filter((call) => call.method === "chat.postMessage")
    assert.equal(reports.length, 1)
    assert.deepEqual(reports[0]?.body.blocks, [
      { type: "section", text: { type: "mrkdwn", text: "<@U0ABC>" } },
      { type: "markdown", text: "Your **Q3 deck** is ready: 12 slides." },
    ])
  } finally {
    await runner.idle()
    server.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
