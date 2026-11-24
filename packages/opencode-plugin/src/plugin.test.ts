import assert from "node:assert/strict"
import { test } from "node:test"
import type {
  ConnectionInfo,
  ConnectionStatus,
  CredentialValue,
  Json,
  McpEditor,
  ModelInfo,
  OAuthCredential,
  OAuthMethodRegistration,
  PluginContext,
  ProviderEditor,
  ProviderInfo,
  RemoteMcpConfig,
} from "./opencode.ts"
import { createPlugin, readOptions } from "./plugin.ts"
import { createDesktopProviderPlugin as createDesktopProviderPluginSource, checkDesktopSession, isDesktopSessionEndpoint } from "./desktop.ts"
import { createHash } from "node:crypto"
import type { DenSession, Fetch } from "./den.ts"
import { setTimeout as delay } from "node:timers/promises"
import { API, createFakeDen, gatewaySummary, GATEWAY_KEY, MCP_TOKEN, MODEL_ID, ORG_ID, PROVIDER_ID, SESSION_TOKEN } from "./test-den.ts"

// Emulate the server-only transport around existing fake Den fixtures. The
// plugin sees only identity metadata and local inventory responses, never token.
function createDesktopProviderPlugin(deps: NonNullable<Parameters<typeof createDesktopProviderPluginSource>[0]> = {}) {
  const upstream = deps.fetch ?? fetch
  let source: DenSession | null = null
  return createDesktopProviderPluginSource({ ...deps, fetch: async (input, init) => {
    const url = new URL(input)
    if (url.pathname === "/session") {
      const response = await upstream(input, init)
      // Failed, non-JSON, and malformed local answers reach the plugin unchanged.
      if (!response.ok) return response
      const text = await response.text()
      let value: unknown
      try { value = JSON.parse(text) } catch { return new Response(text, { status: response.status, headers: response.headers }) }
      if (value === null) { source = null; return Response.json(null) }
      if (typeof value !== "object" || !("token" in value)) return Response.json(value)
      assert.ok(typeof value === "object" && value !== null && "apiBaseUrl" in value && "token" in value && "orgId" in value)
      assert.ok(typeof value.apiBaseUrl === "string" && typeof value.token === "string" && (value.orgId === null || typeof value.orgId === "string"))
      source = { apiBaseUrl: value.apiBaseUrl, token: value.token, orgId: value.orgId }
      const identity = createHash("sha256").update(JSON.stringify(source)).digest("hex")
      return Response.json({ apiBaseUrl: source.apiBaseUrl, orgId: source.orgId, identity,
        inferenceOrigin: url.origin, inferenceKey: `ow_local_${"b".repeat(64)}` })
    }
    assert.ok(source, "inventory transport requires current identity")
    assert.equal(init?.method ?? "GET", "GET")
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer capability")
    assert.match(new Headers(init?.headers).get("x-openwork-provider-identity") ?? "", /^[a-f0-9]{64}$/)
    const response = await upstream(source.apiBaseUrl + url.pathname + url.search, { ...init, headers: {
      authorization: `Bearer ${source.token}`, "x-openwork-org-id": source.orgId ?? "", "x-openwork-legacy-org-id": source.orgId ?? "",
    } })
    if (response.headers.get("content-type")?.includes("text/event-stream")) return response
    return new Response((await response.text()).replace(/ow_gw_[A-Za-z0-9_-]+/g, "ow_local_catalog"), { status: response.status, headers: response.headers })
  } })
}

/** A small stand-in for the OpenCode V2 plugin host: replays transforms on reload like the real one. */
function createHost(options: Record<string, unknown> = {}) {
  const integrationTransforms: ((editor: never) => void)[] = []
  const providerTransforms: ((editor: ProviderEditor) => void)[] = []
  const mcpTransforms: ((editor: McpEditor) => void)[] = []
  const storage = new Map<string, Json>()
  const credentials = new Map<string, OAuthCredential>()
  /** Keys OpenCode 2 imported from the desktop's V1 auth.json, by integration id. */
  const legacyCredentials = new Map<string, string>()
  const statuses: (ConnectionStatus | undefined)[] = []
  const methods: OAuthMethodRegistration[] = []
  let integrationName = ""
  let events: (() => void) | null = null

  /**
   * OpenCode's availability rule (packages/core/src/provider.ts snapshot): the
   * provider's integration is `integrationID ?? id`; a `sourceConnection` must
   * match that integration's active connection; `enabled` is otherwise available.
   */
  const providers = () => {
    const out = new Map<string, { info: ProviderInfo; models: readonly ModelInfo[]; sourceConnection?: ConnectionInfo }>()
    const editor: ProviderEditor = {
      get: (id) => out.get(id),
      add: (input) => void out.set(input.info.id, input),
      remove: (id) => void out.delete(id),
    }
    for (const transform of providerTransforms) transform(editor)
    const integrationConnections = (id: string): ConnectionInfo[] => (id === "openwork" ? connections() : legacyCredentials.has(id) ? [{ type: "credential", id: `legacy_${id}`, label: id, method: "key" }] : [])
    for (const [id, record] of out) {
      const active = integrationConnections(record.info.integrationID ?? id)[0]
      const key = (connection: ConnectionInfo | undefined) => (connection?.type === "credential" ? connection.id : connection?.type === "env" ? connection.name : undefined)
      const hidden = record.info.activation === "disabled" || (record.sourceConnection && key(record.sourceConnection) !== key(active))
      if (hidden) out.delete(id)
    }
    return out
  }
  /** The key OpenCode would send (packages/core/src/model-resolver.ts): an integration credential replaces settings.apiKey. */
  const effectiveApiKey = (providerID: string) => {
    const record = providers().get(providerID)
    if (!record) return undefined
    const integration = record.info.integrationID ?? providerID
    return legacyCredentials.get(integration) ?? record.info.settings?.apiKey
  }
  const mcp = () => {
    const out = new Map<string, RemoteMcpConfig>()
    const editor: McpEditor = { set: (name, config) => void out.set(name, config), remove: (name) => void out.delete(name) }
    for (const transform of mcpTransforms) transform(editor)
    return out
  }
  const connections = (): ConnectionInfo[] =>
    [...credentials.keys()].map((id) => ({ type: "credential", id, label: "ada", method: "oauth" }))

  const ctx: PluginContext = {
    app: { version: "2.0.26" },
    location: { directory: "/tmp/project" },
    options,
    integration: {
      transform: async (callback) => {
        integrationTransforms.push(callback as never)
        callback({
          update: (_id, update) => {
            const ref = { id: "openwork", name: "openwork" }
            update(ref)
            integrationName = ref.name
          },
          method: { update: (method) => void methods.push(method) },
        })
        return { dispose: async () => {} }
      },
      get: async () => ({ data: { id: "openwork", name: integrationName, connections: connections() } }),
      connection: {
        active: async () => connections()[0],
        resolve: async (connection): Promise<CredentialValue | undefined> =>
          connection.type === "credential" ? credentials.get(connection.id) : undefined,
        status: async (input) => void statuses.push(input.status),
      },
    },
    provider: {
      transform: async (callback) => {
        providerTransforms.push(callback)
        return { dispose: async () => {} }
      },
      reload: async () => {},
    },
    mcp: {
      transform: async (callback) => {
        mcpTransforms.push(callback)
        return { dispose: async () => {} }
      },
      reload: async () => {},
    },
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => void storage.set(key, value),
      remove: async (key) => void storage.delete(key),
    },
    event: {
      subscribe: (input) => ({
        async *[Symbol.asyncIterator]() {
          while (!input?.signal?.aborted) {
            await new Promise<void>((resolve) => {
              events = resolve
              input?.signal?.addEventListener("abort", () => resolve(), { once: true })
            })
            if (input?.signal?.aborted) return
            yield { type: "credential.updated", data: {} }
          }
        },
      }),
    },
  }
  return {
    ctx,
    storage,
    credentials,
    legacyCredentials,
    effectiveApiKey,
    statuses,
    methods,
    providers,
    mcp,
    get integrationName() {
      return integrationName
    },
    emitCredentialEvent: () => events?.(),
  }
}

