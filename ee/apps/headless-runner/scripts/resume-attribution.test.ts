import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { ModelAttribution } from "../src/attribution.js"
import { denResumeClient } from "../src/den-resume.js"
import type { McpConnector } from "../src/mcp.js"
import type { ModelClient, ModelRequest } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { grantVault } from "../src/resume-grants.js"
import { Runner } from "../src/runner.js"
import { SelfResume } from "../src/self-resume.js"
import { Store } from "../src/store.js"
import type { Execution } from "../src/types.js"

const oldIdentity: ModelAttribution = { memberId: "member-old", userId: "user-old", organizationId: "org-test", email: "old@example.test" }
const newIdentity: ModelAttribution = { memberId: "member-new", userId: "user-new", organizationId: "org-test" }
const grant = `hrg_${"A".repeat(43)}`
const vault = grantVault("encryption-key-0123456789-0123456789")
const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const done = { text: "Done.", toolCalls: [], usage }
const limits = { maxConcurrentTurns: 4, maxSteps: 10, turnTimeoutMs: Infinity, credentialRefreshMs: Infinity, contextCharBudget: 100_000 }
const mcp: McpConnector = async () => ({ tools: [], async call() { return { output: "", isError: false } }, async close() {} })

function database() {
  const directory = mkdtempSync(join(tmpdir(), "resume-attribution-"))
  const path = join(directory, "runner.sqlite")
  return { open: () => new Store(nodeSqlite(path)), [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) }
}

function exchange(identity?: ModelAttribution) {
  return denResumeClient({ url: "https://den.example.test", token: "callback-token", fetch: async () => Response.json({
    mcpToken: "fresh-mcp", expiresAt: "2099-01-01T00:00:00Z", readOnly: false,
    ...(identity ? { modelAttribution: identity } : {}),
  }) })
}

const modes: Array<{ label: string; execution?: Execution }> = [{ label: "whole turn" }, { label: "step mode", execution: "steps" }]
for (const mode of modes) {
  for (const identity of [undefined, newIdentity]) {
    test(`${mode.label}: fresh credentials ${identity ? "replace" : "remove"} the previous inference identity`, async () => {
      using db = database()
      const store = db.open()
      const resume = new SelfResume({ store, vault, exchange: exchange(identity) })
      const requests: ModelRequest[] = []
      const model: ModelClient = { async complete(request) {
        requests.push(request)
        return requests.length === 1
          ? { text: "", toolCalls: [{ id: "write", name: "write_file", input: { path: "result.txt", content: "ok" } }], usage }
          : done
      } }
      const runner = new Runner({ store, model, defaultModel: "test-model", defaultModelApiKey: "shared-key", mcp, resume, limits: { ...limits, credentialRefreshMs: 0 } })
      const session = store.createSession({})
      assert.ok(runner.send({ sessionId: session.id, messageId: "m1", prompt: "Write a result", execution: mode.execution,
        credentials: { mcpToken: "old-mcp", resumeGrant: grant, modelAttribution: oldIdentity } }).ok)
      await runner.idle()
      await resume.settled()
      assert.equal(store.getTurn(session.id, "m1")?.status, "completed")
      assert.equal(requests.length, 2)
      assert.deepEqual(requests[0]?.attribution, oldIdentity)
      assert.deepEqual(requests[1]?.attribution, identity, "the newly issued identity, including omission, is authoritative")
      const persisted = JSON.stringify(store.exportConversation(session.id))
      assert.ok(!persisted.includes(oldIdentity.memberId) && !persisted.includes(newIdentity.memberId))
      store.close()
    })
  }
}

test("resume exchange rejects malformed attribution instead of using unvalidated identity", async () => {
  const client = denResumeClient({ url: "https://den.example.test", token: "callback-token", fetch: async () => Response.json({
    mcpToken: "fresh-mcp", expiresAt: "2099-01-01T00:00:00Z", readOnly: false,
    modelAttribution: { ...newIdentity, memberId: "bad\r\nheader" },
  }) })
  assert.deepEqual(await client({ grant, sessionId: "s1", messageId: "m1" }), { ok: false, kind: "retryable", code: "invalid_response", status: 200 })
})

test("self-resume sweep sends the fresh Den identity with the resumed turn", async () => {
  using db = database()
  const store = db.open()
  const session = store.createSession({})
  store.admitTurn({ sessionId: session.id, messageId: "m1", prompt: "Continue", model: null })
  store.setTurnStatus(session.id, "m1", "interrupted", "runner_restarted")
  const resume = new SelfResume({ store, vault, exchange: exchange(newIdentity) })
  resume.remember(session.id, "m1", grant)
  const requests: ModelRequest[] = []
  const runner = new Runner({ store, model: { async complete(request) { requests.push(request); return done } }, defaultModel: "test-model", defaultModelApiKey: "shared-key", limits, resume })
  assert.deepEqual(await runner.selfResume(), { resumed: 1, waiting: 0, failed: 0 })
  await runner.idle()
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]?.attribution, newIdentity)
  store.close()
})

test("step recovery without tools re-obtains attribution instead of bypassing the grant exchange", async () => {
  using db = database()
  const firstStore = db.open()
  const firstResume = new SelfResume({ store: firstStore, vault, exchange: exchange(newIdentity) })
  let started: (() => void) | undefined
  const modelStarted = new Promise<void>((resolve) => { started = resolve })
  const first = new Runner({ store: firstStore, model: { async complete() { started?.(); return new Promise(() => undefined) } }, defaultModel: "test-model", defaultModelApiKey: "shared-key", limits, resume: firstResume })
  const session = firstStore.createSession({})
  first.send({ sessionId: session.id, messageId: "m1", prompt: "Continue", execution: "steps", credentials: { resumeGrant: grant, modelAttribution: oldIdentity } })
  await modelStarted
  await firstResume.settled()
  const store = db.open()
  const resume = new SelfResume({ store, vault, exchange: exchange(newIdentity) })
  const requests: ModelRequest[] = []
  const recovered = new Runner({ store, model: { async complete(request) { requests.push(request); return done } }, defaultModel: "test-model", defaultModelApiKey: "shared-key", limits, resume })
  assert.deepEqual(recovered.recoverSteps(), { continued: 1, failed: 0 })
  await recovered.idle()
  assert.equal(store.getTurn(session.id, "m1")?.status, "completed")
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]?.attribution, newIdentity)
  store.close()
  firstStore.close()
})
