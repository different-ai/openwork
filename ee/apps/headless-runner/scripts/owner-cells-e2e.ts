/** Boots the real Worker host with a streamed mock model; all database state is isolated in a temporary project. */
import assert from "node:assert/strict"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { builtinModules } from "node:module"
import { join } from "node:path"
import { z } from "zod"

const runtime = process.argv.includes("--celld") ? "celld" : "wrangler"
const project = join(import.meta.dirname, "..")
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "owner-cells-e2e-")))
const token = `test_${crypto.randomUUID().replaceAll("-", "")}`
const ownerA = "test-org/member-a"
const ownerB = "test-org/member-b"
let worker: ChildProcess | null = null
let output = ""
let base = ""
let slowCalls = 0
const hanging: ServerResponse[] = []
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
    if (prompt.includes("[slow]") && !result && slowCalls++ === 0) {
      hanging.push(response)
      return
    }
    if (result && prompt.includes("[read]")) seenReadResults.push(String(result.content))
    const read = prompt.includes("[read]")
    const tool = { index: 0, id: "call_note", type: "function", function: {
      name: read ? "read_file" : "write_file",
      arguments: JSON.stringify({ path: "memory/note.md", ...(!read ? { content: "shared-memory-witness" } : {}) }),
    } }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(`data: ${JSON.stringify({ choices: [{ delta: result ? { content: "Memory checked." } : { tool_calls: [tool] }, finish_reason: result ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
  } catch (error) {
    response.writeHead(500).end(String(error))
  }
})

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
  }
  writeFileSync(join(temporary, ".dev.vars"), Object.entries(vars).map(([key, value]) => `${key}=${value}`).join("\n"))
  // celld requires main to be inside the project. Bundle into our isolated project instead of clobbering .dev.vars.
  execFileSync(join(project, "node_modules/.bin/esbuild"), [join(project, "src/worker/index.ts"), "--bundle", "--platform=neutral", "--conditions=workerd,browser", "--main-fields=browser,module,main", "--format=esm", "--external:node:*", "--external:cloudflare:*", ...builtinModules.filter((name) => !name.startsWith("node:")).map((name) => `--alias:${name}=node:${name}`), `--outfile=${join(temporary, "index.js")}`], { cwd: project, stdio: "pipe" })
  const config = readFileSync(join(project, "wrangler.jsonc"), "utf8").replace('"src/worker/index.ts"', '"index.js"')
  writeFileSync(join(temporary, "wrangler.jsonc"), config)
  const binary = runtime === "celld" ? process.env.CELLD_BIN ?? "celld" : join(project, "node_modules/.bin/wrangler")
  const args = runtime === "celld"
    ? ["dev", ".", "--host", "127.0.0.1", "--port", String(port), "--no-watch"]
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

function call(path: string, owner = ownerA, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(15_000), headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", ...(owner ? { "x-openwork-headless-owner": owner } : {}), ...init.headers,
  } })
}
const viewSchema = z.object({ status: z.string(), finalAssistantText: z.string(), turns: z.array(z.object({ messageId: z.string(), status: z.string(), error: z.string().nullable() })) })
async function view(id: string, owner = ownerA) { return viewSchema.parse(await (await call(`/v1/sessions/${id}`, owner)).json()) }
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
  const { headlessRemoteCall } = await import("../../den-api/src/slack-assistant/headless.ts")
  const slackDeps = { config: { url: base, token }, fetch, mintToken: async () => ({ token: "test-mcp-token" }), maxTokenTtlMs: 60 * 60_000 }
  const actor = { userId: "test-user", organizationId: "test-org" }
  const opened = await headlessRemoteCall(actor, "create", { title: "Slack thread" }, slackDeps)
  const slackSession = z.object({ sessionId: z.string() }).parse(opened).sessionId
  assert.deepEqual(await headlessRemoteCall(actor, "send", { sessionId: slackSession, messageId: "slack_run_1", prompt: "[write] What changed?" }, slackDeps), {})
  let slackRead: Record<string, unknown> = {}
  for (const until = Date.now() + 30_000; Date.now() < until; await sleep(200)) {
    slackRead = await headlessRemoteCall(actor, "read", { sessionId: slackSession, messageId: "slack_run_1" }, slackDeps)
    if (slackRead.status === "idle") break
  }
  assert.equal(slackRead.status, "idle", JSON.stringify(slackRead))
  assert.equal(slackRead.finalAssistantText, "Memory checked.")
  assert.equal(slackRead.terminalError, undefined)
  assert.ok(modelKeys.at(-1) === "Bearer test-default-key")
  const stopResult = await headlessRemoteCall(actor, "stop", { sessionId: slackSession, messageId: "slack_run_1" }, slackDeps)
  assert.ok("accepted" in stopResult || "stopped" in stopResult, JSON.stringify(stopResult))
  const unknown = await headlessRemoteCall(actor, "read", { sessionId: `hs_${"1".repeat(32)}`, messageId: "x" }, slackDeps)
  assert.equal(unknown.error, "unknown_session")
  console.log("PASS Den's Slack adapter (create, send, read to the answer, stop, unknown session) unchanged on this runtime")

  assert.equal((await send(main, "msg_slow", "[slow] [write] Resume after restart")).status, 202)
  const deadline = Date.now() + 10_000
  while (!hanging.length && Date.now() < deadline) await sleep(100)
  assert.equal(hanging.length, 1)
  assert.equal((await view(main)).status, "busy")
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
} catch (error) {
  console.error(error)
  console.error(output.slice(-8_000))
  process.exitCode = 1
} finally {
  await stop()
  for (const response of hanging) response.destroy()
  model.closeAllConnections()
  await new Promise<void>((resolve) => model.close(() => resolve()))
  rmSync(temporary, { recursive: true, force: true })
}