for (const domain of ["integration", "provider", "mcp", "storage", "event"]) {
  test(`an older host missing ${domain} gets V2 guidance before any registration or network request`, async () => {
    const den = createFakeDen()
    const host = createHost()
    Reflect.deleteProperty(host.ctx, domain)
    await assert.rejects(createPlugin({ fetch: den.fetch }).setup(host.ctx), /needs OpenCode V2.*does not install or upgrade/)
    assert.equal(host.methods.length, 0)
    assert.equal(den.calls.length, 0)
  })
}

function signedIn(): OAuthCredential {
  return {
    type: "oauth",
    methodID: "code",
    access: SESSION_TOKEN,
    refresh: SESSION_TOKEN,
    expires: Date.parse("2026-10-15T00:00:00.000Z"),
    metadata: { apiBaseUrl: API, orgId: ORG_ID, orgName: "Acme", email: "ada@example.test" },
  }
}

async function settle() {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve))
}

test("reads options with safe defaults", () => {
  assert.deepEqual(readOptions({}), { apiBaseUrl: "https://api.openworklabs.com", providers: true, mcp: true, remoteSessions: false, refreshIntervalMs: 300_000 })
  assert.deepEqual(readOptions({ apiBaseUrl: "https://den.example/", providers: false, refreshIntervalMs: 5 }), {
    apiBaseUrl: "https://den.example",
    providers: false,
    mcp: true,
    remoteSessions: false,
    refreshIntervalMs: 60_000,
  })
  assert.equal(readOptions({ apiBaseUrl: "javascript:alert(1)" }).apiBaseUrl, "https://api.openworklabs.com")
  assert.equal(readOptions({ remoteSessions: "true" }).remoteSessions, false)
  assert.equal(readOptions({ remoteSessions: true }).remoteSessions, true)
  assert.equal(readOptions({ label: "  Example computer  " }).label, "Example computer")
})

test("signed out: registers the OpenWork Cloud sign-in and injects nothing", async () => {
  const den = createFakeDen()
  const host = createHost({ apiBaseUrl: API })
  const cleanup = await createPlugin({ fetch: den.fetch }).setup(host.ctx)
  await settle()
  assert.equal(host.integrationName, "OpenWork Cloud")
  assert.deepEqual(host.methods.map((method) => method.method.id), ["browser", "code"])
  assert.equal(host.providers().size, 0)
  assert.equal(host.mcp().size, 0)
  assert.deepEqual(den.calls, [], "no Den traffic while signed out")
  await cleanup?.()
})

test("signed in: injects the gateway providers with the gateway key and the OpenWork MCP servers", async () => {
  const den = createFakeDen()
  const host = createHost({ apiBaseUrl: API })
  host.credentials.set("cred_1", signedIn())
  const cleanup = await createPlugin({ fetch: den.fetch }).setup(host.ctx)
  await settle()

  const provider = host.providers().get(PROVIDER_ID)
  assert.ok(provider, "gateway provider injected and available")
  assert.equal(host.effectiveApiKey(PROVIDER_ID), GATEWAY_KEY)
  assert.equal(provider.models.length, 1)

  const servers = host.mcp()
  assert.deepEqual([...servers.keys()].map((name) => name.replace(/-[0-9a-f]{6}$/, "-<hash>")), ["openwork-cloud", "openwork-direct-slack-<hash>"])
  assert.deepEqual(servers.get("openwork-cloud")?.headers, { Authorization: `Bearer ${MCP_TOKEN}` })

  assert.ok(host.storage.has("inventory"), "inventory cached for the next start")
  await cleanup?.()
})

