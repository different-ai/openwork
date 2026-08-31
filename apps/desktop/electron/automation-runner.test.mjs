import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyAutomationExecutionError,
  createDesktopAutomationRunner,
  executeDesktopAutomation,
  executeDesktopRemoteSession,
  normalizeRunnerBaseUrl,
  resolveAssignmentWorkspace,
  runnerTokenAudience,
} from "./automation-runner.mjs"

function runnerTokenFor(audience, organizationId = "org-1") {
  const payload = Buffer.from(JSON.stringify({
    v: 2,
    o: organizationId,
    m: "member-1",
    r: "runner-1",
    a: audience,
  })).toString("base64url")
  return `${payload}.test-signature`
}

function legacyRunnerToken() {
  const payload = Buffer.from(JSON.stringify({ v: 1, o: "org", m: "member", r: "runner" })).toString("base64url")
  return `${payload}.test-signature`
}

const EXPECTED_RECONNECT_DELAYS = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000]

async function observeHttpFailureBackoff(status) {
  const paths = []
  const delays = []
  const done = new AbortController()
  let runner = null
  runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname)
      return Response.json({ message: "injected HTTP failure" }, { status })
    },
    random: () => 0.5,
    waitBeforeReconnect: async (ms) => {
      delays.push(ms)
      await new Promise((resolve) => setImmediate(resolve))
      if (delays.length === EXPECTED_RECONNECT_DELAYS.length) {
        runner.stop()
        done.abort()
      }
    },
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  if (!done.signal.aborted) {
    await new Promise((resolve) => done.signal.addEventListener("abort", resolve, { once: true }))
  }
  return { paths, delays }
}

async function flushTasks() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function withTimeout(promise, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 1_000)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

async function observeCredentialRejection(status, deniedRequest) {
  const paths = []
  const delays = []
  const rejections = []
  let resolveRejected
  const rejected = new Promise((resolve) => { resolveRejected = resolve })
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname
      paths.push(path)
      if (path === deniedRequest) {
        return Response.json({ message: "invalid runner credential" }, { status })
      }
      if (path === "/v1/automation-runner/work") return Response.json({ items: [] })
      return new Promise((resolve, reject) => {
        const abort = () => reject(options.signal?.reason ?? new Error("aborted"))
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener("abort", abort, { once: true })
      })
    },
    waitBeforeReconnect: async (ms, signal) => {
      delays.push(ms)
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    },
    onCredentialRejected: () => {
      rejections.push(status)
      resolveRejected()
    },
  })
  const configuration = {
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  }
  runner.configure(configuration)
  await withTimeout(rejected, "credential rejection timed out")
  await flushTasks()
  for (let index = 0; index < 20; index += 1) runner.configure(configuration)
  await flushTasks()
  runner.stop()
  return { paths, delays, rejections }
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1_000
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(predicate(), message)
}

function testAssignment() {
  return {
    executionTarget: "desktop",
    runId: "run-1",
    automationId: "automation-1",
    automationName: "Daily brief",
    instructions: "Prepare the brief",
    model: { providerId: "opencode", modelId: "big-pickle" },
    timeoutMs: 30_000,
    leaseExpiresAt: Date.now() + 60_000,
    attempt: 1,
  }
}

function remoteSessionAssignment(overrides = {}) {
  return {
    commandId: "command-1",
    kind: "remote_session_create",
    title: "Desktop handoff",
    prompt: "Inspect the repo",
    model: { providerId: "provider", modelId: "model", variant: "high" },
    expiresAt: Date.now() + 60_000,
    ...overrides,
  }
}

function opencodeSessionPaths(workspaceId, sessionId) {
  const base = `/workspace/${encodeURIComponent(workspaceId)}/opencode/session`
  return {
    create: base,
    prompt: `${base}/${encodeURIComponent(sessionId)}/prompt_async`,
    get: `${base}/${encodeURIComponent(sessionId)}`,
    messages: `${base}/${encodeURIComponent(sessionId)}/message`,
    todo: `${base}/${encodeURIComponent(sessionId)}/todo`,
    status: `${base}/status`,
    abort: `${base}/${encodeURIComponent(sessionId)}/abort`,
  }
}

function respondToSnapshotRequest(parsed, paths, snapshot) {
  if (parsed.pathname === paths.get) return Response.json(snapshot.session ?? { id: paths.get.split("/").at(-1) })
  if (parsed.pathname === paths.messages) return Response.json(snapshot.messages ?? [])
  if (parsed.pathname === paths.todo) return Response.json(snapshot.todos ?? [])
  if (parsed.pathname === paths.status) {
    const sessionId = paths.get.split("/").at(-1)
    return Response.json(snapshot.statuses ?? { [sessionId]: snapshot.status ?? { type: "idle" } })
  }
  return null
}

async function observeAssignmentCredentialRejection(status, deniedRoute) {
  const denRequests = []
  let workRequests = 0
  let snapshotStarted = false
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  let resolveRejected
  const rejected = new Promise((resolve) => { resolveRejected = resolve })
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.origin === "http://127.0.0.1:3000") {
        if (parsed.pathname === "/workspaces") {
          return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
        }
        if (parsed.pathname === sessionPaths.create && options.method === "POST") {
          return Response.json({ id: "session-1" }, { status: 201 })
        }
        if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
        if ([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status].includes(parsed.pathname)) {
          snapshotStarted = true
          if (deniedRoute === "heartbeat") {
            return new Promise((resolve, reject) => {
              const abort = () => reject(options.signal?.reason ?? new Error("aborted"))
              if (options.signal?.aborted) abort()
              else options.signal?.addEventListener("abort", abort, { once: true })
            })
          }
          return respondToSnapshotRequest(parsed, sessionPaths, {
            status: { type: "idle" },
            messages: [{
              info: { id: "msg-finished", role: "assistant", tokens: { input: 1, output: 1 } },
              parts: [{ id: "part-finished", type: "text", text: "Finished" }],
            }],
          })
        }
        throw new Error(`Unexpected local request ${parsed.pathname}`)
      }

      denRequests.push(parsed.pathname)
      if (parsed.pathname === "/v1/automation-runner/work") {
        workRequests += 1
        return Response.json({ items: workRequests === 1 ? [{ runId: "run-1" }] : [] })
      }
      if (parsed.pathname.endsWith("/claim")) {
        if (deniedRoute === "claim") return Response.json({ message: "expired" }, { status })
        return Response.json({ assignment: testAssignment() })
      }
      if (parsed.pathname.endsWith("/events")) {
        if (deniedRoute === "events") return Response.json({ message: "expired" }, { status })
        return Response.json({ ok: true })
      }
      if (parsed.pathname.endsWith("/heartbeat")) {
        if (deniedRoute === "heartbeat") return Response.json({ message: "expired" }, { status })
        return Response.json({ leaseValid: true, cancelRequested: false })
      }
      if (parsed.pathname.endsWith("/complete")) {
        if (deniedRoute === "complete") return Response.json({ message: "expired" }, { status })
        return Response.json({ ok: true })
      }
      throw new Error(`Unexpected Den request ${parsed.pathname}`)
    },
    onCredentialRejected: resolveRejected,
    heartbeatIntervalMs: 1,
  })
  const configuration = {
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  }
  runner.configure(configuration)
  if (deniedRoute === "heartbeat") await waitFor(() => snapshotStarted, "assignment did not start before heartbeat")
  await withTimeout(rejected, `${deniedRoute} credential rejection timed out`)
  await flushTasks()
  runner.configure(configuration)
  await flushTasks()
  runner.stop()
  return denRequests
}

function requestBudget(delays, windowMs) {
  let attempts = 0
  let nextAttemptAt = 0
  while (nextAttemptAt < windowMs) {
    nextAttemptAt += delays[Math.min(attempts, delays.length - 1)]
    attempts += 1
  }
  return attempts
}

