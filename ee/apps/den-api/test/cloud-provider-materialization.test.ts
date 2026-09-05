import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"
import type { CloudProviderMaterializationProvider } from "../src/llm/cloud-provider-materialization.js"
import { runtimeProviderEnvTag } from "../src/llm/provider-credentials.js"

// Fixed row ids so the provider-scoped runtime env names are stable across
// the suite: a models.dev provider's declared names leave Den as
// `<LPR_tag>_<declared name>`, derived from nothing but the row id.
const ANTHROPIC_PROVIDER_ID = "lpr_01kx4t3amgendr682dmp6120jv" as const
const AZURE_PROVIDER_ID = "lpr_01kx4t3apjendr685c2ryzevqe" as const
const ANTHROPIC_API_KEY_ENV = `${runtimeProviderEnvTag(ANTHROPIC_PROVIDER_ID)}_ANTHROPIC_API_KEY`
const AZURE_RESOURCE_NAME_ENV = `${runtimeProviderEnvTag(AZURE_PROVIDER_ID)}_AZURE_RESOURCE_NAME`
const AZURE_API_KEY_ENV = `${runtimeProviderEnvTag(AZURE_PROVIDER_ID)}_AZURE_API_KEY`

type MaterializerModule = typeof import("../src/llm/cloud-provider-materialization.js")
type MaterializeInput = Parameters<MaterializerModule["materializeCloudWorkerProviders"]>[0]
type Store = NonNullable<MaterializeInput["store"]>
type FetchImpl = NonNullable<MaterializeInput["fetchImpl"]>
type Logger = NonNullable<MaterializeInput["logger"]>
type FetchCall = {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
  redirect: RequestRedirect | null
}

const organizationId = createDenTypeId("organization")
const instanceUrl = "https://worker.example.test"
let materializeCloudWorkerProviders: MaterializerModule["materializeCloudWorkerProviders"]
let computeCloudProviderMaterializationFingerprint: MaterializerModule["computeCloudProviderMaterializationFingerprint"]

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

beforeAll(async () => {
  seedRequiredEnv()
  const materializer = await import("../src/llm/cloud-provider-materialization.js")
  materializeCloudWorkerProviders = materializer.materializeCloudWorkerProviders
  computeCloudProviderMaterializationFingerprint = materializer.computeCloudProviderMaterializationFingerprint
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function parseBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string" || !body.trim()) {
    return null
  }

  return JSON.parse(body)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function headersRecord(headers: HeadersInit | undefined) {
  const record: Record<string, string> = {}
  new Headers(headers).forEach((value, key) => {
    record[key] = value
  })
  return record
}

function bodyEntries(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return []
  }

  const entries = Object.entries(body).find(([key]) => key === "entries")?.[1]
  return Array.isArray(entries)
    ? entries.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    : []
}

function providerPatchFromBody(body: unknown) {
  if (!isRecord(body) || !isRecord(body.provider)) {
    return {}
  }

  return body.provider
}

function makeAnthropicProvider(input: {
  apiKey: string
  modelId?: string
}): CloudProviderMaterializationProvider {
  const modelId = input.modelId ?? "claude-fable-5"
  return {
    id: ANTHROPIC_PROVIDER_ID,
    source: "models_dev",
    providerId: "anthropic",
    name: "Anthropic",
    providerConfig: {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      env: ["ANTHROPIC_API_KEY"],
      api: "https://api.anthropic.com/v1",
    },
    apiKey: input.apiKey,
    models: [
      {
        modelId,
        name: modelId,
        modelConfig: {
          id: modelId,
          name: modelId,
          tool_call: true,
        },
      },
    ],
  }
}

function makeAnthropicRuntimeProvider(modelId = "claude-fable-5") {
  return {
    api: "https://api.anthropic.com/v1",
    npm: "@ai-sdk/anthropic",
    models: {
      [modelId]: {
        tool_call: true,
        name: modelId,
        id: modelId,
      },
    },
    env: [ANTHROPIC_API_KEY_ENV],
    name: "Anthropic",
    id: "anthropic",
  }
}

function makeAzureProvider(apiKeys: Record<string, string>): CloudProviderMaterializationProvider {
  return {
    id: AZURE_PROVIDER_ID,
    source: "models_dev",
    providerId: "azure",
    name: "Azure",
    providerConfig: {
      id: "azure",
      name: "Azure",
      npm: "@ai-sdk/azure",
      env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
    },
    apiKey: JSON.stringify(apiKeys),
    models: [
      {
        modelId: "deployment",
        name: "deployment",
        modelConfig: {
          id: "deployment",
          name: "deployment",
        },
      },
    ],
  }
}

