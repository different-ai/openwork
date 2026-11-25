import assert from "node:assert/strict"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { builtinModules } from "node:module"
import { createServer as createNetServer } from "node:net"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"

const { values: args } = parseArgs({
  options: { base: { type: "string" }, head: { type: "string" }, runtime: { type: "string", default: "celld" } },
})
const runtime = z.enum(["celld", "wrangler"]).parse(args.runtime)
if (!args.base) throw new Error("usage: compat-check.ts --base <git ref> [--head <git ref>] [--runtime celld|wrangler]")
const project = join(import.meta.dirname, "..")
const esbuild = join(project, "node_modules/.bin/esbuild")
const annotate = process.env.GITHUB_ACTIONS === "true"
const work = join(project, "node_modules/.cache/compat-check", String(process.pid))
const token = `compat_${crypto.randomUUID().replaceAll("-", "")}`

function git(...gitArgs: string[]) {
  return execFileSync("git", gitArgs, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}
function skip(reason: string): never {
  console.log(annotate ? `::warning title=Runner compatibility check skipped::${reason}` : `SKIP ${reason}`)
  rmSync(work, { recursive: true, force: true })
  process.exit(0)
}
const fail = (reason: string) => console.log(annotate ? `::error title=Runner versions incompatible::${reason}` : `FAIL ${reason}`)

function checkout(label: string, ref: string | undefined) {
  const into = join(work, label)
  mkdirSync(into, { recursive: true })
  if (!ref) {
    cpSync(join(project, "src"), join(into, "src"), { recursive: true })
    cpSync(join(project, "wrangler.jsonc"), join(into, "wrangler.jsonc"))
    return { into, name: "working tree" }
  }
  const prefix = git("rev-parse", "--show-prefix").replace(/\/$/, "")
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`)
  const archive = execFileSync("git", ["archive", "--format=tar", `${commit}:${prefix}`, "src", "wrangler.jsonc"], {
    cwd: git("rev-parse", "--show-toplevel"), maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  })
  execFileSync("tar", ["-x", "-C", into], { input: archive })
  return { into, name: commit.slice(0, 12) }
}

function bundle(entry: string, outfile: string) {
  execFileSync(esbuild, [
    entry,
    "--bundle",
    "--platform=neutral",
    "--conditions=workerd,browser",
    "--main-fields=browser,module,main",
    "--format=esm",
    "--external:node:*",
    "--external:cloudflare:*",
    ...builtinModules.filter((name) => !name.startsWith("node:")).map((name) => `--alias:${name}=node:${name}`),
    `--outfile=${outfile}`,
    "--log-level=error",
  ], { cwd: project, stdio: ["ignore", "pipe", "pipe"] })
}

const wranglerSchema = z.object({
  name: z.string(),
  durable_objects: z.object({ bindings: z.array(z.object({ name: z.string(), class_name: z.string() })) }),
}).passthrough()
const readWrangler = (dir: string) => {
  const source = readFileSync(join(dir, "wrangler.jsonc"), "utf8").split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n")
  return { source, config: wranglerSchema.parse(JSON.parse(source)) }
}

let old: ReturnType<typeof checkout>
try {
  old = checkout("base", args.base)
} catch (error) {
  skip(`could not read the runner at ${args.base}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
}
const current = checkout("head", args.head)
function sameRunner(base: string, head: string | undefined) {
  try {
    execFileSync("git", ["diff", "--quiet", base, ...(head ? [head] : []), "--", "src", "wrangler.jsonc"], { cwd: project, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}
if (sameRunner(args.base, args.head)) skip(`the runner's src/ and wrangler.jsonc are unchanged since ${old.name}; nothing to compare`)
try {
  bundle(join(old.into, "src/worker/index.ts"), join(work, "base-alone.js"))
} catch (error) {
  skip(`the runner at ${old.name} does not bundle with today's packages: ${String(error instanceof Error && "stderr" in error ? error.stderr : error).slice(0, 600)}`)
}
const before = readWrangler(old.into).config
const after = readWrangler(current.into)
const failures: string[] = []
const oldClasses = before.durable_objects.bindings.map((binding) => `${binding.name}=${binding.class_name}`).sort().join(",")
const newClasses = after.config.durable_objects.bindings.map((binding) => `${binding.name}=${binding.class_name}`).sort().join(",")
if (before.name !== after.config.name || oldClasses !== newClasses) {
  fail(`wrangler.jsonc renamed the script or a cell class (${before.name} ${oldClasses} → ${after.config.name} ${newClasses}); celld derives every cell's identity from them, so every conversation would start over`)
  failures.push("wrangler.jsonc names")
}
console.log(`comparing ${old.name} (old) with ${current.name} (new) on ${runtime}`)

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
    const answered = body.messages.slice(body.messages.findLastIndex((message) => message.role === "user") + 1).some((message) => message.role === "tool")
    const tool = { index: 0, id: "call_note", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "memory/note.md", content: "compat" }) } }
    const delta = answered ? { content: "Done." } : { tool_calls: [tool] }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: answered ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
  } catch (error) {
    response.writeHead(500).end(String(error))
  }
})