test("model-not-found failures become a repairable Automation error", () => {
  assert.deepEqual(classifyAutomationExecutionError({
    name: "ProviderModelNotFoundError",
    message: "Model not found: opencode/big-pickle",
  }), {
    code: "model_access_lost",
    message: "The selected model opencode/big-pickle is no longer available. Choose a supported model to resume this Automation.",
  })
})

test("runner base URLs require a protected transport", () => {
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

test("runner credentials retain their signed Den audience", () => {
  assert.equal(runnerTokenAudience(runnerTokenFor("https://den.example.com/api/den")), "https://den.example.com/api/den")
  assert.equal(runnerTokenAudience("not-a-runner-token"), null)
  assert.equal(runnerTokenAudience(runnerTokenFor("http://attacker.example.com")), null)
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
  runner.configure({
    baseUrl: "http://attacker.example.com",
    token: runnerTokenFor("http://attacker.example.com"),
    runnerId: "runner-1",
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  runner.stop()
  assert.deepEqual(attempted, [])
})

test("a renderer cannot redirect a Den runner credential to another HTTPS origin", async () => {
  const attempted = []
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      attempted.push(String(url))
      throw new Error("no network in test")
    },
  })
  runner.configure({
    baseUrl: "https://attacker.example.com",
    token: runnerTokenFor("https://den.example.com/api/den"),
    runnerId: "runner-1",
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  runner.stop()
  assert.deepEqual(attempted, [])
})

test("a v1 runner credential works only with a main-process trusted Den endpoint", async () => {
  const attempted = []
  const runner = createDesktopAutomationRunner({
    legacyBaseUrls: ["https://den.example.com/api/den"],
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      attempted.push(String(url))
      throw new Error("no network in test")
    },
  })
  runner.configure({
    baseUrl: "https://den.example.com/api/den",
    token: legacyRunnerToken(),
    runnerId: "runner-1",
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  runner.stop()
  assert.ok(attempted.length > 0)
  assert.ok(attempted.every((url) => url.startsWith("https://den.example.com/api/den/")))
})

test("a v1 runner credential cannot use an untrusted HTTPS endpoint", async () => {
  const attempted = []
  const runner = createDesktopAutomationRunner({
    legacyBaseUrls: ["https://den.example.com/api/den"],
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      attempted.push(String(url))
      throw new Error("no network in test")
    },
  })
  runner.configure({
    baseUrl: "https://attacker.example.com",
    token: legacyRunnerToken(),
    runnerId: "runner-1",
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  runner.stop()
  assert.deepEqual(attempted, [])
})

test("a runner credential bound elsewhere reports why this desktop stays disconnected", async () => {
  const logged = []
  const attempted = []
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      attempted.push(String(url))
      throw new Error("no network in test")
    },
    log: (state) => logged.push(state),
  })
  runner.configure({
    baseUrl: "https://den.example.com/api/den",
    token: runnerTokenFor("https://api.example.com"),
    runnerId: "runner-1",
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  runner.stop()
  assert.deepEqual(attempted, [])
  assert.deepEqual(logged, [
    "rejected runner credential for https://den.example.com/api/den"
      + ": token audience https://api.example.com",
  ])
})

test("repeated HTTP 502 responses retain exponential runner reconnect backoff", async () => {
  const { paths, delays } = await observeHttpFailureBackoff(502)
  assert.deepEqual(delays, EXPECTED_RECONNECT_DELAYS)
  assert.equal(paths.filter((path) => path === "/v1/automation-runner/work").length, 10)
  assert.equal(paths.filter((path) => path === "/v1/automation-runners/events").length, 0)
})

for (const status of [401, 403]) {
  test(`HTTP ${status} from work retires exactly that credential without reconnecting`, async () => {
    const { paths, delays, rejections } = await observeCredentialRejection(status, "/v1/automation-runner/work")
    assert.equal(paths.filter((path) => path === "/v1/automation-runner/work").length, 1)
    assert.equal(paths.filter((path) => path === "/v1/automation-runners/events").length, 0)
    assert.deepEqual(delays, [])
    assert.deepEqual(rejections, [status])
  })
}

test("HTTP 401 and 403 from every assignment route retire the credential", async () => {
  const routeSuffix = {
    claim: "/v1/automation-runs/run-1/claim",
    events: "/v1/automation-runs/run-1/events",
    heartbeat: "/v1/automation-runs/run-1/heartbeat",
    complete: "/v1/automation-runs/run-1/complete",
  }
  for (const status of [401, 403]) {
    for (const deniedRoute of Object.keys(routeSuffix)) {
      const requests = await observeAssignmentCredentialRejection(status, deniedRoute)
      assert.equal(requests.filter((path) => path === routeSuffix[deniedRoute]).length, 1)
      assert.equal(requests.filter((path) => path === "/v1/automation-runner/work").length, 1)
      assert.equal(requests.filter((path) => path === "/v1/automation-runners/events").length, 0)
    }
  }
})

test("a new credential reconciles immediately and a late rejection cannot retire it", async () => {
  const tokenA = runnerTokenFor("https://den.example.com")
  const tokenB = `${runnerTokenFor("https://den.example.com")}-fresh`
  const requests = []
  const delays = []
  const rejections = []
  let aWorkStarted = false
  let aWorkResponse = null
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname
      const authorization = new Headers(options.headers).get("Authorization")
      requests.push({ path, authorization })
      if (authorization === `Bearer ${tokenA}`) {
        if (path === "/v1/automation-runner/work") {
          aWorkStarted = true
          while (aWorkResponse === null && !options.signal?.aborted) await new Promise((resolve) => setImmediate(resolve))
          if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted")
          return aWorkResponse
        }
      }
      if (path === "/v1/automation-runner/work") return Response.json({ items: [] })
      throw new Error(`Unexpected Den request ${path}`)
    },
    waitBeforeReconnect: async (ms, signal) => {
      delays.push(ms)
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    },
    onCredentialRejected: () => { rejections.push("rejected") },
  })

  runner.configure({ baseUrl: "https://den.example.com", token: tokenA, runnerId: "runner-1" })
  await waitFor(() => aWorkStarted, "token A request did not start")
  const bRequestStart = requests.length
  runner.configure({ baseUrl: "https://den.example.com", token: tokenB, runnerId: "runner-1" })
  await waitFor(
    () => requests.filter((request) => request.authorization === `Bearer ${tokenB}`).length === 1,
    "token B did not reconcile while token A was pending",
  )

  aWorkResponse = Response.json({ message: "expired" }, { status: 401 })
  await flushTasks()
  assert.deepEqual(rejections, [])
  assert.deepEqual(delays, [60_000])
  assert.equal(runner.configure({ baseUrl: "https://den.example.com", token: tokenB, runnerId: "runner-1" }).connected, true)

  assert.ok(requests.slice(bRequestStart).every((request) => request.authorization === `Bearer ${tokenB}`))
  runner.stop()
})

test("a late rejection retires a newer generation that reused the same credential", async () => {
  const tokenA = runnerTokenFor("https://den.example.com")
  const tokenB = `${tokenA}-fresh`
  const pendingA = []
  const requests = []
  const rejections = []
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname
      const authorization = new Headers(options.headers).get("Authorization")
      requests.push({ path, authorization })
      const requestNumber = requests.filter((request) => request.path === path && request.authorization === authorization).length
      if (authorization === `Bearer ${tokenA}` && path === "/v1/automation-runner/work" && requestNumber === 1) {
        return new Promise((resolve) => { pendingA.push(() => resolve(Response.json({ message: "expired" }, { status: 401 }))) })
      }
      if (path === "/v1/automation-runner/work") return Response.json({ items: [] })
      throw new Error(`Unexpected Den request ${path}`)
    },
    onCredentialRejected: () => { rejections.push("rejected") },
  })
  const configurationA = { baseUrl: "https://den.example.com", token: tokenA, runnerId: "runner-1" }
  const configurationB = { baseUrl: "https://den.example.com", token: tokenB, runnerId: "runner-1" }

  runner.configure(configurationA)
  await waitFor(() => pendingA.length === 1, "first token A generation did not start")
  runner.configure(configurationB)
  await waitFor(
    () => requests.filter((request) => request.authorization === `Bearer ${tokenB}`).length === 1,
    "token B generation did not start",
  )
  runner.configure(configurationA)
  await waitFor(
    () => requests.filter((request) => request.authorization === `Bearer ${tokenA}`).length === 2,
    "second token A generation did not start",
  )
  for (const resolve of pendingA) resolve()
  await waitFor(() => rejections.length === 1, "reused token A was not retired")
  assert.equal(runner.configure(configurationA).connected, false)
  await flushTasks()
  assert.equal(requests.filter((request) => request.authorization === `Bearer ${tokenA}`).length, 2)
  runner.stop()
})

