import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { accessSync, constants, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { CloudProviderMaterializationProvider } from "../src/llm/cloud-provider-materialization.js"
import { bedrockCredentialError, toRuntimeProviderEnv } from "../src/llm/provider-credentials.ts"

const bedrockNpm = "@ai-sdk/amazon-bedrock"
const bedrockEnv = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK"]
// The models.dev Bedrock entry as Den stores it.
const bedrock: Record<string, unknown> = { npm: bedrockNpm, env: bedrockEnv }
const rowId = "lpr_01kx00000000000000000keys1"

test("a catalog Bedrock row binds each delivered scoped name to its SDK option", () => {
  const runtime = toRuntimeProviderEnv({
    id: rowId,
    source: "models_dev",
    providerConfig: bedrock,
    apiKeys: { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "eu-central-2" },
  })
  assert.deepEqual(runtime.providerConfig.env, bedrockEnv.map((name) => `LPR_KEYS1_${name}`))
  // The bearer token has no value, so the SDK keeps its own fallback for it.
  assert.deepEqual(runtime.providerConfig.options, {
    accessKeyId: "{env:LPR_KEYS1_AWS_ACCESS_KEY_ID}",
    secretAccessKey: "{env:LPR_KEYS1_AWS_SECRET_ACCESS_KEY}",
    region: "{env:LPR_KEYS1_AWS_REGION}",
  })
  assert.deepEqual(Object.keys(runtime.apiKeys ?? {}), ["LPR_KEYS1_AWS_ACCESS_KEY_ID", "LPR_KEYS1_AWS_SECRET_ACCESS_KEY", "LPR_KEYS1_AWS_REGION"])
})

test("an option the provider sets explicitly keeps precedence", () => {
  const runtime = toRuntimeProviderEnv({
    id: rowId,
    source: "models_dev",
    providerConfig: { ...bedrock, options: { region: "us-west-2" } },
    apiKeys: { AWS_BEARER_TOKEN_BEDROCK: "token", AWS_REGION: "eu-central-2" },
  })
  assert.deepEqual(runtime.providerConfig.options, { apiKey: "{env:LPR_KEYS1_AWS_BEARER_TOKEN_BEDROCK}", region: "us-west-2" })
})

test("single-env and custom providers are left as they were", () => {
  // OpenCode already hands a single env value to the SDK as apiKey.
  const openai: Record<string, unknown> = { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] }
  const single = toRuntimeProviderEnv({ id: rowId, source: "models_dev", providerConfig: openai, apiKeys: { OPENAI_API_KEY: "sk" } })
  assert.equal(single.providerConfig.options, undefined)
  // Custom providers keep their declared names, which the SDK reads itself.
  const custom = { id: rowId, source: "custom", providerConfig: bedrock, apiKeys: { AWS_REGION: "eu-central-2" } }
  assert.equal(toRuntimeProviderEnv(custom), custom)
})

test("saving a Bedrock credential requires a valid AWS_REGION", () => {
  const credential = (values: Record<string, string>) => JSON.stringify(values)
  assert.equal(bedrockCredentialError(bedrock, credential({ AWS_BEARER_TOKEN_BEDROCK: "token", AWS_REGION: "us-east-1" })), null)
  assert.match(bedrockCredentialError(bedrock, credential({ AWS_BEARER_TOKEN_BEDROCK: "token" })) ?? "", /AWS_REGION/)
  assert.match(bedrockCredentialError(bedrock, credential({ AWS_BEARER_TOKEN_BEDROCK: "token", AWS_REGION: "bedrock.evil.example" })) ?? "", /AWS_REGION/)
  // Nothing stored (a per-member provider's organization row) and other providers are not checked.
  assert.equal(bedrockCredentialError(bedrock, null), null)
  assert.equal(bedrockCredentialError({ npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] }, "sk"), null)
})

