// Run only in a test child. No request can reach a network.
import { readFileSync, writeFileSync } from "node:fs"
import { mock } from "node:test"

const plan = JSON.parse(readFileSync(process.env.DEVICE_LOGIN_TEST_PLAN, "utf8"))
const start = Date.parse("2026-10-12T00:00:00Z")
mock.timers.enable({ apis: ["Date"], now: start })
const requests = []
const delays = []
const realSetTimeout = globalThis.setTimeout
let poll = 0
let aborted = false

function waitForAbort(signal) {
  if (!signal) throw new Error("The poll needs a deadline signal")
  return new Promise((resolve, reject) => {
    const keepAlive = realSetTimeout(() => reject(new Error("The poll did not stop")), 5000)
    signal.addEventListener("abort", () => {
      clearTimeout(keepAlive)
      aborted = true
      mock.timers.tick(Math.max(0, start + plan.expiresIn * 1000 - Date.now()))
      reject(signal.reason)
    }, { once: true })
  })
}

globalThis.setTimeout = (callback, ms, ...args) => {
  delays.push(ms)
  mock.timers.tick(ms)
  return realSetTimeout(callback, 0, ...args)
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input)
  if (url.origin !== "http://device-login.test") throw new Error("Unexpected test origin")
  requests.push({ path: url.pathname, elapsed: Date.now() - start })
  if (url.pathname === "/api/auth/device/code") {
    return Response.json({ device_code: "test-device-secret", user_code: "TESTCODE", verification_uri: `${url.origin}/device`, verification_uri_complete: `${url.origin}/device`, expires_in: plan.expiresIn ?? 900, interval: 5 })
  }
  if (url.pathname === "/api/auth/device/token") {
    const answer = plan.answers[Math.min(poll++, plan.answers.length - 1)]
    if (answer.elapsed) mock.timers.tick(answer.elapsed)
    if (answer.networkError) throw new Error("test_network_failure")
    if (answer.stall === "fetch") await waitForAbort(init.signal)
    if (answer.stall === "body") return new Response(new ReadableStream({
      start(controller) { waitForAbort(init.signal).catch((error) => controller.error(error)) },
    }))
    return new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), { status: answer.status, headers: answer.headers })
  }
  if (url.pathname === "/v1/me") {
    if (plan.meElapsed) mock.timers.tick(plan.meElapsed)
    return Response.json({ user: { id: "test-user", email: "device@example.test" } })
  }
  throw new Error("Unexpected test path")
}

process.on("exit", () => {
  writeFileSync(process.env.DEVICE_LOGIN_TEST_TRACE, JSON.stringify({ requests, delays, aborted, elapsed: Date.now() - start }))
})