test("routine credential rotation waits for the active assignment to complete", async () => {
  const tokenA = runnerTokenFor("https://den.example.com")
  const tokenB = `${tokenA}-fresh`
  const requests = []
  let offeredAssignment = false
  let snapshotStarted = false
  let finishSnapshot = false
  let localAborts = 0
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.origin === "http://127.0.0.1:3000") {
        if (parsed.pathname === "/workspaces") return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
        if (parsed.pathname === sessionPaths.create) return Response.json({ id: "session-1" })
        if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
        if (parsed.pathname === sessionPaths.abort) { localAborts += 1; return Response.json(true) }
        if ([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status].includes(parsed.pathname)) {
          snapshotStarted = true
          while (!finishSnapshot) await new Promise((resolve) => setImmediate(resolve))
          return respondToSnapshotRequest(parsed, sessionPaths, {
            status: { type: "idle" },
            messages: [{ info: { id: "msg-finished", role: "assistant" }, parts: [{ id: "part-finished", type: "text", text: "Finished" }] }],
          })
        }
      }
      const path = parsed.pathname
      const authorization = new Headers(options.headers).get("Authorization")
      requests.push({ path, authorization })
      if (path === "/v1/automation-runner/work") {
        if (!offeredAssignment && authorization === `Bearer ${tokenA}`) {
          offeredAssignment = true
          return Response.json({ items: [{ runId: "run-1" }] })
        }
        return Response.json({ items: [] })
      }
      if (path.endsWith("/claim")) return Response.json({ assignment: testAssignment() })
      return Response.json({ ok: true })
    },
  })
  const configurationA = { baseUrl: "https://den.example.com", token: tokenA, runnerId: "runner-1" }
  const configurationB = { baseUrl: "https://den.example.com", token: tokenB, runnerId: "runner-1" }
  runner.configure(configurationA)
  await waitFor(() => snapshotStarted, "assignment did not start")
  assert.equal(runner.configure(configurationB).connected, true)
  await flushTasks()
  assert.equal(requests.filter((request) => request.authorization === `Bearer ${tokenB}`).length, 0)
  assert.equal(localAborts, 0)

  finishSnapshot = true
  await waitFor(
    () => requests.filter((request) => request.authorization === `Bearer ${tokenB}`).length === 1,
    "fresh credential did not connect after assignment completion",
  )
  assert.equal(localAborts, 0)
  assert.ok(requests.some((request) => request.path.endsWith("/complete") && request.authorization === `Bearer ${tokenA}`))
  runner.stop()
})

test("routine credential rotation waits for an in-flight claim", async () => {
  const tokenA = runnerTokenFor("https://den.example.com")
  const tokenB = `${tokenA}-fresh`
  const requests = []
  /** @type {(response: Response) => void} */
  let resolveClaim = () => {}
  const claimResponse = new Promise((resolve) => { resolveClaim = resolve })
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.origin === "http://127.0.0.1:3000") {
        if (parsed.pathname === "/workspaces") return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
        if (parsed.pathname === sessionPaths.create) return Response.json({ id: "session-1" })
        if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
        if ([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status].includes(parsed.pathname)) {
          return respondToSnapshotRequest(parsed, sessionPaths, {
            status: { type: "idle" },
            messages: [{ info: { id: "msg-finished", role: "assistant" }, parts: [{ id: "part-finished", type: "text", text: "Finished" }] }],
          })
        }
      }
      const path = parsed.pathname
      const authorization = new Headers(options.headers).get("Authorization")
      requests.push({ path, authorization })
      if (path === "/v1/automation-runner/work") {
        const offered = requests.some((request) => request.path.endsWith("/claim"))
        return Response.json({ items: offered ? [] : [{ runId: "run-1" }] })
      }
      if (path.endsWith("/claim")) return claimResponse
      return Response.json({ ok: true })
    },
  })
  const configurationA = { baseUrl: "https://den.example.com", token: tokenA, runnerId: "runner-1" }
  const configurationB = { baseUrl: "https://den.example.com", token: tokenB, runnerId: "runner-1" }
  runner.configure(configurationA)
  await waitFor(() => requests.some((request) => request.path.endsWith("/claim")), "claim did not start")
  assert.equal(runner.configure(configurationB).connected, true)
  await flushTasks()
  assert.equal(requests.filter((request) => request.authorization === `Bearer ${tokenB}`).length, 0)

  resolveClaim(Response.json({ assignment: testAssignment() }))
  await waitFor(
    () => requests.filter((request) => request.authorization === `Bearer ${tokenB}`).length === 1,
    "fresh credential did not connect after the claimed assignment completed",
  )
  assert.ok(requests.some((request) => request.path.endsWith("/complete") && request.authorization === `Bearer ${tokenA}`))
  runner.stop()
})

test("retiring a generation cancels its reconnect wait", async () => {
  const tokenA = runnerTokenFor("https://den.example.com")
  const tokenB = `${tokenA}-fresh`
  /** @type {AbortSignal | null} */
  let waitSignal = null
  const reconnectWaitAborted = () => waitSignal?.aborted === true
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      const path = new URL(url).pathname
      if (path === "/v1/automation-runner/work") return new Response(null, { status: 502 })
      throw new Error(`Unexpected request ${path}`)
    },
    waitBeforeReconnect: async (_ms, signal) => {
      waitSignal = signal
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    },
  })
  runner.configure({ baseUrl: "https://den.example.com", token: tokenA, runnerId: "runner-1" })
  await waitFor(() => waitSignal !== null, "reconnect wait did not start")
  runner.configure({ baseUrl: "https://den.example.com", token: tokenB, runnerId: "runner-1" })
  assert.equal(reconnectWaitAborted(), true)
  runner.stop()
})

test("runner HTTP failure request budget drops from the reset-on-response baseline", () => {
  const previousResetOnResponseDelays = Array(10).fill(500)
  assert.equal(requestBudget(previousResetOnResponseDelays, 60_000), 120)
  assert.equal(requestBudget(EXPECTED_RECONNECT_DELAYS, 60_000), 7)
  assert.equal(previousResetOnResponseDelays.reduce((total, delay) => total + delay, 0), 5_000)
  assert.equal(EXPECTED_RECONNECT_DELAYS.reduce((total, delay) => total + delay, 0), 151_500)
})

test("a healthy work poll resets runner reconnect backoff", async () => {
  const delays = []
  let workRequests = 0
  const done = new AbortController()
  let runner = null
  runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      const path = new URL(url).pathname
      assert.equal(path, "/v1/automation-runner/work")
      workRequests += 1
      if (workRequests <= 3) return new Response(null, { status: 502 })
      return Response.json({ items: [] })
    },
    random: () => 0.5,
    waitBeforeReconnect: async (ms) => {
      delays.push(ms)
      await new Promise((resolve) => setImmediate(resolve))
      if (delays.length === 4) {
        runner.stop()
        done.abort()
      }
    },
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  if (!done.signal.aborted) {
    await new Promise((resolve) => done.signal.addEventListener("abort", resolve, { once: true }))
  }
  assert.deepEqual(delays, [500, 1_000, 2_000, 60_000])
})

