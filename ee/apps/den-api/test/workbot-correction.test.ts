import assert from "node:assert/strict"
import { test } from "node:test"
import { createHeadlessRunnerClient } from "../../../packages/headless-protocol/src/client.ts"
import { editWorkbotMessage, type WorkbotActor } from "../../../packages/workbot-server/src/service.ts"
import { readWorkbotContextPrompt, readWorkbotCorrectionPrompt, workbotContextPrompt, workbotCorrectionPrompt, WORKBOT_MAX_MESSAGE_CHARS } from "../../../../packages/types/src/workbot-context.ts"

const actor: WorkbotActor = { organizationId: "org_example", organizationName: "Example", organizationMetadata: {}, memberId: "member_example", userId: "user_example", firstName: "Alex" }

function fixture() {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  let refuse = true
  const turns = ["wb_original1", "wb_followup1"]
  const client = createHeadlessRunnerClient({
    config: { url: "http://runner", token: "local-fixture-token" }, maxTokenTtlMs: 1000,
    mintToken: async () => ({ token: "local-member-token" }),
    fetch: async (url, init) => {
      const method = init?.method ?? "GET"
      const path = new URL(String(url)).pathname
      const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {}
      calls.push({ method, path, body })
      if (method === "DELETE") {
        if (!turns.includes(path.split("/").pop() ?? "")) return Response.json({ error: "unknown_message" }, { status: 404 })
        const removed = turns.splice(0)
        return Response.json({ removed })
      }
      if (method === "GET") return Response.json({ turns: turns.map((messageId, index) => ({ messageId, status: "completed", createdAt: 100 + index, error: null })), messages: turns.map(messageId => ({ role: "user", messageId, text: "Use Monday" })), finalAssistantText: "Earlier answer" })
      if (method === "PUT") return Response.json({ id: path.split("/").pop() })
      if (refuse) return Response.json({ error: "too_many_queued" }, { status: 429 })
      if (typeof body.messageId === "string" && !turns.includes(body.messageId)) turns.push(body.messageId)
      return Response.json({ state: "accepted" }, { status: 202 })
    },
  })
  return { client, calls, turns, accept: () => { refuse = false } }
}

test("a refused correction keeps the original and all later turns; retry uses the same new id", async () => {
  const runner = fixture()
  const deps = { client: runner.client, canSchedule: async () => false }
  const input = { id: "original1", newId: "corrected1", text: "Use Friday", attachments: ["file_example"] }
  assert.deepEqual(await editWorkbotMessage(actor, input, deps), { ok: false, code: "too_many_queued" })
  assert.deepEqual(runner.turns, ["wb_original1", "wb_followup1"])
  runner.accept()
  assert.deepEqual(await editWorkbotMessage(actor, input, deps), { ok: true })
  assert.deepEqual(await editWorkbotMessage(actor, input, deps), { ok: true })
  assert.deepEqual(runner.turns, ["wb_original1", "wb_followup1", "wb_corrected1"])
  assert.equal(runner.calls.some(call => call.method === "DELETE"), false)
  const sends = runner.calls.filter(call => call.method === "POST")
  assert.equal(sends.length, 3)
  for (const send of sends) {
    assert.equal(send.body.messageId, "wb_corrected1")
    assert.equal(send.body.prompt, '[OpenWork correction reference v1]\n{"messageId":"wb_original1","quote":"Use Monday","sentAt":100}\n[End OpenWork correction reference]\n\nUse Friday')
    assert.deepEqual(send.body.attachments, ["file_example"])
  }
})

test("identical earlier messages retain distinct authoritative correction targets", async () => {
  const runner = fixture()
  runner.accept()
  const deps = { client: runner.client, canSchedule: async () => false }
  await editWorkbotMessage(actor, { id: "followup1", newId: "corrected2", text: "Use Thursday" }, deps)
  const sent = runner.calls.find(call => call.method === "POST")
  assert.equal(typeof sent?.body.prompt, "string")
  const visible = readWorkbotCorrectionPrompt(String(sent?.body.prompt))
  assert.deepEqual(visible, { text: "Use Thursday", correction: { messageId: "wb_followup1", quote: "Use Monday", sentAt: 101 } })
  assert.deepEqual(runner.turns, ["wb_original1", "wb_followup1", "wb_corrected2"])
})

test("the final serialized correction budget includes its reference and view context", async () => {
  const runner = fixture()
  runner.accept()
  const deps = { client: runner.client, canSchedule: async () => false }
  const context = { kind: "document", provider: "google-drive", fileId: "file_example", title: "Project notes", mimeType: "text/plain", unsaved: false } as const
  const reference = { messageId: "wb_original1", quote: "Use Monday", sentAt: 100 }
  const overhead = workbotContextPrompt(workbotCorrectionPrompt("", reference), context).length
  const text = "x".repeat(WORKBOT_MAX_MESSAGE_CHARS - overhead)
  assert.deepEqual(await editWorkbotMessage(actor, { id: "original1", newId: "boundary1", text: text + "x", context }, deps), { ok: false, code: "message_too_long" })
  assert.equal(runner.calls.some(call => call.method === "POST" || call.method === "PUT"), false, "too-long corrections never reach session mutation or the runner")
  assert.deepEqual(await editWorkbotMessage(actor, { id: "original1", newId: "boundary1", text, context }, deps), { ok: true })
  const prompt = String(runner.calls.find(call => call.method === "POST")?.body.prompt)
  assert.equal(prompt.length, WORKBOT_MAX_MESSAGE_CHARS)
  assert.equal(readWorkbotCorrectionPrompt(readWorkbotContextPrompt(prompt).text).text, text)
})

test("an unknown original never sends or deletes anything", async () => {
  const runner = fixture()
  assert.deepEqual(await editWorkbotMessage(actor, { id: "unknown01", newId: "corrected1", text: "Use Friday" }, { client: runner.client, canSchedule: async () => false }), { ok: false, code: "unknown_message" })
  assert.equal(runner.calls.some(call => call.method === "POST"), false)
  assert.deepEqual(runner.turns, ["wb_original1", "wb_followup1"])
})
