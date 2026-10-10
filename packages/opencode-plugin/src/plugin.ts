/**
 * OpenWork for OpenCode (V2 plugin).
 *
 * - Registers the `openwork` integration: `opencode auth login openwork`
 *   signs the member in to OpenWork Cloud (Den device authorization).
 * - On every load, and every few minutes, fetches the member's AI Gateway
 *   providers (with their gateway key) and MCP connections from Den, caches
 *   them in plugin storage, and injects them with provider/MCP transforms.
 *
 * Transforms only ever read the in-memory snapshot below; they never touch the
 * network and never throw (a throwing transform disables the plugin).
 */
import { createHash } from "node:crypto"
import {
  INTEGRATION_ID,
  INTEGRATION_NAME,
  readCredentialMetadata,
  signInMethods,
} from "./auth.ts"
import { DenAuthError, isAllowedApiBaseUrl, isRecord, normalizeBaseUrl, signOut, type DenSession, type Fetch } from "./den.ts"
import {
  fetchDirectServers,
  mcpServerEntries,
  mcpTokenNeedsRenewal,
  mintMcpToken,
  type DirectServer,
  type McpToken,
} from "./mcp.ts"
import type {
  Cleanup,
  ConnectionInfo,
  Json,
  OAuthCredential,
  PluginContext,
  PluginDefinition,
  RemoteMcpConfig,
} from "./opencode.ts"
import { fetchGatewayInventory, toProviderRecord, type GatewayProvider, type ProviderRecord } from "./providers.ts"
import type { RemoteRunnerController } from "./remote-runner.ts"

export const PLUGIN_ID = "openwork"
export const DEFAULT_API_BASE_URL = "https://api.openworklabs.com"
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000
const MIN_REFRESH_INTERVAL_MS = 60 * 1000
/** Several Locations load the plugin at once; storage is shared, so one fetch serves them all. */
const FRESH_MS = 30 * 1000
const INVENTORY_KEY = "inventory"
const SESSIONS_KEY = "sessions"

export interface PluginOptions {
  readonly apiBaseUrl: string
  readonly providers: boolean
  readonly mcp: boolean
  /** Sign-in alone is not permission to remotely run prompts on this machine. */
  readonly remoteSessions: boolean
  readonly label?: string
  readonly refreshIntervalMs: number
}

export function readOptions(options: Readonly<Record<string, unknown>>): PluginOptions {
  const apiBaseUrl = typeof options.apiBaseUrl === "string" && isAllowedApiBaseUrl(normalizeBaseUrl(options.apiBaseUrl))
    ? normalizeBaseUrl(options.apiBaseUrl)
    : DEFAULT_API_BASE_URL
  const interval = typeof options.refreshIntervalMs === "number" && Number.isFinite(options.refreshIntervalMs)
    ? Math.max(MIN_REFRESH_INTERVAL_MS, options.refreshIntervalMs)
    : DEFAULT_REFRESH_INTERVAL_MS
  return {
    apiBaseUrl,
    providers: options.providers !== false,
    mcp: options.mcp !== false,
    remoteSessions: options.remoteSessions === true,
    ...(typeof options.label === "string" && options.label.trim() ? { label: options.label.trim().slice(0, 120) } : {}),
    refreshIntervalMs: interval,
  }
}

// ---- Cached inventory (plugin storage, shared by every Location) ----

export interface Inventory {
  readonly version: 1
  /** Which signed-in credential produced it: id + token hash. */
  readonly connectionKey: string
  readonly apiBaseUrl: string
  readonly fetchedAt: number
  readonly gateway: { readonly providers: readonly GatewayProvider[]; readonly apiKey: string | null } | null
  readonly mcp: { readonly token: McpToken; readonly servers: readonly DirectServer[] } | null
}

function parseInventory(value: Json | undefined): Inventory | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.connectionKey !== "string" || typeof value.fetchedAt !== "number") {
    return null
  }
  // Written only by this plugin; trust its shape beyond the version marker.
  return value as unknown as Inventory
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function connectionId(connection: ConnectionInfo): string {
  return connection.type === "credential" ? connection.id : connection.name
}

