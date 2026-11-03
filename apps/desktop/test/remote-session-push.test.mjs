import assert from "node:assert/strict"
import { test } from "node:test"
import { createDesktopAutomationRunner, readRunnerEvents } from "../electron/automation-runner.mjs"

const denBaseUrl = "https://runner.invalid"
const account = { organizationId: "org_fixture", memberId: "member_fixture", runnerId: "runner_fixture" }
const token = `${Buffer.from(JSON.stringify({
  v: 2, a: denBaseUrl, o: account.organizationId, m: account.memberId, r: account.runnerId,
  c: ["remote_session_v1", "remote_session_control_v1"],
})).toString("base64url")}.signature`

async function eventually(predicate, message) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

/** Den with a controllable runner event stream. */
function den({ eventsStatus = 200 } = {}) {
  const calls = []
  const waits = []
  let controller = null
  const encoder = new TextEncoder()
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    const headers = new Headers(init.headers)
    calls.push({ path: url.pathname, push: headers.get("x-openwork-remote-session-push") })
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
    if (url.pathname === "/v1/automation-runners/events") {
      if (eventsStatus !== 200) return json({ error: "feature_disabled" }, eventsStatus)
      const body = new ReadableStream({ start(stream) { controller = stream } })
      init.signal?.addEventListener("abort", () => controller?.error(new Error("aborted")), { once: true })
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    }
    if (url.pathname === "/v1/automation-runner/work") return json({ items: [] })
    if (url.pathname === "/v1/remote-session-requests/pending") return json({ items: [] })
    return json({ accepted: true })
  }
  return {
    calls,
    waits,
    fetchImpl,
    send(event) { controller?.enqueue(encoder.encode(`event: ${event}\ndata: {}\n\n`)) },
    workPolls() { return calls.filter((call) => call.path === "/v1/automation-runner/work").length },
    events() { return calls.filter((call) => call.path === "/v1/automation-runners/events") },
  }
}

function runner(fixture, options = {}) {
  return createDesktopAutomationRunner({
    fetchImpl: fixture.fetchImpl,
    getLocalRuntime: async () => null,
    remoteSessionRequestPoll: { pollMs: 60_000 },
    // Nothing waits for real: every wait parks until the runner stops.
    waitBeforeReconnect: (ms, signal) => {
      fixture.waits.push(ms)
      return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
    },
    ...options,
  })
}

test("an announced remote-session task makes the desktop check for work at once, not at the next minute poll", async (t) => {
  const fixture = den()
  const desktop = runner(fixture, { remoteSessionPush: true })
  t.after(() => desktop.stop())
  desktop.configure({ baseUrl: denBaseUrl, runnerId: account.runnerId, token })
  await eventually(() => fixture.workPolls() === 1 && fixture.events().length === 1, "the first poll and the event stream start")
  assert.equal(fixture.events()[0]?.push, "1", "the stream asks Den for remote-session pushes")
  fixture.send("keepalive")
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(fixture.workPolls(), 1, "a keepalive does not poll")
  fixture.send("remote_session_work_available")
  await eventually(() => fixture.workPolls() === 2, "the announced task triggers a work check")
})

test("while Den has the feature off the desktop keeps polling and asks again ten minutes later", async (t) => {
  const fixture = den({ eventsStatus: 404 })
  const desktop = runner(fixture, { remoteSessionPush: true })
  t.after(() => desktop.stop())
  desktop.configure({ baseUrl: denBaseUrl, runnerId: account.runnerId, token })
  await eventually(() => fixture.waits.includes(10 * 60_000), "the push loop waits ten minutes after a 404")
  assert.equal(fixture.events().length, 1)
  assert.ok(fixture.workPolls() >= 1, "the minute poll still runs")
})

test("without the option the desktop never opens the event stream", async (t) => {
  const fixture = den()
  const desktop = runner(fixture)
  t.after(() => desktop.stop())
  desktop.configure({ baseUrl: denBaseUrl, runnerId: account.runnerId, token })
  await eventually(() => fixture.workPolls() === 1, "the first poll runs")
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(fixture.events().length, 0)
})

test("the event reader splits events across chunks and CRLF line endings", async () => {
  const encoder = new TextEncoder()
  const chunks = ["event: keep", "alive\r\ndata: {}\r\n\r\nevent: remote_session_work_available\n", "data: {}\n\n"]
  const body = new ReadableStream({ start(stream) { for (const chunk of chunks) stream.enqueue(encoder.encode(chunk)); stream.close() } })
  const seen = []
  await readRunnerEvents(body, () => true, (type) => seen.push(type))
  assert.deepEqual(seen, ["keepalive", "remote_session_work_available"])
})