test("an old desktop key OpenCode imported under the same provider id never replaces the gateway key", async () => {
  const den = createFakeDen()
  const host = createHost({ apiBaseUrl: API })
  host.credentials.set("cred_1", signedIn())
  host.legacyCredentials.set(PROVIDER_ID, "ow_gw_stale_desktop_key")
  const cleanup = await createPlugin({ fetch: den.fetch }).setup(host.ctx)
  await settle()
  assert.ok(host.providers().has(PROVIDER_ID))
  assert.equal(host.effectiveApiKey(PROVIDER_ID), GATEWAY_KEY)
  await cleanup?.()
})

test("a second load within 30s reuses the cache instead of calling Den again", async () => {
  const den = createFakeDen()
  const host = createHost({ apiBaseUrl: API })
  host.credentials.set("cred_1", signedIn())
  const first = await createPlugin({ fetch: den.fetch }).setup(host.ctx)
  await settle()
  const calls = den.calls.length
  const second = await createPlugin({ fetch: den.fetch }).setup(host.ctx)
  await settle()
  assert.equal(den.calls.length, calls)
  await first?.()
  await second?.()
})

test("starts from the cache before any network call", async () => {
  const den = createFakeDen()
  const host = createHost({ apiBaseUrl: API })
  host.credentials.set("cred_1", signedIn())
  const warm = await createPlugin({ fetch: den.fetch }).setup(host.ctx)
  await settle()
  await warm?.()

  // Den is now unreachable: the cached inventory is still published.
  const offline = createHost({ apiBaseUrl: API })
  offline.credentials.set("cred_1", signedIn())
  for (const [key, value] of host.storage) offline.storage.set(key, value)
  const cleanup = await createPlugin({ fetch: async () => { throw new TypeError("fetch failed") } }).setup(offline.ctx)
  assert.ok(offline.providers().has(PROVIDER_ID), "published synchronously during setup")
  await settle()
  assert.ok(offline.providers().has(PROVIDER_ID), "kept while offline")
  await cleanup?.()
})

test("after switching accounts, the previous account's cached key and MCP token are never published", async () => {
  const den = createFakeDen()
  const host = createHost({ apiBaseUrl: API })
  host.credentials.set("cred_1", signedIn())
  const warm = await createPlugin({ fetch: den.fetch }).setup(host.ctx)
  await settle()
  await warm?.()
  assert.ok(host.storage.has("inventory"))

  // Another account signed in while OpenCode was closed, and OpenWork is unreachable now.
  const switched = createHost({ apiBaseUrl: API })
  for (const [key, value] of host.storage) switched.storage.set(key, value)
  switched.credentials.set("cred_2", { ...signedIn(), access: "den_session_token_other", refresh: "den_session_token_other" })
  const cleanup = await createPlugin({ fetch: async () => { throw new TypeError("fetch failed") } }).setup(switched.ctx)
  assert.equal(switched.providers().size, 0, "nothing published during setup")
  assert.equal(switched.mcp().size, 0)
  await settle()
  assert.equal(switched.providers().size, 0, "nothing published after the failed refresh either")
  assert.equal(switched.mcp().size, 0)
  await cleanup?.()
})

test("a session Den rejects asks the member to sign in again and withdraws everything", async () => {
  const den = createFakeDen()
  den.sessionValid = false
  const host = createHost({ apiBaseUrl: API })
  host.credentials.set("cred_1", signedIn())
  const cleanup = await createPlugin({ fetch: den.fetch }).setup(host.ctx)
  await settle()
  assert.equal(host.providers().size, 0)
  assert.equal(host.mcp().size, 0)
  assert.equal(host.statuses.at(-1)?.status, "needs_auth")
  await cleanup?.()
})

test("signing out ends the Den session and removes the injected providers and servers", async () => {
  const den = createFakeDen()
  const host = createHost({ apiBaseUrl: API })
  host.credentials.set("cred_1", signedIn())
  const cleanup = await createPlugin({ fetch: den.fetch }).setup(host.ctx)
  await settle()
  assert.equal(host.providers().size, 1)

  // `opencode auth logout openwork` deletes the credential, then OpenCode emits credential.updated.
  host.credentials.delete("cred_1")
  host.emitCredentialEvent()
  await settle()
  assert.deepEqual(den.signedOut, [`Bearer ${SESSION_TOKEN}`])
  assert.equal(host.providers().size, 0)
  assert.equal(host.mcp().size, 0)
  assert.equal(host.storage.has("inventory"), false)
  await cleanup?.()
})

test("providers: false and mcp: false turn off either half", async () => {
  const den = createFakeDen()
  const host = createHost({ apiBaseUrl: API, providers: false })
  host.credentials.set("cred_1", signedIn())
  const cleanup = await createPlugin({ fetch: den.fetch }).setup(host.ctx)
  await settle()
  assert.equal(host.providers().size, 0)
  assert.ok(host.mcp().has("openwork-cloud"))
  assert.ok(!den.calls.some((call) => call.includes("inference-providers")))
  await cleanup?.()
})

function liveDen() {
  const den = createFakeDen()
  let empty = false
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  let cancelled = 0
  let inventories = 0
  const fetcher: Fetch = async (url, init) => {
    if (url.endsWith("/inventory/events")) {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller) }, cancel() { cancelled++ } }), { headers: { "content-type": "text/event-stream" } })
    }
    if (url.includes("inference-providers?")) {
      inventories++
      if (empty) return Response.json({ inferenceProviders: [] })
    }
    return den.fetch(url, init)
  }
  return {
    den, fetch: fetcher, streams,
    get inventories() { return inventories },
    get cancelled() { return cancelled },
    set empty(value: boolean) { empty = value },
    emit() { streams.at(-1)?.enqueue(new TextEncoder().encode('event: inventory.changed\ndata: {"revision":"next"}\n\n')) },
  }
}

