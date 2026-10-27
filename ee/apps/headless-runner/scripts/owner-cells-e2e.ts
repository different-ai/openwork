/** Boots the real Worker host with a streamed mock model; all database state is isolated in a temporary project. */
import assert from "node:assert/strict"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { builtinModules } from "node:module"
import { join } from "node:path"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import { z } from "zod"
import { createApp } from "../src/app.js"
import type { ModelClient } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { Store } from "../src/store.js"

const runtime = process.argv.includes("--celld") ? "celld" : "wrangler"
const project = join(import.meta.dirname, "..")
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "owner-cells-e2e-")))
const token = `test_${crypto.randomUUID().replaceAll("-", "")}`
const ownerA = "test-org/member-a"
const ownerB = "test-org/member-b"
/** A person whose chats live in session cells (hs_c_), and whose legacy chats are split out of their owner cell. */
const ownerC = "test-org/member-c"
let worker: ChildProcess | null = null
let output = ""
let base = ""
let slowCalls = 0
let durableCalls = 0
const hanging: ServerResponse[] = []
/** A `[steps]` turn: this many tool steps, each model call taking STEP_MS, then its answer; calls per step index. */
const STEP_COUNT = 5
const STEP_MS = 800
const stepCalls = new Map<number, number>()
const modelKeys: string[] = []
const seenReadResults: string[] = []
const modelRequest = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).loose()) })
const model = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "test-model" }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    const body = modelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
    modelKeys.push(request.headers.authorization ?? "")
    const index = body.messages.findLastIndex((message) => message.role === "user")
    const content = body.messages[index]?.content
    const prompt = typeof content === "string" ? content : ""
    const result = body.messages.slice(index + 1).find((message) => message.role === "tool")
    if (prompt.includes("[steps]")) {
      // A slow step-mode turn: each call streams a little, waits, then asks for the next note (or answers).
      const step = body.messages.slice(index + 1).filter((message) => message.role === "tool").length
      stepCalls.set(step, (stepCalls.get(step) ?? 0) + 1)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Step ${step}. ` } }] })}\n\n`)
      const note = { index: 0, id: `call_step_${step}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `steps/${step}.md`, content: `step ${step}` }) } }
      setTimeout(() => {
        const last = { choices: [{ delta: step < STEP_COUNT ? { tool_calls: [note] } : { content: "Steps done." }, finish_reason: step < STEP_COUNT ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
        response.end(`data: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`)
      }, STEP_MS)
      return
    }
    if (prompt.includes("[slow]") && !result && slowCalls++ === 0) {
      hanging.push(response)
      return
    }
    if (prompt.includes("[durable]") && !result && durableCalls++ === 0) {
      hanging.push(response)
      return
    }
    // Session storage: `[big]` writes a large file and reads it back (a large body); `[seal]` answers at once, at length.
    if (prompt.includes("[big]") || prompt.includes("[seal]")) {
      const results = body.messages.slice(index + 1).filter((message) => message.role === "tool")
      if (prompt.includes("[big]") && results.length === 2) bigReadResults.push(String(results[1]?.content ?? ""))
      const call = prompt.includes("[seal]") || results.length === 2 ? null : results.length === 0
        ? { index: 0, id: "call_big_write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "big.md", content: BIG_FILE }) } }
        : { index: 0, id: "call_big_read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "big.md" }) } }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(`data: ${JSON.stringify({ choices: [{ delta: call ? { tool_calls: [call] } : { content: `Sealed answer. ${"Lorem ipsum dolor sit amet. ".repeat(20)}` }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
      return
    }
    // A turn that waits until it is stopped (Stop in a session cell).
    if (prompt.includes("[hang]") && !result) {
      hanging.push(response)
      return
    }
    // `[owner-write]` / `[owner-read]`: a note of its own, to follow the owner's memory across session cells.
    const ownerNote = prompt.includes("[owner-write]") || prompt.includes("[owner-read]")
    const read = prompt.includes("[read]") || prompt.includes("[owner-read]")
    if (result && read) seenReadResults.push(String(result.content))
    const tool = { index: 0, id: "call_note", type: "function", function: {
      name: read ? "read_file" : "write_file",
      arguments: JSON.stringify({ path: ownerNote ? "memory/owner.md" : "memory/note.md", ...(!read ? { content: ownerNote ? "owner-memory-witness" : "shared-memory-witness" } : {}) }),
    } }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(`data: ${JSON.stringify({ choices: [{ delta: result ? { content: "Memory checked." } : { tool_calls: [tool] }, finish_reason: result ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
  } catch (error) {
    response.writeHead(500).end(String(error))
  }
})

// Den's resume-token exchange (self-resume): answers every grant with a fresh token and records who asked.
const callbackToken = `test_callback_${crypto.randomUUID().replaceAll("-", "")}`
const grantKey = `test_grant_key_${crypto.randomUUID().replaceAll("-", "")}`
const grant = `hrg_${randomBytes(32).toString("base64url")}`
const exchanges: Array<{ authorization: string | undefined; grant: string; sessionId: string; messageId: string }> = []
const den = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  if (request.method !== "POST" || request.url !== "/v1/headless/resume-token") return void response.writeHead(404).end()
  const body = z.object({ grant: z.string(), sessionId: z.string(), messageId: z.string() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString()))
  exchanges.push({ authorization: request.headers.authorization, ...body })
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ mcpToken: `test-fresh-token-${exchanges.length}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), readOnly: false }))
})
let denPort = 0

