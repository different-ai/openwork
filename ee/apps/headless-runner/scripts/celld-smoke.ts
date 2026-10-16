/**
 * A real turn against a deployed runner: owner cell, model answer, the conversation moved into a Node runner (so the
 * way off celld is proven on every deploy), delete. Prints no credentials.
 *
 *   SMOKE_BASE=http://127.0.0.1:8080 HEADLESS_API_TOKEN=... tsx scripts/celld-smoke.ts
 */
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { createApp } from "../src/app.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { Store } from "../src/store.js"

const base = z.url().parse(process.env.SMOKE_BASE)
const token = z.string().min(32).parse(process.env.HEADLESS_API_TOKEN)
const owner = `ci:smoke-${randomUUID().slice(0, 8)}`
const sessionId = `hs_ci${randomUUID().replaceAll("-", "")}`
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-openwork-headless-owner": owner }
const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) })
const expect = (label: string, status: number, wanted: number) => {
  console.log(`${label}: ${status}`)
  if (status !== wanted) throw new Error(`${label} returned ${status}, expected ${wanted}`)
}

expect("unauthenticated", (await fetch(`${base}/v1/models`)).status, 401)
expect("create", (await call(`/v1/sessions/${sessionId}`, { method: "PUT", body: JSON.stringify({ owner }) })).status, 201)
try {
  const sent = await call(`/v1/sessions/${sessionId}/turns`, { method: "POST", body: JSON.stringify({ messageId: "m1", prompt: "Reply with exactly the word: pong" }) })
  expect("send", sent.status, 202)
  const view = z.object({ status: z.string(), turns: z.array(z.object({ status: z.string() })), finalAssistantText: z.string() })
  const deadline = Date.now() + 120_000
  let read = view.parse({ status: "busy", turns: [], finalAssistantText: "" })
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 2_000))
    read = view.parse(await (await call(`/v1/sessions/${sessionId}`)).json())
    if (read.status === "idle" && read.turns.length > 0) break
  }
  const status = read.turns.at(-1)?.status
  console.log(`turn: ${status ?? "none"}, answer: ${JSON.stringify(read.finalAssistantText.slice(0, 40))}`)
  if (status !== "completed" || !/pong/i.test(read.finalAssistantText)) throw new Error("the smoke turn did not complete with the expected answer")

  const exported = await call(`/v1/sessions/${sessionId}/export`)
  expect("export", exported.status, 200)
  const store = new Store(nodeSqlite(":memory:"))
  const model = { complete: async () => { throw new Error("the Node runner only stores here") } }
  const node = createApp({ store, apiToken: token, runner: new Runner({ store, model, defaultModel: "unused", limits: { maxConcurrentTurns: 1, maxSteps: 1, turnTimeoutMs: 60_000, credentialRefreshMs: 60_000, contextCharBudget: 10_000 } }) })
  expect("import into Node", (await node.request(`/v1/sessions/${sessionId}/import`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: await exported.text() })).status, 201)
  const moved = store.turnMessages(sessionId, "m1").some(({ message }) => message.role === "assistant" && /pong/i.test(message.text))
  store.close()
  if (!moved) throw new Error("the conversation reached Node without its answer")
} finally {
  console.log(`delete: ${(await call(`/v1/sessions/${sessionId}`, { method: "DELETE" })).status}`)
}