test("standalone live events bypass the fresh cache, withdraw removed models, and no-op identical inventories", async () => {
  const den = liveDen()
  const host = createHost({ apiBaseUrl: API })
  host.credentials.set("cred_1", signedIn())
  let reloads = 0
  Reflect.set(host.ctx.provider, "reload", async () => { reloads++ })
  const cleanup = await createPlugin({ fetch: den.fetch }).setup(host.ctx)
  await settle()
  assert.equal(den.streams.length, 1)
  assert.equal(host.providers().size, 1)
  assert.ok(host.mcp().size, "MCP still runs alongside the stream")
  const previous = reloads
  const fetched = den.inventories
  den.emit()
  await settle()
  assert.ok(den.inventories > fetched, "live event bypassed the 30-second cache")
  assert.equal(reloads, previous, "identical inventory did not invalidate models")
  den.empty = true
  den.emit()
  await settle()
  assert.equal(host.providers().size, 0)
  await cleanup?.()
  assert.equal(den.cancelled, 1)
})

test("provider reload failure is retried for the same fingerprint", async () => {
  const den = liveDen()
  const host = createHost({ apiBaseUrl: API })
  host.credentials.set("cred_1", signedIn())
  let attempts = 0
  Reflect.set(host.ctx.provider, "reload", async () => { if (++attempts === 1) throw new Error("transient reload") })
  const cleanup = await createPlugin({ fetch: den.fetch }).setup(host.ctx)
  await settle()
  den.emit()
  await settle()
  assert.ok(attempts >= 2)
  await cleanup?.()
})

test("desktop bridge accepts only literal loopback and never follows redirects or persists Den tokens", async () => {
  for (const value of ["http://example.test/session", "https://127.0.0.1/session", "http://localhost/session", "http://user@127.0.0.1/session"]) assert.equal(isDesktopSessionEndpoint(value), false)
  assert.equal(isDesktopSessionEndpoint("http://127.0.0.1:1234/session"), true)
  let calls = 0
  const check = await checkDesktopSession(async (_url, init) => {
    calls++
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer process-capability")
    assert.equal(init?.redirect, "error")
    return Response.json({ apiBaseUrl: API, identity: "a".repeat(64), orgId: ORG_ID,
      inferenceOrigin: "http://127.0.0.1:1234", inferenceKey: `ow_local_${"b".repeat(64)}` })
  }, "http://127.0.0.1:1234/session", "process-capability")
  assert.equal(calls, 1)
  assert.equal(check.kind === "session" ? check.value.identity : null, "a".repeat(64))
  assert.ok(!JSON.stringify(check).includes(SESSION_TOKEN))
})

test("desktop session check: only an explicit 2xx null is a sign-out; every failure is unknown", async () => {
  const endpoint = "http://127.0.0.1:1234/session"
  const kind = async (fetcher: Fetch, capability: string | undefined = "capability") =>
    (await checkDesktopSession(fetcher, endpoint, capability)).kind
  assert.equal(await kind(async () => Response.json(null)), "signed_out")
  assert.equal(await kind(async () => Response.json(null, { status: 500 })), "unknown")
  assert.equal(await kind(async () => Response.json(null, { status: 401 })), "unknown")
  assert.equal(await kind(async () => new Response("<html>", { status: 200 })), "unknown")
  assert.equal(await kind(async () => Response.json({ apiBaseUrl: API, token: SESSION_TOKEN, orgId: ORG_ID })), "unknown")
  assert.equal(await kind(async () => { throw new TypeError("fetch failed") }), "unknown")
  assert.equal(await kind(async () => { throw new DOMException("The operation timed out.", "TimeoutError") }), "unknown")
  // No capability and no process broker: nothing answered, so nothing is known.
  assert.equal(await kind(async () => assert.fail("no direct fetch without a capability"), undefined), "unknown")
  assert.equal((await checkDesktopSession(async () => Response.json(null), "http://example.test/session", "capability")).kind, "unknown")
})

test("desktop provider-only mode reacts to local org changes and sign-out without inventory polling", async () => {
  const den = liveDen()
  const endpoint = "http://127.0.0.1:1234/session"
  let session: DenSession | null = { apiBaseUrl: API, token: SESSION_TOKEN, orgId: ORG_ID }
  const host = createHost({ desktopSession: endpoint })
  for (const key of ["integration", "mcp", "event"]) Reflect.deleteProperty(host.ctx, key)
  const cleanup = await createDesktopProviderPlugin({
    capability: () => "capability", sessionIntervalMs: 5,
    fetch: async (url, init) => url === endpoint ? Response.json(session) : den.fetch(url, init),
  }).setup(host.ctx)
  await delay(20)
  await settle()
  assert.equal(host.providers().size, 1)
  assert.equal(host.methods.length, 0)
  assert.ok(!den.den.calls.some(call => call.includes("mcp")))
  const fetched = den.inventories
  const cached = JSON.stringify([...host.storage])
  assert.ok(!cached.includes(SESSION_TOKEN))
  assert.ok(!cached.includes("capability"))
  await delay(20)
  assert.equal(den.inventories, fetched, "local session polling did not poll gateway inventory")
  session = { apiBaseUrl: API, token: SESSION_TOKEN, orgId: "org_other" }
  await delay(20)
  await settle()
  assert.ok(den.inventories > fetched, "same-token org switch invalidated the cache")
  assert.ok(den.cancelled >= 1)
  session = null
  await delay(20)
  await settle()
  assert.equal(host.providers().size, 0)
  assert.equal(host.storage.has("desktop/provider-inventory"), false)
  await cleanup?.()
})

test("a credential event fences a late old-account inventory even when fetch ignores cancellation", async () => {
  const den = createFakeDen()
  const host = createHost({ apiBaseUrl: API, mcp: false })
  host.credentials.set("cred_1", signedIn())
  let release: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { release = resolve })
  let requested = false
  const cleanup = await createPlugin({ fetch: async (url, init) => {
    if (url.includes("inference-providers?")) { requested = true; await waiting }
    return den.fetch(url, init)
  } }).setup(host.ctx)
  await settle()
  assert.equal(requested, true)
  host.credentials.clear()
  host.emitCredentialEvent()
  await settle()
  assert.equal(host.providers().size, 0)
  release?.()
  await settle()
  assert.equal(host.providers().size, 0)
  assert.equal(host.storage.has("inventory"), false)
  await cleanup?.()
})

