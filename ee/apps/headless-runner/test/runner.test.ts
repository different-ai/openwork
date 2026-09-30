import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { buildContext } from "../src/runner.js"
import { Store } from "../src/store.js"
import { calls, fakeMcp, makeRunner, scriptedModel, tempDbPath, text, waitForAbort } from "./helpers.js"

const creds = { modelApiKey: "ow_gw_model_secret_value", mcpToken: "ow_mcp_at_secret_value" }

test("completes a turn through MCP and the scratch filesystem", async () => {
  const mcp = fakeMcp({ search_capabilities: () => "slack.search: found 2 messages" })
  const { model, requests } = scriptedModel([
    calls({ id: "c1", name: "search_capabilities", input: { query: "slack" } }),
    calls({ id: "c2", name: "write_file", input: { path: "drafts/digest.md", content: "# Digest" } }),
    text("Here is your digest."),
  ])
  const { store, runner } = makeRunner({ model, mcp: mcp.connector })
  const session = store.createSession({ title: "Slack digest" })

  const sent = runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "digest #launch", credentials: creds })
  assert.equal(sent.ok && sent.state, "accepted")
  await runner.idle()

  const turn = store.getTurn(session.id, "msg_1")
  assert.equal(turn?.status, "completed")
  assert.deepEqual(turn?.usage, { inputTokens: 30, cachedInputTokens: 12, outputTokens: 15 })
  assert.equal(store.readFile(session.id, "drafts/digest.md"), "# Digest")
  assert.deepEqual(mcp.seen, [{ token: creds.mcpToken, name: "search_capabilities", input: { query: "slack" } }])
  assert.equal(requests[0].apiKey, creds.modelApiKey)
  assert.equal(requests[0].model, "gwm_test")
  assert.ok(requests[0].tools.some((tool) => tool.name === "search_capabilities"))
  assert.ok(requests[0].tools.some((tool) => tool.name === "write_file"))
  const last = store.messages(session.id).at(-1)?.message
  assert.deepEqual(last, { role: "assistant", text: "Here is your digest.", toolCalls: [] })
})

test("never writes caller credentials to disk", async () => {
  const path = tempDbPath()
  const mcp = fakeMcp({ lookup: () => "ok" })
  const { model } = scriptedModel([calls({ id: "c1", name: "lookup", input: {} }), text("done")])
  const { store, runner } = makeRunner({ store: new Store(path), model, mcp: mcp.connector })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "go", credentials: creds })
  await runner.idle()
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  const bytes = readFileSync(path).toString("latin1")
  assert.ok(bytes.includes("done"))
  assert.ok(!bytes.includes(creds.modelApiKey))
  assert.ok(!bytes.includes(creds.mcpToken))
})

test("sending the same messageId is idempotent; a second turn waits for the first", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { model, requests } = scriptedModel([async () => (await gate, text("one"))])
  const { store, runner } = makeRunner({ model })
  const session = store.createSession({})

  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "first", credentials: creds })
  const again = runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "first", credentials: creds })
  assert.equal(again.ok && again.state, "already_present")
  const busy = runner.send({ sessionId: session.id, messageId: "msg_2", prompt: "second", credentials: creds })
  assert.deepEqual(busy, { ok: false, error: "session_busy" })
  release()
  await runner.idle()
  assert.equal(requests.length, 1)
  assert.equal(store.listTurns(session.id).length, 1)
})

test("a crash mid-tool-call resumes without re-running the tool", async () => {
  const path = tempDbPath()
  const crashed = new Store(path)
  const session = crashed.createSession({})
  crashed.admitTurn({ sessionId: session.id, messageId: "msg_1", prompt: "post the update", model: null })
  crashed.setTurnStatus(session.id, "msg_1", "running")
  crashed.appendMessage(session.id, "msg_1", {
    role: "assistant",
    text: "",
    toolCalls: [{ id: "c1", name: "execute_capability", input: { name: "slack.post" } }],
  })
  crashed.close()

  const store = new Store(path)
  assert.equal(store.recoverInterruptedTurns(), 1)
  assert.equal(store.getTurn(session.id, "msg_1")?.status, "interrupted")

  const mcp = fakeMcp({ execute_capability: () => "posted" })
  const { model, requests } = scriptedModel([text("I could not confirm the post; please check Slack.")])
  const { runner } = makeRunner({ store, model, mcp: mcp.connector })
  const resumed = runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "ignored", credentials: creds })
  assert.equal(resumed.ok && resumed.state, "resumed")
  await runner.idle()

  assert.equal(mcp.seen.length, 0, "the possibly-executed tool call must not run again")
  assert.equal(store.getTurn(session.id, "msg_1")?.status, "completed")
  const toolResult = requests[0].messages.find((message) => message.role === "tool")
  assert.equal(toolResult?.role === "tool" && toolResult.isError, true)
  assert.equal(store.messages(session.id).filter((entry) => entry.message.role === "user").length, 1)
})

