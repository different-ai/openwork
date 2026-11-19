import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { Hono } from "hono"
import { readWorkbotContextPrompt, readWorkbotCorrectionPrompt, workbotContextForModel, type WorkbotViewContext } from "@openwork/types/workbot-context"
import { createComposerState } from "../../../packages/workbot-ui/src/composer-state.js"
import { errorMessage } from "../../../packages/workbot-ui/src/host.js"
import { createAuth, type AppEnv } from "../src/server/auth.js"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

test("catalog loss inside a correction send preserves history, correction and next draft; available retries append once", async () => {
  let catalogAvailable = true
  let verifyModel = true
  let catalogReads = 0
  let deletes = 0
  let sessionWrites = 0
  const sent: Record<string, unknown>[] = []
  const turns = new Map<string, { text: string; createdAt: number; answer: string }>([
    ["wb_message_001", { text: "Use Monday", createdAt: 100, answer: "Earlier answer" }],
    ["wb_message_002", { text: "Keep the later message", createdAt: 200, answer: "Later answer" }],
  ])
  const originalHistory = structuredClone([...turns])
  const owner = createComposerState(async () => { throw new Error("This correction has no upload") })
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk
    response.setHeader("content-type", "application/json")
    if (request.headers.authorization !== `Bearer ${"r".repeat(32)}`) { response.writeHead(401).end("{}"); return }
    if (request.url === "/v1/models") {
      catalogReads++
      if (!catalogAvailable) { response.writeHead(503).end("{}"); return }
      response.end(JSON.stringify({ defaultModel: "gateway/other", verified: true, models: [{ id: "gateway/luna", name: "GPT-6 Luna" }] })); return
    }
    if (request.method === "DELETE") { deletes++; const removed = [...turns.keys()]; turns.clear(); response.end(JSON.stringify({ removed })); return }
    if (request.method === "PUT") { sessionWrites++; response.end(JSON.stringify({ id: request.url?.split("/").at(-1) })); return }
    if (request.method === "POST" && request.url?.endsWith("/turns")) {
      const body: unknown = JSON.parse(raw)
      if (!isRecord(body) || typeof body.messageId !== "string" || typeof body.prompt !== "string") { response.writeHead(400).end("{}"); return }
      sent.push(body)
      if (!turns.has(body.messageId)) turns.set(body.messageId, { text: body.prompt, createdAt: 300, answer: "Correction answer" })
      response.writeHead(202).end(JSON.stringify({ state: "accepted" })); return
    }
    if (request.method === "GET" && request.url?.startsWith("/v1/sessions/")) {
      response.end(JSON.stringify({ turns: [...turns].map(([messageId, entry]) => ({ messageId, status: "completed", createdAt: entry.createdAt, error: null })), messages: [...turns].flatMap(([messageId, entry]) => [{ role: "user", messageId, text: entry.text }, { role: "assistant", messageId, text: entry.answer, toolCalls: [] }]), finalAssistantText: "Earlier answer" })); return
    }
    response.writeHead(404).end("{}")
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Runner did not start")
  try {
    const runnerUrl = `http://127.0.0.1:${address.port}`
    const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3090", WORKBOT_DEN_API_URL: "http://localhost:3091", WORKBOT_RUNNER_URL: runnerUrl, WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
    const den = { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), runToken: async () => ({ token: "fixture-token" }) }
    const auth = createAuth({ config, den })
    const app = new Hono<AppEnv>()
    registerWorkbotRoutes(app, { config, den, sameOrigin: auth.sameOrigin, member: async (c, next) => {
      const who = denSessionSchema.parse({ user: { id: "user_example", name: "Example", email: "member@example.test" }, organization: { id: "org_example", name: "Example workspace", brandAppName: null }, memberId: "member_example", enabled: true, canSchedule: false, documents: true, workspaceAssistant: true, model: "gateway/luna", verifyModel })
      c.set("member", { session: { id: "session_example", userId: who.user.id, organizationId: who.organization.id, tokens: { accessToken: "fixture-token", expiresAt: Date.now() + 60000 }, createdAt: Date.now() }, accessToken: "fixture-token", den: who })
      await next()
    } })
    const prior = await fetch(`${runnerUrl}/v1/models`, { headers: { authorization: `Bearer ${"r".repeat(32)}` } })
    assert.equal(prior.status, 200)
    const catalog: unknown = await prior.json()
    assert.ok(isRecord(catalog) && catalog.verified === true)
    catalogAvailable = false
    const context: WorkbotViewContext = { kind: "document", provider: "google-drive", fileId: "file_example", title: "Project brief", mimeType: "text/plain", unsaved: true }
    const reference = { messageId: "wb_message_001", quote: "Use Monday", sentAt: 100 }
    owner.setText("My next unsent question")
    const id = owner.enqueue({ id: "message_003", text: "Use Friday", correctionOf: "message_001", correctionReference: reference, context })
    const send = async () => {
      const pending = owner.getSnapshot().pending.find(entry => entry.id === id)
      assert.ok(pending)
      const response = await app.request(`http://localhost:3090/v1/workbot/messages/${pending.correctionOf}/edit`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3090" }, body: JSON.stringify({ newId: pending.id, text: pending.text, context: pending.context }) })
      const payload: unknown = await response.json()
      if (!response.ok) throw new Error(errorMessage(payload, "Couldn't send the correction."))
    }
    await owner.send(id, send)
    assert.equal(catalogReads, 2, "one prior success, then one failed lookup inside modelFor; no duplicate route preflight")
    assert.equal(sessionWrites, 1, "the failure actually occurs after session refresh, inside the correction's send path")
    assert.equal(sent.length, 0)
    assert.equal(deletes, 0)
    assert.deepEqual([...turns], originalHistory)
    assert.equal(owner.getSnapshot().text, "My next unsent question")
    const failed = owner.getSnapshot().pending[0]
    assert.equal(failed?.id, id)
    assert.equal(failed?.text, "Use Friday")
    assert.deepEqual(failed?.context, context)
    assert.deepEqual(failed?.correctionReference, reference)
    assert.match(failed?.failed ?? "", /can't answer with your workspace's model/)
    const history = await app.request("http://localhost:3090/v1/workbot")
    const historyText = await history.text()
    for (const text of ["Use Monday", "Earlier answer", "Keep the later message", "Later answer"]) assert.ok(historyText.includes(text), text)

    catalogAvailable = true
    await owner.send(id, send, true)
    await owner.send(id, send, true)
    assert.equal(catalogReads, 4, "one catalog check per available correction send")
    assert.equal(deletes, 0)
    assert.deepEqual([...turns].slice(0, 2), originalHistory)
    assert.deepEqual([...turns.keys()], ["wb_message_001", "wb_message_002", "wb_message_003"])
    assert.equal(sent.length, 2)
    for (const body of sent) {
      assert.equal(body.messageId, "wb_message_003")
      assert.equal(body.model, "gateway/luna")
      const visible = readWorkbotContextPrompt(String(body.prompt))
      assert.deepEqual(visible.context, workbotContextForModel(context))
      assert.deepEqual(readWorkbotCorrectionPrompt(visible.text), { text: "Use Friday", correction: reference })
    }
    assert.equal(owner.getSnapshot().pending[0]?.failed, null)
    assert.equal(owner.getSnapshot().text, "My next unsent question")
    owner.acknowledge(new Set([id]))
    assert.equal(owner.getSnapshot().pending.length, 0)

    verifyModel = false
    catalogAvailable = false
    const killed = await app.request("http://localhost:3090/v1/workbot/messages/message_001/edit", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3090" }, body: JSON.stringify({ newId: "message_004", text: "Use Thursday" }) })
    assert.equal(killed.status, 202)
    assert.equal(catalogReads, 4, "killing only Luna restores the previous model policy, not delete-then-send")
    assert.deepEqual([...turns.keys()], ["wb_message_001", "wb_message_002", "wb_message_003", "wb_message_004"])
    assert.equal(deletes, 0)
  } finally {
    owner.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test("a tap on Show me or Carry on without me leaves the draft being typed alone", () => {
  const composer = createComposerState(async () => { throw new Error("No uploads in this test") })
  composer.setText("My half-typed reply")
  const id = composer.enqueue({ id: "message_switch", text: "Show me what you're doing on screen.", keepDraft: true })
  const snapshot = composer.getSnapshot()
  assert.equal(snapshot.text, "My half-typed reply")
  const pending = snapshot.pending.find(entry => entry.id === id)
  assert.deepEqual(pending?.uploads, [])
  assert.equal(pending && "keepDraft" in pending, false)
})