test("desktop sign-out fences and cancels an in-flight inventory response", async () => {
  const den = createFakeDen()
  const endpoint = "http://127.0.0.1:1234/session"
  let session: DenSession | null = { apiBaseUrl: API, token: SESSION_TOKEN, orgId: ORG_ID }
  const host = createHost({ desktopSession: endpoint })
  let release: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { release = resolve })
  let requestSignal: AbortSignal | null | undefined
  const cleanup = await createDesktopProviderPlugin({
    capability: () => "capability", sessionIntervalMs: 5,
    fetch: async (url, init) => {
      if (url === endpoint) return Response.json(session)
      if (url.includes("inference-providers?")) { requestSignal = init?.signal; await waiting }
      return den.fetch(url, init)
    },
  }).setup(host.ctx)
  await delay(10)
  session = null
  await delay(15)
  assert.equal(requestSignal?.aborted, true)
  release?.()
  await settle()
  assert.equal(host.providers().size, 0)
  assert.equal(host.storage.has("desktop/provider-inventory"), false)
  await cleanup?.()
})

type SessionFailure = "stall" | "throw" | "500" | "invalid-json" | "invalid-shape"

/**
 * A desktop Location whose local /session check can fail on demand, as it does
 * when the server is slow (>1.5 s), restarting, or answering garbage. Records
 * every provider reload and what a model lookup would find at each failed check.
 */
async function desktopWithFlakySession(options: { sessionIntervalMs?: number } = {}) {
  const den = liveDen()
  const endpoint = "http://127.0.0.1:1234/session"
  const host = createHost({ desktopSession: endpoint })
  const state: { session: DenSession | null; failure: SessionFailure | null } = {
    session: { apiBaseUrl: API, token: SESSION_TOKEN, orgId: ORG_ID }, failure: null,
  }
  const log: string[] = []
  let failedChecks = 0
  const modelVisible: boolean[] = []
  Reflect.set(host.ctx.provider, "reload", async () => { log.push(`reload:${host.providers().size}`) })
  const findModel = () => host.providers().get(PROVIDER_ID)?.models.some(model => model.id === MODEL_ID) ?? false
  const cleanup = await createDesktopProviderPlugin({
    capability: () => "capability", sessionIntervalMs: options.sessionIntervalMs ?? 5,
    fetch: async (url, init) => {
      if (url === endpoint) {
        const failure = state.failure
        if (!failure) return Response.json(state.session)
        modelVisible.push(findModel())
        try {
          if (failure === "stall") {
            // Never answers; only the plugin's own 1.5 s session timeout ends it.
            return await new Promise<Response>((_, reject) => {
              const signal = init?.signal
              if (!signal) return
              if (signal.aborted) reject(signal.reason)
              signal.addEventListener("abort", () => reject(signal.reason), { once: true })
            })
          }
          if (failure === "throw") throw new TypeError("fetch failed")
          if (failure === "500") return Response.json({ error: "internal_error" }, { status: 500 })
          if (failure === "invalid-json") return new Response("<html>busy</html>", { status: 200 })
          return Response.json({ unexpected: true })
        } finally { failedChecks++ }
      }
      if (url.includes("inference-providers?")) log.push(`inventory:${new Headers(init?.headers).get("x-openwork-org-id")}`)
      return den.fetch(url, init)
    },
  }).setup(host.ctx)
  for (let i = 0; i < 100 && !findModel(); i++) await delay(2)
  await settle()
  assert.ok(findModel(), "signed-in Location published the gateway model")
  return {
    den, host, log, state, modelVisible, findModel, cleanup,
    get failedChecks() { return failedChecks },
    async waitForFailedChecks(count: number, timeoutMs = 5_000) {
      const start = failedChecks
      const deadline = Date.now() + timeoutMs
      while (failedChecks - start < count && Date.now() < deadline) await delay(2)
      assert.ok(failedChecks - start >= count, `expected ${count} failed session checks`)
      await settle()
    },
  }
}

for (const failure of ["stall", "throw", "500", "invalid-json", "invalid-shape"] satisfies SessionFailure[]) {
  test(`desktop session check failure (${failure}) keeps providers, cache and stream; no reload`, async () => {
    const flaky = await desktopWithFlakySession()
    try {
      const reloads = flaky.log.filter(entry => entry.startsWith("reload:")).length
      const inventories = flaky.den.inventories
      const streams = flaky.den.streams.length
      const cache = JSON.stringify(flaky.host.storage.get("desktop/provider-inventory"))
      assert.notEqual(cache, undefined)
      flaky.state.failure = failure
      await flaky.waitForFailedChecks(failure === "stall" ? 1 : 3)
      assert.ok(flaky.findModel(), "a model lookup during the failed check still resolves")
      assert.equal(flaky.host.providers().size, 1, "providers stay published while the local check is unknown")
      assert.deepEqual(flaky.log.filter(entry => entry === "reload:0"), [], "never reloaded with an empty provider set")
      assert.equal(JSON.stringify(flaky.host.storage.get("desktop/provider-inventory")), cache, "cache kept")
      flaky.state.failure = null
      await delay(20)
      await settle()
      assert.ok(flaky.findModel())
      assert.equal(flaky.log.filter(entry => entry.startsWith("reload:")).length, reloads, "no spurious provider reload")
      assert.equal(flaky.den.inventories, inventories, "recovery did not refetch inventory")
      assert.equal(flaky.den.streams.length, streams, "the inventory stream was never torn down")
      assert.ok(flaky.modelVisible.every(Boolean), "every model lookup inside the failure window found the model")
    } finally { await flaky.cleanup?.() }
  })
}