/** The pinned OpenCode engine: OPENWORK_OPENCODE_BIN, else `opencode` on PATH. */
function pinnedEngine(): string {
  const constantsPath = join(import.meta.dirname, "..", "..", "..", "..", "constants.json")
  const pinned = String(JSON.parse(readFileSync(constantsPath, "utf8")).opencodeVersion).replace(/^v/, "")
  const candidates = process.env.OPENWORK_OPENCODE_BIN
    ? [process.env.OPENWORK_OPENCODE_BIN]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "opencode"))
  const binary = candidates.find((path) => {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  assert.ok(binary, `OpenCode ${pinned} not found: install the version pinned in constants.json or set OPENWORK_OPENCODE_BIN.`)
  const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()
  assert.equal(version, pinned, `${binary} is OpenCode ${version}; constants.json pins ${pinned}.`)
  return binary
}

test("the pinned engine sends BYOK Bedrock requests with only scoped env names set", { timeout: 120_000 }, async () => {
  const binary = pinnedEngine()
  const requests: { path: string; authorization: string }[] = []
  const witness = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    if (request.method === "POST") requests.push({ path: request.url ?? "", authorization: String(request.headers.authorization ?? "") })
    // Capture the dispatch only; a 400 is not retried and no completion is claimed.
    response.writeHead(request.method === "POST" ? 400 : 200, { "content-type": "application/json" })
    response.end(request.method === "POST" ? JSON.stringify({ message: "Synthetic Bedrock witness" }) : "{}")
  })
  await new Promise<void>((resolve) => witness.listen(0, "127.0.0.1", resolve))
  const address = witness.address()
  if (!address || typeof address === "string") throw new Error("Witness did not bind")
  const witnessUrl = `http://127.0.0.1:${address.port}`
  const root = await mkdtemp(join(tmpdir(), "byok-bedrock-"))
  const directory = join(root, "workspace")
  await mkdir(directory)

  const rows: { id: string; apiKeys: Record<string, string> }[] = [
    { id: "lpr_01kx00000000000000000keys1", apiKeys: { AWS_ACCESS_KEY_ID: "AKIDSYNTHETIC", AWS_SECRET_ACCESS_KEY: "synthetic-secret", AWS_REGION: "eu-central-2" } },
    { id: "lpr_01kx00000000000000000tokn2", apiKeys: { AWS_BEARER_TOKEN_BEDROCK: "synthetic-bedrock-token", AWS_REGION: "ap-south-1" } },
  ]
  const modelId = "anthropic.synthetic-witness-v1:0"
  const provider: Record<string, unknown> = {}
  // A minimal environment: no AWS_* name from the host can satisfy the SDK.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: root, OPENCODE_CONFIG: join(root, "opencode.json"),
    OPENCODE_MODELS_URL: witnessUrl, OPENCODE_DISABLE_MODELS_FETCH: "1",
    XDG_CONFIG_HOME: join(root, "xdg"), XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
  }
  for (const row of rows) {
    const runtime = toRuntimeProviderEnv({ id: row.id, source: "models_dev", providerConfig: bedrock, apiKeys: row.apiKeys })
    Object.assign(env, runtime.apiKeys)
    const options = runtime.providerConfig.options
    provider[row.id] = {
      // Built the way the desktop sync builds a Den provider; only baseURL is
      // added so the SDK calls the witness instead of AWS.
      id: "amazon-bedrock", name: row.id, env: runtime.providerConfig.env, npm: bedrockNpm,
      options: { ...(typeof options === "object" && options !== null ? options : {}), baseURL: witnessUrl },
      models: { [modelId]: { id: modelId, name: "Synthetic witness" } },
    }
  }
  assert.ok(Object.keys(env).filter((name) => name.includes("AWS")).every((name) => name.startsWith("LPR_")))
  await writeFile(env.OPENCODE_CONFIG, JSON.stringify({ provider }))

  const engine = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] })
  try {
    const engineUrl = await new Promise<string>((resolve, reject) => {
      let output = ""
      const timer = setTimeout(() => reject(new Error(`OpenCode did not start:\n${output}`)), 60_000)
      const read = (chunk: Buffer) => {
        output += chunk.toString()
        const match = /opencode server listening on (http:\/\/\S+)/.exec(output)
        if (match?.[1]) {
          clearTimeout(timer)
          resolve(match[1])
        }
      }
      engine.stdout.on("data", read)
      engine.stderr.on("data", read)
      engine.once("exit", (code) => reject(new Error(`OpenCode exited with ${code}:\n${output}`)))
    })
    const call = async (path: string, body: unknown): Promise<unknown> => {
      const url = new URL(path, engineUrl)
      url.searchParams.set("directory", directory)
      const response = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
      })
      assert.equal(response.status, 200, `${path} answered ${response.status}`)
      return response.json()
    }

    for (const row of rows) {
      const session = await call("/session", { title: "BYOK Bedrock witness" })
      const sessionId = typeof session === "object" && session !== null && "id" in session ? session.id : null
      assert.equal(typeof sessionId, "string")
      const offset = requests.length
      await call(`/session/${sessionId}/message`, {
        model: { providerID: row.id, modelID: modelId }, parts: [{ type: "text", text: "Reply hello." }],
      })
      const dispatched = requests.slice(offset).find((entry) => entry.path.includes(encodeURIComponent(modelId)))
      assert.ok(dispatched, `${row.id}: no request reached Bedrock (before the fix: "AWS region setting is missing")`)
      if ("AWS_BEARER_TOKEN_BEDROCK" in row.apiKeys) {
        assert.equal(dispatched.authorization, `Bearer ${row.apiKeys.AWS_BEARER_TOKEN_BEDROCK}`)
      } else {
        // SigV4 scope: <key id>/<date>/<region>/bedrock/aws4_request
        const scope = /Credential=([^,]+)/.exec(dispatched.authorization)?.[1]?.split("/") ?? []
        assert.deepEqual([scope[0], scope[2], scope[3]], [row.apiKeys.AWS_ACCESS_KEY_ID, row.apiKeys.AWS_REGION, "bedrock"])
      }
    }
  } finally {
    engine.kill()
    witness.closeAllConnections()
    await new Promise<void>((resolve) => witness.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

async function materializationFixture() {
  // Match the other Den unit harnesses: injected store/fetch never contact DB.
  process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/provider_materialization_unit_test"
  process.env.BETTER_AUTH_URL ??= "http://unit.test"
  process.env.BETTER_AUTH_SECRET ??= "synthetic-provider-materialization-unit-test-secret"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-provider-materialization-unit-test-key"
  process.env.OPENWORK_DEV_MODE ??= "1"
  const { materializeCloudWorkerProviders } = await import("../src/llm/cloud-provider-materialization.js")
  const keys = Array.from({ length: 7 }, (_, index) => `TEST_KEY_${index}`)
  const providers: CloudProviderMaterializationProvider[] = ["ipr_first", "ipr_second"].map((id) => ({
    id, source: "custom", providerId: "custom", name: id,
    providerConfig: { npm: "@ai-sdk/openai-compatible", env: keys },
    apiKey: JSON.stringify(Object.fromEntries(keys.map((key) => [key, "new-value"]))),
    models: [],
  }))
  const config = deferredResponse()
  const reads = new Map<string, ReturnType<typeof deferredResponse>>()
  const writes: { method: string; path: string; body: string | null }[] = []
  let configReads = 0
  let activeReads = 0
  let peakReads = 0
  let finished = false
  let failReadback = false
  const run = () => materializeCloudWorkerProviders({
    organizationId: createDenTypeId("organization"), workerId: createDenTypeId("worker"),
    instanceUrl: "https://worker.example.test", hostToken: "host", clientToken: "client",
    store: { listProviders: async () => providers, getActiveTokens: async () => [] },
    logger: { warn() {}, error() {} },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname
      const method = init?.method ?? "GET"
      if (method !== "GET") {
        writes.push({ method, path, body: typeof init?.body === "string" ? init.body : null })
        return Response.json({})
      }
      if (path === "/opencode/config") {
        configReads++
        if (configReads === 1) return config.promise
        if (failReadback) return new Response("readback failed", { status: 500 })
        return Response.json({ provider: Object.fromEntries(providers.map((provider) => [provider.id, {}])) })
      }
      assert.ok(path.startsWith("/env/"), path)
      const key = decodeURIComponent(path.slice("/env/".length))
      assert.equal(reads.has(key), false, `${key} must be read only once`)
      const read = deferredResponse()
      reads.set(key, read)
      activeReads++
      peakReads = Math.max(peakReads, activeReads)
      try {
        return await read.promise
      } finally {
        activeReads--
      }
    },
  }).finally(() => { finished = true })
  const release = (key: string, response = new Response(null, { status: 404 })) => {
    const read = reads.get(key)
    assert.ok(read, `${key} was launched`)
    read.resolve(response)
  }
  return {
    keys, providers, config, reads, writes, run, release,
    active: () => activeReads, peak: () => peakReads, finished: () => finished,
    failReadback: () => { failReadback = true },
  }
}

test("cloud materialization overlaps config/env reads, bounds and deduplicates env reads, and gates writes", { timeout: 15_000 }, async () => {
  const fixture = await materializationFixture()
  const result = fixture.run()
  await setImmediate()
  assert.equal(fixture.reads.size, 4, "env snapshot starts before config completes")
  assert.equal(fixture.active(), 4)
  assert.deepEqual(fixture.writes, [])
  // Complete out of order; each free slot schedules exactly one more key.
  fixture.release(fixture.keys[3])
  await setImmediate()
  assert.equal(fixture.reads.size, 5)
  fixture.release(fixture.keys[2])
  await setImmediate()
  assert.equal(fixture.reads.size, 6)
  fixture.release(fixture.keys[1])
  await setImmediate()
  assert.equal(fixture.reads.size, 7)
  for (const index of [6, 5, 4, 0]) fixture.release(fixture.keys[index])
  await setImmediate()
  assert.equal(fixture.active(), 0)
  assert.equal(fixture.finished(), false, "config snapshot still gates completion")
  assert.deepEqual(fixture.writes, [])
  fixture.config.resolve(Response.json({ provider: {} }))
  assert.equal((await result).status, "applied")
  assert.equal(fixture.peak(), 4)
  assert.deepEqual([...fixture.reads.keys()], fixture.keys)
  assert.deepEqual(fixture.writes.map(({ method, path }) => `${method} ${path}`), ["PUT /env", "PATCH /runtime-config/providers"])
})

test("cloud materialization drains env reads after config failure without writing", { timeout: 15_000 }, async () => {
  const fixture = await materializationFixture()
  const result = fixture.run()
  await setImmediate()
  fixture.config.resolve(new Response(null, { status: 500 }))
  await setImmediate()
  assert.equal(fixture.finished(), false)
  assert.deepEqual(fixture.writes, [])
  for (const key of fixture.keys) {
    fixture.release(key)
    await setImmediate()
  }
  const failed = await result
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.equal(failed.reason, "engine_config_read_failed_500")
  assert.equal(fixture.active(), 0)
  assert.deepEqual(fixture.writes, [])
})

test("cloud materialization drains both snapshots after env failure and stops scheduling env reads", { timeout: 15_000 }, async () => {
  const fixture = await materializationFixture()
  const result = fixture.run()
  await setImmediate()
  fixture.release(fixture.keys[0], new Response(null, { status: 500 }))
  await setImmediate()
  assert.equal(fixture.finished(), false)
  assert.equal(fixture.reads.size, 4)
  fixture.release(fixture.keys[1], new Response(null, { status: 502 }))
  fixture.release(fixture.keys[3])
  await setImmediate()
  assert.equal(fixture.finished(), false, "the last launched env read still gates failure")
  fixture.release(fixture.keys[2])
  await setImmediate()
  assert.equal(fixture.finished(), false, "the config read still gates failure")
  fixture.config.resolve(Response.json({ provider: {} }))
  const failed = await result
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.equal(failed.reason, "env_read_failed_500")
  assert.equal(fixture.active(), 0)
  assert.equal(fixture.reads.size, 4)
  assert.deepEqual(fixture.writes, [])
})

test("cloud materialization preserves provider-first rollback and env key order despite out-of-order snapshots", { timeout: 15_000 }, async () => {
  const fixture = await materializationFixture()
  fixture.failReadback()
  const result = fixture.run()
  await setImmediate()
  fixture.config.resolve(Response.json({ provider: { ipr_old: { name: "Old provider" } } }))
  await setImmediate()
  assert.deepEqual(fixture.writes, [], "env snapshots still gate writes after config succeeds")
  fixture.release(fixture.keys[3])
  await setImmediate()
  fixture.release(fixture.keys[2], Response.json({ item: { value: "old-2" } }))
  await setImmediate()
  fixture.release(fixture.keys[1])
  await setImmediate()
  fixture.release(fixture.keys[6])
  fixture.release(fixture.keys[5])
  fixture.release(fixture.keys[4], Response.json({ item: { value: "old-4" } }))
  fixture.release(fixture.keys[0])
  assert.equal((await result).ok, false)
  assert.equal(fixture.active(), 0)
  assert.deepEqual(fixture.writes.map(({ method, path }) => `${method} ${path}`), [
    "PUT /env", "PATCH /runtime-config/providers", "PATCH /runtime-config/providers", "PUT /env",
    ...[0, 1, 3, 5, 6].map((index) => `DELETE /env/${fixture.keys[index]}`),
  ])
  assert.equal(fixture.writes[2].body, JSON.stringify({ provider: {
    ipr_old: { name: "Old provider" }, ipr_first: null, ipr_second: null,
  } }))
  assert.equal(fixture.writes[3].body, JSON.stringify({ entries: [
    { key: fixture.keys[2], value: "old-2" }, { key: fixture.keys[4], value: "old-4" },
  ] }))
})