// The files bucket (HEADLESS_FILES=s3), path-style, in memory: sealed segments and large bodies (storage/) live here.
const BIG_FILE = Array.from({ length: 40 }, (_, line) => `row ${line}: figures for the region, quarter by quarter`).join("\n")
const bigReadResults: string[] = []
const bucket = new Map<string, { bytes: Buffer; at: number }>()
const bucketLog: Array<{ method: string; key: string }> = []
const s3 = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  const url = new URL(request.url ?? "/", "http://bucket")
  const key = decodeURIComponent(url.pathname.replace(/^\/e2e-bucket\/?/, ""))
  bucketLog.push({ method: request.method ?? "", key })
  if (request.method === "PUT") {
    bucket.set(key, { bytes: Buffer.concat(chunks), at: Date.now() })
    return void response.writeHead(200).end()
  }
  if (request.method === "DELETE") {
    bucket.delete(key)
    return void response.writeHead(204).end()
  }
  if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") ?? ""
    const contents = [...bucket.entries()].filter(([name]) => name.startsWith(prefix)).map(([name, value]) => `<Contents><Key>${name}</Key><LastModified>${new Date(value.at).toISOString()}</LastModified></Contents>`)
    return void response.writeHead(200, { "content-type": "application/xml" }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents.join("")}</ListBucketResult>`)
  }
  const found = request.method === "GET" ? bucket.get(key) : undefined
  if (!found) return void response.writeHead(404).end()
  response.writeHead(200).end(found.bytes)
})
let s3Port = 0

async function freePort() {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function start(modelPort: number) {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  const vars = {
    HEADLESS_API_TOKEN: token,
    HEADLESS_MODEL_PROTOCOL: "openai",
    HEADLESS_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}`,
    HEADLESS_MODEL: "test-model",
    // Slack and Automations send no model key of their own; the runner's default key answers them.
    HEADLESS_MODEL_API_KEY: "test-default-key",
    // Self-resume: turns sent with a resume grant keep going after a restart with nobody re-sending them.
    HEADLESS_DEN_API_URL: `http://127.0.0.1:${denPort}`,
    HEADLESS_DEN_CALLBACK_TOKEN: callbackToken,
    HEADLESS_GRANT_KEY: grantKey,
    // Slows an owner split's copy so the check can kill the runtime in the middle of one.
    HEADLESS_TEST_SPLIT_PAUSE_MS: "250",
    // Session storage: files in a bucket, sealing on with small thresholds so a 34-turn chat seals its oldest turns.
    HEADLESS_FILES: "s3",
    HEADLESS_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    HEADLESS_S3_BUCKET: "e2e-bucket",
    HEADLESS_S3_ACCESS_KEY_ID: "test-access-key",
    HEADLESS_S3_SECRET_ACCESS_KEY: "test-secret-key",
    HEADLESS_S3_FORCE_PATH_STYLE: "true",
    HEADLESS_SEGMENTS: "on",
    HEADLESS_SEGMENT_TARGET_BYTES: "1024",
    HEADLESS_LARGE_BODY_BYTES: "1024",
    HEADLESS_CONTEXT_CHAR_BUDGET: "10000",
  }
  writeFileSync(join(temporary, ".dev.vars"), Object.entries(vars).map(([key, value]) => `${key}=${value}`).join("\n"))
  // celld requires main to be inside the project. Bundle into our isolated project instead of clobbering .dev.vars.
  execFileSync(join(project, "node_modules/.bin/esbuild"), [join(project, "src/worker/index.ts"), "--bundle", "--platform=neutral", "--conditions=workerd,browser", "--main-fields=browser,module,main", "--format=esm", "--external:node:*", "--external:cloudflare:*", ...builtinModules.filter((name) => !name.startsWith("node:")).map((name) => `--alias:${name}=node:${name}`), `--outfile=${join(temporary, "index.js")}`], { cwd: project, stdio: "pipe" })
  const config = readFileSync(join(project, "wrangler.jsonc"), "utf8").replace('"src/worker/index.ts"', '"index.js"')
  writeFileSync(join(temporary, "wrangler.jsonc"), config)
  const binary = runtime === "celld" ? process.env.CELLD_BIN ?? "celld" : join(project, "node_modules/.bin/wrangler")
  const args = runtime === "celld"
    // --logs prints the internal (operator) listener, which the version-switch check calls.
    ? ["dev", ".", "--host", "127.0.0.1", "--port", String(port), "--no-watch", "--logs"]
    : ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(temporary, "state"), "--show-interactive-dev-session=false"]
  const child = spawn(binary, args, { cwd: temporary, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", CELLD_ESBUILD: join(project, "node_modules/.bin/esbuild"),
  } })
  worker = child
  let spawnError: Error | null = null
  child.on("error", (error) => { spawnError = error })
  child.stdout?.on("data", (chunk: unknown) => { output += String(chunk) })
  child.stderr?.on("data", (chunk: unknown) => { output += String(chunk) })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(`${runtime} exited: ${output.slice(-6_000)}`)
    if (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok, () => false)) return
    await sleep(200)
  }
  throw new Error(`${runtime} startup timed out: ${output.slice(-6_000)}`)
}

async function stop() {
  const child = worker
  worker = null
  if (!child?.pid || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  try { process.kill(-child.pid, "SIGKILL") } catch { return }
  await exited
}

function call(path: string, owner: string = ownerA, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(15_000), headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", ...(owner ? { "x-openwork-headless-owner": owner } : {}), ...init.headers,
  } })
}
/** celld's internal listener (POST /reload, GET /state), from the newest node's log. */
function celldInternal() {
  const address = [...output.matchAll(/celld internal listening on (\S+)/g)].at(-1)?.[1]
  assert.ok(address, "celld printed its internal listener")
  return `http://${address}`
}
const celldStateSchema = z.object({ deployment: z.object({ generation: z.number(), swapping: z.number(), cells: z.record(z.string(), z.number()) }).loose() }).loose()
async function celldDeployment() {
  return celldStateSchema.parse(await (await fetch(`${celldInternal()}/state`, { signal: AbortSignal.timeout(5_000) })).json()).deployment
}
/** A session's SSE `data:` events, parsed, until `signal` aborts. */
async function readSse(id: string, owner: string, signal: AbortSignal, into: unknown[]) {
  const response = await fetch(`${base}/v1/sessions/${id}/events`, { signal, headers: { authorization: `Bearer ${token}`, "x-openwork-headless-owner": owner } })
  assert.equal(response.status, 200)
  assert.ok(response.body)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += value
        for (let boundary = buffer.indexOf("\n\n"); boundary !== -1; boundary = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          if (block.startsWith(":") || /^event: ready/m.test(block)) continue
          into.push(JSON.parse(block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")))
        }
      }
    } catch {
      // Aborted.
    }
  })()
}
const completedEvent = (messageId: string) => (event: unknown) => {
  const parsed = z.object({ type: z.literal("changed"), messageId: z.literal(messageId), status: z.literal("completed") }).safeParse(event)
  return parsed.success
}
async function until(check: () => boolean, ms: number, what: string) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

const viewSchema = z.object({ status: z.string(), finalAssistantText: z.string(), turns: z.array(z.object({ messageId: z.string(), status: z.string(), error: z.string().nullable() })) })
async function view(id: string, owner = ownerA) {
  const response = await call(`/v1/sessions/${id}`, owner)
  const body: unknown = await response.json()
  const parsed = viewSchema.safeParse(body)
  if (!parsed.success) throw new Error(`read ${id}: ${response.status} ${JSON.stringify(body).slice(0, 300)}`)
  return parsed.data
}
async function untilIdle(id: string, owner = ownerA) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await view(id, owner)
    if (snapshot.status === "idle") return snapshot
    await sleep(100)
  }
  throw new Error(`turn did not finish: ${JSON.stringify(await view(id, owner))}`)
}
function send(id: string, messageId: string, prompt: string, owner = ownerA) {
  return call(`/v1/sessions/${id}/turns`, owner, { method: "POST", body: JSON.stringify({ messageId, prompt, credentials: { modelApiKey: "test-turn-key" } }) })
}
async function create(owner: string, body: Record<string, unknown>) {
  const response = await call("/v1/sessions", owner, { method: "POST", body: JSON.stringify(body) })
  assert.equal(response.status, 201, await response.clone().text())
  return z.object({ id: z.string() }).parse(await response.json()).id
}