function makeStore(providers: () => CloudProviderMaterializationProvider[]): Store {
  return {
    async listProviders() {
      return providers()
    },
    async getActiveTokens() {
      return [
        { scope: "host", token: "host-token" },
        { scope: "client", token: "client-token" },
      ]
    },
  }
}

function makeInstance(input: {
  envValues?: Record<string, string>
  failEnvWrites?: number
  envWriteRejection?: { status: number; body: unknown }
  failConfigPatches?: number
  providerRouteStatus?: number
  providerRouteServesSpa?: boolean
  runtimeVersion?: string | null
  runtimeProviders?: Record<string, unknown>
  opencodeConfigProviders?: Record<string, unknown>
  missingEngineReadbacks?: number
} = {}) {
  const calls: FetchCall[] = []
  const envValues = new Map(Object.entries(input.envValues ?? {}))
  let failEnvWrites = input.failEnvWrites ?? 0
  let failConfigPatches = input.failConfigPatches ?? 0
  let missingEngineReadbacks = input.missingEngineReadbacks ?? 0
  const runtimeProviders: Record<string, unknown> = { ...(input.runtimeProviders ?? {}) }
  const engineProviders = input.opencodeConfigProviders ? { ...input.opencodeConfigProviders } : null
  const fetchImpl: FetchImpl = async (url, init) => {
    const parsed = new URL(url)
    const method = init?.method ?? "GET"
    const body = parseBody(init?.body)
    calls.push({
      method,
      path: parsed.pathname,
      headers: headersRecord(init?.headers),
      body,
      redirect: init?.redirect ?? null,
    })

    if (method === "GET" && parsed.pathname.startsWith("/env/")) {
      const key = decodeURIComponent(parsed.pathname.slice("/env/".length))
      const value = envValues.get(key) ?? null
      return value
        ? jsonResponse({ item: { key, value } })
        : jsonResponse({ error: "env_not_found" }, 404)
    }

    if (method === "GET" && parsed.pathname === "/opencode/config") {
      if (missingEngineReadbacks > 0) {
        missingEngineReadbacks -= 1
        return jsonResponse({ provider: {} })
      }
      return jsonResponse({ provider: engineProviders ?? runtimeProviders })
    }

    if (method === "GET" && parsed.pathname === "/runtime/versions") {
      return jsonResponse({
        services: [
          {
            name: "openwork-server",
            actualVersion: input.runtimeVersion ?? null,
          },
        ],
      })
    }

    if (method === "PUT" && parsed.pathname === "/env") {
      if (input.envWriteRejection) {
        return jsonResponse(input.envWriteRejection.body, input.envWriteRejection.status)
      }
      if (failEnvWrites > 0) {
        failEnvWrites -= 1
        return jsonResponse({ error: "env_write_failed" }, 500)
      }
      const persistableInternalKeys = new Set([
        "OPENWORK_API_KEY",
        "OPENWORK_MODELS_API_KEY",
        "OPENWORK_INFERENCE_BASE_URL",
        "OPENWORK_MODELS_BASE_URL",
      ])
      const hasReservedEntry = bodyEntries(body).some((entry) => (
        typeof entry.key === "string"
        && /^(OPENWORK_|OPENCODE_)/.test(entry.key)
        && !persistableInternalKeys.has(entry.key)
      ))
      if (hasReservedEntry) {
        return jsonResponse({ code: "reserved_env_key" }, 400)
      }
      for (const entry of bodyEntries(body)) {
        if (typeof entry.key === "string" && typeof entry.value === "string") {
          envValues.set(entry.key, entry.value)
        }
      }
      return jsonResponse({ ok: true })
    }

    if (method === "DELETE" && parsed.pathname.startsWith("/env/")) {
      const key = decodeURIComponent(parsed.pathname.slice("/env/".length))
      if (!envValues.has(key)) {
        return jsonResponse({ error: "env_not_found" }, 404)
      }
      envValues.delete(key)
      return jsonResponse({ ok: true })
    }

    if (method === "PATCH" && parsed.pathname === "/runtime-config/providers") {
      if (input.providerRouteServesSpa) {
        // Instances older than this route fall through to the SPA catch-all and
        // answer 200 with index.html (seen on a real worker on 0.18.3).
        return new Response("<!doctype html>\n<html lang=\"en\"><head><title>OpenWork</title></head></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      }
      if (input.providerRouteStatus) {
        return jsonResponse({ error: "runtime_provider_route_unavailable" }, input.providerRouteStatus)
      }
      if (failConfigPatches > 0) {
        failConfigPatches -= 1
        return jsonResponse({ error: "config_patch_failed" }, 500)
      }
      const providerPatch = providerPatchFromBody(body)
      for (const [providerId, value] of Object.entries(providerPatch)) {
        if (value === null) {
          delete runtimeProviders[providerId]
        } else if (isRecord(value)) {
          runtimeProviders[providerId] = value
        }
      }
      return jsonResponse({ updatedAt: Date.now() })
    }

    return jsonResponse({ error: "not_found" }, 404)
  }

  return {
    calls,
    fetchImpl,
    envValue(key: string) {
      return envValues.get(key) ?? null
    },
    runtimeProvider(providerId: string) {
      return runtimeProviders[providerId] ?? null
    },
  }
}

function callMethods(calls: FetchCall[]) {
  return calls.map((call) => `${call.method} ${call.path}`)
}

function writeCalls(calls: FetchCall[]) {
  return calls.filter((call) => ["PUT", "PATCH", "POST"].includes(call.method))
}

async function materialize(input: {
  workerId?: MaterializeInput["workerId"]
  providers: () => CloudProviderMaterializationProvider[]
  fetchImpl: FetchImpl
  logger?: Logger
  force?: boolean
  instanceUrl?: string
  now?: () => number
}) {
  return materializeCloudWorkerProviders({
    organizationId,
    workerId: input.workerId ?? createDenTypeId("worker"),
    instanceUrl: input.instanceUrl ?? instanceUrl,
    hostToken: "host-token",
    clientToken: "client-token",
    store: makeStore(input.providers),
    fetchImpl: input.fetchImpl,
    logger: input.logger,
    force: input.force,
    now: input.now,
  })
}

describe("Cloud provider materialization", () => {
  test("does not rewrite matching provider state after the den-api cache is lost", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance({
      envValues: { [ANTHROPIC_API_KEY_ENV]: "sk-anthropic" },
      runtimeProviders: { [provider.id]: makeAnthropicRuntimeProvider() },
    })
    const workerId = createDenTypeId("worker")

    await materialize({ workerId, providers: () => [provider], fetchImpl: instance.fetchImpl, force: true })
    instance.calls.length = 0

    const second = await materialize({ workerId, providers: () => [provider], fetchImpl: instance.fetchImpl, force: true })

    expect(second.status).toBe("noop")
    expect(instance.calls.filter((call) => call.method === "PUT" && call.path === "/env")).toHaveLength(0)
    expect(instance.calls.filter((call) => call.method === "PATCH" && call.path === "/runtime-config/providers")).toHaveLength(0)
  })

  test("re-materializes after a recycle replaces the instance", async () => {
    // A recycle onto a new snapshot gives the worker a brand new sandbox: only
    // the runtime config survives (shared volume), the env store starts empty.
    // Keying the cache by worker alone made den-api answer "cached" and never
    // write the credential into the new instance, so every provider failed with
    // "API key is missing" while still appearing in the picker.
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const workerId = createDenTypeId("worker")

    const before = makeInstance({
      envValues: { [ANTHROPIC_API_KEY_ENV]: "sk-anthropic" },
      runtimeProviders: { [provider.id]: makeAnthropicRuntimeProvider() },
    })
    await materialize({ workerId, providers: () => [provider], fetchImpl: before.fetchImpl })

    // Same worker, same credential fingerprint, new sandbox: config persisted on
    // the volume, env store empty.
    const recycled = makeInstance({
      runtimeProviders: { [provider.id]: makeAnthropicRuntimeProvider() },
    })
    const result = await materialize({
      workerId,
      providers: () => [provider],
      fetchImpl: recycled.fetchImpl,
      instanceUrl: "https://worker-recycled.example.test",
    })

    expect(result.ok).toBe(true)
    expect(result.status).toBe("applied")
    expect(recycled.calls.filter((call) => call.method === "PUT" && call.path === "/env")).toHaveLength(1)
    expect(recycled.calls.find((call) => call.method === "PUT" && call.path === "/env")?.body).toEqual({
      entries: [{ key: ANTHROPIC_API_KEY_ENV, value: "sk-anthropic" }],
    })
  })

  test("writes a models.dev provider block, credential env, and reloads OpenCode", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance()

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result.ok).toBe(true)
    expect(result.status).toBe("applied")
    expect(callMethods(instance.calls)).toEqual([
      "GET /opencode/config",
      `GET /env/${ANTHROPIC_API_KEY_ENV}`,
      "GET /env/ANTHROPIC_API_KEY",
      "PUT /env",
      "PATCH /runtime-config/providers",
      "GET /opencode/config",
    ])
    expect(instance.calls[3]?.headers["x-openwork-host-token"]).toBe("host-token")
    expect(instance.calls[3]?.body).toEqual({
      entries: [{ key: ANTHROPIC_API_KEY_ENV, value: "sk-anthropic" }],
    })
    expect(instance.calls[4]?.headers["x-openwork-host-token"]).toBe("host-token")
    expect(instance.calls[4]?.headers.authorization).toBeUndefined()
    expect(instance.calls.every((call) => call.redirect === "error")).toBe(true)
    expect(instance.calls[4]?.body).toEqual({
      provider: {
        [provider.id]: {
          id: "anthropic",
          name: "Anthropic",
          env: [ANTHROPIC_API_KEY_ENV],
          models: {
            "claude-fable-5": {
              id: "claude-fable-5",
              name: "claude-fable-5",
              tool_call: true,
            },
          },
          npm: "@ai-sdk/anthropic",
          api: "https://api.anthropic.com/v1",
        },
      },
    })
    expect(writeCalls(instance.calls).map((call) => call.method)).toEqual(["PUT", "PATCH"])
  })

  test("writes Azure resource name and API key env while preserving the provider env config", async () => {
    const provider = makeAzureProvider({
      AZURE_RESOURCE_NAME: "resource-name",
      AZURE_API_KEY: "real-api-key",
    })
    const instance = makeInstance()

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result.ok).toBe(true)
    expect(instance.calls.find((call) => call.method === "PUT" && call.path === "/env")?.body).toEqual({
      entries: [
        { key: AZURE_RESOURCE_NAME_ENV, value: "resource-name" },
        { key: AZURE_API_KEY_ENV, value: "real-api-key" },
      ],
    })
    expect(instance.runtimeProvider(provider.id)).toMatchObject({
      id: "azure",
      env: [AZURE_RESOURCE_NAME_ENV, AZURE_API_KEY_ENV],
    })
  })

  test("removes the org credential an earlier release left under the bare catalog name, never a different value", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })

    // Worker materialized before runtime names were provider-scoped: the org
    // credential sits under ANTHROPIC_API_KEY, which also switches on
    // OpenCode's built-in Anthropic catalog.
    const upgraded = makeInstance({
      envValues: { ANTHROPIC_API_KEY: "sk-anthropic" },
      runtimeProviders: { [provider.id]: { ...makeAnthropicRuntimeProvider(), env: ["ANTHROPIC_API_KEY"] } },
    })
    const first = await materialize({ providers: () => [provider], fetchImpl: upgraded.fetchImpl, force: true })
    expect(first.status).toBe("applied")
    expect(upgraded.envValue(ANTHROPIC_API_KEY_ENV)).toBe("sk-anthropic")
    expect(upgraded.envValue("ANTHROPIC_API_KEY")).toBeNull()
    expect(callMethods(upgraded.calls)).toContain("DELETE /env/ANTHROPIC_API_KEY")

    const second = await materialize({ providers: () => [provider], fetchImpl: upgraded.fetchImpl, force: true })
    expect(second.status).toBe("noop")

    // A different value under the bare name is the member's own key.
    const withOwnKey = makeInstance({ envValues: { ANTHROPIC_API_KEY: "sk-members-own" } })
    await materialize({ providers: () => [provider], fetchImpl: withOwnKey.fetchImpl, force: true })
    expect(withOwnKey.envValue(ANTHROPIC_API_KEY_ENV)).toBe("sk-anthropic")
    expect(withOwnKey.envValue("ANTHROPIC_API_KEY")).toBe("sk-members-own")
    expect(callMethods(withOwnKey.calls)).not.toContain("DELETE /env/ANTHROPIC_API_KEY")
  })

  test("a custom provider keeps the exact env name its author declared", async () => {
    // Organizations that route members to their own gateway (a LiteLLM
    // deployment, for instance) declare the env name themselves and may leave
    // the credential for the member's machine. That contract is theirs to
    // keep: only models.dev rows get the provider-scoped runtime name.
    const provider: CloudProviderMaterializationProvider = {
      id: "lpr_01kx4t3aqfendr688a4dedf2m5",
      source: "custom",
      providerId: "gateway",
      name: "Gateway",
      providerConfig: {
        id: "gateway",
        name: "Gateway",
        npm: "@ai-sdk/openai-compatible",
        env: ["OPENAI_API_KEY"],
        options: { baseURL: "https://gateway.example.test/v1" },
      },
      apiKey: "sk-gateway",
      models: [{ modelId: "gpt-x", name: "gpt-x", modelConfig: { id: "gpt-x", name: "gpt-x" } }],
    }
    const instance = makeInstance()

    const result = await materialize({ providers: () => [provider], fetchImpl: instance.fetchImpl, force: true })

    expect(result.ok).toBe(true)
    expect(instance.calls.find((call) => call.method === "PUT" && call.path === "/env")?.body).toEqual({
      entries: [{ key: "OPENAI_API_KEY", value: "sk-gateway" }],
    })
    expect(instance.runtimeProvider(provider.id)).toMatchObject({ id: "gateway", env: ["OPENAI_API_KEY"] })
  })

  test("does not materialize Azure from a resource name without its API key", async () => {
    const provider = makeAzureProvider({ AZURE_RESOURCE_NAME: "resource-name" })
    const instance = makeInstance()

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result.ok).toBe(true)
    expect(result.providers).toBe(0)
    expect(instance.envValue(AZURE_RESOURCE_NAME_ENV)).toBeNull()
    expect(instance.runtimeProvider(provider.id)).toBeNull()
  })

  test("materializes a legacy scalar Azure credential as the API key env", async () => {
    const provider = makeAzureProvider({})
    provider.apiKey = "legacy-api-key"
    const instance = makeInstance()

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result.ok).toBe(true)
    expect(result.providers).toBe(1)
    expect(instance.calls.find((call) => call.method === "PUT" && call.path === "/env")?.body).toEqual({
      entries: [{ key: AZURE_API_KEY_ENV, value: "legacy-api-key" }],
    })
    expect(instance.runtimeProvider(provider.id)).toMatchObject({
      id: "azure",
      env: [AZURE_RESOURCE_NAME_ENV, AZURE_API_KEY_ENV],
    })
  })

  test("skips writes and reloads when observed provider and env state match", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const fingerprint = computeCloudProviderMaterializationFingerprint([provider])
    const instance = makeInstance({
      envValues: { [ANTHROPIC_API_KEY_ENV]: "sk-anthropic" },
      runtimeProviders: { [provider.id]: makeAnthropicRuntimeProvider() },
    })

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result).toEqual({ ok: true, status: "noop", fingerprint, providers: 1 })
    expect(callMethods(instance.calls)).toEqual([
      "GET /opencode/config",
      `GET /env/${ANTHROPIC_API_KEY_ENV}`,
      "GET /env/ANTHROPIC_API_KEY",
    ])
    expect(writeCalls(instance.calls)).toHaveLength(0)
  })

  test("applies when the observed provider config is incomplete", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance({
      envValues: { [ANTHROPIC_API_KEY_ENV]: "sk-anthropic" },
      runtimeProviders: { [provider.id]: { id: "anthropic" } },
    })

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result.ok).toBe(true)
    expect(result.status).toBe("applied")
    expect(callMethods(instance.calls)).toEqual([
      "GET /opencode/config",
      `GET /env/${ANTHROPIC_API_KEY_ENV}`,
      "GET /env/ANTHROPIC_API_KEY",
      "PUT /env",
      "PATCH /runtime-config/providers",
      "GET /opencode/config",
    ])
  })

  test("treats missing provider read-back as materialization failure", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance({ opencodeConfigProviders: {} })

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe(`provider_readback_missing_${provider.id}`)
    }
    expect(callMethods(instance.calls)).toEqual([
      "GET /opencode/config",
      `GET /env/${ANTHROPIC_API_KEY_ENV}`,
      "GET /env/ANTHROPIC_API_KEY",
      "PUT /env",
      "PATCH /runtime-config/providers",
      "GET /opencode/config",
      "PATCH /runtime-config/providers",
      `DELETE /env/${ANTHROPIC_API_KEY_ENV}`,
    ])
    expect(instance.envValue(ANTHROPIC_API_KEY_ENV)).toBeNull()
  })

  test("fails when the provider is absent from engine-visible config", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance({ opencodeConfigProviders: {} })

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe(`provider_readback_missing_${provider.id}`)
    }
  })

  test("uses the global provider route without workspace discovery", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance()

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result.ok).toBe(true)
    expect(instance.calls.some((call) => call.path === "/workspaces")).toBe(false)
    expect(instance.calls.some((call) => call.method === "PATCH" && call.path === "/runtime-config/providers")).toBe(true)
    expect(instance.calls.some((call) => call.path.startsWith("/workspace/"))).toBe(false)
  })

  test("reapplies exactly once when providers drift, then caches the resolve check", async () => {
    const workerId = createDenTypeId("worker")
    let providers = [makeAnthropicProvider({ apiKey: "sk-first" })]
    const instance = makeInstance()

    await materialize({ workerId, providers: () => providers, fetchImpl: instance.fetchImpl })
    instance.calls.length = 0

    providers = [makeAnthropicProvider({ apiKey: "sk-second", modelId: "claude-fable-5-updated" })]
    const drift = await materialize({ workerId, providers: () => providers, fetchImpl: instance.fetchImpl })
    expect(drift.ok).toBe(true)
    expect(drift.status).toBe("applied")
    expect(writeCalls(instance.calls).map((call) => call.method)).toEqual(["PUT", "PATCH"])

    instance.calls.length = 0
    const cached = await materialize({ workerId, providers: () => providers, fetchImpl: instance.fetchImpl })
    expect(cached.ok).toBe(true)
    expect(cached.status).toBe("cached")
    expect(instance.calls).toHaveLength(0)
  })

  test("removes a provider that is no longer desired", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance({
      envValues: { [ANTHROPIC_API_KEY_ENV]: "sk-anthropic" },
      runtimeProviders: { [provider.id]: makeAnthropicRuntimeProvider() },
    })

    const result = await materialize({
      providers: () => [],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result.status).toBe("applied")
    expect(writeCalls(instance.calls).map((call) => call.method)).toEqual(["PATCH"])
    expect(instance.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      provider: { [provider.id]: null },
    })
    expect(instance.runtimeProvider(provider.id)).toBeNull()
  })

  test("rewrites env when an API key rotates", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-rotated" })
    const instance = makeInstance({
      envValues: { [ANTHROPIC_API_KEY_ENV]: "sk-original" },
      runtimeProviders: { [provider.id]: makeAnthropicRuntimeProvider() },
    })

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result.status).toBe("applied")
    expect(writeCalls(instance.calls).map((call) => call.method)).toEqual(["PUT", "PATCH"])
    expect(instance.calls.find((call) => call.method === "PUT")?.body).toEqual({
      entries: [{ key: ANTHROPIC_API_KEY_ENV, value: "sk-rotated" }],
    })
  })

  test("rewrites providers when the model list changes", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic", modelId: "claude-updated" })
    const instance = makeInstance({
      envValues: { [ANTHROPIC_API_KEY_ENV]: "sk-anthropic" },
      runtimeProviders: { [provider.id]: makeAnthropicRuntimeProvider("claude-original") },
    })

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result.status).toBe("applied")
    expect(writeCalls(instance.calls).map((call) => call.method)).toEqual(["PUT", "PATCH"])
    expect(instance.runtimeProvider(provider.id)).toEqual(makeAnthropicRuntimeProvider("claude-updated"))
  })

  test("logs and returns a rejected env write with its status and response body", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance({
      envWriteRejection: { status: 400, body: { code: "reserved_env_key" } },
    })
    const logs: Array<{ level: "warn" | "error"; message: string; metadata?: Record<string, unknown> }> = []
    const logger: Logger = {
      warn(message, metadata) {
        logs.push({ level: "warn", message, metadata })
      },
      error(message, metadata) {
        logs.push({ level: "error", message, metadata })
      },
    }

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      logger,
      force: true,
    })

    expect(result.status).toBe("failed")
    if (!result.ok) {
      expect(result.reason).toBe("env_write_failed_400")
      expect(result.message).toBe('env_write_failed_400: {"code":"reserved_env_key"}')
    }
    expect(logs).toEqual([
      {
        level: "error",
        message: "cloud provider materialization write rejected",
        metadata: expect.objectContaining({
          reason: "env_write_failed_400",
          status: 400,
          response_body: '{"code":"reserved_env_key"}',
        }),
      },
    ])
  })

  test("does not patch provider blocks when credential env write fails, and allows a forced retry", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance({ failEnvWrites: 1 })

    const failed = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
    })

    expect(failed.ok).toBe(false)
    expect(callMethods(instance.calls)).toEqual([
      "GET /opencode/config",
      `GET /env/${ANTHROPIC_API_KEY_ENV}`,
      "GET /env/ANTHROPIC_API_KEY",
      "PUT /env",
    ])
    expect(instance.calls.some((call) => call.method === "PATCH")).toBe(false)

    instance.calls.length = 0
    const retried = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })
    expect(retried.ok).toBe(true)
    expect(retried.status).toBe("applied")
    expect(writeCalls(instance.calls).map((call) => call.method)).toEqual(["PUT", "PATCH"])
  })

  test("rolls back credential env and allows a forced retry when config patch fails", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance({ failConfigPatches: 1 })

    const failed = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
    })

    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.reason).toBe("runtime_provider_patch_failed_500")
    }
    expect(callMethods(instance.calls)).toEqual([
      "GET /opencode/config",
      `GET /env/${ANTHROPIC_API_KEY_ENV}`,
      "GET /env/ANTHROPIC_API_KEY",
      "PUT /env",
      "PATCH /runtime-config/providers",
      "PATCH /runtime-config/providers",
      `DELETE /env/${ANTHROPIC_API_KEY_ENV}`,
    ])
    expect(instance.envValue(ANTHROPIC_API_KEY_ENV)).toBeNull()

    instance.calls.length = 0
    const retried = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })
    expect(retried.ok).toBe(true)
    expect(retried.status).toBe("applied")
    expect(writeCalls(instance.calls).map((call) => call.method)).toEqual(["PUT", "PATCH"])
  })

  test("treats an instance that serves the SPA on the provider route as unsupported", async () => {
    // A real worker still running openwork-server 0.18.3 answered PATCH
    // /runtime-config/providers with 200 + index.html, so the patch looked like
    // a success while the engine ended up with zero providers. The org then saw
    // an opaque failure instead of "this workspace needs an update", and every
    // model failed with "no API keys".
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance({ providerRouteServesSpa: true })

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      force: true,
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe("unsupported")
    await Promise.resolve()
  })

  test("preserves credential env when the global provider route is unsupported", async () => {
    const workerId = createDenTypeId("worker")
    let provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance({ providerRouteStatus: 404, runtimeVersion: "openwork-0.18.8" })
    const logs: Array<{ message: string; metadata?: Record<string, unknown> }> = []
    const logger: Logger = {
      warn(message, metadata) {
        logs.push({ message, metadata })
      },
      error(message, metadata) {
        logs.push({ message, metadata })
      },
    }

    const unsupported = await materialize({
      workerId,
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      logger,
    })

    expect(unsupported.ok).toBe(false)
    expect(unsupported.status).toBe("unsupported")
    expect(callMethods(instance.calls)).toEqual([
      "GET /opencode/config",
      `GET /env/${ANTHROPIC_API_KEY_ENV}`,
      "GET /env/ANTHROPIC_API_KEY",
      "PUT /env",
      "PATCH /runtime-config/providers",
      "GET /runtime/versions",
    ])
    expect(instance.envValue(ANTHROPIC_API_KEY_ENV)).toBe("sk-anthropic")
    expect(instance.calls.some((call) => call.method === "DELETE")).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      message: "cloud provider materialization unsupported by worker version",
      metadata: {
        instance_version: "openwork-0.18.8",
        reason: "runtime_provider_patch_failed_404",
      },
    })

    instance.calls.length = 0
    const repeated = await materialize({
      workerId,
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      logger,
    })

    expect(repeated.status).toBe("unsupported")
    expect(instance.envValue(ANTHROPIC_API_KEY_ENV)).toBe("sk-anthropic")
    expect(logs).toHaveLength(1)
    expect(instance.calls).toHaveLength(0)

    provider = makeAnthropicProvider({ apiKey: "sk-anthropic-rotated" })
    const changed = await materialize({
      workerId,
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      logger,
      force: true,
    })

    expect(changed.status).toBe("unsupported")
    expect(instance.envValue(ANTHROPIC_API_KEY_ENV)).toBe("sk-anthropic-rotated")
    expect(logs).toHaveLength(2)
  })

  test("does not serialize provider keys into logs, results, or fingerprints", async () => {
    const secret = "sk-secret-never"
    const provider = makeAnthropicProvider({ apiKey: secret })
    const instance = makeInstance()
    const logs: Array<{ message: string; metadata?: Record<string, unknown> }> = []
    const logger: Logger = {
      warn(message, metadata) {
        logs.push({ message, metadata })
      },
      error(message, metadata) {
        logs.push({ message, metadata })
      },
    }

    const result = await materialize({
      providers: () => [provider],
      fetchImpl: instance.fetchImpl,
      logger,
      force: true,
    })
    const fingerprint = computeCloudProviderMaterializationFingerprint([provider])

    expect(result.ok).toBe(true)
    expect(JSON.stringify({ logs, result, fingerprint })).not.toContain(secret)
    expect(fingerprint).not.toContain(secret)
  })

  test("cools down a failed materialization without making more preview requests", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance({ failEnvWrites: 1 })
    const workerId = createDenTypeId("worker")
    const now = () => 1_000

    const failed = await materialize({ workerId, providers: () => [provider], fetchImpl: instance.fetchImpl, now })
    instance.calls.length = 0
    const cooledDown = await materialize({ workerId, providers: () => [provider], fetchImpl: instance.fetchImpl, now })

    expect(failed.ok).toBe(false)
    expect(cooledDown).toEqual(failed)
    expect(instance.calls).toHaveLength(0)
  })

  test("force bypasses a materialization failure cooldown", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const instance = makeInstance({ failEnvWrites: 1 })
    const workerId = createDenTypeId("worker")
    const now = () => 2_000

    await materialize({ workerId, providers: () => [provider], fetchImpl: instance.fetchImpl, now })
    instance.calls.length = 0
    const forced = await materialize({ workerId, providers: () => [provider], fetchImpl: instance.fetchImpl, now, force: true })

    expect(forced.ok).toBe(true)
    expect(instance.calls.length).toBeGreaterThan(0)
  })

  test("success clears the failure cooldown before the next failure cycle", async () => {
    let provider = makeAnthropicProvider({ apiKey: "sk-first" })
    const workerId = createDenTypeId("worker")
    const now = () => 3_000
    const firstInstance = makeInstance({ failEnvWrites: 1 })

    await materialize({ workerId, providers: () => [provider], fetchImpl: firstInstance.fetchImpl, now })
    const succeeded = await materialize({ workerId, providers: () => [provider], fetchImpl: firstInstance.fetchImpl, now, force: true })
    expect(succeeded.ok).toBe(true)

    provider = makeAnthropicProvider({ apiKey: "sk-second" })
    const secondInstance = makeInstance({ failEnvWrites: 1 })
    const freshFailure = await materialize({ workerId, providers: () => [provider], fetchImpl: secondInstance.fetchImpl, now })
    expect(freshFailure.ok).toBe(false)
    expect(secondInstance.calls.length).toBeGreaterThan(0)

    secondInstance.calls.length = 0
    const cooledDown = await materialize({ workerId, providers: () => [provider], fetchImpl: secondInstance.fetchImpl, now })
    expect(cooledDown).toEqual(freshFailure)
    expect(secondInstance.calls).toHaveLength(0)
  })

  test("failure cooldown is scoped to worker and instance URL", async () => {
    const provider = makeAnthropicProvider({ apiKey: "sk-anthropic" })
    const workerId = createDenTypeId("worker")
    const failedInstance = makeInstance({ failEnvWrites: 1 })
    const otherInstance = makeInstance()
    const now = () => 4_000

    await materialize({ workerId, providers: () => [provider], fetchImpl: failedInstance.fetchImpl, now })
    const otherResult = await materialize({
      workerId,
      providers: () => [provider],
      fetchImpl: otherInstance.fetchImpl,
      instanceUrl: "https://other-worker.example.test",
      now,
    })

    expect(otherResult.ok).toBe(true)
    expect(otherInstance.calls.length).toBeGreaterThan(0)
  })
})