test("waking the machine polls for work immediately without new credentials", async () => {
  const polls = []
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, "/v1/automation-runner/work")
      polls.push(String(url))
      return Response.json({ items: [] })
    },
    // Park the loop between polls the way a sleeping machine leaves it.
    waitBeforeReconnect: () => new Promise(() => {}),
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  await flushTasks()
  assert.equal(polls.length, 1)

  assert.deepEqual(runner.wake(), { polled: true })
  await flushTasks()
  assert.equal(polls.length, 2)
  runner.stop()
})

test("waking during an active run keeps its lease and starts no second claim loop", async () => {
  const paths = []
  let releaseSnapshot = () => {}
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = () => resolve(undefined) })
  let resolveCompleted
  const completed = new Promise((resolve) => { resolveCompleted = resolve })
  let offered = false
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      paths.push(parsed.pathname)
      if (parsed.origin === "http://127.0.0.1:3000") {
        if (parsed.pathname === "/workspaces") {
          return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
        }
        if (parsed.pathname === sessionPaths.create && options.method === "POST") {
          return Response.json({ id: "session-1" }, { status: 201 })
        }
        if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
        if ([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status].includes(parsed.pathname)) {
          await snapshotGate
          return respondToSnapshotRequest(parsed, sessionPaths, {
            status: { type: "idle" },
            messages: [{
              info: { id: "msg-done", role: "assistant", tokens: { input: 1, output: 1 } },
              parts: [{ id: "part-done", type: "text", text: "done" }],
            }],
          })
        }
        throw new Error(`Unexpected local request ${parsed.pathname}`)
      }
      if (parsed.pathname === "/v1/automation-runner/work") {
        if (offered) return Response.json({ items: [] })
        offered = true
        return Response.json({ items: [{ runId: "run-1" }] })
      }
      if (parsed.pathname.endsWith("/claim")) return Response.json({ assignment: testAssignment() })
      if (parsed.pathname.endsWith("/events")) return Response.json({ ok: true })
      if (parsed.pathname.endsWith("/complete")) {
        resolveCompleted()
        return Response.json({ ok: true })
      }
      throw new Error(`Unexpected Den request ${parsed.pathname}`)
    },
    waitBeforeReconnect: () => new Promise(() => {}),
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  await flushTasks()
  assert.equal(paths.filter((path) => path === "/v1/automation-runner/work").length, 1)
  assert.equal(paths.filter((path) => path.endsWith("/claim")).length, 1)
  assert.ok([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status]
    .every((path) => paths.includes(path)), "snapshot endpoints did not start in parallel")

  // The wake joins the reconcile cycle that is already executing run-1 rather
  // than polling over it, so the desktop cannot double-claim its own work.
  assert.deepEqual(runner.wake(), { polled: true })
  await flushTasks()
  assert.equal(paths.filter((path) => path === "/v1/automation-runner/work").length, 1)
  assert.equal(paths.filter((path) => path.endsWith("/claim")).length, 1)

  releaseSnapshot()
  await withTimeout(completed, "active run completion timed out")
  runner.stop()
})

test("waking a desktop that was never configured stays disconnected", () => {
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async () => { throw new Error("no network in test") },
  })
  assert.deepEqual(runner.wake(), { polled: false })
  runner.stop()
})

test("a remote-session work item creates a local session and completes with its real ids", async () => {
  const tokenA = runnerTokenFor("https://den.example.com")
  const tokenB = `${tokenA}-fresh`
  const denRequests = []
  const localRequests = []
  let offered = false
  let releaseCreate = () => {}
  const createGate = new Promise((resolve) => { releaseCreate = () => resolve(undefined) })
  let createStarted = false
  let resolveCompleted
  const completed = new Promise((resolve) => { resolveCompleted = resolve })
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      const body = options.body ? JSON.parse(options.body) : null
      const authorization = new Headers(options.headers).get("Authorization")
      if (parsed.origin === "http://127.0.0.1:3000") {
        localRequests.push({ path: parsed.pathname, method: options.method ?? "GET", body, authorization })
        if (parsed.pathname === "/workspaces") {
          return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
        }
        if (parsed.pathname === sessionPaths.create && options.method === "POST") {
          createStarted = true
          await createGate
          return Response.json({ id: "session-1" }, { status: 201 })
        }
        if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
        throw new Error(`Unexpected local request ${parsed.pathname}`)
      }
      denRequests.push({ path: parsed.pathname, authorization, body })
      if (parsed.pathname === "/v1/automation-runner/work") {
        if (!offered && authorization === `Bearer ${tokenA}`) {
          offered = true
          return Response.json({ items: [{ kind: "remote_session_create", commandId: "command-1" }] })
        }
        return Response.json({ items: [] })
      }
      if (parsed.pathname === "/v1/remote-session-commands/command-1/claim") {
        return Response.json({ assignment: remoteSessionAssignment() })
      }
      if (parsed.pathname === "/v1/remote-session-commands/command-1/complete") {
        resolveCompleted()
        return Response.json({ command: { id: "command-1", status: "delivered" } })
      }
      throw new Error(`Unexpected Den request ${parsed.pathname}`)
    },
    waitBeforeReconnect: () => new Promise(() => {}),
  })

  runner.configure({ baseUrl: "https://den.example.com", token: tokenA, runnerId: "runner-1" })
  await waitFor(() => createStarted, "remote session create did not start")
  assert.equal(runner.configure({ baseUrl: "https://den.example.com", token: tokenB, runnerId: "runner-1" }).connected, true)
  await flushTasks()
  assert.equal(denRequests.filter((request) => request.authorization === `Bearer ${tokenB}`).length, 0)

  releaseCreate()
  await withTimeout(completed, "remote session completion timed out")
  await waitFor(
    () => denRequests.some((request) => request.path === "/v1/automation-runner/work" && request.authorization === `Bearer ${tokenB}`),
    "deferred runner credential did not connect",
  )
  runner.stop()

  assert.deepEqual(localRequests, [
    { path: "/workspaces", method: "GET", body: null, authorization: "Bearer local-client-token" },
    {
      path: "/workspace/workspace-1/opencode/session",
      method: "POST",
      body: { title: "Desktop handoff" },
      authorization: "Bearer local-client-token",
    },
    {
      path: "/workspace/workspace-1/opencode/session/session-1/prompt_async",
      method: "POST",
      body: {
        model: { providerID: "provider", modelID: "model" },
        variant: "high",
        parts: [{ type: "text", text: "Inspect the repo" }],
      },
      authorization: "Bearer local-client-token",
    },
  ])
  assert.equal(denRequests.some((request) => request.path.includes("/automation-runs/")), false)
  assert.equal(denRequests.some((request) => request.path.endsWith("/heartbeat")), false)
  assert.deepEqual(
    denRequests.find((request) => request.path.endsWith("/complete"))?.body,
    {
      status: "delivered",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      resultSummary: "Remote session created",
    },
  )
})

test("remote-session creation omits nullable prompt and model fields", async () => {
  const requests = []
  const sessionPaths = opencodeSessionPaths("workspace/first", "session-not-started")
  const result = await executeDesktopRemoteSession(remoteSessionAssignment({ prompt: null, model: null }), {
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      requests.push({ path: parsed.pathname, body: options.body ? JSON.parse(options.body) : null })
      if (parsed.pathname === "/workspaces") return Response.json({ items: [{ id: "workspace/first" }] })
      if (parsed.pathname === sessionPaths.create) {
        return Response.json({ id: "session-not-started" }, { status: 201 })
      }
      throw new Error(`Unexpected request ${parsed.pathname}`)
    },
    signal: new AbortController().signal,
  })

  assert.deepEqual(result, { sessionId: "session-not-started", workspaceId: "workspace/first", started: false })
  assert.deepEqual(requests, [
    { path: "/workspaces", body: null },
    { path: "/workspace/workspace%2Ffirst/opencode/session", body: { title: "Desktop handoff" } },
  ])
})