test("desktop: many consecutive session check failures, then success, never drop providers; real changes still fence", async () => {
  const flaky = await desktopWithFlakySession()
  try {
    const reloads = flaky.log.filter(entry => entry.startsWith("reload:")).length
    for (const failure of ["throw", "500", "invalid-json", "throw"] satisfies SessionFailure[]) {
      flaky.state.failure = failure
      await flaky.waitForFailedChecks(5)
      assert.ok(flaky.findModel(), `model still resolvable after repeated ${failure}`)
    }
    flaky.state.failure = null
    await delay(20)
    await settle()
    assert.ok(flaky.modelVisible.length >= 20)
    assert.ok(flaky.modelVisible.every(Boolean), "providers never disappeared")
    assert.equal(flaky.log.filter(entry => entry.startsWith("reload:")).length, reloads, "no reload across the whole outage")

    // An org switch after an outage still drops the old org's providers before
    // any request for the new org's inventory.
    flaky.log.length = 0
    flaky.state.session = { apiBaseUrl: API, token: SESSION_TOKEN, orgId: "org_other" }
    for (let i = 0; i < 100 && !flaky.log.includes("inventory:org_other"); i++) await delay(2)
    await settle()
    const fenced = flaky.log.indexOf("reload:0")
    const requested = flaky.log.indexOf("inventory:org_other")
    assert.ok(fenced >= 0 && requested > fenced, `old providers fenced before the new org request: ${flaky.log.join(", ")}`)

    // A failure after the switch keeps the new org's providers.
    flaky.state.failure = "throw"
    await flaky.waitForFailedChecks(3)
    assert.ok(flaky.findModel())

    // An explicit 200 null is a real sign-out: providers and cache go.
    flaky.state.failure = null
    flaky.state.session = null
    for (let i = 0; i < 100 && flaky.host.providers().size; i++) await delay(2)
    await settle()
    assert.equal(flaky.host.providers().size, 0)
    assert.equal(flaky.host.storage.has("desktop/provider-inventory"), false)
  } finally { await flaky.cleanup?.() }
})

test("desktop inventory stream reconnect during a failed session check keeps the current session", async () => {
  // Slow timer: the stream's own reconnect is what asks for the session here.
  const flaky = await desktopWithFlakySession({ sessionIntervalMs: 60_000 })
  try {
    assert.equal(flaky.den.streams.length, 1)
    flaky.state.failure = "throw"
    flaky.den.streams[0]?.close()
    for (let i = 0; i < 400 && flaky.den.streams.length < 2; i++) await delay(10)
    assert.ok(flaky.failedChecks >= 1, "reconnect re-checked the local session")
    assert.equal(flaky.den.streams.length, 2, "reconnected with the retained session instead of giving up")
    await settle()
    assert.ok(flaky.findModel())
    assert.deepEqual(flaky.log.filter(entry => entry === "reload:0"), [])
  } finally { await flaky.cleanup?.() }
})

test("desktop event inventory failures converge with bounded retries while the stream stays open", async () => {
  const den = liveDen()
  const endpoint = "http://127.0.0.1:1234/session"
  const host = createHost({ desktopSession: endpoint })
  let failures = 0
  let attempts = 0
  const cleanup = await createDesktopProviderPlugin({
    capability: () => "capability", retryMs: 5,
    fetch: async (url, init) => {
      if (url === endpoint) return Response.json({ apiBaseUrl: API, token: SESSION_TOKEN, orgId: ORG_ID })
      if (url.includes("inference-providers?")) {
        attempts++
        if (failures-- > 0) throw new Error("temporary inventory outage")
      }
      return den.fetch(url, init)
    },
  }).setup(host.ctx)
  await settle()
  assert.equal(host.providers().size, 1)
  const previous = attempts
  failures = 2
  den.empty = true
  den.emit()
  await settle()
  assert.equal(host.providers().size, 1, "keeps same-account inventory during outage")
  for (let i = 0; i < 100 && host.providers().size; i++) await delay(2)
  assert.equal(host.providers().size, 0)
  assert.equal(attempts, previous + 3)
  assert.equal(den.streams.length, 1, "retry did not need a new event/reconnect")
  const converged = attempts
  await delay(40)
  assert.equal(attempts, converged, "successful reconciliation stopped inventory retries")
  failures = 100
  den.emit()
  await settle()
  const stopped = attempts
  await cleanup?.()
  await delay(40)
  assert.equal(attempts, stopped, "unload cancelled the scheduled retry")
})

test("standalone event inventory failure retries before the periodic timer without another revision", async () => {
  const den = liveDen()
  const host = createHost({ apiBaseUrl: API })
  host.credentials.set("cred_1", signedIn())
  let failures = 0
  let attempts = 0
  const cleanup = await createPlugin({ retryMs: 5, fetch: async (url, init) => {
    if (url.includes("inference-providers?")) {
      attempts++
      if (failures-- > 0) throw new Error("temporary inventory outage")
    }
    return den.fetch(url, init)
  } }).setup(host.ctx)
  await settle()
  const previous = attempts
  failures = 1
  den.empty = true
  den.emit()
  await settle()
  for (let i = 0; i < 100 && host.providers().size; i++) await delay(2)
  assert.equal(host.providers().size, 0)
  assert.equal(attempts, previous + 2)
  assert.equal(den.streams.length, 1)
  const converged = attempts
  await delay(30)
  assert.equal(attempts, converged)
  failures = 100
  den.emit()
  await settle()
  host.credentials.clear()
  host.emitCredentialEvent()
  await settle()
  const stopped = attempts
  await delay(30)
  assert.equal(attempts, stopped, "sign-out cancelled the old-account retry")
  await cleanup?.()
})