let worker: ChildProcess | null = null
let output = ""
let baseUrl = ""
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function freePort() {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

function prepare(dir: string, router: string, cell: string, modelPort: number) {
  mkdirSync(dir, { recursive: true })
  const entry = join(work, `entry-${router}-${cell}.ts`)
  writeFileSync(entry, [
    `export { default } from ${JSON.stringify(join(work, router, "src/worker/index.ts"))}`,
    `export { HeadlessCell } from ${JSON.stringify(join(work, cell, "src/worker/index.ts"))}`,
    "",
  ].join("\n"))
  bundle(entry, join(dir, "index.js"))
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({ ...JSON.parse(after.source), main: "index.js" }))
  const vars = {
    HEADLESS_API_TOKEN: token,
    HEADLESS_MODEL_PROTOCOL: "openai",
    HEADLESS_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}`,
    HEADLESS_MODEL: "test-model",
    HEADLESS_MODEL_API_KEY: "test-default-key",
  }
  writeFileSync(join(dir, ".dev.vars"), Object.entries(vars).map(([key, value]) => `${key}=${value}`).join("\n"))
}

async function start(dir: string) {
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  output = ""
  const binary = runtime === "celld" ? process.env.CELLD_BIN ?? "celld" : join(project, "node_modules/.bin/wrangler")
  const runtimeArgs = runtime === "celld"
    ? ["dev", ".", "--host", "127.0.0.1", "--port", String(port), "--no-watch"]
    : ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(dir, "state"), "--show-interactive-dev-session=false"]
  const child = spawn(binary, runtimeArgs, { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", CELLD_ESBUILD: esbuild,
  } })
  worker = child
  let spawnError: Error | null = null
  child.on("error", (error) => { spawnError = error })
  child.stdout?.on("data", (chunk: unknown) => { output += String(chunk) })
  child.stderr?.on("data", (chunk: unknown) => { output += String(chunk) })
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(200)) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(`${runtime} exited: ${output.slice(-4_000)}`)
    if (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok, () => false)) return
  }
  throw new Error(`${runtime} did not start: ${output.slice(-4_000)}`)
}

async function stop() {
  const child = worker
  worker = null
  if (!child?.pid || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  try { process.kill(-child.pid, "SIGKILL") } catch { return }
  await exited
}

const OWNER = "compat-org/member-a"
const OTHER = "compat-org/member-b"
function call(path: string, owner: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(15_000), headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", ...(owner ? { "x-openwork-headless-owner": owner } : {}),
  } })
}
async function expectStatus(label: string, response: Response, wanted: number) {
  const body = await response.text()
  assert.equal(response.status, wanted, `${label}: ${response.status} ${body.slice(0, 300)}`)
  return body
}
const viewSchema = z.object({ status: z.string(), finalAssistantText: z.string(), turns: z.array(z.object({ messageId: z.string(), status: z.string() })) })
async function turn(id: string, messageId: string, owner: string) {
  const sent = z.object({ state: z.string() }).parse(JSON.parse(await expectStatus(`send ${messageId}`, await call(`/v1/sessions/${id}/turns`, owner, {
    method: "POST", body: JSON.stringify({ messageId, prompt: "Write a note, then say Done." }),
  }), 202)))
  assert.notEqual(sent.state, "already_present", `send ${messageId}: already_present on first send`)
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(150)) {
    const view = viewSchema.parse(JSON.parse(await expectStatus(`read ${id}`, await call(`/v1/sessions/${id}`, owner), 200)))
    if (view.status !== "idle") continue
    assert.equal(view.turns.find((t) => t.messageId === messageId)?.status, "completed", `turn ${messageId}: ${JSON.stringify(view.turns)}`)
    assert.equal(view.finalAssistantText, "Done.")
    return
  }
  throw new Error(`turn ${messageId} did not finish in 30 s`)
}
async function create(owner: string) {
  const body = await expectStatus(`create (${owner || "no owner"})`, await call("/v1/sessions", owner, { method: "POST", body: JSON.stringify({ title: "Compat" }) }), 201)
  return z.object({ id: z.string() }).parse(JSON.parse(body)).id
}

async function traffic() {
  assert.equal((await fetch(`${baseUrl}/v1/models`)).status, 401, "unauthenticated request was not refused")
  const mine = await create(OWNER)
  await turn(mine, "m1", OWNER)
  const listed = z.object({ sessions: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(await expectStatus("list", await call(`/v1/sessions?owner=${encodeURIComponent(OWNER)}`, OWNER), 200)))
  assert.ok(listed.sessions.some((session) => session.id === mine), "owner listing misses the new chat")
  await expectStatus("other owner's read", await call(`/v1/sessions/${mine}`, OTHER), 404)
  await expectStatus("note", await call(`/v1/sessions/${mine}/files/content?path=memory/note.md`, OWNER), 200)
  const thread = await create("")
  assert.match(thread, /^hs_/)
  await turn(thread, "t1", "")
  const again = z.object({ state: z.string() }).parse(JSON.parse(await expectStatus("resend", await call(`/v1/sessions/${thread}/turns`, "", {
    method: "POST", body: JSON.stringify({ messageId: "t1", prompt: "Write a note, then say Done." }),
  }), 202)))
  assert.equal(again.state, "already_present", "a re-sent message was not recognised")
  return { mine, thread }
}

async function sessionCellTraffic() {
  const id = `hs_c_${crypto.randomUUID().replaceAll("-", "")}`
  await expectStatus("create a session-cell chat", await call(`/v1/sessions/${id}`, OWNER, { method: "PUT", body: JSON.stringify({ title: "Compat cell", memoryScope: "owner" }) }), 201)
  await turn(id, "c1", OWNER)
  await expectStatus("other owner's read of a session-cell chat", await call(`/v1/sessions/${id}`, OTHER), 404)
  for (const deadline = Date.now() + 10_000; ; await sleep(200)) {
    const listed = z.object({ sessions: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(await expectStatus("list", await call(`/v1/sessions?owner=${encodeURIComponent(OWNER)}`, OWNER), 200)))
    if (listed.sessions.some((session) => session.id === id)) break
    assert.ok(Date.now() < deadline, "owner listing misses the session-cell chat")
  }
  await expectStatus("delete a session-cell chat", await call(`/v1/sessions/${id}`, OWNER, { method: "DELETE" }), 204)
}

async function scenario(label: string, run: () => Promise<void>) {
  try {
    await run()
    console.log(`PASS ${label}`)
  } catch (error) {
    fail(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    if (output) console.log(output.split("\n").filter((line) => !/log_ship_loop|node_lease_attempt|celld::memory|jemalloc/.test(line)).slice(-40).join("\n"))
    failures.push(label)
  } finally {
    await stop()
  }
}

try {
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve))
  const address = model.address()
  assert.ok(address && typeof address === "object")
  const modelPort = address.port

  await scenario(`old router (${old.name}) → new cell (${current.name})`, async () => {
    prepare(join(work, "old-router"), "base", "head", modelPort)
    await start(join(work, "old-router"))
    const { mine } = await traffic()
    await expectStatus("delete", await call(`/v1/sessions/${mine}`, OWNER, { method: "DELETE" }), 204)
    await expectStatus("read deleted", await call(`/v1/sessions/${mine}`, OWNER), 404)
    await sessionCellTraffic()
  })
  await scenario(`new router (${current.name}) → old cell (${old.name})`, async () => {
    prepare(join(work, "new-router"), "head", "base", modelPort)
    await start(join(work, "new-router"))
    const { mine } = await traffic()
    await expectStatus("delete", await call(`/v1/sessions/${mine}`, OWNER, { method: "DELETE" }), 204)
  })
  await scenario(`cells written by ${old.name} open and continue on ${current.name}`, async () => {
    const dir = join(work, "upgrade")
    prepare(dir, "base", "base", modelPort)
    await start(dir)
    const { mine, thread } = await traffic()
    await stop()
    prepare(dir, "head", "head", modelPort)
    await start(dir)
    await expectStatus("note after upgrade", await call(`/v1/sessions/${mine}/files/content?path=memory/note.md`, OWNER), 200)
    await turn(mine, "m2", OWNER)
    await turn(thread, "t2", "")
    await sessionCellTraffic()
  })
} finally {
  await stop()
  model.closeAllConnections()
  await new Promise<void>((resolve) => model.close(() => resolve()))
  rmSync(work, { recursive: true, force: true })
}

if (failures.length) {
  console.log(`${failures.length} compatibility check(s) failed between ${old.name} and ${current.name}`)
  process.exitCode = 1
} else {
  console.log(`compatible: ${old.name} and ${current.name} can serve each other during a switch`)
}