test("native OpenCode failures preserve upstream status, message, and workspace context", async () => {
  const sessionPaths = opencodeSessionPaths("workspace-1", "unused")
  await assert.rejects(
    executeDesktopRemoteSession(remoteSessionAssignment({ prompt: null, model: null }), {
      getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
      fetchImpl: async (url) => {
        const parsed = new URL(url)
        if (parsed.pathname === "/workspaces") {
          return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
        }
        if (parsed.pathname === sessionPaths.create) {
          return Response.json({ message: "OpenCode is temporarily unavailable" }, { status: 503 })
        }
        throw new Error(`Unexpected request ${parsed.pathname}`)
      },
      signal: new AbortController().signal,
    }),
    (error) => error instanceof Error
      && error.message === "OpenCode is temporarily unavailable"
      && Reflect.get(error, "status") === 503
      && Reflect.get(error, "workspaceId") === "workspace-1",
  )
})

test("a local remote-session failure completes as failed without leaking the response body", async () => {
  const sensitiveToken = "local-sensitive-token"
  const completions = []
  let offered = false
  let resolveCompleted
  const completed = new Promise((resolve) => { resolveCompleted = resolve })
  const sessionPaths = opencodeSessionPaths("workspace-1", "unused")
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.origin === "http://127.0.0.1:3000") {
        if (parsed.pathname === "/workspaces") {
          return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
        }
        if (parsed.pathname === sessionPaths.create) {
          return Response.json({ message: "x".repeat(2_500), token: sensitiveToken }, { status: 500 })
        }
      }
      if (parsed.pathname === "/v1/automation-runner/work") {
        if (offered) return Response.json({ items: [] })
        offered = true
        return Response.json({ items: [{ kind: "remote_session_create", commandId: "command-1" }] })
      }
      if (parsed.pathname.endsWith("/claim")) {
        return Response.json({ assignment: remoteSessionAssignment({ prompt: null, model: null }) })
      }
      if (parsed.pathname.endsWith("/complete")) {
        completions.push(JSON.parse(options.body))
        resolveCompleted()
        return Response.json({ command: { id: "command-1", status: "failed" } })
      }
      throw new Error(`Unexpected request ${parsed.pathname}`)
    },
    waitBeforeReconnect: () => new Promise(() => {}),
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  await withTimeout(completed, "failed remote session completion timed out")
  runner.stop()

  assert.equal(completions.length, 1)
  assert.equal(completions[0].status, "failed")
  assert.equal(completions[0].error.code, "execution_failed")
  assert.equal(completions[0].error.message.length, 2_000)
  assert.equal(completions[0].sessionId, undefined)
  assert.equal(completions[0].workspaceId, undefined)
  assert.equal(JSON.stringify(completions[0]).includes(sensitiveToken), false)
})

test("a work poll left hanging by a suspended machine times out and retries", async () => {
  const pollSignals = []
  let resolveRetried
  const retried = new Promise((resolve) => { resolveRetried = resolve })
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      assert.equal(new URL(url).pathname, "/v1/automation-runner/work")
      pollSignals.push(options.signal)
      if (pollSignals.length === 1) {
        // A suspended machine leaves the socket half-open: no response and no
        // error, which without a bound would park the loop indefinitely.
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal.reason ?? new Error("aborted")),
            { once: true },
          )
        })
      }
      resolveRetried()
      return Response.json({ items: [] })
    },
    workPollTimeoutMs: 5,
    random: () => 0.5,
    waitBeforeReconnect: async () => {
      await new Promise((resolve) => setImmediate(resolve))
    },
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  await withTimeout(retried, "hung work poll was never retried")
  assert.equal(pollSignals[0]?.aborted, true)
  runner.stop()
})

test("desktop Automation execution creates a normal visible local OpenWork thread", async () => {
  const requests = []
  let snapshots = 0
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ path: parsed.pathname, search: parsed.search, method: options.method ?? "GET", body, options })
    if (parsed.pathname === "/workspaces") {
      return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
    }
    if (parsed.pathname === sessionPaths.create && options.method === "POST") {
      return Response.json({ id: "session-1" }, { status: 201 })
    }
    if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
    if ([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status].includes(parsed.pathname)) {
      if (parsed.pathname === sessionPaths.get) snapshots += 1
      return respondToSnapshotRequest(parsed, sessionPaths, {
        status: { type: snapshots <= 1 ? "busy" : "idle" },
        messages: snapshots <= 1 ? [] : [{
          info: { id: "msg-result", role: "assistant", tokens: { input: 12, output: 7 } },
          parts: [{ id: "part-result", type: "text", text: "Desktop runner result" }],
        }],
      })
    }
    throw new Error(`Unexpected request ${parsed.pathname}`)
  }

  const result = await executeDesktopAutomation({
    executionTarget: "desktop",
    runId: "run-1",
    automationId: "automation-1",
    automationName: "Daily brief",
    instructions: "Prepare the brief",
    model: { providerId: "opencode", modelId: "big-pickle", variant: "high" },
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
  const localRequests = requests.filter((request) => request.path !== "/workspaces")
  assert.deepEqual(localRequests.slice(0, 2).map(({ path, method, body }) => ({ path, method, body })), [
    {
      path: sessionPaths.create,
      method: "POST",
      body: { title: "Automation: Daily brief" },
    },
    {
      path: sessionPaths.prompt,
      method: "POST",
      body: {
        model: { providerID: "opencode", modelID: "big-pickle" },
        variant: "high",
        parts: [{ type: "text", text: "Prepare the brief" }],
      },
    },
  ])
  for (const path of [sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status]) {
    assert.equal(requests.filter((request) => request.path === path).length, 2)
  }
  assert.deepEqual(
    requests.filter((request) => request.path === sessionPaths.messages).map((request) => request.search),
    ["?limit=200", "?limit=200"],
  )
  assert.ok(requests.every((request) => request.options.signal instanceof AbortSignal))
  assert.ok(localRequests.every((request) => new Headers(request.options.headers).get("Authorization") === "Bearer local-client-token"))
})

test("a pinned workspace wins over the active workspace", () => {
  const listed = {
    items: [{ id: "workspace-pinned" }, { id: "workspace-active" }],
    activeId: "workspace-active",
  }
  assert.equal(resolveAssignmentWorkspace(listed, "workspace-pinned").id, "workspace-pinned")
})

test("an unpinned assignment keeps the legacy active-workspace fallback", () => {
  const listed = {
    items: [{ id: "workspace-first" }, { id: "workspace-active" }],
    activeId: "workspace-active",
  }
  assert.equal(resolveAssignmentWorkspace(listed, null).id, "workspace-active")
  assert.equal(resolveAssignmentWorkspace({ items: [{ id: "workspace-first" }] }, null).id, "workspace-first")
})

test("a pinned workspace missing locally fails instead of silently retargeting", () => {
  const listed = { items: [{ id: "workspace-active" }], activeId: "workspace-active" }
  assert.throws(
    () => resolveAssignmentWorkspace(listed, "workspace-gone"),
    (error) => error instanceof Error && Reflect.get(error, "code") === "execution_runtime_unavailable",
  )
})

test("desktop Automation execution runs in the assignment's pinned workspace", async () => {
  const sessionPaths = opencodeSessionPaths("workspace-pinned", "session-pinned")
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === "/workspaces") {
      return Response.json({
        items: [{ id: "workspace-pinned" }, { id: "workspace-active" }],
        activeId: "workspace-active",
      })
    }
    if (parsed.pathname === sessionPaths.create && options.method === "POST") {
      return Response.json({ id: "session-pinned" }, { status: 201 })
    }
    if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
    if ([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status].includes(parsed.pathname)) {
      return respondToSnapshotRequest(parsed, sessionPaths, {
        messages: [{
          info: { id: "msg-pinned", role: "assistant", tokens: { input: 5, output: 2 } },
          parts: [{ id: "part-pinned", type: "text", text: "Pinned result" }],
        }],
      })
    }
    throw new Error(`Unexpected request ${parsed.pathname}`)
  }

  const result = await executeDesktopAutomation({ ...testAssignment(), workspaceId: "workspace-pinned" }, {
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
    fetchImpl,
    signal: new AbortController().signal,
  })
  assert.equal(result.workspaceId, "workspace-pinned")
  assert.equal(result.sessionId, "session-pinned")
})