test("five desktop Locations share one session stream, fan out changes, and release independently", async () => {
  const den = liveDen()
  const endpoint = "http://127.0.0.1:1234/session"
  const hosts = Array.from({ length: 5 }, () => createHost({ desktopSession: endpoint }))
  const plugin = createDesktopProviderPlugin({
    capability: () => "capability",
    fetch: async (url, init) => url === endpoint
      ? Response.json({ apiBaseUrl: API, token: SESSION_TOKEN, orgId: ORG_ID }) : den.fetch(url, init),
  })
  const cleanups = await Promise.all(hosts.map(host => plugin.setup(host.ctx)))
  await settle()
  assert.equal(den.streams.length, 1)
  assert.ok(hosts.every(host => host.providers().size === 1))
  den.empty = true
  den.emit()
  await settle()
  assert.ok(hosts.every(host => host.providers().size === 0), "every Location received the change")
  await cleanups[0]?.()
  assert.equal(den.cancelled, 0, "first owner unloading did not abort other Locations")
  den.empty = false
  den.emit()
  await settle()
  assert.ok(hosts.slice(1).every(host => host.providers().size === 1))
  for (const cleanup of cleanups.slice(1)) await cleanup?.()
  assert.equal(den.cancelled, 1, "last reference closed the stream")
})

test("five desktop Locations share one local session poll, all receive changes, and release independently", async () => {
  const den = liveDen()
  const endpoint = "http://127.0.0.1:1234/session"
  let session: DenSession | null = { apiBaseUrl: API, token: SESSION_TOKEN, orgId: ORG_ID }
  let checks = 0
  const hosts = Array.from({ length: 5 }, () => createHost({ desktopSession: endpoint }))
  const plugin = createDesktopProviderPlugin({
    capability: () => "capability", sessionIntervalMs: 25,
    fetch: async (url, init) => {
      if (url !== endpoint) return den.fetch(url, init)
      checks++
      return Response.json(session)
    },
  })
  const cleanups = await Promise.all(hosts.map(host => plugin.setup(host.ctx)))
  try {
    await settle()
    // One startup check for all five, plus the shared inventory stream's own
    // session lookup when it opens. Unshared, startup alone was five.
    assert.ok(checks <= 2, `five Locations starting together shared their session check, got ${checks}`)
    assert.ok(hosts.every(host => host.providers().size === 1))
    const before = checks
    await delay(250)
    // One poll at 25 ms is ~10 checks; five independent Locations would be ~50.
    assert.ok(checks - before <= 14, `one shared poll, got ${checks - before} checks in 250 ms`)
    assert.ok(checks - before >= 5, "the shared poll keeps running")

    session = null
    for (let i = 0; i < 100 && hosts.some(host => host.providers().size); i++) await delay(5)
    assert.ok(hosts.every(host => host.providers().size === 0), "every Location received the sign-out")
    assert.ok(hosts.every(host => !host.storage.has("desktop/provider-inventory")))

    session = { apiBaseUrl: API, token: SESSION_TOKEN, orgId: ORG_ID }
    for (let i = 0; i < 100 && hosts.some(host => !host.providers().size); i++) await delay(5)
    assert.ok(hosts.every(host => host.providers().size === 1), "every Location received the sign-in")

    for (const cleanup of cleanups.slice(0, 4)) await cleanup?.()
    const remaining = checks
    await delay(100)
    assert.ok(checks > remaining, "the last Location keeps polling after the others unload")
    session = null
    for (let i = 0; i < 100 && hosts[4]?.providers().size; i++) await delay(5)
    assert.equal(hosts[4]?.providers().size, 0)
    assert.ok(hosts.slice(0, 4).every(host => host.providers().size === 1), "unloaded Locations no longer receive checks")
    await cleanups[4]?.()
    const stopped = checks
    await delay(100)
    assert.equal(checks, stopped, "the last Location unloading stopped the poll")
  } finally { for (const cleanup of cleanups) await cleanup?.() }
})

test("desktop warm offline cache rebinds public catalogs to a new engine port/key without persisting inference credentials", async () => {
  const identity = "a".repeat(64)
  const firstOrigin = "http://127.0.0.1:1234"
  const nextOrigin = "http://127.0.0.1:5678"
  const firstKey = `ow_local_${"b".repeat(64)}`
  const nextKey = `ow_local_${"c".repeat(64)}`
  const make = (origin: string, key: string, offline: boolean) => {
    const endpoint = `${origin}/session`
    return createDesktopProviderPluginSource({ capability: () => "inventory-capability", retryMs: 60_000, fetch: async (url, init) => {
      assert.equal(new URL(url).origin, origin, "no direct Gateway/Den inference credential fetches in the engine")
      if (url === endpoint) return Response.json({ apiBaseUrl: API, identity, orgId: ORG_ID, inferenceOrigin: origin, inferenceKey: key })
      assert.equal(new Headers(init?.headers).get("x-openwork-provider-identity"), identity)
      if (offline) throw new Error("inventory unavailable")
      if (url.endsWith("/inventory/events")) return Response.json({ error: "feature_disabled" }, { status: 404 })
      if (url.endsWith("/connect")) return Response.json({ inferenceProvider: { ...gatewaySummary(), apiKey: "ow_local_catalog" } })
      return Response.json({ inferenceProviders: [gatewaySummary()] })
    } })
  }
  const one = createHost({ desktopSession: `${firstOrigin}/session` })
  const stopOne = await make(firstOrigin, firstKey, false).setup(one.ctx)
  await settle()
  assert.equal(one.providers().get(PROVIDER_ID)?.info.settings?.apiKey, firstKey)
  assert.equal(one.providers().get(PROVIDER_ID)?.info.settings?.baseURL, `${firstOrigin}/api/v1/providers/${PROVIDER_ID}`)
  const portable = JSON.stringify([...one.storage])
  assert.ok(portable.includes("ow_local_catalog"))
  for (const forbidden of [GATEWAY_KEY, SESSION_TOKEN, firstKey, firstOrigin, "inventory-capability"]) assert.ok(!portable.includes(forbidden), forbidden)
  await stopOne?.()
  const two = createHost({ desktopSession: `${nextOrigin}/session` })
  for (const [key, value] of one.storage) two.storage.set(key, value)
  const stopTwo = await make(nextOrigin, nextKey, true).setup(two.ctx)
  await settle()
  assert.equal(two.providers().get(PROVIDER_ID)?.info.settings?.apiKey, nextKey)
  assert.equal(two.providers().get(PROVIDER_ID)?.info.settings?.baseURL, `${nextOrigin}/api/v1/providers/${PROVIDER_ID}`)
  assert.ok(!JSON.stringify([...two.storage]).includes(nextKey))
  await stopTwo?.()
})

