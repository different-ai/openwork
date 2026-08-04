import assert from "node:assert/strict"
import test from "node:test"

import {
  createDesktopAutomationRunner,
  executeDesktopAutomation,
  normalizeRunnerBaseUrl,
} from "./automation-runner.mjs"

test("runner base URLs are restricted to https or loopback http", () => {
  assert.equal(normalizeRunnerBaseUrl("https://den.example.com"), "https://den.example.com")
  assert.equal(normalizeRunnerBaseUrl("https://den.example.com/api/"), "https://den.example.com/api")
  assert.equal(normalizeRunnerBaseUrl("http://127.0.0.1:8788"), "http://127.0.0.1:8788")
  assert.equal(normalizeRunnerBaseUrl("http://localhost:8788"), "http://localhost:8788")
  assert.equal(normalizeRunnerBaseUrl("http://den.localhost:8788"), "http://den.localhost:8788")
  assert.equal(normalizeRunnerBaseUrl("http://attacker.example.com"), null)
  assert.equal(normalizeRunnerBaseUrl("ftp://den.example.com"), null)
  assert.equal(normalizeRunnerBaseUrl("https://user:pass@den.example.com"), null)
  assert.equal(normalizeRunnerBaseUrl("not a url"), null)
  assert.equal(normalizeRunnerBaseUrl(undefined), null)
})

test("a renderer-supplied non-https base URL never receives the runner token", async () => {
  const attempted = []
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      attempted.push(String(url))
      throw new Error("no network in test")
    },
  })
  runner.configure({ baseUrl: "http://attacker.example.com", token: "runner-token", runnerId: "runner-1" })
  await new Promise((resolve) => setTimeout(resolve, 25))
  runner.stop()
  assert.deepEqual(attempted, [])
})

test("desktop Automation execution creates a normal visible local OpenWork thread", async () => {
  const requests = []
  let snapshots = 0
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ path: parsed.pathname, method: options.method ?? "GET", body })
    if (parsed.pathname === "/workspaces") {
      return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
    }
    if (parsed.pathname === "/workspace/workspace-1/sessions" && options.method === "POST") {
      return Response.json({ item: { id: "session-1" }, started: true }, { status: 201 })
    }
    if (parsed.pathname === "/workspace/workspace-1/sessions/session-1/snapshot") {
      snapshots += 1
      return Response.json({ item: {
        status: { type: snapshots === 1 ? "busy" : "idle" },
        messages: snapshots === 1 ? [] : [{
          info: { role: "assistant", tokens: { input: 12, output: 7 } },
          parts: [{ type: "text", text: "Desktop runner result" }],
        }],
      } })
    }
    throw new Error(`Unexpected request ${parsed.pathname}`)
  }

  const result = await executeDesktopAutomation({
    executionTarget: "desktop",
    runId: "run-1",
    automationId: "automation-1",
    automationName: "Daily brief",
    instructions: "Prepare the brief",
    model: { providerId: "opencode", modelId: "big-pickle" },
    timeoutMs: 30_000,
    leaseExpiresAt: Date.now() + 60_000,
    attempt: 1,
  }, {
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
    fetchImpl,
    signal: new AbortController().signal,
  })

  assert.equal(result.sessionId, "session-1")
  assert.equal(result.workspaceId, "workspace-1")
  assert.equal(result.resultSummary, "Desktop runner result")
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7, costMicros: null })
  const create = requests.find((request) => request.path === "/workspace/workspace-1/sessions")
  assert.deepEqual(create?.body, {
    title: "Automation: Daily brief",
    prompt: "Prepare the brief",
    providerId: "opencode",
    modelId: "big-pickle",
  })
})