try {
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve))
  const address = model.address()
  assert.ok(address && typeof address === "object")
  await new Promise<void>((resolve) => den.listen(0, "127.0.0.1", resolve))
  const denAddress = den.address()
  assert.ok(denAddress && typeof denAddress === "object")
  denPort = denAddress.port
  await new Promise<void>((resolve) => s3.listen(0, "127.0.0.1", resolve))
  const s3Address = s3.address()
  assert.ok(s3Address && typeof s3Address === "object")
  s3Port = s3Address.port
  await start(address.port)
  assert.equal((await fetch(`${base}/v1/models`)).status, 401)
  assert.equal((await call("/v1/sessions", ownerA, { method: "POST", body: JSON.stringify({ owner: ownerB }) })).status, 400)
  const main = await create(ownerA, { title: "Main", tasks: true })
  const side = await create(ownerA, { title: "Side", memoryOf: main })
  const other = await create(ownerB, { title: "Other owner" })
  assert.equal((await call(`/v1/sessions/${main}`, ownerB)).status, 404)
  assert.equal((await call(`/v1/sessions?owner=${encodeURIComponent(ownerB)}`, ownerA)).status, 400)
  assert.equal((await call("/v1/sessions", ownerB, { method: "POST", body: JSON.stringify({ memoryOf: main }) })).status, 400)
  assert.equal((await call("/v1/sessions?owner=x", "")).status, 400)
  const filesStatus = await call("/v1/files/status", "")
  assert.equal(filesStatus.status, 200, await filesStatus.clone().text())
  console.log("PASS authenticated owner routing, body consistency, and cross-owner isolation")

  // Slack and Automations: no owner header, one cell per conversation, same API as the Node runner.
  const slack = await create("", { title: "Slack thread" })
  assert.match(slack, /^hs_[0-9a-f]{32}$/)
  assert.equal((await call(`/v1/sessions/${slack}`, ownerA)).status, 404)
  assert.equal((await call(`/v1/sessions/hs_${"0".repeat(32)}`, "")).status, 404)
  assert.equal((await send(slack, "msg_slack", "[write] Slack question", "")).status, 202)
  const slackDone = await untilIdle(slack, "")
  assert.equal(slackDone.turns[0]?.status, "completed")
  assert.equal(slackDone.finalAssistantText, "Memory checked.")
  const stopped = await call(`/v1/sessions/${slack}/abort`, "", { method: "POST", body: "{}" })
  assert.equal(stopped.status, 200)
  const slackAgain = z.object({ state: z.string() }).parse(await (await send(slack, "msg_slack", "[write] Slack question", "")).json())
  assert.equal(slackAgain.state, "already_present")
  console.log("PASS owner-less (Slack/Automations) conversations: create, send, read, stop, idempotent resend, isolation")

  assert.equal((await send(main, "msg_1", "[write] Remember a note")).status, 202)
  assert.equal((await untilIdle(main)).turns[0]?.status, "completed")
  assert.equal((await call(`/v1/sessions/${main}/files/content?path=memory/note.md`)).status, 200)
  assert.equal((await send(side, "msg_2", "[read] Read the shared note")).status, 202)
  assert.equal((await untilIdle(side)).turns[0]?.status, "completed")
  assert.ok(seenReadResults.some((result) => result.includes("shared-memory-witness")))
  assert.equal((await send(other, "msg_other", "[write] A different owner", ownerB)).status, 202)
  assert.equal((await untilIdle(other, ownerB)).turns[0]?.status, "completed")
  const sessions = z.object({ sessions: z.array(z.object({ id: z.string() })) }).parse(await (await call(`/v1/sessions?owner=${encodeURIComponent(ownerA)}`)).json())
  assert.deepEqual(new Set(sessions.sessions.map((s) => s.id)), new Set([main, side]))
  const again = z.object({ state: z.string() }).parse(await (await send(main, "msg_1", "[write] Remember a note")).json())
  assert.equal(again.state, "already_present")
  assert.ok(modelKeys.length > 0 && modelKeys.every((key) => key === "Bearer test-turn-key"))
  console.log("PASS streamed model turns, file tools, shared side-chat memory, owner listing, per-turn credentials, and idempotency")

  // Den's own Slack adapter (the code Slack runs use), unchanged, against this runtime.
  const { createSlackRunner } = await import("../../den-api/src/slack-assistant/headless.ts")
  const slackDeps = { config: { url: base, token }, fetch, mintToken: async () => ({ token: "test-mcp-token" }), maxTokenTtlMs: 60 * 60_000 }
  const slackRunner = createSlackRunner({ userId: "test-user", organizationId: "test-org" }, slackDeps)
  const opened = await slackRunner.create({ title: "Slack thread" })
  assert.ok(opened.ok, JSON.stringify(opened))
  const slackSession = opened.sessionId
  const sentRun = await slackRunner.send({ sessionId: slackSession, messageId: "slack_run_1", prompt: "[write] What changed?" })
  assert.ok(sentRun.ok && sentRun.accepted, JSON.stringify(sentRun))
  let slackStatus = "busy"
  let slackText = ""
  let slackError: string | undefined
  for (const until = Date.now() + 30_000; Date.now() < until; await sleep(200)) {
    const read = await slackRunner.read({ sessionId: slackSession, messageId: "slack_run_1" })
    assert.ok(read.ok, JSON.stringify(read))
    slackStatus = read.snapshot.status
    slackText = read.snapshot.finalAssistantText
    slackError = read.snapshot.terminalError?.code
    if (slackStatus === "idle") break
  }
  assert.equal(slackStatus, "idle")
  assert.equal(slackText, "Memory checked.")
  assert.equal(slackError, undefined)
  assert.ok(modelKeys.at(-1) === "Bearer test-default-key")
  await slackRunner.stop({ sessionId: slackSession, messageId: "slack_run_1" })
  const unknown = await slackRunner.read({ sessionId: `hs_${"1".repeat(32)}`, messageId: "x" })
  assert.ok(!unknown.ok && unknown.error === "unknown_session", JSON.stringify(unknown))
  console.log("PASS Den's Slack adapter (create, send, read to the answer, stop, unknown session) unchanged on this runtime")

  // Live updates over a WebSocket (headless-protocol's openEventsSocket): the same events as the SSE stream.
  const live = await create(ownerA, { title: "Live" })
  const liveClient = createHeadlessRunnerClient({ config: { url: base, token, owner: ownerA }, fetch, mintToken: async () => ({ token: "unused" }), maxTokenTtlMs: 60_000 })
  const socketStop = new AbortController()
  const socket = await liveClient.openEventsSocket(live, socketStop.signal)
  assert.ok(socket, `${runtime} upgraded the events request`)
  const socketEvents: unknown[] = []
  let socketEnded = false
  const socketDone = (async () => {
    for await (const event of socket) socketEvents.push(event)
    socketEnded = true
  })()
  const sseStop = new AbortController()
  const sseEvents: unknown[] = []
  await readSse(live, ownerA, sseStop.signal, sseEvents)
  await until(() => socketEvents.length > 0, 5_000, "the socket's ready message")
  await sleep(200)
  assert.equal((await send(live, "msg_live_1", "[write] A live note")).status, 202)
  assert.equal((await untilIdle(live)).turns[0]?.status, "completed")
  await until(() => sseEvents.some(completedEvent("msg_live_1")) && socketEvents.some(completedEvent("msg_live_1")), 10_000, "both streams to see the turn complete")
  await sleep(200)
  assert.deepEqual(socketEvents[0], { type: "ready" })
  assert.deepEqual(socketEvents.slice(1), sseEvents, "each socket message is one SSE event, in the same order")
  assert.ok(sseEvents.length >= 4, JSON.stringify(sseEvents))
  // An open SSE stream is a request the cell is serving: it would hold up a version switch, so it ends here.
  sseStop.abort()
  console.log(`PASS live events over a WebSocket on ${runtime} match the SSE stream for the same turn`)

  if (runtime === "celld") {
    // A runner deploy: celld switches resident cells to new code once they are idle. The open hibernatable socket
    // neither holds that up (a forced switch waits 60 s) nor is closed by it, and events after the switch reach it.
    const before = await celldDeployment()
    // The socket's cell just answered a turn, so it is resident, on the code before the switch.
    assert.ok(Object.keys(before.cells).length > 0 && Object.values(before.cells).every((generation) => generation === before.generation), JSON.stringify(before))
    const reload = z.object({ ok: z.literal(true), outcome: z.literal("adopted"), generation: z.number() }).loose().parse(await (await fetch(`${celldInternal()}/reload`, { method: "POST", signal: AbortSignal.timeout(60_000) })).json())
    assert.notEqual(reload.generation, before.generation)
    const switchStarted = Date.now()
    let after = await celldDeployment()
    while (Date.now() - switchStarted < 30_000 && (after.swapping > 0 || Object.values(after.cells).some((generation) => generation !== reload.generation))) {
      await sleep(250)
      after = await celldDeployment()
    }
    assert.ok(Object.values(after.cells).every((generation) => generation === reload.generation) && after.swapping === 0, `every resident cell switched: ${JSON.stringify(after)}`)
    const switchMs = Date.now() - switchStarted
    assert.ok(switchMs < 30_000, `the switch took ${switchMs} ms`)
    assert.equal(socketEnded, false, "the socket stayed open across the switch")
    assert.equal((await send(live, "msg_live_2", "[write] After the switch")).status, 202)
    assert.equal((await untilIdle(live)).turns.find((turn) => turn.messageId === "msg_live_2")?.status, "completed")
    await until(() => socketEvents.some(completedEvent("msg_live_2")), 10_000, "the socket to see the turn after the switch")
    assert.equal(socketEnded, false)
    console.log(`PASS an open hibernatable socket didn't hold up a celld version switch (${switchMs} ms) and kept receiving events after it`)
  }
  socketStop.abort()
  await socketDone

  assert.equal((await send(main, "msg_slow", "[slow] [write] Resume after restart")).status, 202)
  // Another person's turn, sent with a resume grant (as current Den sends them).
  const durable = await call(`/v1/sessions/${other}/turns`, ownerB, { method: "POST", body: JSON.stringify({
    messageId: "msg_durable", prompt: "[durable] [write] Keep going on your own", credentials: { modelApiKey: "test-turn-key", resumeGrant: grant },
  }) })
  assert.equal(durable.status, 202, await durable.clone().text())
  assert.ok(!(await durable.text()).includes(grant))
  const deadline = Date.now() + 10_000
  while (hanging.length < 2 && Date.now() < deadline) await sleep(100)
  assert.equal(hanging.length, 2)
  assert.equal((await view(main)).status, "busy")
  assert.equal((await view(other, ownerB)).status, "busy")
  await stop()
  for (const response of hanging.splice(0)) response.destroy()
  await start(address.port)
  const cut = (await view(main)).turns.find((turn) => turn.messageId === "msg_slow")
  assert.equal(cut?.status, "interrupted")
  assert.equal(cut?.error, "runner_restarted")
  assert.equal((await call(`/v1/sessions/${main}/files/content?path=memory/note.md`)).status, 200)
  assert.equal((await view(slack, "")).turns[0]?.status, "completed")
  assert.equal((await send(main, "msg_slow", "[slow] [write] Resume after restart")).status, 202)
  assert.equal((await untilIdle(main)).turns.find((turn) => turn.messageId === "msg_slow")?.status, "completed")
  assert.equal((await call(`/v1/sessions/${side}`, ownerA, { method: "DELETE" })).status, 204)
  assert.equal((await call(`/v1/sessions/${side}`)).status, 404)
  assert.equal((await call(`/v1/sessions/${main}`)).status, 200)
  assert.equal((await call(`/v1/sessions/${main}/files/content?path=memory/note.md`)).status, 200)
  console.log("PASS runtime-kill recovery, resume, persisted memory, and deleting a side chat without deleting its owner's state")

  // Nobody re-sends msg_durable, or even reads that cell: its alarm wakes it on the restarted runtime, recovery
  // marks the turn interrupted, and the runner exchanges the grant with Den and resumes the turn itself.
  const resumedBy = Date.now() + 90_000
  while (!exchanges.some((entry) => entry.messageId === "msg_durable") && Date.now() < resumedBy) await sleep(250)
  assert.deepEqual(exchanges, [{ authorization: `Bearer ${callbackToken}`, grant, sessionId: other, messageId: "msg_durable" }])
  const finished = Date.now() + 30_000
  let durableView = await view(other, ownerB)
  while (durableView.turns.find((turn) => turn.messageId === "msg_durable")?.status !== "completed" && Date.now() < finished) {
    await sleep(200)
    durableView = await view(other, ownerB)
  }
  assert.equal(durableView.turns.find((turn) => turn.messageId === "msg_durable")?.status, "completed", JSON.stringify(durableView.turns))
  assert.equal(durableView.finalAssistantText, "Memory checked.")
  assert.equal(durableCalls, 2, "the turn's model call was made again after the restart")
  assert.ok(!output.includes(grant) && !output.includes("test-fresh-token"), "no grant or token in the runtime's logs")
  console.log(`PASS a turn with a resume grant completes after a ${runtime} restart with no caller re-send (alarm → Den exchange → resume)`)

  // Step mode (`execution: "steps"`): the turn runs one step at a time from its cell's alarm, so a runner deploy
  // switches the cell between two steps instead of cancelling one, and the turn goes on to its answer on the new
  // code (with the runner's model key: the caller's own is held in memory only).
  const stepped = await create("", { title: "Step mode" })
  const sentSteps = await call(`/v1/sessions/${stepped}/turns`, "", { method: "POST", body: JSON.stringify({
    messageId: "msg_steps", prompt: "[steps] Work through the list", execution: "steps", credentials: { modelApiKey: "test-turn-key" },
  }) })
  assert.equal(sentSteps.status, 202, await sentSteps.clone().text())
  assert.equal(z.object({ turn: z.object({ execution: z.string() }).loose() }).parse(await sentSteps.json()).turn.execution, "steps")
  await until(() => stepCalls.has(1), 20_000, "the first step to commit")
  let switchNote: string
  if (runtime === "celld") {
    // POST /reload on the internal listener rebuilds the deployment and adopts it as a new generation in place, the
    // same switch a `celld deploy` makes: each resident cell moves at a safe point (no request, alarm or output
    // pending), or is forced after CELLD_DEPLOY_MAX_AGE_S (60 s), cancelling its work.
    const reload = z.object({ ok: z.literal(true), outcome: z.literal("adopted"), generation: z.number() }).loose().parse(await (await fetch(`${celldInternal()}/reload`, { method: "POST", signal: AbortSignal.timeout(60_000) })).json())
    const switchStarted = Date.now()
    let after = await celldDeployment()
    while (Date.now() - switchStarted < 30_000 && (after.swapping > 0 || Object.values(after.cells).some((generation) => generation !== reload.generation))) {
      await sleep(100)
      after = await celldDeployment()
    }
    const switchMs = Date.now() - switchStarted
    assert.ok(Object.values(after.cells).every((generation) => generation === reload.generation) && after.swapping === 0, `every resident cell switched: ${JSON.stringify(after)}`)
    // Well inside the 60 s a forced switch waits: the cell was idle between two steps.
    assert.ok(switchMs < 30_000, `the switch took ${switchMs} ms`)
    const stepsAtSwitch = stepCalls.size
    assert.ok(stepsAtSwitch <= STEP_COUNT, `the cell switched before the turn's last step (${stepsAtSwitch} of ${STEP_COUNT + 1} model calls made)`)
    switchNote = `switched to generation ${reload.generation} in ${switchMs} ms after ${stepsAtSwitch} of ${STEP_COUNT + 1} model calls`
  } else {
    // wrangler dev reloads on a changed bundle: workerd restarts with the new code and cancels what was running, as a
    // Cloudflare deploy does. The step it cut off (if any) runs again from the alarm.
    const reloadsBefore = output.match(/Local server updated and ready/g)?.length ?? 0
    writeFileSync(join(temporary, "index.js"), `${readFileSync(join(temporary, "index.js"), "utf8")}\n// version switch ${Date.now()}\n`)
    await until(() => (output.match(/Local server updated and ready/g)?.length ?? 0) > reloadsBefore, 30_000, "wrangler to reload the changed bundle")
    switchNote = `reloaded with a changed bundle after ${stepCalls.size} of ${STEP_COUNT + 1} model calls`
  }
  let steppedView = await view(stepped, "")
  for (const deadline = Date.now() + 60_000; steppedView.status !== "idle" && Date.now() < deadline; steppedView = await view(stepped, "")) await sleep(200)
  assert.equal(steppedView.turns[0]?.status, "completed", JSON.stringify(steppedView.turns))
  assert.ok(steppedView.finalAssistantText.endsWith("Steps done."), steppedView.finalAssistantText)
  assert.deepEqual([...stepCalls.keys()].sort(), Array.from({ length: STEP_COUNT + 1 }, (_, step) => step), "every step ran")
  for (let step = 0; step < STEP_COUNT; step += 1) {
    assert.equal(await (await call(`/v1/sessions/${stepped}/files/content?path=steps/${step}.md`, "")).text(), `step ${step}`)
  }
  if (runtime === "celld") {
    // A forced switch cancels the step in flight, which then runs its model call again.
    assert.ok([...stepCalls.values()].every((calls) => calls === 1), `no step was cut off and run again: ${JSON.stringify([...stepCalls])}`)
  } else {
    assert.ok([...stepCalls.values()].reduce((sum, calls) => sum + calls, 0) <= STEP_COUNT + 2, `at most the step cut off ran again: ${JSON.stringify([...stepCalls])}`)
  }
  console.log(`PASS a step-mode turn keeps going through a ${runtime} version switch and completes (${switchNote}; model calls per step ${JSON.stringify(Object.fromEntries(stepCalls))})`)

  // The way off this host: a conversation's export imports into a Node runner and re-exports byte for byte.
  const exported = await call(`/v1/sessions/${main}/export`)
  assert.equal(exported.status, 200, await exported.clone().text())
  const conversation = await exported.text()
  assert.equal((await call(`/v1/sessions/${main}/import`, ownerA, { method: "POST", body: conversation })).status, 405)
  const nodeStore = new Store(nodeSqlite(":memory:"))
  const nodeModel: ModelClient = { complete: async () => { throw new Error("the Node runner only stores here") } }
  const nodeApp = createApp({ store: nodeStore, apiToken: token, runner: new Runner({ store: nodeStore, model: nodeModel, defaultModel: "test-model", limits: { maxConcurrentTurns: 1, maxSteps: 1, turnTimeoutMs: 60_000, credentialRefreshMs: 60_000, contextCharBudget: 10_000 } }) })
  const nodeAuth = { authorization: `Bearer ${token}` }
  const intoNode = await nodeApp.request(`/v1/sessions/${main}/import`, { method: "POST", headers: nodeAuth, body: conversation })
  assert.equal(intoNode.status, 201, await intoNode.clone().text())
  assert.equal(nodeStore.readFile(main, "memory/note.md"), "shared-memory-witness")
  assert.deepEqual(nodeStore.listSessions(ownerA, 10).map((session) => session.id), [main])
  assert.equal(await (await nodeApp.request(`/v1/sessions/${main}/export`, { headers: nodeAuth })).text(), conversation)
  nodeStore.close()
  console.log("PASS a conversation moves off this host into a Node runner with nothing lost; this host refuses imports")

  // ---- Session storage: a long chat seals its oldest turns into segments in the bucket, a large tool output goes there
  // too, and after a version switch the new code pages back through all of it (storage/, HEADLESS_SEGMENTS=on) ----
  const sealedChat = await create("", { title: "Long chat" })
  const sealedTurns = ["seal_big", ...Array.from({ length: 33 }, (_, turn) => `seal_${String(turn).padStart(2, "0")}`)]
  for (const messageId of sealedTurns) {
    assert.equal((await send(sealedChat, messageId, messageId === "seal_big" ? "[big] Read the big file" : `[seal] Message ${messageId}`, "")).status, 202)
    assert.equal((await untilIdle(sealedChat, "")).turns.at(-1)?.status, "completed", messageId)
  }
  assert.deepEqual(bigReadResults, [BIG_FILE], "the model got the large output whole")
  assert.ok(bucketLog.some((entry) => entry.method === "PUT" && entry.key.startsWith(`sessions/${sealedChat}/bodies/`)), "the large output went to the bucket")
  await until(() => bucket.has(`sessions/${sealedChat}/segments/000001.jsonl.gz`), 60_000, "the cell's alarm to seal the oldest turns")
  // Sealing goes on until only what must stay hot is left (the newest 30 turns and the model's context).
  let sealedSegments = 0
  for (let settled = 0; settled < 10; await sleep(500)) {
    const count = [...bucket.keys()].filter((key) => key.startsWith(`sessions/${sealedChat}/segments/`)).length
    settled = count === sealedSegments ? settled + 1 : 0
    sealedSegments = count
  }
  let storageSwitch: string
  if (runtime === "celld") {
    const reload = z.object({ ok: z.literal(true), outcome: z.literal("adopted"), generation: z.number() }).loose().parse(await (await fetch(`${celldInternal()}/reload`, { method: "POST", signal: AbortSignal.timeout(60_000) })).json())
    const switchStarted = Date.now()
    let after = await celldDeployment()
    while (Date.now() - switchStarted < 30_000 && (after.swapping > 0 || Object.values(after.cells).some((generation) => generation !== reload.generation))) {
      await sleep(250)
      after = await celldDeployment()
    }
    assert.ok(Object.values(after.cells).every((generation) => generation === reload.generation) && after.swapping === 0, `every resident cell switched: ${JSON.stringify(after)}`)
    storageSwitch = `celld generation ${reload.generation}`
  } else {
    const reloadsBefore = output.match(/Local server updated and ready/g)?.length ?? 0
    writeFileSync(join(temporary, "index.js"), `${readFileSync(join(temporary, "index.js"), "utf8")}\n// storage version switch ${Date.now()}\n`)
    await until(() => (output.match(/Local server updated and ready/g)?.length ?? 0) > reloadsBefore, 30_000, "wrangler to reload the changed bundle")
    storageSwitch = "a wrangler reload"
  }
  // Paging back from the newest turn, 7 at a time: every turn once, in order, the sealed ones from the bucket.
  const pageSchema = z.object({ turns: z.array(z.object({ messageId: z.string() }).loose()), hasEarlier: z.boolean().optional() }).loose()
  const pagedBack: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const response = await call(`/v1/sessions/${sealedChat}?turns=7${cursor ? `&before=${cursor}` : ""}`, "")
    assert.equal(response.status, 200, await response.clone().text())
    const window = pageSchema.parse(await response.json())
    pagedBack.unshift(...window.turns.map((turn) => turn.messageId))
    if (!window.hasEarlier) break
    cursor = window.turns[0]?.messageId
  }
  assert.deepEqual(pagedBack, sealedTurns, "the whole history pages back after the switch")
  const bigTurn = z.object({ messages: z.array(z.object({ role: z.string(), output: z.string().optional() }).loose()) }).loose().parse(await (await call(`/v1/sessions/${sealedChat}?messageId=seal_big`, "")).json())
  assert.ok(bigTurn.messages.some((message) => message.role === "tool" && message.output === BIG_FILE), "the sealed turn's large output reads back whole")
  const exportedSealed = z.object({ turns: z.array(z.unknown()) }).loose().parse(await (await call(`/v1/sessions/${sealedChat}/export`, "")).json())
  assert.equal(exportedSealed.turns.length, sealedTurns.length, "the export has every turn, sealed ones included")
  console.log(`PASS a long chat sealed ${sealedSegments} segment(s) into the bucket on ${runtime}, and pages back through all ${sealedTurns.length} turns (and its large output) after ${storageSwitch}`)

  // ---- Session cells: each new chat in its own cell under its owner (hs_c_), and the owner-cell split ----
  // Legacy chats first, as Workbot made them before session cells: a main chat with memory and a side chat sharing it.
  const cMain = `hs_wb_e2e_${randomBytes(12).toString("hex")}`
  const putC = (id: string, body: Record<string, unknown>) => call(`/v1/sessions/${id}`, ownerC, { method: "PUT", body: JSON.stringify(body) })
  assert.equal((await putC(cMain, { title: "C main", ref: "main", tasks: true })).status, 201)
  const cSide = await create(ownerC, { title: "C side", ref: "side", memoryOf: cMain })
  assert.equal((await send(cMain, "c_m1", "[write] Remember a note", ownerC)).status, 202)
  assert.equal((await untilIdle(cMain, ownerC)).turns[0]?.status, "completed")
  assert.equal((await send(cSide, "c_s1", "[read] Read the note", ownerC)).status, 202)
  assert.equal((await untilIdle(cSide, ownerC)).turns[0]?.status, "completed")

  // A chat in its own cell: placed by its id, created and then reached only by its owner.
  const c1 = `hs_c_${randomBytes(16).toString("hex")}`
  const c2 = `hs_c_${randomBytes(16).toString("hex")}`
  assert.equal((await call(`/v1/sessions/${c1}`, ownerC, { method: "PUT", body: JSON.stringify({ owner: ownerB, memoryScope: "owner" }) })).status, 400, "a body can't name another owner")
  assert.equal((await putC(c1, { title: "C one", ref: "c1", memoryScope: "owner", tasks: true })).status, 201)
  assert.equal((await putC(c1, { title: "C one", ref: "c1", memoryScope: "owner", tasks: true })).status, 200)
  assert.equal((await putC(c2, { ref: "c2", autoTitle: true, memoryScope: "owner" })).status, 201)
  assert.equal((await call(`/v1/sessions/${c1}`, ownerB)).status, 404, "another owner gets what an unknown chat gets")
  assert.equal((await call(`/v1/sessions/${c1}`, ownerB, { method: "PUT", body: JSON.stringify({ title: "Mine now" }) })).status, 404, "another owner can't take over the id")
  const ownerless = await call(`/v1/sessions/${c1}`, "")
  assert.equal(ownerless.status, 400)
  assert.equal(z.object({ error: z.string() }).parse(await ownerless.json()).error, "owner_required")
  assert.equal((await call(`/v1/sessions/${c1}/turns`, "", { method: "POST", body: JSON.stringify({ messageId: "x", prompt: "hi" }) })).status, 400)
  assert.equal((await call("/v1/owner/split", "", { method: "POST", body: "{}" })).status, 400)
  // Cell-to-cell routes are never reachable from outside, whatever the request carries.
  for (const path of ["/internal/memory", "/internal/owner-directory", "/internal/import/begin"]) {
    const probe = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-openwork-headless-owner": ownerC, "x-openwork-headless-cell": `owner:${ownerC}`, "x-openwork-headless-from": `session:${c1}` }, body: JSON.stringify({ op: "list" }) })
    assert.equal(probe.status, 404, `${path} is not public`)
  }
  assert.equal((await call(`/v1/sessions/${c1}/import`, ownerC, { method: "POST", body: "{}" })).status, 405)
  console.log("PASS hs_c_ chats: placed in their own cell, owner stored at creation, other owner 404, no owner 400, /internal/* not public")

  // The owner's memory, shared through the owner cell: the legacy chats' memory became the owner's.
  const readsBefore = seenReadResults.length
  assert.equal((await send(c1, "c1_m1", "[read] Read the shared note", ownerC)).status, 202)
  assert.equal((await untilIdle(c1, ownerC)).turns[0]?.status, "completed")
  assert.ok(seenReadResults.slice(readsBefore).some((result) => result.includes("shared-memory-witness")), "a session-cell chat reads the owner's memory")
  assert.equal((await send(c1, "c1_m2", "[owner-write] Remember this for every chat", ownerC)).status, 202)
  assert.equal((await untilIdle(c1, ownerC)).turns.find((turn) => turn.messageId === "c1_m2")?.status, "completed")
  assert.equal(await (await call(`/v1/sessions/${c2}/files/content?path=memory/owner.md`, ownerC)).text(), "owner-memory-witness", "the files API reads the owner's memory too")
  const ownerReads = seenReadResults.length
  assert.equal((await send(c2, "c2_m1", "[owner-read] What do you remember?", ownerC)).status, 202)
  assert.equal((await untilIdle(c2, ownerC)).turns[0]?.status, "completed")
  assert.equal((await send(cSide, "c_s2", "[owner-read] And here?", ownerC)).status, 202)
  assert.equal((await untilIdle(cSide, ownerC)).turns.find((turn) => turn.messageId === "c_s2")?.status, "completed")
  assert.equal(seenReadResults.slice(ownerReads).filter((result) => result.includes("owner-memory-witness")).length, 2, "another session cell and a legacy chat both see it")
  const listC = async () => z.object({ sessions: z.array(z.object({ id: z.string(), title: z.string() })) }).parse(await (await call(`/v1/sessions?owner=${encodeURIComponent(ownerC)}`, ownerC)).json()).sessions
  // A session cell tells its owner cell after the turn ends (the directory outbox), so the list follows shortly.
  const listedAs = async (ids: string[]) => {
    let listed: string[] = []
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; await sleep(200)) {
      listed = (await listC()).map((session) => session.id).sort()
      if (JSON.stringify(listed) === JSON.stringify([...ids].sort())) return
    }
    assert.deepEqual(listed, [...ids].sort())
  }
  await listedAs([cMain, cSide, c1, c2])
  console.log("PASS memory shared across a person's session-cell and legacy chats through the owner cell; listing merges both")

  // Step mode inside a session cell: each step runs from the session cell's own alarm.
  const stepCallsBefore = [...stepCalls.values()].reduce((sum, calls) => sum + calls, 0)
  const cSteps = await call(`/v1/sessions/${c1}/turns`, ownerC, { method: "POST", body: JSON.stringify({
    messageId: "c1_steps", prompt: "[steps] Work through the list", execution: "steps", credentials: { modelApiKey: "test-turn-key" },
  }) })
  assert.equal(cSteps.status, 202, await cSteps.clone().text())
  const cStepped = await untilIdle(c1, ownerC)
  assert.equal(cStepped.turns.find((turn) => turn.messageId === "c1_steps")?.status, "completed")
  assert.ok(cStepped.finalAssistantText.endsWith("Steps done."), cStepped.finalAssistantText)
  for (let step = 0; step < STEP_COUNT; step += 1) assert.equal(await (await call(`/v1/sessions/${c1}/files/content?path=steps/${step}.md`, ownerC)).text(), `step ${step}`)
  assert.equal([...stepCalls.values()].reduce((sum, calls) => sum + calls, 0) - stepCallsBefore, STEP_COUNT + 1, "each step's model call made once")
  console.log("PASS a step-mode turn runs step by step from a session cell's alarm")

  // Live events and Stop inside a session cell.
  const cClient = createHeadlessRunnerClient({ config: { url: base, token, owner: ownerC }, fetch, mintToken: async () => ({ token: "unused" }), maxTokenTtlMs: 60_000 })
  const cStop = new AbortController()
  const cSocket = await cClient.openEventsSocket(c2, cStop.signal)
  assert.ok(cSocket, "a session cell upgrades its events request")
  const cEvents: unknown[] = []
  const cDone = (async () => { for await (const event of cSocket) cEvents.push(event) })()
  const cSse: unknown[] = []
  const cSseStop = new AbortController()
  await readSse(c2, ownerC, cSseStop.signal, cSse)
  await until(() => cEvents.length > 0, 5_000, "the session cell socket's ready message")
  const hangingBefore = hanging.length
  assert.equal((await send(c2, "c2_hang", "[hang] Take your time", ownerC)).status, 202)
  await until(() => hanging.length > hangingBefore, 10_000, "the session cell's turn to call the model")
  assert.equal((await view(c2, ownerC)).status, "busy")
  const stopC = z.object({ accepted: z.boolean() }).parse(await (await call(`/v1/sessions/${c2}/abort`, ownerC, { method: "POST", body: "{}" })).json())
  assert.equal(stopC.accepted, true)
  assert.equal((await untilIdle(c2, ownerC)).turns.find((turn) => turn.messageId === "c2_hang")?.status, "aborted")
  const aborted = (event: unknown) => z.object({ type: z.literal("changed"), messageId: z.literal("c2_hang"), status: z.literal("aborted") }).safeParse(event).success
  await until(() => cEvents.some(aborted) && cSse.some(aborted), 10_000, "both streams to see the stopped turn")
  cSseStop.abort()
  cStop.abort()
  await cDone
  console.log("PASS live events (SSE and WebSocket) and Stop inside a session cell")

  // Delete: the session cell's data goes, and so does its line in the owner's list.
  assert.equal((await call(`/v1/sessions/${c2}`, ownerC, { method: "DELETE" })).status, 204)
  assert.equal((await call(`/v1/sessions/${c2}`, ownerC)).status, 404)
  assert.deepEqual((await listC()).map((session) => session.id).sort(), [cMain, cSide, c1].sort(), "removed from the list right away")
  assert.equal((await call(`/v1/sessions/${c2}`, ownerB, { method: "PUT", body: JSON.stringify({ title: "Reuse" }) })).status, 404, "a deleted chat's id stays its owner's")
  console.log("PASS deleting a session-cell chat removes its data and its directory row")

  // A long legacy chat, sealed in the owner cell before the split: segments and a large output in the bucket.
  const cLong = await create(ownerC, { title: "C long", ref: "long" })
  const longTurns = ["long_big", ...Array.from({ length: 33 }, (_, turn) => `long_${String(turn).padStart(2, "0")}`)]
  const bigReadsBefore = bigReadResults.length
  for (const messageId of longTurns) {
    assert.equal((await send(cLong, messageId, messageId === "long_big" ? "[big] Read the big file" : `[seal] Message ${messageId}`, ownerC)).status, 202)
    assert.equal((await untilIdle(cLong, ownerC)).turns.at(-1)?.status, "completed", messageId)
  }
  assert.deepEqual(bigReadResults.slice(bigReadsBefore), [BIG_FILE])
  await until(() => bucket.has(`sessions/${cLong}/segments/000001.jsonl.gz`), 60_000, "the owner cell's alarm to seal the long chat")
  let longSegments = 0
  for (let settled = 0; settled < 10; await sleep(500)) {
    const count = [...bucket.keys()].filter((key) => key.startsWith(`sessions/${cLong}/segments/`)).length
    settled = count === longSegments ? settled + 1 : 0
    longSegments = count
  }
  const longObjects = [...bucket.keys()].filter((key) => key.startsWith(`sessions/${cLong}/`)).sort()
  assert.ok(bucketLog.some((entry) => entry.method === "PUT" && entry.key.startsWith(`sessions/${cLong}/bodies/`)), "the long chat's large output went to the bucket")

  // The owner split: legacy chats move to their own cells and keep their ids. Killed in the middle, it resumes.
  const exportsBefore = new Map<string, string>()
  for (const id of [cMain, cSide, cLong]) exportsBefore.set(id, await (await call(`/v1/sessions/${id}/export`, ownerC)).text())
  const splitOf = async () => {
    const response = await call("/v1/owner/split", ownerC, { method: "POST", body: "{}" })
    const body: unknown = await response.json()
    const parsed = z.object({ split: z.string() }).safeParse(body)
    if (!parsed.success) throw new Error(`split: ${response.status} ${JSON.stringify(body)}`)
    return parsed.data.split
  }
  assert.equal(await splitOf(), "started")
  assert.equal(await splitOf(), "running")
  // Into the first chat's copy (each import call waits HEADLESS_TEST_SPLIT_PAUSE_MS), then the runtime dies.
  await sleep(700)
  assert.equal(await splitOf(), "running", "killed mid-split")
  const movedBeforeKill = [cMain, cSide, cLong].filter((id) => output.includes(`chat moved to its own cell {"sessionId":"${id}"}`)).length
  assert.ok(movedBeforeKill < 3, "the runtime is killed before the split moved every chat")
  await stop()
  for (const response of hanging.splice(0)) response.destroy()
  await start(address.port)
  // Nobody asks again: the owner cell's alarm resumes the split after the restart.
  let split = "running"
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(500)) {
    split = await splitOf()
    if (split === "done") break
  }
  assert.equal(split, "done", "the split finished after the kill")
  for (const id of [cMain, cSide, cLong]) {
    assert.equal(await (await call(`/v1/sessions/${id}/export`, ownerC)).text(), exportsBefore.get(id), `${id} moved with nothing lost`)
    assert.equal((await call(`/v1/sessions/${id}`, ownerB)).status, 404)
    assert.equal((await call(`/v1/sessions/${id}`, "")).status, 404, "a moved chat's own cell answers only its owner")
  }
  assert.deepEqual((await listC()).map((session) => session.id).sort(), [cMain, cSide, c1, cLong].sort(), "listed once each")
  // The sealed chat, through its legacy id and the forward: every turn pages back (sealed ones from the bucket, read
  // by its new cell under the same keys), and its large output reads back whole.
  const longPage = z.object({ turns: z.array(z.object({ messageId: z.string() }).loose()), hasEarlier: z.boolean().optional() }).loose()
  const longPaged: string[] = []
  let longCursor: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const response = await call(`/v1/sessions/${cLong}?turns=7${longCursor ? `&before=${longCursor}` : ""}`, ownerC)
    assert.equal(response.status, 200, await response.clone().text())
    const window = longPage.parse(await response.json())
    longPaged.unshift(...window.turns.map((turn) => turn.messageId))
    if (!window.hasEarlier) break
    longCursor = window.turns[0]?.messageId
  }
  assert.deepEqual(longPaged, longTurns, "the moved sealed chat pages back through its whole history")
  const longBig = z.object({ messages: z.array(z.object({ role: z.string(), output: z.string().optional() }).loose()) }).loose().parse(await (await call(`/v1/sessions/${cLong}?messageId=long_big`, ownerC)).json())
  assert.ok(longBig.messages.some((message) => message.role === "tool" && message.output === BIG_FILE), "the moved chat's large output reads back whole")
  assert.ok(longObjects.every((key) => bucket.has(key)), "the moved chat's objects kept their keys; nothing was deleted")
  assert.equal((await send(cLong, "long_after", "[seal] After the move", ownerC)).status, 202)
  assert.equal((await untilIdle(cLong, ownerC)).turns.at(-1)?.status, "completed")
  // The legacy ids keep working through the owner cell's forward: a turn, its memory, and live events on a WebSocket.
  const movedStop = new AbortController()
  // The runtime restarted on a new port: a new client.
  const movedClient = createHeadlessRunnerClient({ config: { url: base, token, owner: ownerC }, fetch, mintToken: async () => ({ token: "unused" }), maxTokenTtlMs: 60_000 })
  const movedSocket = await movedClient.openEventsSocket(cSide, movedStop.signal)
  assert.ok(movedSocket, "a WebSocket upgrade for a moved chat is forwarded to its cell")
  const movedEvents: unknown[] = []
  let movedEnded = false
  const movedDone = (async () => {
    for await (const event of movedSocket) movedEvents.push(event)
    movedEnded = true
  })()
  await until(() => movedEvents.length > 0, 5_000, "the forwarded socket's ready message")
  const movedReads = seenReadResults.length
  assert.equal((await send(cSide, "c_s3", "[owner-read] After the move", ownerC)).status, 202)
  assert.equal((await untilIdle(cSide, ownerC)).turns.find((turn) => turn.messageId === "c_s3")?.status, "completed")
  assert.ok(seenReadResults.slice(movedReads).some((result) => result.includes("owner-memory-witness")), "a moved chat reads the owner's memory from its own cell")
  await until(() => movedEvents.some(completedEvent("c_s3")), 10_000, "the forwarded socket to see the turn")
  let forwardedSwitch = ""
  if (runtime === "celld") {
    // A runner deploy while the forwarded socket is open: its cells switch to new code; the socket goes on.
    const reload = z.object({ ok: z.literal(true), outcome: z.literal("adopted"), generation: z.number() }).loose().parse(await (await fetch(`${celldInternal()}/reload`, { method: "POST", signal: AbortSignal.timeout(60_000) })).json())
    const switchStarted = Date.now()
    let after = await celldDeployment()
    while (Date.now() - switchStarted < 30_000 && (after.swapping > 0 || Object.values(after.cells).some((generation) => generation !== reload.generation))) {
      await sleep(250)
      after = await celldDeployment()
    }
    assert.ok(Object.values(after.cells).every((generation) => generation === reload.generation) && after.swapping === 0, `every resident cell switched: ${JSON.stringify(after)}`)
    const switchMs = Date.now() - switchStarted
    assert.equal(movedEnded, false, "the forwarded socket stayed open across the switch")
    assert.equal((await send(cSide, "c_s4", "[write] After the deploy", ownerC)).status, 202)
    assert.equal((await untilIdle(cSide, ownerC)).turns.find((turn) => turn.messageId === "c_s4")?.status, "completed")
    await until(() => movedEvents.some(completedEvent("c_s4")), 10_000, "the forwarded socket to see a turn after the switch")
    forwardedSwitch = `, and through a celld version switch (${switchMs} ms)`
  }
  movedStop.abort()
  await movedDone
  assert.equal((await send(cMain, "c_m2", "[write] After the move", ownerC)).status, 202)
  assert.equal((await untilIdle(cMain, ownerC)).turns.find((turn) => turn.messageId === "c_m2")?.status, "completed")
  // Workbot keeps refreshing its chats with the same settings (memoryOf the main chat, which has moved).
  assert.equal((await putC(cMain, { title: "C main", ref: "main", tasks: true })).status, 200)
  assert.equal((await putC(cSide, { ref: "side", memoryOf: cMain })).status, 200)
  assert.ok(!output.includes(grant), "no grant in the runtime's logs")
  // Off this host with nothing lost: a moved chat on its owner's memory carries that memory into a Node runner.
  const movedExport = await call(`/v1/sessions/${cSide}/export`, ownerC)
  assert.equal(movedExport.status, 200, await movedExport.clone().text())
  const movedConversation = await movedExport.text()
  const cNodeStore = new Store(nodeSqlite(":memory:"))
  const cNodeApp = createApp({ store: cNodeStore, apiToken: token, runner: new Runner({ store: cNodeStore, model: { complete: async () => { throw new Error("the Node runner only stores here") } }, defaultModel: "test-model", limits: { maxConcurrentTurns: 1, maxSteps: 1, turnTimeoutMs: 60_000, credentialRefreshMs: 60_000, contextCharBudget: 10_000 } }) })
  const intoCNode = await cNodeApp.request(`/v1/sessions/${cSide}/import`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: movedConversation })
  assert.equal(intoCNode.status, 201, await intoCNode.clone().text())
  for (const [path, content] of [["memory/owner.md", "owner-memory-witness"], ["memory/note.md", "shared-memory-witness"]]) {
    assert.equal(await (await cNodeApp.request(`/v1/sessions/${cSide}/files/content?path=${path}`, { headers: { authorization: `Bearer ${token}` } })).text(), content, `${path} came along`)
  }
  assert.equal(await (await cNodeApp.request(`/v1/sessions/${cSide}/export`, { headers: { authorization: `Bearer ${token}` } })).text(), movedConversation, "and re-exports byte for byte")
  cNodeStore.close()
  console.log(`PASS the owner split on ${runtime}: killed mid-split (${movedBeforeKill} of 3 chats moved, one of them sealed into ${longSegments} segment(s) with a large output) it resumes from the alarm, moves every legacy chat losslessly, and legacy ids keep working (turns, memory, a forwarded WebSocket${forwardedSwitch}); a moved chat moves on to Node with its owner's memory`)
} catch (error) {
  console.error(error)
  console.error(output.slice(-8_000))
  // The whole runtime log, for a failure the tail doesn't explain.
  if (process.env.OWNER_CELLS_E2E_LOG) writeFileSync(process.env.OWNER_CELLS_E2E_LOG, output)
  process.exitCode = 1
} finally {
  await stop()
  for (const response of hanging) response.destroy()
  model.closeAllConnections()
  await new Promise<void>((resolve) => model.close(() => resolve()))
  den.closeAllConnections()
  await new Promise<void>((resolve) => den.close(() => resolve()))
  s3.closeAllConnections()
  await new Promise<void>((resolve) => s3.close(() => resolve()))
  rmSync(temporary, { recursive: true, force: true })
}
