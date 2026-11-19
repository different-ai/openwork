#!/usr/bin/env node
// A stand-in for the Workbot server, for running the iPhone app in the simulator without a real one.
// It speaks the routes the app uses, keeps one conversation in memory, and streams a canned answer.
//
//   node Tools/stand-in-server.mjs [--port 8787] [--phones-off] [--workbot-off]
//
// Messages that change what happens: "fail" (the answer fails), "limit" (the free allowance is used up),
// "slow" (a long answer, to try Stop). Anything else gets the same formatted answer.
// Development only. It accepts one fixed session and holds no real data.

import http from "node:http"

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const port = Number(args[args.indexOf("--port") + 1]) || 8787
const SESSION = "dev-session"

const turns = []
const listeners = new Set()
const timers = new Map()

const ANSWER = `## Here's your day

You have **two meetings** and one thing due:

1. Design review at 10:00
2. Customer call at 14:30

- The report is due *tomorrow*
  - I can draft it now

> Tip: ask me to draft the report.

\`\`\`
total = meetings + deadlines
\`\`\`

More at [openworklabs.com](https://openworklabs.com).`

const me = () => ({
  userId: "user_dev",
  organizationId: "org_dev",
  name: "Ada Park",
  email: "ada@example.test",
  organizationName: "Example Co",
  enabled: !flag("--workbot-off"),
  mobile: !flag("--workbot-off") && !flag("--phones-off"),
})

const emit = (event) => {
  for (const response of listeners) response.write(`data: ${JSON.stringify(event)}\n\n`)
}

function answer(turn) {
  // The keyboard capitalizes the first letter, so match the special messages loosely.
  const said = turn.text.trim().toLowerCase()
  if (said === "fail") return finish(turn, { status: "failed", error: "Workbot couldn't finish that. Try again.", retryable: true })
  if (said === "limit") return finish(turn, { status: "failed", error: null, modelIssue: "free_limit", retryable: false })
  const text = said === "slow" ? Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long answer.`).join("\n\n") : ANSWER
  const pieces = text.match(/[\s\S]{1,12}/g) ?? []
  let sent = 0
  turn.status = "working"
  emit({ type: "changed", messageId: turn.id, status: "working" })
  emit({ type: "working", messageId: turn.id, step: 0, on: "other" })
  timers.set(turn.id, setInterval(() => {
    if (sent >= pieces.length) return finish(turn, { status: "done", parts: [{ kind: "steps", steps: [{ label: "Calendar", icon: "app", status: "done", app: "calendar" }] }, { kind: "text", text, step: 0 }] })
    emit({ type: "text", messageId: turn.id, step: 0, delta: pieces[sent++] })
  }, said === "slow" ? 150 : 60))
}

function finish(turn, change) {
  clearInterval(timers.get(turn.id))
  timers.delete(turn.id)
  Object.assign(turn, { finishedAt: Date.now() }, change)
  emit({ type: "changed", messageId: turn.id, status: turn.status })
}

const json = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json" })
  response.end(JSON.stringify(body))
}

const body = async (request) => {
  let text = ""
  for await (const chunk of request) text += chunk
  try { return JSON.parse(text || "{}") } catch { return null }
}

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  const route = `${request.method} ${url.pathname}`
  console.log(route)
  if (request.headers.authorization !== `Bearer ${SESSION}`) return json(response, 401, { error: "signed_out" })
  if (route === "POST /auth/logout") return json(response, 200, { ok: true })
  if (route === "POST /auth/app/refresh") return json(response, 200, { session: SESSION, expiresAt: Date.now() + 45 * 60_000 })
  if (route === "GET /v1/workbot/me") return json(response, 200, me())
  if (!me().mobile) return json(response, 403, { error: "workbot_mobile_not_enabled" })

  if (route === "GET /v1/workbot") {
    return json(response, 200, {
      available: true, name: "Workbot", organizationName: "Example Co",
      status: turns.some((turn) => turn.status === "working" || turn.status === "queued") ? "busy" : "idle",
      turns, hasEarlier: false, filesEnabled: true,
    })
  }
  if (route === "GET /v1/workbot/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" })
    response.write("event: ready\ndata: {}\n\n")
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000)
    listeners.add(response)
    request.on("close", () => { clearInterval(keepAlive); listeners.delete(response) })
    return
  }
  if (route === "POST /v1/workbot/messages") {
    const message = await body(request)
    if (!message || !/^[A-Za-z0-9_-]{8,64}$/.test(message.id ?? "") || typeof message.text !== "string" || !message.text.trim()) return json(response, 400, { error: "invalid_request" })
    if (!turns.some((turn) => turn.id === message.id)) {
      const turn = { id: message.id, text: message.text.trim(), sentAt: Date.now(), finishedAt: null, status: "queued", attachments: [], outputs: [], parts: [], modelSteps: 0, error: null, retryable: true, tasks: [] }
      turns.push(turn)
      setTimeout(() => answer(turn), 400)
    }
    return json(response, 202, { ok: true })
  }
  const retry = /^POST \/v1\/workbot\/messages\/([^/]+)\/retry$/.exec(route)
  if (retry) {
    const turn = turns.find((candidate) => candidate.id === decodeURIComponent(retry[1]))
    if (!turn) return json(response, 404, { error: "unknown_message" })
    if (turn.status !== "failed") return json(response, 409, { error: "not_failed" })
    Object.assign(turn, { status: "queued", error: null, modelIssue: undefined, parts: [], text: turn.text.trim().toLowerCase() === "fail" ? "try again" : turn.text })
    setTimeout(() => answer(turn), 400)
    return json(response, 202, { ok: true })
  }
  if (route === "POST /v1/workbot/stop") {
    for (const turn of turns) if (turn.status === "working" || turn.status === "queued") finish(turn, { status: "stopped" })
    return json(response, 200, { ok: true })
  }
  return json(response, 404, { error: "not_found" })
}).listen(port, "127.0.0.1", () => console.log(`Stand-in Workbot server on http://127.0.0.1:${port} (session "${SESSION}")`))
