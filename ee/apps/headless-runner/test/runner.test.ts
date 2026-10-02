import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { buildContext, TRIMMED_TOOL_OUTPUT } from "../src/runner.js"
import { Store, type StoredMessage } from "../src/store.js"
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

test("sending the same messageId is idempotent", async () => {
  const { model, requests } = scriptedModel([text("one")])
  const { store, runner } = makeRunner({ model })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "first", credentials: creds })
  const again = runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "first", credentials: creds })
  assert.equal(again.ok && again.state, "already_present")
  await runner.idle()
  assert.equal(requests.length, 1)
  assert.equal(store.listTurns(session.id).length, 1)
})

test("follow-ups sent while a turn runs are accepted, answered in order, and see earlier answers", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { model, requests } = scriptedModel([
    async () => (await gate, text("Digest for #launch.")),
    text("Added links."),
    text("Shortened."),
  ])
  const { store, runner } = makeRunner({ model })
  const session = store.createSession({})

  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "summarize #launch", credentials: creds })
  const second = runner.send({ sessionId: session.id, messageId: "msg_2", prompt: "and include links", credentials: creds })
  const third = runner.send({ sessionId: session.id, messageId: "msg_3", prompt: "keep it short", credentials: creds })
  assert.equal(second.ok && second.state, "accepted")
  assert.equal(third.ok && third.turn.status, "queued")
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(requests.length, 1, "follow-ups wait for the running turn instead of racing it")
  assert.ok(
    !requests[0].messages.some((message) => message.role === "user" && message.text === "and include links"),
    "a queued follow-up never leaks into the running turn",
  )
  release()
  await runner.idle()

  assert.deepEqual(store.listTurns(session.id).map((turn) => turn.status), ["completed", "completed", "completed"])
  assert.deepEqual(
    store.messages(session.id).map((entry) => (entry.message.role === "tool" ? "tool" : entry.message.text)),
    ["summarize #launch", "Digest for #launch.", "and include links", "Added links.", "keep it short", "Shortened."],
  )
  const lastContext = requests[2].messages.map((message) => (message.role === "tool" ? "tool" : message.text))
  assert.deepEqual(lastContext.slice(0, 4), ["summarize #launch", "Digest for #launch.", "and include links", "Added links."])
})

test("stop targets one message, or the whole conversation", async () => {
  const { model } = scriptedModel([(request) => waitForAbort(request.signal), text("second answer")])
  const { store, runner } = makeRunner({ model })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "slow", credentials: creds })
  runner.send({ sessionId: session.id, messageId: "msg_2", prompt: "next", credentials: creds })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runner.abort(session.id, "msg_1"), true)
  await runner.idle()
  assert.deepEqual(store.listTurns(session.id).map((turn) => turn.status), ["aborted", "completed"])

  const other = store.createSession({})
  const { model: slow } = scriptedModel([(request) => waitForAbort(request.signal)])
  const second = makeRunner({ store, model: slow })
  second.runner.send({ sessionId: other.id, messageId: "a", prompt: "x", credentials: creds })
  second.runner.send({ sessionId: other.id, messageId: "b", prompt: "y", credentials: creds })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(second.runner.abort(other.id), true)
  await second.runner.idle()
  assert.deepEqual(store.listTurns(other.id).map((turn) => turn.status), ["aborted", "aborted"])
})

test("a runaway queue is capped per conversation", () => {
  const { model } = scriptedModel([(request) => waitForAbort(request.signal)])
  const { store, runner } = makeRunner({ model })
  const session = store.createSession({})
  const results = Array.from({ length: 23 }, (_, i) =>
    runner.send({ sessionId: session.id, messageId: `m${i}`, prompt: "x", credentials: creds }),
  )
  assert.deepEqual(results.at(-1), { ok: false, error: "too_many_queued" })
  assert.equal(results.filter((result) => result.ok).length, 21, "one running plus twenty queued")
  runner.abort(session.id)
})

test("a crash mid-tool-call resumes without re-running the tool", async () => {
  const path = tempDbPath()
  const crashed = new Store(path)
  const session = crashed.createSession({})
  crashed.admitTurn({ sessionId: session.id, messageId: "msg_1", prompt: "post the update", model: null })
  crashed.setTurnStatus(session.id, "msg_1", "running")
  crashed.startTranscript(session.id, "msg_1")
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
    limits: { maxConcurrentTurns: 1, maxSteps: 4, turnTimeoutMs: 30, credentialRefreshMs: 3_600_000, contextCharBudget: 10_000 },
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
  const { model } = scriptedModel(Array.from({ length: 10 }, (_, i) => calls({ id: `c${i}`, name: "list_files", input: { attempt: i } })))
  const { store, runner } = makeRunner({ model })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "go", credentials: {} })
  await runner.idle()
  assert.equal(store.getTurn(session.id, "msg_1")?.error, "model_credentials_missing")

  runner.send({ sessionId: session.id, messageId: "msg_2", prompt: "loop", credentials: creds })
  await runner.idle()
  assert.equal(store.getTurn(session.id, "msg_2")?.error, "max_steps_exceeded")
})