function connectionKey(connection: ConnectionInfo, token: string): string {
  return `${connectionId(connection)}:${hash(token)}`
}

/** The cache belongs to this signed-in account (the token itself may have been renewed since). */
export function belongsTo(inventory: Inventory | null, connection: ConnectionInfo | undefined): Inventory | null {
  if (!inventory || !connection) return null
  return inventory.connectionKey.startsWith(`${connectionId(connection)}:`) ? inventory : null
}

/** What the transforms publish. */
interface Snapshot {
  readonly providers: readonly ProviderRecord[]
  readonly mcp: Readonly<Record<string, RemoteMcpConfig>>
  readonly sourceConnection: ConnectionInfo | undefined
}

const EMPTY: Snapshot = { providers: [], mcp: {}, sourceConnection: undefined }

export function snapshotFrom(inventory: Inventory | null, options: PluginOptions, connection: ConnectionInfo | undefined): Snapshot {
  if (!inventory || !connection) return EMPTY
  const providers = options.providers && inventory.gateway?.apiKey
    ? inventory.gateway.providers.map((provider) => toProviderRecord(provider, inventory.gateway?.apiKey ?? ""))
    : []
  const mcp = options.mcp && inventory.mcp
    ? mcpServerEntries({ apiBaseUrl: inventory.apiBaseUrl, token: inventory.mcp.token.token, servers: inventory.mcp.servers })
    : {}
  return { providers, mcp, sourceConnection: connection }
}

function fingerprint(value: unknown): string {
  return hash(JSON.stringify(value))
}

function readIntegrationConnections(value: unknown): ConnectionInfo[] {
  const info = isRecord(value) && isRecord(value.data) ? value.data : value
  return isRecord(info) && Array.isArray(info.connections) ? (info.connections as ConnectionInfo[]) : []
}

function isCredentialEvent(event: unknown): boolean {
  return isRecord(event) && typeof event.type === "string" && event.type.startsWith("credential.")
}

