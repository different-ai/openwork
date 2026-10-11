import assert from "node:assert/strict"
import { realpath } from "node:fs/promises"
import { test } from "node:test"
import { createNativeOpenCodeAdapter, nativeWorkspace } from "./native-opencode.ts"
import { createNativeHost } from "./test-native.ts"

const signal = () => new AbortController().signal
const command = { kind: "remote_session_create", commandId: "cmd_example", title: "Remote task", prompt: "Review", model: null,
  expiresAt: 100_000 } satisfies Parameters<ReturnType<typeof createNativeOpenCodeAdapter>["create"]>[0]

async function fixture() {
  const host = createNativeHost()
  const options = { ctx: host.ctx, directory: await realpath(host.ctx.location.directory), workspaceId: "opaque_workspace", storagePrefix: "account/native", now: () => 5000 }
  return { host, options, adapter: createNativeOpenCodeAdapter(options) }
}

test("uses only verified host create/location/model and durable prompt id shapes", async () => {
  const { host, adapter } = await fixture()
  const receipt = await adapter.create({ ...command, model: { providerId: "provider", modelId: "model", variant: "careful" } }, signal())
  assert.deepEqual(host.calls.find(call => call.method === "session.create")?.input,
    { id: "ses_cmdexample", title: "Remote task", location: host.ctx.location,
      metadata: { openwork: { commandId: command.commandId } }, model: { providerID: "provider", id: "model", variant: "careful" } })
  assert.deepEqual(receipt, { sessionId: "ses_cmdexample", workspaceId: "opaque_workspace" })
  await adapter.send(receipt, { prompt: "Review", messageId: "msg_stable1", model: { providerId: "provider", modelId: "model", variant: "careful" } }, signal())
  assert.deepEqual(host.calls.find(call => call.method === "session.prompt")?.input,
    { sessionID: receipt.sessionId, id: "msg_stable1", text: "Review", delivery: "queue", resume: true })
  assert.deepEqual(host.calls.find(call => call.method === "session.switchModel")?.input,
    { sessionID: receipt.sessionId, model: { providerID: "provider", id: "model", variant: "careful" } })
})

test("deterministic creation replays an existing native session and rejects metadata/location conflicts", async () => {
  const { host, adapter } = await fixture()
  const receipt = await adapter.create(command, signal())
  assert.deepEqual(await adapter.create(command, signal()), receipt)
  assert.equal(host.sessions.size, 1)
  const info = host.sessions.get(receipt.sessionId)!
  host.sessions.set(receipt.sessionId, { ...info, metadata: { openwork: { commandId: "cmd_other" } } })
  await assert.rejects(adapter.create(command, signal()), /belongs to different work/)
  host.sessions.set(receipt.sessionId, { ...info, location: { directory: "/" } })
  await assert.rejects(adapter.create(command, signal()), /different Location/)
  assert.equal(host.calls.filter(call => call.method === "session.prompt").length, 0)
})

test("stable admissions survive adapter restart and compaction without another prompt or model switch", async () => {
  const { host, adapter, options } = await fixture()
  const receipt = await adapter.create(command, signal())
  const prompt = { prompt: "Review", messageId: "msg_stable1", model: null }
  await adapter.send(receipt, prompt, signal())
  host.histories.set(receipt.sessionId, [{ type: "compaction", id: "msg_compacted", status: "completed", time: { created: 2000 } }])
  assert.deepEqual(await createNativeOpenCodeAdapter(options).send(receipt, prompt, signal()), { messageId: prompt.messageId, alreadyPresent: true })
  assert.equal(host.calls.filter(call => call.method === "session.prompt").length, 1)
})