const unbounded = {
  maxConcurrentTurns: 4,
  maxSteps: Number.POSITIVE_INFINITY,
  turnTimeoutMs: Number.POSITIVE_INFINITY,
  credentialRefreshMs: 0,
  contextCharBudget: 100_000,
}

test("a long turn pauses between steps for a fresh MCP token and resumes without repeating a tool call", async () => {
  const mcp = fakeMcp({ lookup: (input) => `result ${String(input.n)}` })
  const { model } = scriptedModel([
    calls({ id: "c1", name: "lookup", input: { n: 1 } }),
    calls({ id: "c2", name: "lookup", input: { n: 2 } }),
    text("All done."),
  ])
  const { store, runner } = makeRunner({ model, mcp: mcp.connector, limits: unbounded })
  const session = store.createSession({})
  const turn = () => store.getTurn(session.id, "msg_1")

  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "go", credentials: { modelApiKey: "k", mcpToken: "token-1" } })
  await runner.idle()
  assert.deepEqual([turn()?.status, turn()?.error], ["interrupted", "credentials_refresh"], "paused after a finished step, not mid-call")

  for (const token of ["token-2", "token-3"]) {
    const resumed = runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "resume", credentials: { modelApiKey: "k", mcpToken: token } })
    assert.equal(resumed.ok && resumed.state, "resumed")
    await runner.idle()
  }
  assert.equal(turn()?.status, "completed")
  assert.deepEqual(
    mcp.seen.map((call) => [call.token, call.input.n]),
    [["token-1", 1], ["token-2", 2]],
    "each stretch uses its own token and no call runs twice",
  )
  assert.equal(store.messages(session.id).filter((entry) => entry.message.role === "user").length, 1)
})

test("a turn without an MCP token has nothing to refresh and never pauses", async () => {
  const { model } = scriptedModel([calls({ id: "c1", name: "write_file", input: { path: "a.md", content: "a" } }), text("done")])
  const { store, runner } = makeRunner({ model, limits: unbounded })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "go", credentials: { modelApiKey: "k" } })
  await runner.idle()
  assert.equal(store.getTurn(session.id, "msg_1")?.status, "completed")
})

test("a model repeating the same call and getting the same result is stopped; changing results keep it going", async () => {
  const sameCall = (i: number) => calls({ id: `c${i}`, name: "check_ci", input: { pr: 7 } })
  const limits = { ...unbounded, credentialRefreshMs: 3_600_000 }

  const stuck = fakeMcp({ check_ci: () => "still pending" })
  const looping = makeRunner({ model: scriptedModel(Array.from({ length: 9 }, (_, i) => sameCall(i))).model, mcp: stuck.connector, limits })
  const first = looping.store.createSession({})
  looping.runner.send({ sessionId: first.id, messageId: "msg_1", prompt: "wait for CI", credentials: { modelApiKey: "k", mcpToken: "t" } })
  await looping.runner.idle()
  const turn = looping.store.getTurn(first.id, "msg_1")
  assert.deepEqual([turn?.status, turn?.error], ["failed", "stuck_repeating"])
  assert.equal(stuck.seen.length, 5)

  let polls = 0
  const moving = fakeMcp({ check_ci: () => `pending, ${++polls} of 6 jobs done` })
  const progressing = makeRunner({
    model: scriptedModel([...Array.from({ length: 6 }, (_, i) => sameCall(i)), text("CI passed.")]).model,
    mcp: moving.connector,
    limits,
  })
  const second = progressing.store.createSession({})
  progressing.runner.send({ sessionId: second.id, messageId: "msg_1", prompt: "wait for CI", credentials: { modelApiKey: "k", mcpToken: "t" } })
  await progressing.runner.idle()
  assert.equal(progressing.store.getTurn(second.id, "msg_1")?.status, "completed")
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
    limits: { maxConcurrentTurns: 2, maxSteps: 4, turnTimeoutMs: 60_000, credentialRefreshMs: 3_600_000, contextCharBudget: 10_000 },
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
    limits: { maxConcurrentTurns: 16, maxSteps: 4, turnTimeoutMs: 60_000, credentialRefreshMs: 3_600_000, contextCharBudget: 100_000 },
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

test("an image from a tool is shown to the model in its turn, then dropped from later context and from the API", async () => {
  const image = { mediaType: "image/png", data: "QUJD" }
  const { model, requests } = scriptedModel([
    calls({ id: "c1", name: "slack_read_file", input: { file_id: "F1" } }),
    text("It says hello."),
    text("Sure."),
  ])
  const { store, runner } = makeRunner({
    model,
    mcp: async () => ({
      tools: [{ name: "slack_read_file", description: "read", inputSchema: { type: "object" } }],
      async call() {
        return { output: "[image 1: image/png, attached]", isError: false, images: [image] }
      },
      async close() {},
    }),
  })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "what is written here", credentials: creds })
  await runner.idle()
  const toolInTurn = requests[1].messages.find((message) => message.role === "tool")
  assert.deepEqual(toolInTurn?.role === "tool" && toolInTurn.images, [image])

  runner.send({ sessionId: session.id, messageId: "msg_2", prompt: "thanks", credentials: creds })
  await runner.idle()
  const toolLater = requests[2].messages.find((message) => message.role === "tool")
  assert.equal(toolLater?.role === "tool" && toolLater.images, undefined)
})