export function createPlugin(deps: { fetch?: Fetch; now?: () => number } = {}): PluginDefinition {
  const fetcher: Fetch = deps.fetch ?? ((input, init) => fetch(input, init))
  const now = deps.now ?? Date.now

  return {
    id: PLUGIN_ID,
    async setup(ctx: PluginContext): Promise<Cleanup> {
      if (typeof ctx.integration?.transform !== "function"
        || typeof ctx.integration?.connection?.active !== "function"
        || typeof ctx.provider?.transform !== "function"
        || typeof ctx.provider?.reload !== "function"
        || typeof ctx.mcp?.transform !== "function"
        || typeof ctx.mcp?.reload !== "function"
        || typeof ctx.storage?.get !== "function"
        || typeof ctx.event?.subscribe !== "function") {
        throw new Error("OpenWork needs OpenCode V2 with the integration, provider and MCP plugin APIs (tested with 2.0.26). The plugin does not install or upgrade OpenCode.")
      }
      const options = readOptions(ctx.options)
      const remote: { current: RemoteRunnerController | null } = { current: null }
      let remoteLoading: Promise<void> | null = null
      let snapshot: Snapshot = EMPTY
      let applied = { providers: "", mcp: "" }
      let reportedNeedsAuth = false
      let disposed = false

      // 1. Sign-in methods. Registered from constants: nothing here can fail.
      await ctx.integration.transform((editor) => {
        editor.update(INTEGRATION_ID, (integration) => {
          integration.name = INTEGRATION_NAME
        })
        for (const method of signInMethods({ fetcher, apiBaseUrl: () => options.apiBaseUrl, now })) {
          editor.method.update(method)
        }
      })

      // 2. Start from the cache so setup never waits on the network (it blocks the first prompt).
      const initialConnection = await ctx.integration.connection.active(INTEGRATION_ID).catch(() => undefined)
      // Never publish another account's gateway key or MCP token after an account switch.
      const cachedInventory = belongsTo(parseInventory(await ctx.storage.get(INVENTORY_KEY).catch(() => undefined)), initialConnection)
      snapshot = snapshotFrom(cachedInventory, options, initialConnection)
      applied = { providers: fingerprint([snapshot.providers, snapshot.sourceConnection]), mcp: fingerprint(snapshot.mcp) }

      // 3. Transforms publish the current snapshot.
      await ctx.provider.transform((editor) => {
        for (const record of snapshot.providers) {
          // No `sourceConnection`: OpenCode compares it with the connection of the
          // provider's own integration (`openwork-gateway`, which has none), so it
          // would hide every gateway provider. Account switches republish instead.
          editor.add({ info: record.info, models: record.models })
        }
      })
      await ctx.mcp.transform((editor) => {
        for (const [name, config] of Object.entries(snapshot.mcp)) editor.set(name, config)
      })

      const publish = async (next: Snapshot) => {
        snapshot = next
        const providers = fingerprint([next.providers, next.sourceConnection])
        const mcp = fingerprint(next.mcp)
        const reloads: Promise<void>[] = []
        if (providers !== applied.providers) reloads.push(ctx.provider.reload())
        if (mcp !== applied.mcp) reloads.push(ctx.mcp.reload())
        applied = { providers, mcp }
        await Promise.all(reloads)
      }

      const setNeedsAuth = async (connection: ConnectionInfo, message: string | null) => {
        if (message === null && !reportedNeedsAuth) return
        reportedNeedsAuth = message !== null
        await ctx.integration.connection
          .status({
            integrationID: INTEGRATION_ID,
            connection,
            status: message === null ? undefined : { status: "needs_auth", message },
          })
          .catch(() => {})
      }

      /**
       * Ends Den sessions whose OpenCode credential is gone (`opencode auth
       * logout openwork` only deletes the local copy), and remembers the active one.
       */
      const reconcileSessions = async (active: { id: string; token: string; apiBaseUrl: string } | null) => {
        const stored = await ctx.storage.get(SESSIONS_KEY).catch(() => undefined)
        const sessions: Record<string, { token: string; apiBaseUrl: string }> = isRecord(stored)
          ? (stored as Record<string, { token: string; apiBaseUrl: string }>)
          : {}
        const integration = await ctx.integration.get({ integrationID: INTEGRATION_ID }).catch(() => null)
        // Without a readable connection list, never revoke anything.
        if (integration === null) return
        const live = new Set(
          readIntegrationConnections(integration).flatMap((connection) => (connection.type === "credential" ? [connection.id] : [])),
        )
        let changed = false
        for (const [id, session] of Object.entries(sessions)) {
          if (live.has(id)) continue
          await signOut(fetcher, session.apiBaseUrl, session.token)
          delete sessions[id]
          changed = true
        }
        if (active && sessions[active.id]?.token !== active.token) {
          sessions[active.id] = { token: active.token, apiBaseUrl: active.apiBaseUrl }
          changed = true
        }
        if (changed) await ctx.storage.set(SESSIONS_KEY, toJson(sessions)).catch(() => {})
      }

      let running: Promise<void> | null = null
      let queued = false

      const refreshOnce = async () => {
        const connection = await ctx.integration.connection.active(INTEGRATION_ID).catch(() => undefined)
        if (!connection) {
          await reconcileSessions(null)
          await ctx.storage.remove(INVENTORY_KEY).catch(() => {})
          await publish(EMPTY)
          return
        }

        let credential: OAuthCredential
        try {
          const value = await ctx.integration.connection.resolve(connection)
          if (!value || value.type !== "oauth") {
            await publish(EMPTY)
            return
          }
          credential = value
        } catch {
          // `resolve` runs our refresh(); it fails when Den ended the session.
          await setNeedsAuth(connection, "Your OpenWork sign-in expired. Run: opencode auth login openwork")
          await publish(snapshotFrom(null, options, connection))
          return
        }

        const metadata = readCredentialMetadata(credential, options.apiBaseUrl)
        const session: DenSession = { apiBaseUrl: metadata.apiBaseUrl, token: credential.access, orgId: metadata.orgId }
        const key = connectionKey(connection, credential.access)
        if (connection.type === "credential") {
          await reconcileSessions({ id: connection.id, token: credential.access, apiBaseUrl: metadata.apiBaseUrl })
        }

        const cached = parseInventory(await ctx.storage.get(INVENTORY_KEY).catch(() => undefined))
        const sameAccount = cached?.connectionKey === key ? cached : null
        if (sameAccount && now() - sameAccount.fetchedAt < FRESH_MS) {
          await publish(snapshotFrom(sameAccount, options, connection))
          return
        }

        try {
          const [gateway, mcp] = await Promise.all([
            options.providers
              ? fetchGatewayInventory(fetcher, session).then((inventory) => ({ providers: inventory.providers, apiKey: inventory.apiKey }))
              : Promise.resolve(null),
            options.mcp
              ? (async () => {
                  const previous = sameAccount?.mcp?.token ?? null
                  const token = previous && !mcpTokenNeedsRenewal(previous, now()) ? previous : await mintMcpToken(fetcher, session)
                  try {
                    return { token, servers: await fetchDirectServers(fetcher, session.apiBaseUrl, token.token) }
                  } catch {
                    // The index is optional: keep openwork-cloud with the last known direct servers.
                    return { token, servers: sameAccount?.mcp?.servers ?? [] }
                  }
                })()
              : Promise.resolve(null),
          ])
          const inventory: Inventory = {
            version: 1,
            connectionKey: key,
            apiBaseUrl: session.apiBaseUrl,
            fetchedAt: now(),
            gateway,
            mcp,
          }
          await ctx.storage.set(INVENTORY_KEY, toJson(inventory)).catch(() => {})
          await setNeedsAuth(connection, null)
          await publish(snapshotFrom(inventory, options, connection))
        } catch (error) {
          if (error instanceof DenAuthError) {
            await setNeedsAuth(connection, "OpenWork rejected your sign-in. Run: opencode auth login openwork")
            await publish(EMPTY)
            return
          }
          // Offline or Den unavailable: keep what this account last had.
          await publish(snapshotFrom(sameAccount, options, connection))
        }
      }

      const refresh = (): Promise<void> => {
        if (disposed) return Promise.resolve()
        if (running) {
          queued = true
          return running
        }
        running = refreshOnce()
          .catch(() => {})
          .finally(() => {
            running = null
            if (queued && !disposed) {
              queued = false
              void refresh()
            }
          })
        return running
      }

      // 4. Refresh now, on sign-in, sign-out and account switches, and on a timer.
      // Explicit remote approval starts a separate background loop; it never gates a native prompt.
      if (options.remoteSessions) {
        // Keep ordinary Git sparse installs working without the optional shared source package.
        // A missing optional module must never disable sign-in, providers, or MCP.
        remoteLoading = import("./remote-runner.ts").then(async module => {
          if (disposed) return
          if (!module.hasNativeSessionHost(ctx)) throw new Error("native_host_unavailable")
          remote.current = module.createRemoteRunnerController({ ctx, apiBaseUrl: options.apiBaseUrl, label: options.label, fetch: fetcher, now })
          await ctx.storage.set("remoteSessions/status", { status: "enabled", directory: ctx.location.directory })
          if (!disposed) remote.current.start()
        }).catch(async () => {
          if (disposed) return
          const message = "Remote sessions could not start. Use OpenCode 2.0.26 or newer with native session APIs. For Git installs, run sparse-checkout set packages/opencode-plugin packages/remote-sessions and reload. Ordinary OpenWork sign-in, models, and MCP remain available."
          await ctx.storage.set("remoteSessions/status", { status: "unavailable", directory: ctx.location.directory, message }).catch(() => {})
          console.warn(`[OpenWork] ${message}`)
        })
      }
      void refresh()
      const events = new AbortController()
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: events.signal })) {
            if (isCredentialEvent(event)) {
              remote.current?.credentialsChanged()
              void refresh()
            }
          }
        } catch {
          // The stream ends when the plugin unloads.
        }
      })()

      const timer = setInterval(() => void refresh(), options.refreshIntervalMs)
      timer.unref?.()

      return async () => {
        disposed = true
        clearInterval(timer)
        events.abort()
        await remoteLoading
        await remote.current?.close()
      }
    },
  }
}