test("five standalone Locations share a stream and one account change cannot abort the others", async () => {
  const den = liveDen()
  const hosts = Array.from({ length: 5 }, () => createHost({ apiBaseUrl: API }))
  for (const host of hosts) host.credentials.set("cred_1", signedIn())
  const plugin = createPlugin({ fetch: den.fetch })
  const cleanups = await Promise.all(hosts.map(host => plugin.setup(host.ctx)))
  await settle()
  assert.equal(den.streams.length, 1)
  assert.ok(hosts.every(host => host.providers().size === 1))
  hosts[0]?.credentials.clear()
  hosts[0]?.emitCredentialEvent()
  await settle()
  assert.equal(den.cancelled, 0)
  den.empty = true
  den.emit()
  await settle()
  assert.ok(hosts.every(host => host.providers().size === 0))
  for (const cleanup of cleanups) await cleanup?.()
  assert.equal(den.cancelled, 1)
})

for (const desktop of [false, true]) {
  test(`${desktop ? "desktop" : "standalone"} whole-inventory 403 withdraws providers and cached credentials`, async () => {
    const den = liveDen()
    const endpoint = "http://127.0.0.1:1234/session"
    const host = createHost(desktop ? { desktopSession: endpoint } : { apiBaseUrl: API })
    host.credentials.set("cred_1", signedIn())
    let denied = false
    const fetcher: Fetch = async (url, init) => {
      if (url === endpoint) return Response.json({ apiBaseUrl: API, token: SESSION_TOKEN, orgId: ORG_ID })
      if (denied && url.includes("inference-providers?")) return Response.json({ error: "forbidden" }, { status: 403 })
      return den.fetch(url, init)
    }
    const plugin = desktop ? createDesktopProviderPlugin({ fetch: fetcher, capability: () => "capability" }) : createPlugin({ fetch: fetcher })
    const cleanup = await plugin.setup(host.ctx)
    await settle()
    assert.equal(host.providers().size, 1)
    denied = true
    den.emit()
    await settle()
    assert.equal(host.providers().size, 0)
    assert.equal(host.storage.has(desktop ? "desktop/provider-inventory" : "inventory"), false)
    assert.equal(host.credentials.size, 1, "does not delete the host's credential")
    assert.equal(den.cancelled, 0, "an inventory-list membership denial must retain the recovery subscription")
    denied = false
    den.streams.at(-1)?.close()
    for (let i = 0; i < 350 && !host.providers().size; i++) await delay(10)
    assert.equal(host.providers().size, 1, "same-token regrant recovers after an inventory-list 403 without restart or new credentials")
    await cleanup?.()
  })

  for (const status of [403, 404]) {
  test(`${desktop ? "desktop" : "standalone"} stream ${status} organization denial fences late inventory, clears Locations, and recovers same-session regrant`, async () => {
    const den = liveDen()
    const endpoint = "http://127.0.0.1:1234/session"
    const hosts = Array.from({ length: 2 }, () => createHost(desktop ? { desktopSession: endpoint } : { apiBaseUrl: API }))
    for (const host of hosts) host.credentials.set("cred_1", signedIn())
    let denied = false
    let block = false
    let release: (() => void) | undefined
    const waiting = new Promise<void>(resolve => { release = resolve })
    const fetcher: Fetch = async (url, init) => {
      if (url === endpoint) return Response.json({ apiBaseUrl: API, token: SESSION_TOKEN, orgId: ORG_ID })
      if (denied && url.endsWith("/inventory/events")) return Response.json({ error: "organization_not_found" }, { status })
      if (block && url.includes("inference-providers?")) await waiting
      return den.fetch(url, init)
    }
    const plugin = desktop ? createDesktopProviderPlugin({ fetch: fetcher, capability: () => "capability" }) : createPlugin({ fetch: fetcher })
    const cleanups = await Promise.all(hosts.map(host => plugin.setup(host.ctx)))
    await settle()
    assert.ok(hosts.every(host => host.providers().size === 1))
    assert.equal(den.streams.length, 1)
    block = true
    den.emit()
    await settle()
    denied = true
    den.streams[0]?.close()
    for (let i = 0; i < 150 && hosts.some(host => host.providers().size); i++) await delay(10)
    assert.ok(hosts.every(host => host.providers().size === 0), "stream auth failure withdrew every Location without another revision")
    release?.()
    await settle()
    assert.ok(hosts.every(host => host.providers().size === 0), "late old-authority fetch cannot republish")
    assert.ok(hosts.every(host => !host.storage.has(desktop ? "desktop/provider-inventory" : "inventory")))
    assert.ok(hosts.every(host => host.credentials.size === 1))
    if (!desktop) {
      // Another provider's credential event does not replace this OpenWork
      // token or restore denied authority. It must not lose the recovery rail.
      for (const host of hosts) host.emitCredentialEvent()
      await settle()
      assert.ok(hosts.every(host => host.providers().size === 0), "unrelated credential events cannot clear the denial fence")
    }
    denied = false
    block = false
    for (let i = 0; i < 350 && hosts.some(host => !host.providers().size); i++) await delay(10)
    assert.ok(hosts.every(host => host.providers().size === 1), "same-token/org regrant recovered without an engine restart or credential event")
    assert.equal(den.streams.length, 2, "one shared subscription reconnected after regrant")
    for (const cleanup of cleanups) await cleanup?.()
  })
  }
}
