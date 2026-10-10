import assert from "node:assert/strict"
import { test } from "node:test"
import { createSlackRunner, type HeadlessDeps, type SlackRunner, type SlackRunSnapshot } from "../src/slack-assistant/headless.js"
import { advanceSlackRun, checkpointSchema, RemoteSessionUnavailableError, type Checkpoint } from "../src/slack-assistant/run.js"

/** Records Slack calls; streams get a ts so appends can follow. */
function fakeSlack() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  let ts = 0
  const slack = async (method: string, body: Record<string, unknown>) => {
    calls.push({ method, body })
    return method === "chat.startStream" || method === "chat.postMessage" ? { ok: true, ts: `1.${++ts}` } : { ok: true }
  }
  const text = () =>
    calls
      .flatMap((call) => (Array.isArray(call.body.chunks) ? call.body.chunks : []))
      .map((chunk: { text?: string }) => chunk.text ?? "")
      .join("")
  return { calls, slack, text }
}

const idle = (text: string): SlackRunSnapshot => ({ status: "idle", finalAssistantText: text, lastAssistantText: text, steps: [] })

function fakeRunner(overrides: Partial<SlackRunner> = {}) {
  const sent: Array<{ sessionId: string; prompt: string }> = []
  let created = 0
  const runner: SlackRunner = {
    create: async () => ({ ok: true, sessionId: `hs_new${++created}` }),
    send: async (input) => {
      sent.push(input)
      return { ok: true }
    },
    read: async () => ({ ok: true, snapshot: idle("Here you go.") }),
    stop: async () => {},
    ...overrides,
  }
  return { runner, sent, created: () => created }
}

async function drive(input: {
  cp: Checkpoint
  runner: SlackRunner
  slack: ReturnType<typeof fakeSlack>["slack"]
  saved: string[]
  cleared: { count: number }
}) {
  for (let i = 0; i < 20; i++) {
    const result = await advanceSlackRun({
      checkpoint: input.cp,
      runner: input.runner,
      slack: input.slack,
      messageId: "msg_1",
      title: "C1 · hi",
      saveSession: async (id) => {
        input.saved.push(id)
      },
      clearSession: async () => {
        input.cleared.count += 1
      },
    })
    if (result.done) return result
  }
  throw new Error("run did not finish")
}

test("a thread whose saved session is gone on the runner runs the same message in a fresh session", async () => {
  const { slack, text } = fakeSlack()
  const { runner, sent } = fakeRunner({
    send: async (input) => {
      sent.push(input)
      return input.sessionId === "ses_from_openwork_web" ? { ok: false, error: "unknown_session", retryable: false } : { ok: true }
    },
  })
  const cp = checkpointSchema.parse({ phase: "create", sessionId: "ses_from_openwork_web", prompt: "envelope", channel: "C1", threadTs: "1.0", live: true })
  const saved: string[] = []
  const cleared = { count: 0 }
  await drive({ cp, runner, slack, saved, cleared })
  assert.equal(cleared.count, 1)
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
  const { runner } = fakeRunner({
    read: async () => (++reads <= 2 ? { ok: false, error: "unknown_session", retryable: false } : { ok: true, snapshot: idle("x") }),
  })
  const cp = checkpointSchema.parse({ phase: "read", sessionId: "hs_old", prompt: "envelope", channel: "C1", threadTs: "1.0" })
  await assert.rejects(drive({ cp, runner, slack, saved: [], cleared: { count: 0 } }), RemoteSessionUnavailableError)
  assert.equal(cp.sessionResets, 1)
})

test("the runner adapter reports a missing session as unknown_session", async () => {
  const deps: HeadlessDeps = {
    config: { url: "http://headless-runner:8795", token: "t".repeat(40) },
    fetch: async () => new Response(JSON.stringify({ error: "unknown_session" }), { status: 404 }),
    mintToken: async () => ({ token: "ow_mcp_at_run_1" }),
    maxTokenTtlMs: 3_600_000,
  }
  const runner = createSlackRunner({ userId: "usr_1", organizationId: "org_1" }, deps)
  assert.deepEqual(await runner.send({ sessionId: "hs_x", messageId: "msg_1", prompt: "p" }), { ok: false, error: "unknown_session", retryable: false })
  assert.deepEqual(await runner.read({ sessionId: "hs_x", messageId: "msg_1" }), { ok: false, error: "unknown_session", retryable: false })
})

test("without a runner every call fails without retrying", async () => {
  const runner = createSlackRunner({ userId: "usr_1", organizationId: "org_1" }, null)
  const created = await runner.create({ title: "t" })
  assert.equal(created.ok, false)
  assert.equal(created.ok === false && created.retryable, false)
})