test("the first prompt settles after compaction removes its user id even with no previous idle boundary", async () => {
  const { host, adapter, options } = await fixture()
  const receipt = await adapter.create(command, signal())
  await adapter.send(receipt, { prompt: "First", messageId: "msg_first", model: null }, signal())
  host.finish(receipt.sessionId, "An answer now outside recent context")
  host.histories.set(receipt.sessionId, [
    { type: "compaction", id: "msg_compaction", status: "completed", time: { created: 5000 } },
    { type: "idle", id: "msg_compactedIdle", outcome: "succeeded", time: { created: 6000 } },
  ])
  const info = host.sessions.get(receipt.sessionId)!
  host.sessions.set(receipt.sessionId, { ...info, time: { ...info.time, idle: 6000 } })
  const restarted = createNativeOpenCodeAdapter(options)
  const progress = await restarted.observe(receipt, signal())
  assert.equal(progress.status, "idle")
  assert.equal(progress.finalText, "", "do not invent an answer unavailable through native recent context")
  const read = await restarted.read(receipt, { from: "start", cursor: null, limit: 100 }, signal())
  assert.equal(read.historyScope, "context")
  assert.equal(read.status, "idle")
  assert.equal(read.lastError, null)
})

test("rejects foreign workspaces and sessions moved outside the approved native Location", async () => {
  const { host, adapter } = await fixture()
  await assert.rejects(adapter.create({ ...command, workspaceId: "another" }, signal()), /requested workspace/)
  assert.equal(host.calls.filter(call => call.method === "session.create").length, 0)
  const receipt = await adapter.create(command, signal())
  const info = host.sessions.get(receipt.sessionId)!
  host.sessions.set(receipt.sessionId, { ...info, location: { directory: "/" } })
  await assert.rejects(adapter.send(receipt, { prompt: "Review", messageId: "msg_stable1", model: null }, signal()), /moved outside/)
  assert.equal(host.calls.filter(call => call.method === "session.prompt").length, 0)
})

test("reconstructs native idle progress after restart; a follow-up cannot report the previous answer", async () => {
  const { host, adapter, options } = await fixture()
  const receipt = await adapter.create(command, signal())
  await adapter.send(receipt, { prompt: "First", messageId: "msg_first", model: null }, signal())
  host.finish(receipt.sessionId, "Previous answer")
  assert.equal((await createNativeOpenCodeAdapter(options).observe(receipt, signal())).finalText, "Previous answer")
  await adapter.send(receipt, { prompt: "Second", messageId: "msg_second", model: null }, signal())
  const running = await createNativeOpenCodeAdapter(options).observe(receipt, signal())
  assert.equal(running.status, "running")
  assert.equal(running.finalText, "")
  host.finish(receipt.sessionId, "New answer")
  const done = await createNativeOpenCodeAdapter(options).observe(receipt, signal())
  assert.equal(done.status, "idle")
  assert.equal(done.finalText, "New answer")
})

test("a settled follow-up without an assistant never returns the previous answer or question wait", async () => {
  const { host, adapter, options } = await fixture()
  const receipt = await adapter.create(command, signal())
  await adapter.send(receipt, { prompt: "First", messageId: "msg_first", model: null }, signal())
  host.finish(receipt.sessionId, "Previous answer")
  await adapter.send(receipt, { prompt: "Second", messageId: "msg_second", model: null }, signal())
  host.histories.get(receipt.sessionId)?.push({ type: "idle", id: "msg_interrupted", outcome: "interrupted", time: { created: 4000 } })
  const info = host.sessions.get(receipt.sessionId)!
  host.sessions.set(receipt.sessionId, { ...info, outcome: "interrupted", time: { ...info.time, idle: 4000 } })
  const done = await createNativeOpenCodeAdapter(options).observe(receipt, signal())
  assert.equal(done.status, "idle")
  assert.equal(done.finalText, "")
  assert.equal(done.waitingFor, null)
  assert.equal(done.messageCount, host.histories.get(receipt.sessionId)?.length)
})

test("permission and question waits are reported without replying or approving", async () => {
  const { host, adapter } = await fixture()
  const receipt = await adapter.create(command, signal())
  await adapter.send(receipt, { prompt: "Review", messageId: "msg_first", model: null }, signal())
  host.pendingPermissions = true
  assert.equal((await adapter.observe(receipt, signal())).waitingFor, "permission")
  host.pendingPermissions = false
  host.histories.get(receipt.sessionId)?.push({ type: "assistant", id: "msg_question", model: { providerID: "provider", id: "model" },
    time: { created: 2000 }, content: [{ type: "tool", id: "tool_question", name: "question", state: { status: "running", input: {} } }] })
  assert.equal((await adapter.observe(receipt, signal())).waitingFor, "question")
  assert.ok(!host.calls.some(call => /reply|rules|hook/.test(call.method)))
})