test("desktop Automation execution accepts a completed tool-only assistant turn", async () => {
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-tool-only")
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === "/workspaces") {
      return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
    }
    if (parsed.pathname === sessionPaths.create && options.method === "POST") {
      return Response.json({ id: "session-tool-only" }, { status: 201 })
    }
    if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
    if ([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status].includes(parsed.pathname)) {
      return respondToSnapshotRequest(parsed, sessionPaths, {
        statuses: {},
        messages: [{
          info: { id: "msg-tool", role: "assistant", tokens: { input: 9, output: 3 } },
          parts: [{ id: "part-tool", type: "tool", tool: "example", state: { status: "completed", output: "done" } }],
        }],
      })
    }
    throw new Error(`Unexpected request ${parsed.pathname}`)
  }

  const result = await executeDesktopAutomation(testAssignment(), {
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
    fetchImpl,
    signal: new AbortController().signal,
  })

  assert.deepEqual(result, {
    sessionId: "session-tool-only",
    workspaceId: "workspace-1",
    resultSummary: null,
    usage: { inputTokens: 9, outputTokens: 3, costMicros: null },
  })
})

test("failed desktop assignments retain their created local thread in the Den completion", async () => {
  let offered = false
  const completions = []
  let resolveCompleted
  const completed = new Promise((resolve) => { resolveCompleted = resolve })
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-failed")
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.origin === "http://127.0.0.1:3000") {
        if (parsed.pathname === "/workspaces") {
          return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
        }
        if (parsed.pathname === sessionPaths.create && options.method === "POST") {
          return Response.json({ id: "session-failed" }, { status: 201 })
        }
        if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
        if ([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status].includes(parsed.pathname)) {
          return respondToSnapshotRequest(parsed, sessionPaths, {
            status: { type: "idle" },
            messages: [{
              info: {
                id: "msg-failed",
                role: "assistant",
                error: {
                  name: "ProviderModelNotFoundError",
                  message: "Model not found: opencode/removed-model",
                },
              },
              parts: [],
            }],
          })
        }
        throw new Error(`Unexpected local request ${parsed.pathname}`)
      }
      if (parsed.pathname === "/v1/automation-runner/work") {
        if (offered) return Response.json({ items: [] })
        offered = true
        return Response.json({ items: [{ runId: "run-1" }] })
      }
      if (parsed.pathname.endsWith("/claim")) return Response.json({ assignment: testAssignment() })
      if (parsed.pathname.endsWith("/events")) return Response.json({ ok: true })
      if (parsed.pathname.endsWith("/complete")) {
        completions.push(JSON.parse(options.body))
        resolveCompleted()
        return Response.json({ ok: true })
      }
      throw new Error(`Unexpected Den request ${parsed.pathname}`)
    },
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  await withTimeout(completed, "failed assignment completion timed out")
  runner.stop()

  const completionBody = completions[0]
  assert.ok(completionBody, "the failed assignment never reached a completion")
  assert.equal(completionBody.status, "failed")
  assert.equal(completionBody.sessionId, "session-failed")
  assert.equal(completionBody.workspaceId, "workspace-1")
  assert.equal(completionBody.error.code, "model_access_lost")
})

test("cancellation during execution preserves the local thread and reaches a terminal completion", async () => {
  let offered = false
  let snapshotStarted = false
  const completions = []
  const events = []
  let resolveCompleted
  const completed = new Promise((resolve) => { resolveCompleted = resolve })
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-cancelled")
  const localRequests = []
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.origin === "http://127.0.0.1:3000") {
        localRequests.push({
          path: parsed.pathname,
          method: options.method ?? "GET",
          authorization: new Headers(options.headers).get("Authorization"),
          signal: options.signal,
        })
        if (parsed.pathname === "/workspaces") {
          return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
        }
        if (parsed.pathname === sessionPaths.create && options.method === "POST") {
          return Response.json({ id: "session-cancelled" }, { status: 201 })
        }
        if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
        if ([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status].includes(parsed.pathname)) {
          snapshotStarted = true
          return new Promise((resolve, reject) => {
            const abort = () => reject(options.signal?.reason ?? new Error("cancelled"))
            if (options.signal?.aborted) abort()
            else options.signal?.addEventListener("abort", abort, { once: true })
          })
        }
        if (parsed.pathname === sessionPaths.abort) return Response.json(true)
        throw new Error(`Unexpected local request ${parsed.pathname}`)
      }
      if (parsed.pathname === "/v1/automation-runner/work") {
        if (offered) return Response.json({ items: [] })
        offered = true
        return Response.json({ items: [{ runId: "run-1" }] })
      }
      if (parsed.pathname.endsWith("/claim")) return Response.json({ assignment: testAssignment() })
      if (parsed.pathname.endsWith("/heartbeat")) {
        return Response.json({ leaseValid: true, cancelRequested: snapshotStarted })
      }
      if (parsed.pathname.endsWith("/events")) {
        events.push(JSON.parse(options.body))
        return Response.json({ ok: true })
      }
      if (parsed.pathname.endsWith("/complete")) {
        completions.push(JSON.parse(options.body))
        resolveCompleted()
        return Response.json({ ok: true })
      }
      throw new Error(`Unexpected Den request ${parsed.pathname}`)
    },
    heartbeatIntervalMs: 1,
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  await withTimeout(completed, "cancelled assignment completion timed out")
  runner.stop()

  const completionBody = completions[0]
  assert.ok(completionBody, "the cancelled assignment never reached a completion")
  assert.equal(completionBody.status, "cancelled")
  assert.equal(completionBody.sessionId, "session-cancelled")
  assert.equal(completionBody.workspaceId, "workspace-1")
  assert.equal(completionBody.error.code, "cancelled")
  assert.equal(events.find((entry) => entry.type === "terminal")?.payload.status, "cancelled")
  const abortRequest = localRequests.find((request) => request.path === sessionPaths.abort)
  assert.equal(abortRequest?.method, "POST")
  assert.equal(abortRequest?.authorization, "Bearer local-client-token")
  assert.equal(abortRequest?.signal?.aborted, false)
})

test("an explicit assistant provider failure terminates immediately with its local thread", async () => {
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-provider-failure")
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === "/workspaces") {
      return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
    }
    if (parsed.pathname === sessionPaths.create && options.method === "POST") {
      return Response.json({ id: "session-provider-failure" }, { status: 201 })
    }
    if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
    if ([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status].includes(parsed.pathname)) {
      return respondToSnapshotRequest(parsed, sessionPaths, {
        status: { type: "idle" },
        messages: [{
          info: {
            id: "msg-provider-failure",
            role: "assistant",
            error: {
              name: "APIError",
              data: { message: "Provider returned HTTP 503 and is temporarily unavailable", statusCode: 503 },
            },
          },
          parts: [],
        }],
      })
    }
    throw new Error(`Unexpected request ${parsed.pathname}`)
  }

  await assert.rejects(
    executeDesktopAutomation(testAssignment(), {
      getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
      fetchImpl,
      signal: new AbortController().signal,
    }),
    (error) => error instanceof Error
      && Reflect.get(error, "code") === "execution_failed"
      && Reflect.get(error, "sessionId") === "session-provider-failure"
      && Reflect.get(error, "workspaceId") === "workspace-1"
      && error.message === "Provider returned HTTP 503 and is temporarily unavailable",
  )
})

test("a temporarily unavailable workspace fails clearly before session creation", async () => {
  await assert.rejects(
    executeDesktopAutomation(testAssignment(), {
      getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
      fetchImpl: async (url) => {
        const parsed = new URL(url)
        if (parsed.pathname === "/workspaces") return Response.json({ items: [], activeId: null })
        throw new Error(`Unexpected request ${parsed.pathname}`)
      },
      signal: new AbortController().signal,
    }),
    /No local workspace is available/,
  )
})

