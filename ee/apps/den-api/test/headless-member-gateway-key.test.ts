import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { serve } from "@hono/node-server"
// The real headless runner (its HTTP app, queue and store) with a scripted model in place of the AI Gateway.
import { createApp } from "../../headless-runner/src/app.js"
import type { ModelClient } from "../../headless-runner/src/model.js"
import { nodeSqlite } from "../../headless-runner/src/node-sqlite.js"
import { Runner } from "../../headless-runner/src/runner.js"
import { Store } from "../../headless-runner/src/store.js"
import { createHeadlessRunnerClient, type HeadlessRunnerDeps } from "../src/headless-runner/client.js"

const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }

test("a runner without its own model key answers with the member's Gateway key, sent per turn and per model list", async () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-member-key-"))
  const modelKeys: string[] = []
  const catalogKeys: Array<string | undefined> = []
  const model: ModelClient = {
    async complete(request) {
      modelKeys.push(request.apiKey)
      return { text: "Done.", toolCalls: [], usage }
    },
  }
  const store = new Store(nodeSqlite(join(directory, "runner.sqlite")))
  const limits = { maxConcurrentTurns: 4, maxSteps: 10, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 100_000 }
  // No defaultModelApiKey: the runner has no key of its own, as on a managed AWS install.
  const runner = new Runner({ store, model, defaultModel: "set-a-default-model-in-den", limits })
  const models = async (callerApiKey?: string) => {
    catalogKeys.push(callerApiKey)
    return { defaultModel: "set-a-default-model-in-den", models: [{ id: "gwm_sonnet", name: "Sonnet" }] }
  }
  const token = "r".repeat(40)
  const server = serve({ fetch: createApp({ store, runner, apiToken: token, models }).fetch, port: 0 })
  await new Promise((resolve) => server.once("listening", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  try {
    const deps: HeadlessRunnerDeps = {
      config: { url: `http://127.0.0.1:${port}`, token },
      fetch,
      mintToken: async () => ({ token: "ow_mcp_at_run_test", modelApiKey: "gw_member_key" }),
      catalogModelApiKey: async () => "gw_owner_key",
      maxTokenTtlMs: 3_600_000,
    }
    const client = createHeadlessRunnerClient(deps)

    const catalog = await client.listModels()
    assert.deepEqual(catalog?.models, [{ id: "gwm_sonnet", name: "Sonnet" }])
    assert.deepEqual(catalogKeys, ["gw_owner_key"])

    const session = await client.createSession({ title: "Member key" })
    assert.ok(session.ok)
    const messageId = `msg_${"a".repeat(64)}`
    const sent = await client.sendTurn({ userId: "usr_1", organizationId: "org_1" }, { sessionId: session.value.id, messageId, prompt: "Hello" })
    assert.ok(sent.ok)
    let status = ""
    for (let i = 0; i < 50 && status !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const read = await client.readSession(session.value.id, { messageId })
      if (read.ok) status = read.value.turns.find((turn) => turn.messageId === messageId)?.status ?? ""
    }
    assert.equal(status, "completed")
    assert.deepEqual(modelKeys, ["gw_member_key"])
  } finally {
    server.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