test("abort stops a running turn and closes open tool calls", async () => {
  const { model } = scriptedModel([
    calls({ id: "c1", name: "slow", input: {} }),
  ])
  const slow = fakeMcp({})
  const { store, runner } = makeRunner({
    model,
    mcp: async (input) => ({
      ...(await slow.connector(input)),
      tools: [{ name: "slow", description: "slow", inputSchema: { type: "object" } }],
      call: (_name, _input, signal) => waitForAbort(signal),
    }),
  })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "go", credentials: creds })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(runner.abort(session.id), true)
  await runner.idle()
  assert.equal(store.getTurn(session.id, "msg_1")?.status, "aborted")
  const last = store.messages(session.id).at(-1)?.message
  assert.equal(last?.role === "tool" && last.isError, true)
  const aborted = runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "go", credentials: creds })
  assert.equal(aborted.ok && aborted.state, "already_present", "an aborted turn is not resumed")
})

test("turn timeout fails the turn instead of hanging", async () => {
  const { model } = scriptedModel([(request) => waitForAbort(request.signal)])
  const { store, runner } = makeRunner({
    model,
    limits: { maxConcurrentTurns: 1, maxSteps: 4, turnTimeoutMs: 30, contextCharBudget: 10_000 },
  })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "go", credentials: creds })
  await runner.idle()
  assert.deepEqual(
    { status: store.getTurn(session.id, "msg_1")?.status, error: store.getTurn(session.id, "msg_1")?.error },
    { status: "failed", error: "turn_timeout" },
  )
})

test("fails clearly without model credentials and caps runaway loops", async () => {
  const { model } = scriptedModel(Array.from({ length: 10 }, (_, i) => calls({ id: `c${i}`, name: "list_files", input: {} })))
  const { store, runner } = makeRunner({ model })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "go", credentials: {} })
  await runner.idle()
  assert.equal(store.getTurn(session.id, "msg_1")?.error, "model_credentials_missing")

  runner.send({ sessionId: session.id, messageId: "msg_2", prompt: "loop", credentials: creds })
  await runner.idle()
  assert.equal(store.getTurn(session.id, "msg_2")?.error, "max_steps_exceeded")
})

test("concurrency limit queues turns across sessions", async () => {
  let inFlight = 0
  let peak = 0
  const step = async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 10))
    inFlight -= 1
    return text("ok")
  }
  const { model } = scriptedModel(Array.from({ length: 6 }, () => step))
  const { store, runner } = makeRunner({
    model,
    limits: { maxConcurrentTurns: 2, maxSteps: 4, turnTimeoutMs: 60_000, contextCharBudget: 10_000 },
  })
  for (let i = 0; i < 6; i += 1) {
    const session = store.createSession({})
    runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "hi", credentials: creds })
  }
  await runner.idle()
  assert.equal(peak, 2)
})

test("many members at once: each turn uses only its own credentials, transcript and files", async () => {
  const members = Array.from({ length: 40 }, (_, i) => `member${i}`)
  const seen: Array<{ token: string; input: Record<string, unknown> }> = []
  const { store, runner } = makeRunner({
    limits: { maxConcurrentTurns: 16, maxSteps: 4, turnTimeoutMs: 60_000, contextCharBudget: 100_000 },
    // Every turn: one MCP call, one file write, then an answer — with random latency so turns interleave.
    model: {
      async complete(request) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 15))
        const user = request.messages.find((message) => message.role === "user")
        const who = user?.role === "user" ? user.text : "?"
        const steps = request.messages.filter((message) => message.role === "assistant").length
        if (steps === 0) return calls({ id: `${who}-1`, name: "whoami", input: { who } })
        if (steps === 1) return calls({ id: `${who}-2`, name: "write_file", input: { path: "me.txt", content: who } })
        return text(`done for ${who}`)
      },
    },
    mcp: async ({ token }) => ({
      tools: [{ name: "whoami", description: "", inputSchema: { type: "object" } }],
      async call(_name, input) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 15))
        seen.push({ token, input })
        return { output: token, isError: false }
      },
      async close() {},
    }),
  })
  const sessions = members.map((member) => ({ member, session: store.createSession({ title: member }) }))
  for (const { member, session } of sessions) {
    runner.send({
      sessionId: session.id,
      messageId: "msg_1",
      prompt: member,
      credentials: { modelApiKey: "k", mcpToken: `token-for-${member}` },
    })
  }
  await runner.idle()

  for (const { member, session } of sessions) {
    assert.equal(store.getTurn(session.id, "msg_1")?.status, "completed")
    assert.equal(store.readFile(session.id, "me.txt"), member)
    const toolOutput = store.messages(session.id).find((entry) => entry.message.role === "tool")?.message
    assert.equal(toolOutput?.role === "tool" && toolOutput.output, `token-for-${member}`)
  }
  assert.equal(seen.length, members.length)
  for (const call of seen) assert.equal(call.token, `token-for-${String(call.input.who)}`)
})

test("context keeps whole recent turns within budget", () => {
  const entry = (seq: number, messageId: string, body: string) => ({
    seq,
    messageId,
    message: { role: "user" as const, text: body },
  })
  const messages = [entry(1, "a", "x".repeat(500)), entry(2, "b", "y".repeat(500)), entry(3, "c", "z")]
  const context = buildContext(messages, "c", 700)
  assert.deepEqual(context.map((message) => message.role === "user" && message.text[0]), ["y", "z"])
})
