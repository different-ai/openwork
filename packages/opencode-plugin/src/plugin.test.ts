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
import { API, createFakeDen, GATEWAY_KEY, MCP_TOKEN, ORG_ID, PROVIDER_ID, SESSION_TOKEN } from "./test-den.ts"

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
  assert.deepEqual(readOptions({}), { apiBaseUrl: "https://api.openworklabs.com", providers: true, mcp: true, refreshIntervalMs: 300_000 })
  assert.deepEqual(readOptions({ apiBaseUrl: "https://den.example/", providers: false, refreshIntervalMs: 5 }), {
    apiBaseUrl: "https://den.example",
    providers: false,
    mcp: true,
    refreshIntervalMs: 60_000,
  })
  assert.equal(readOptions({ apiBaseUrl: "javascript:alert(1)" }).apiBaseUrl, "https://api.openworklabs.com")
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
