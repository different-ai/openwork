import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { accessSync, constants, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { test } from "node:test"
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