test("desktop Automation execution surfaces a missing pinned model", async () => {
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === "/workspaces") {
      return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
    }
    if (parsed.pathname === sessionPaths.create && options.method === "POST") {
      return Response.json({ id: "session-1" }, { status: 201 })
    }
    if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
    if ([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status].includes(parsed.pathname)) {
      return respondToSnapshotRequest(parsed, sessionPaths, {
        status: { type: "idle" },
        messages: [{
          info: {
            id: "msg-missing-model",
            role: "assistant",
            error: {
              name: "ProviderModelNotFoundError",
              message: "Model not found: opencode/big-pickle",
            },
          },
          parts: [],
        }],
      })
    }
    throw new Error(`Unexpected request ${parsed.pathname}`)
  }

  await assert.rejects(
    executeDesktopAutomation({
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
    }),
    (error) => error instanceof Error
      && Reflect.get(error, "code") === "model_access_lost"
      && Reflect.get(error, "sessionId") === "session-1"
      && Reflect.get(error, "workspaceId") === "workspace-1"
      && /Choose a supported model/.test(error.message),
  )
})

function localExecutionRoutes(sessionPaths, snapshot) {
  return async (parsed, options) => {
    if (parsed.pathname === "/workspaces") {
      return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
    }
    if (parsed.pathname === sessionPaths.create && options.method === "POST") {
      return Response.json({ id: "session-1" }, { status: 201 })
    }
    if (parsed.pathname === sessionPaths.prompt) return new Response(null, { status: 204 })
    if ([sessionPaths.get, sessionPaths.messages, sessionPaths.todo, sessionPaths.status].includes(parsed.pathname)) {
      return snapshot(parsed, options)
    }
    if (parsed.pathname === sessionPaths.abort) return Response.json(true)
    throw new Error(`Unexpected local request ${parsed.pathname}`)
  }
}

function finishedSnapshot(parsed, sessionPaths) {
  return respondToSnapshotRequest(parsed, sessionPaths, {
    status: { type: "idle" },
    messages: [{
      info: { id: "msg-done", role: "assistant", tokens: { input: 1, output: 1 } },
      parts: [{ id: "part-done", type: "text", text: "done" }],
    }],
  })
}

test("a heartbeat slower than its interval never overlaps the next probe", async () => {
  let inflight = 0
  let maxInflight = 0
  let settled = 0
  let releaseSnapshot = () => {}
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = () => resolve(undefined) })
  let resolveCompleted
  const completed = new Promise((resolve) => { resolveCompleted = resolve })
  let offered = false
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  const local = localExecutionRoutes(sessionPaths, async (parsed) => {
    await snapshotGate
    return finishedSnapshot(parsed, sessionPaths)
  })
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.origin === "http://127.0.0.1:3000") return local(parsed, options)
      if (parsed.pathname === "/v1/automation-runner/work") {
        if (offered) return Response.json({ items: [] })
        offered = true
        return Response.json({ items: [{ runId: "run-1" }] })
      }
      if (parsed.pathname.endsWith("/claim")) return Response.json({ assignment: testAssignment() })
      if (parsed.pathname.endsWith("/heartbeat")) {
        inflight += 1
        maxInflight = Math.max(maxInflight, inflight)
        // Ten intervals long: a setInterval heartbeat would pile up here.
        await new Promise((resolve) => setTimeout(resolve, 10))
        inflight -= 1
        settled += 1
        return Response.json({ leaseValid: true, cancelRequested: false })
      }
      if (parsed.pathname.endsWith("/events")) return Response.json({ ok: true })
      if (parsed.pathname.endsWith("/complete")) {
        resolveCompleted()
        return Response.json({ ok: true })
      }
      throw new Error(`Unexpected Den request ${parsed.pathname}`)
    },
    heartbeatIntervalMs: 1,
    waitBeforeReconnect: () => new Promise(() => {}),
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  await waitFor(() => settled >= 2, "two heartbeats did not settle")
  releaseSnapshot()
  await withTimeout(completed, "completion timed out")
  runner.stop()
  assert.ok(settled >= 2, "expected at least two settled heartbeats")
  assert.equal(maxInflight, 1)
})

test("a hung completion request is bounded and the runner keeps claiming new work", async () => {
  const completeSignals = []
  const completions = []
  let claims = 0
  let resolveRunTwoComplete
  const runTwoCompleted = new Promise((resolve) => { resolveRunTwoComplete = resolve })
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  const local = localExecutionRoutes(sessionPaths, (parsed) => finishedSnapshot(parsed, sessionPaths))
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.origin === "http://127.0.0.1:3000") return local(parsed, options)
      if (parsed.pathname === "/v1/automation-runner/work") {
        if (claims === 0) return Response.json({ items: [{ runId: "run-1" }] })
        if (claims === 1) return Response.json({ items: [{ runId: "run-2" }] })
        return Response.json({ items: [] })
      }
      if (parsed.pathname.endsWith("/claim")) {
        claims += 1
        return Response.json({ assignment: { ...testAssignment(), runId: parsed.pathname.split("/").at(-2) } })
      }
      if (parsed.pathname.endsWith("/events")) return Response.json({ ok: true })
      if (parsed.pathname === "/v1/automation-runs/run-1/complete") {
        completeSignals.push(options.signal)
        // A suspended machine leaves the socket half-open: no response and no
        // error until the request's own deadline aborts it.
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal.reason ?? new Error("aborted")),
            { once: true },
          )
        })
      }
      if (parsed.pathname === "/v1/automation-runs/run-2/complete") {
        completions.push(JSON.parse(options.body))
        resolveRunTwoComplete()
        return Response.json({ ok: true })
      }
      throw new Error(`Unexpected Den request ${parsed.pathname}`)
    },
    lifecycleRequestTimeoutMs: 5,
    waitBeforeReconnect: () => new Promise(() => {}),
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  await withTimeout(runTwoCompleted, "the runner never claimed new work after the hung completion")
  runner.stop()
  assert.equal(completeSignals.length, 2, "expected exactly one bounded retry of the hung completion")
  assert.ok(completeSignals.every((signal) => signal?.aborted === true))
  assert.equal(completions[0]?.status, "succeeded")
})

test("transient heartbeat failures below the miss threshold do not abort the run", async () => {
  let heartbeats = 0
  let releaseSnapshot = () => {}
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = () => resolve(undefined) })
  const completions = []
  let resolveCompleted
  const completed = new Promise((resolve) => { resolveCompleted = resolve })
  let offered = false
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  // The gate is signal-aware so that an abort of the execution controller
  // fails the run instead of being masked by the scripted response.
  const local = localExecutionRoutes(sessionPaths, async (parsed, options) => {
    await new Promise((resolve, reject) => {
      const abort = () => reject(options.signal?.reason ?? new Error("aborted"))
      if (options.signal?.aborted) return abort()
      options.signal?.addEventListener("abort", abort, { once: true })
      void snapshotGate.then(resolve)
    })
    return finishedSnapshot(parsed, sessionPaths)
  })
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.origin === "http://127.0.0.1:3000") return local(parsed, options)
      if (parsed.pathname === "/v1/automation-runner/work") {
        if (offered) return Response.json({ items: [] })
        offered = true
        return Response.json({ items: [{ runId: "run-1" }] })
      }
      if (parsed.pathname.endsWith("/claim")) return Response.json({ assignment: testAssignment() })
      if (parsed.pathname.endsWith("/heartbeat")) {
        heartbeats += 1
        if (heartbeats <= 2) return Response.json({ message: "transient" }, { status: 500 })
        return Response.json({ leaseValid: true, cancelRequested: false })
      }
      if (parsed.pathname.endsWith("/events")) return Response.json({ ok: true })
      if (parsed.pathname.endsWith("/complete")) {
        completions.push(JSON.parse(options.body))
        resolveCompleted()
        return Response.json({ ok: true })
      }
      throw new Error(`Unexpected Den request ${parsed.pathname}`)
    },
    heartbeatIntervalMs: 1,
    heartbeatMissLimit: 3,
    waitBeforeReconnect: () => new Promise(() => {}),
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  await waitFor(() => heartbeats >= 3, "the run did not survive to a third heartbeat")
  releaseSnapshot()
  await withTimeout(completed, "completion timed out")
  runner.stop()
  assert.equal(completions[0]?.status, "succeeded")
})

