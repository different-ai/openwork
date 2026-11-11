import assert from "node:assert/strict"
import { test } from "node:test"
import { COMPUTER_DISCONNECTED_ERROR, createDesktopAutomationRunner } from "../electron/automation-runner.mjs"

const denBaseUrl = "https://runner.invalid"
const account = { organizationId: "org_fixture", memberId: "member_fixture", runnerId: "runner_fixture" }
const token = (nonce = "first") => `${Buffer.from(JSON.stringify({
  v: 2, a: denBaseUrl, o: account.organizationId, m: account.memberId, r: account.runnerId,
  c: ["remote_session_v1", "remote_session_control_v1"], nonce,
})).toString("base64url")}.signature`
const workPath = "/v1/automation-runner/work"
const claimPath = "/v1/remote-session-commands/command_fixture/claim"
const eventsPath = "/v1/automation-runners/events"
const disconnected = { status: 403, body: { error: COMPUTER_DISCONNECTED_ERROR, message: "This computer was disconnected." } }

async function eventually(predicate, message) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

/** Den that refuses the routes named in `refusals`, and otherwise has one remote task waiting. */
function den(refusals) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
    const refusal = refusals[url.pathname]
    if (refusal) return json(refusal.body, refusal.status)
    if (url.pathname === eventsPath) {
      let controller = null
      const body = new ReadableStream({ start(stream) { controller = stream } })
      init.signal?.addEventListener("abort", () => controller?.error(new Error("aborted")), { once: true })
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    }
    if (url.pathname === workPath) return json({ items: [{ kind: "remote_session_create", commandId: "command_fixture" }] })
    if (url.pathname === "/v1/remote-session-requests/pending") return json({ items: [] })
    return json({ accepted: true })
  }
  return { calls, fetchImpl, count: (path) => calls.filter((call) => call === path).length }
}

function runner(fixture) {
  const rejections = []
  const waits = []
  const desktop = createDesktopAutomationRunner({
    fetchImpl: fixture.fetchImpl,
    getLocalRuntime: async () => null,
    remoteSessionPush: true,
    remoteSessionRequestPoll: { pollMs: 60_000 },
    // Nothing waits for real: every wait parks until the runner stops.
    waitBeforeReconnect: (ms, signal) => {
      waits.push(ms)
      return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
    },
    onCredentialRejected: (rejection) => { rejections.push(rejection) },
  })
  return { desktop, rejections, waits }
}

for (const [route, path] of [["the work poll", workPath], ["a claim", claimPath], ["the events stream", eventsPath]]) {
  test(`a disconnect answered on ${route} is reported with its reason and stops every loop`, async (t) => {
    const fixture = den({ [path]: disconnected })
    const { desktop, rejections, waits } = runner(fixture)
    t.after(() => desktop.stop())
    desktop.configure({ baseUrl: denBaseUrl, runnerId: account.runnerId, token: token() })
    await eventually(() => rejections.length > 0, "the refusal is reported")
    await settle()
    assert.deepEqual(rejections, [{ reason: COMPUTER_DISCONNECTED_ERROR }], "reported once, as a disconnect")
    const calls = fixture.calls.length
    assert.equal(fixture.count(path), 1, "the refused route is not asked again")
    assert.equal(fixture.count(eventsPath), 1, "the events stream does not reconnect")
    assert.equal(desktop.wake().polled, false, "waking the machine polls nothing")
    assert.deepEqual(desktop.configure({ baseUrl: denBaseUrl, runnerId: account.runnerId, token: token() }), { connected: false }, "the refused credential is not taken back")
    await settle()
    assert.equal(fixture.calls.length, calls, "nothing more is sent to Den")
    assert.equal(waits.filter((ms) => ms < 60_000).length, 0, "no reconnect backoff starts")
  })
}

test("signing in again connects the computer with its new credential", async (t) => {
  const refusals = { [workPath]: disconnected }
  const fixture = den(refusals)
  const { desktop, rejections } = runner(fixture)
  t.after(() => desktop.stop())
  desktop.configure({ baseUrl: denBaseUrl, runnerId: account.runnerId, token: token() })
  await eventually(() => rejections.length === 1, "the refusal is reported")
  delete refusals[workPath]
  desktop.configure({ baseUrl: denBaseUrl, runnerId: account.runnerId, token: token("signed-in-again") })
  await eventually(() => fixture.count(claimPath) === 1, "the new credential polls and claims work")
  assert.equal(rejections.length, 1)
})

for (const [status, body] of [[401, { error: "unauthorized" }], [403, { error: "forbidden" }], [401, null]]) {
  test(`an ordinary ${status}${body ? "" : " without a body"} is reported as a rejected credential, as before`, async (t) => {
    for (const path of [workPath, claimPath, eventsPath]) {
      const fixture = den({ [path]: { status, body } })
      const { desktop, rejections } = runner(fixture)
      t.after(() => desktop.stop())
      desktop.configure({ baseUrl: denBaseUrl, runnerId: account.runnerId, token: token() })
      await eventually(() => rejections.length > 0, `the rejection on ${path} is reported`)
      await settle()
      assert.deepEqual(rejections, [{ reason: "credential_rejected" }])
      assert.equal(fixture.count(path), 1, "the rejected route is not asked again")
      assert.equal(desktop.wake().polled, false)
    }
  })
}