test("stop compares the native current user message and uses interrupt resume=false", async () => {
  const { host, adapter } = await fixture()
  const receipt = await adapter.create(command, signal())
  await adapter.send(receipt, { prompt: "Review", messageId: "msg_first", model: null }, signal())
  assert.deepEqual(await adapter.stop(receipt, { messageId: "msg_other" }, signal()), { stopped: false, reason: "different_turn" })
  assert.equal(host.calls.filter(call => call.method === "session.interrupt").length, 0)
  assert.deepEqual(await adapter.stop(receipt, { messageId: "msg_first" }, signal()), { stopped: true, reason: null })
  assert.deepEqual(host.calls.find(call => call.method === "session.interrupt")?.input, { sessionID: receipt.sessionId, resume: false })
})

test("pagination is over recent native context; unknown or compacted cursors fail explicitly", async () => {
  const { host, adapter } = await fixture()
  const receipt = await adapter.create(command, signal())
  await adapter.send(receipt, { prompt: "Review", messageId: "msg_first", model: null }, signal())
  host.finish(receipt.sessionId)
  const first = await adapter.read(receipt, { from: "start", cursor: null, limit: 1 }, signal())
  assert.equal(first.messages[0]?.role, "user")
  assert.ok(first.nextCursor)
  const last = await adapter.read(receipt, { from: "start", cursor: first.nextCursor, limit: 1 }, signal())
  assert.equal(last.messages[0]?.role, "assistant")
  assert.equal(last.nextCursor, null)
  await assert.rejects(adapter.read(receipt, { from: "end", cursor: first.nextCursor, limit: 1 }, signal()), /cursor is unknown/)
  host.histories.set(receipt.sessionId, [{ type: "compaction", status: "completed", id: "msg_compaction", time: { created: 2000 } }])
  await assert.rejects(adapter.read(receipt, { from: "start", cursor: first.nextCursor, limit: 1 }, signal()), /messages were compacted/)
  const compacted = await adapter.read(receipt, { from: "start", cursor: null, limit: 1 }, signal())
  assert.equal(compacted.historyScope, "context")
  assert.equal(compacted.lastError, null)
})

test("bounds multibyte transcript pages by bytes and omits reasoning", async () => {
  const { host, adapter } = await fixture()
  const receipt = await adapter.create(command, signal())
  for (let index = 0; index < 100; index++) host.histories.get(receipt.sessionId)?.push({ type: "assistant", id: `msg_large${index}`,
    model: { providerID: "provider", id: "model" }, time: { created: index + 2000 },
    content: [{ type: "text", text: "界".repeat(20_000) }, { type: "reasoning", text: "not shared" }] })
  const result = await adapter.read(receipt, { from: "end", cursor: null, limit: 100 }, signal())
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 256 * 1024)
  assert.ok(result.messages.every(message => message.truncated && !message.text.includes("not shared")))
})

test("inventory uses native location-scoped model list/default and public model ids, not upstream modelID", async () => {
  const { host } = await fixture()
  const workspace = await nativeWorkspace(host.ctx, "opaque_workspace", signal())
  assert.deepEqual(workspace.defaultModel, { providerId: "local-provider", modelId: "local-model" })
  assert.deepEqual(workspace.models, [{ providerId: "local-provider", modelId: "local-model", name: "Local model" }])
  assert.deepEqual(host.calls.filter(call => call.method.startsWith("model.")).map(call => call.input),
    [undefined, undefined])
  await assert.rejects(async () => { await Reflect.apply(host.ctx.model.list, undefined, [{ location: host.ctx.location.directory }]) }, /LocationQuery/)
  await assert.rejects(async () => { await Reflect.apply(host.ctx.model.default, undefined, [{ location: host.ctx.location.directory }]) }, /LocationQuery/)
})