test("consecutive heartbeat misses abort the run and still deliver terminal and completion", async () => {
  let heartbeats = 0
  const events = []
  const completions = []
  let resolveCompleted
  const completed = new Promise((resolve) => { resolveCompleted = resolve })
  let offered = false
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  const local = localExecutionRoutes(sessionPaths, (parsed, options) => new Promise((_resolve, reject) => {
    const abort = () => reject(options.signal?.reason ?? new Error("aborted"))
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener("abort", abort, { once: true })
  }))
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.origin === "http://127.0.0.1:3000") return local(parsed, options)
      if (parsed.pathname === "/v1/automation-runner/work") {
        if (offered) return Response.json({ items: [] })
        offered = true
        return Response.json({ items: [{ runId: "run-1" }] })
      }
      if (parsed.pathname.endsWith("/claim")) return Response.json({ assignment: testAssignment() })
      if (parsed.pathname.endsWith("/heartbeat")) {
        heartbeats += 1
        return Response.json({ message: "boom" }, { status: 500 })
      }
      if (parsed.pathname.endsWith("/events")) {
        events.push(JSON.parse(options.body))
        return Response.json({ ok: true })
      }
      if (parsed.pathname.endsWith("/complete")) {
        completions.push(JSON.parse(options.body))
        resolveCompleted()
        return Response.json({ ok: true })
      }
      throw new Error(`Unexpected Den request ${parsed.pathname}`)
    },
    heartbeatIntervalMs: 1,
    heartbeatMissLimit: 3,
    waitBeforeReconnect: () => new Promise(() => {}),
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  await withTimeout(completed, "the failed run never reached completion")
  runner.stop()
  assert.equal(heartbeats, 3, "the run should survive exactly up to the miss threshold")
  assert.equal(completions[0]?.status, "failed")
  assert.match(completions[0]?.error.message, /heartbeat failed 3 times/)
  assert.equal(events.find((entry) => entry.type === "terminal")?.payload.status, "failed")
})

test("a snapshot poll left hanging by a suspended machine still honors the assignment timeout", async () => {
  const snapshotSignals = []
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  const local = localExecutionRoutes(sessionPaths, (parsed, options) => {
    snapshotSignals.push(options.signal)
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(options.signal.reason ?? new Error("aborted")),
        { once: true },
      )
    })
  })
  await assert.rejects(
    executeDesktopAutomation({ ...testAssignment(), timeoutMs: 20 }, {
      getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
      fetchImpl: async (url, options = {}) => local(new URL(url), options),
      signal: new AbortController().signal,
    }),
    /Desktop Automation execution timed out/,
  )
  assert.equal(snapshotSignals[0]?.aborted, true)
})

test("a late heartbeat verdict for a finished run cannot cancel its successor", async () => {
  const completions = []
  let claims = 0
  /** @type {((response: Response) => void) | null} */
  let holdHeartbeat = null
  let releaseRunOne = () => {}
  const runOneGate = new Promise((resolve) => { releaseRunOne = () => resolve(undefined) })
  let releaseRunTwo = () => {}
  const runTwoGate = new Promise((resolve) => { releaseRunTwo = () => resolve(undefined) })
  let resolveRunTwoComplete
  const runTwoCompleted = new Promise((resolve) => { resolveRunTwoComplete = resolve })
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  const local = localExecutionRoutes(sessionPaths, async (parsed) => {
    await (claims === 1 ? runOneGate : runTwoGate)
    return finishedSnapshot(parsed, sessionPaths)
  })
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.origin === "http://127.0.0.1:3000") return local(parsed, options)
      if (parsed.pathname === "/v1/automation-runner/work") {
        if (claims === 0) return Response.json({ items: [{ runId: "run-1" }] })
        if (claims === 1) return Response.json({ items: [{ runId: "run-2" }] })
        return Response.json({ items: [] })
      }
      if (parsed.pathname.endsWith("/claim")) {
        claims += 1
        return Response.json({ assignment: { ...testAssignment(), runId: parsed.pathname.split("/").at(-2) } })
      }
      if (parsed.pathname === "/v1/automation-runs/run-1/heartbeat") {
        return new Promise((resolve) => { holdHeartbeat = resolve })
      }
      if (parsed.pathname === "/v1/automation-runs/run-2/heartbeat") {
        return Response.json({ leaseValid: true, cancelRequested: false })
      }
      if (parsed.pathname.endsWith("/events")) return Response.json({ ok: true })
      if (parsed.pathname.endsWith("/complete")) {
        completions.push({ runId: parsed.pathname.split("/").at(-2), body: JSON.parse(options.body) })
        if (parsed.pathname === "/v1/automation-runs/run-2/complete") resolveRunTwoComplete()
        return Response.json({ ok: true })
      }
      throw new Error(`Unexpected Den request ${parsed.pathname}`)
    },
    heartbeatIntervalMs: 1,
    waitBeforeReconnect: () => new Promise(() => {}),
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  await waitFor(() => holdHeartbeat !== null, "run-1's heartbeat did not start")
  releaseRunOne()
  await waitFor(() => claims === 2, "run-2 was not claimed")
  // The stale probe answers with a cancellation verdict for the finished
  // run-1: it must not touch the successor's execution.
  holdHeartbeat?.(Response.json({ leaseValid: true, cancelRequested: true }))
  await flushTasks()
  releaseRunTwo()
  await withTimeout(runTwoCompleted, "run-2 completion timed out")
  runner.stop()
  assert.equal(completions.find((entry) => entry.runId === "run-1")?.body.status, "succeeded")
  assert.equal(completions.find((entry) => entry.runId === "run-2")?.body.status, "succeeded")
})

test("stopping the runner during terminal delivery aborts it without further requests", async () => {
  const denPaths = []
  /** @type {AbortSignal | null} */
  let terminalSignal = null
  let offered = false
  const sessionPaths = opencodeSessionPaths("workspace-1", "session-1")
  const local = localExecutionRoutes(sessionPaths, (parsed) => finishedSnapshot(parsed, sessionPaths))
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.origin === "http://127.0.0.1:3000") return local(parsed, options)
      denPaths.push(parsed.pathname)
      if (parsed.pathname === "/v1/automation-runner/work") {
        if (offered) return Response.json({ items: [] })
        offered = true
        return Response.json({ items: [{ runId: "run-1" }] })
      }
      if (parsed.pathname.endsWith("/claim")) return Response.json({ assignment: testAssignment() })
      if (parsed.pathname.endsWith("/events")) {
        if (JSON.parse(options.body).type !== "terminal") return Response.json({ ok: true })
        terminalSignal = options.signal
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal.reason ?? new Error("aborted")),
            { once: true },
          )
        })
      }
      if (parsed.pathname.endsWith("/complete")) return Response.json({ ok: true })
      throw new Error(`Unexpected Den request ${parsed.pathname}`)
    },
    lifecycleRequestTimeoutMs: 10_000,
    waitBeforeReconnect: () => new Promise(() => {}),
  })
  runner.configure({
    baseUrl: "https://den.example.com",
    token: runnerTokenFor("https://den.example.com"),
    runnerId: "runner-1",
  })
  await waitFor(() => terminalSignal !== null, "the terminal event did not start")
  runner.stop()
  await flushTasks()
  assert.equal(terminalSignal?.aborted, true)
  // user, assistant, and usage events plus exactly one terminal attempt: the
  // retired generation never retries and never posts the completion.
  assert.equal(denPaths.filter((path) => path.endsWith("/events")).length, 4)
  assert.equal(denPaths.filter((path) => path.endsWith("/complete")).length, 0)
})