test("idle conversations expire with their transcript and files, but never one with a turn in progress", () => {
  let clock = 1_000
  const store = new Store(tempDbPath(), () => clock)
  const old = store.createSession({})
  store.admitTurn({ sessionId: old.id, messageId: "m", prompt: "hi", model: null })
  store.startTranscript(old.id, "m")
  store.writeFile(old.id, "notes.md", "x")
  store.setTurnStatus(old.id, "m", "completed")
  const busy = store.createSession({})
  store.admitTurn({ sessionId: busy.id, messageId: "m", prompt: "long task", model: null })
  store.setTurnStatus(busy.id, "m", "running")
  clock = 10 * 86_400_000
  const recent = store.createSession({})

  assert.equal(store.pruneIdleSessions(clock - 7 * 86_400_000), 1)
  assert.equal(store.getSession(old.id), null)
  assert.deepEqual(store.messages(old.id), [])
  assert.equal(store.readFile(old.id, "notes.md"), null)
  assert.ok(store.getSession(busy.id), "a running turn keeps its conversation")
  assert.ok(store.getSession(recent.id))
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

test("a long turn keeps every call but drops its oldest large outputs, in blocks, to fit the budget", () => {
  let seq = 0
  const messages: StoredMessage[] = [{ seq: ++seq, messageId: "m", message: { role: "user", text: "fix the PR" } }]
  for (let i = 0; i < 20; i += 1) {
    messages.push({ seq: ++seq, messageId: "m", message: { role: "assistant", text: "", toolCalls: [{ id: `c${i}`, name: "fetch", input: {} }] } })
    messages.push({ seq: ++seq, messageId: "m", message: { role: "tool", callId: `c${i}`, name: "fetch", output: `${i}:`.padEnd(5_000, "x"), isError: false } })
  }
  messages.push({ seq: ++seq, messageId: "m", message: { role: "tool", callId: "short", name: "fetch", output: "ok", isError: false } })
  const outputs = (budget: number) =>
    buildContext(messages, "m", budget).flatMap((message) => (message.role === "tool" ? [message.output] : []))

  assert.ok(outputs(1_000_000).every((output) => output !== TRIMMED_TOOL_OUTPUT), "a turn within budget is untouched")

  // About 106,000 characters against a 60,000 budget: 10 outputs must go, which rounds up to two blocks of 8.
  const fitted = outputs(60_000)
  assert.equal(fitted.length, 21, "every tool call keeps a result, so the transcript stays valid")
  assert.equal(fitted.filter((output) => output === TRIMMED_TOOL_OUTPUT).length, 16)
  assert.ok(fitted.slice(0, 16).every((output) => output === TRIMMED_TOOL_OUTPUT), "the oldest go first")
  assert.ok(fitted[16].startsWith("16:"), "the newest outputs stay")
  assert.equal(fitted.at(-1), "ok", "short outputs are never replaced")

  // One more step: the same 16 are trimmed, so the cached prefix is unchanged.
  messages.push({ seq: ++seq, messageId: "m", message: { role: "assistant", text: "", toolCalls: [{ id: "c20", name: "fetch", input: {} }] } })
  messages.push({ seq: ++seq, messageId: "m", message: { role: "tool", callId: "c20", name: "fetch", output: "20:".padEnd(5_000, "x"), isError: false } })
  assert.deepEqual(outputs(60_000).slice(0, 21), fitted)
})
