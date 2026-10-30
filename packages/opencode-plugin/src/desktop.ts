import { createHash } from "node:crypto"
import { fetchDesktopInventory, fetchDesktopSession } from "./desktop-credential-channel.ts"
import { DenAuthError, isAllowedApiBaseUrl, isRecord, normalizeBaseUrl, type DenSession, type Fetch } from "./den.ts"
import { joinDesktopSessionPoll } from "./desktop-session-poll.ts"
import { subscribeSharedInventory } from "./inventory-events.ts"
import { inventoryRetry } from "./inventory-retry.ts"
import type { Json, PluginDefinition } from "./opencode.ts"
import { parseInventory, readOptions, snapshotFrom, type Inventory } from "./plugin.ts"
import { fetchSharedGatewayInventory, inventoryRequestTicket } from "./inventory-fetch.ts"
import type { ProviderRecord } from "./providers.ts"

const CACHE_KEY = "desktop/provider-inventory"
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** Only a literal loopback endpoint may receive the process capability. No redirects. */
export function isDesktopSessionEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
      && !url.username && !url.password && !url.hash
  } catch { return false }
}

export interface DesktopSession {
  readonly apiBaseUrl: string
  readonly identity: string
  readonly orgId: string | null
  readonly inferenceOrigin: string
  readonly inferenceKey: string
}

// The shared inventory helpers accept a token-shaped identity key. In desktop
// mode this is ONLY an opaque hash, never a Den bearer, and the transport below
// replaces those helper headers with an identity-bound local inventory request.
function inventorySession(value: DesktopSession): DenSession {
  return { apiBaseUrl: value.apiBaseUrl, token: value.identity, orgId: value.orgId }
}

/**
 * The local session check's answer. Only the bridge's explicit answer that no
 * Den session exists is a sign-out. A slow, failed, or malformed check is
 * unknown: it says nothing about the account, so callers keep what they have.
 */
export type SessionCheck =
  | { readonly kind: "session"; readonly value: DesktopSession }
  | { readonly kind: "signed_out" }
  | { readonly kind: "unknown" }

const UNKNOWN: SessionCheck = { kind: "unknown" }
const SIGNED_OUT: SessionCheck = { kind: "signed_out" }

/** signed_out only for a 2xx JSON `null`; non-2xx, bad JSON, bad shape or no response are unknown. */
export async function classifyDesktopSession(response: Response | null, endpoint: string): Promise<SessionCheck> {
  if (!response) return UNKNOWN
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return UNKNOWN
  }
  let value: unknown
  try { value = await response.json() } catch { return UNKNOWN }
  if (value === null) return SIGNED_OUT
  if (!isRecord(value) || typeof value.apiBaseUrl !== "string" || !isAllowedApiBaseUrl(value.apiBaseUrl)
    || "token" in value || typeof value.identity !== "string" || !/^[a-f0-9]{64}$/.test(value.identity)
    || !(value.orgId === null || typeof value.orgId === "string")
    || typeof value.inferenceOrigin !== "string" || value.inferenceOrigin !== new URL(endpoint).origin
    || typeof value.inferenceKey !== "string" || !/^ow_local_[a-f0-9]{64}$/.test(value.inferenceKey)) {
    return UNKNOWN
  }
  return { kind: "session", value: { apiBaseUrl: normalizeBaseUrl(value.apiBaseUrl), identity: value.identity, orgId: value.orgId,
    inferenceOrigin: value.inferenceOrigin, inferenceKey: value.inferenceKey } }
}

/**
 * One local session check. With a capability it calls the loopback endpoint
 * directly; otherwise through the process credential broker. Never throws:
 * timeouts, aborts and network errors are unknown.
 */
export async function checkDesktopSession(fetcher: Fetch, endpoint: string, capability: string | undefined, signal?: AbortSignal): Promise<SessionCheck> {
  if (!isDesktopSessionEndpoint(endpoint)) return UNKNOWN
  try {
    const response = capability
      ? await fetcher(endpoint, {
        headers: { accept: "application/json", authorization: `Bearer ${capability}` },
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500),
      })
      : await fetchDesktopSession(fetcher, endpoint, signal)
    return await classifyDesktopSession(response, endpoint)
  } catch { return UNKNOWN }
}

/** Provider-only host path: never registers login methods, revokes Den sessions, or touches MCP. */
export function createDesktopProviderPlugin(deps: { fetch?: Fetch; now?: () => number; capability?: () => string | undefined; sessionIntervalMs?: number; retryMs?: number } = {}): PluginDefinition {
  const fetcher = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  return {
    id: "openwork",
    async setup(ctx) {
      const endpoint = ctx.options.desktopSession
      const capability = deps.capability?.()
      if (!isDesktopSessionEndpoint(endpoint)) return
      if (typeof ctx.provider?.transform !== "function" || typeof ctx.provider?.reload !== "function" || typeof ctx.storage?.get !== "function") {
        throw new Error("OpenWork provider sync needs OpenCode V2 provider and storage APIs")
      }
      const options = { ...readOptions(ctx.options), mcp: false }
      const inventoryFetch = (source: DesktopSession): Fetch => async (input, init) => {
        const base = normalizeBaseUrl(source.apiBaseUrl)
        if (!input.startsWith(`${base}/`) || (init?.method ?? "GET") !== "GET" || init?.body != null) return new Response(null, { status: 404 })
        const path = input.slice(base.length)
        if (path !== "/v1/inference-providers?scope=usable" && path !== "/v1/inference-providers/inventory/events"
          && !/^\/v1\/inference-providers\/ipr_[a-z0-9_]{1,128}\/connect$/.test(path)) return new Response(null, { status: 404 })
        const signal = init?.signal ?? undefined
        const response = capability
          ? await fetcher(new URL(endpoint).origin + path, {
            method: "GET", redirect: "error", signal,
            headers: { accept: path.endsWith("/inventory/events") ? "text/event-stream" : "application/json",
              authorization: `Bearer ${capability}`, "x-openwork-provider-identity": source.identity },
          })
          : await fetchDesktopInventory(fetcher, endpoint, path, source.identity, signal)
        return response ?? new Response(null, { status: 503 })
      }
      const lifetime = new AbortController()
      let session: DesktopSession | null = null
      let key = ""
      let epoch = 0
      let stream: AbortController | null = null
      let refreshController = new AbortController()
      let providers: readonly ProviderRecord[] = []
      let applied = digest(providers)
      let running: Promise<void> | null = null
      let queued = false
      let inventory: Inventory | null = null
      const retry = inventoryRetry(() => { void refresh() }, deps.retryMs)

      await ctx.provider.transform(editor => {
        for (const provider of providers) editor.add(provider)
      })
      const publish = async (next: readonly ProviderRecord[]) => {
        providers = next
        const fingerprint = digest(next)
        if (fingerprint === applied) return
        await ctx.provider.reload()
        if (providers === next) applied = fingerprint // Failed/stale reloads remain retryable.
      }
      const safeHeaders = (headers: Record<string, string> | undefined) => headers ? Object.fromEntries(Object.entries(headers)
        .filter(([name]) => !["authorization", "x-api-key", "api-key", "x-goog-api-key", "cookie", "host"].includes(name.toLowerCase()))) : undefined
      const records = (value: Inventory | null): readonly ProviderRecord[] => {
        if (!session || value?.gateway?.apiKey !== "ow_local_catalog") return []
        // Cached catalog definitions stay portable/public. Only publication binds
        // them to this engine's current loopback origin and identity-scoped key.
        const source = session
        return snapshotFrom(value, options, { type: "env", name: "openwork-desktop" }).providers.map(provider => {
          const baseURL = `${source.inferenceOrigin}/api/v1/providers/${provider.info.id}`
          return {
            info: { ...provider.info, settings: { ...provider.info.settings, baseURL, apiKey: source.inferenceKey }, headers: safeHeaders(provider.info.headers) },
            models: provider.models.map(model => ({ ...model, settings: { ...model.settings, baseURL, apiKey: source.inferenceKey }, headers: safeHeaders(model.headers) })),
          }
        })
      }
      const revoked = () => {
        epoch++
        retry.reset()
        refreshController.abort()
        refreshController = new AbortController()
        inventory = null
        queued = false
        // Keep the session/stream: membership can return without a new token.
        void ctx.storage.remove(CACHE_KEY).catch(() => {})
        void publish([]).catch(() => {})
      }
      const unauthorized = () => {
        epoch++
        retry.reset()
        refreshController.abort()
        stream?.abort()
        stream = null
        // Keep the rejected identity key so local session checks cannot reopen
        // it. Only a changed handoff (or engine restart) can authorize it again.
        session = null
        inventory = null
        queued = false
        void ctx.storage.remove(CACHE_KEY).catch(() => {})
        void publish([]).catch(() => {})
      }
      const refresh = (): Promise<void> => {
        if (lifetime.signal.aborted || !session) return Promise.resolve()
        if (running) { queued = true; return running }
        retry.cancel()
        const source = session
        const accountKey = key
        const generation = epoch
        const current = () => !lifetime.signal.aborted && generation === epoch
        const ticket = inventoryRequestTicket()
        running = (async () => {
          try {
            // Deliberately no 30s freshness shortcut: every event/reconnect is authoritative.
            const gateway = await fetchSharedGatewayInventory({ fetch: inventoryFetch(source), session: inventorySession(source), scope: "desktop", ticket, signal: refreshController.signal })
            if (!current()) return
            const next: Inventory = { version: 1, connectionKey: accountKey, apiBaseUrl: source.apiBaseUrl, fetchedAt: now(), gateway, mcp: null }
            inventory = next
            // Public definitions + a dummy credential only. Never persist raw
            // reusable credentials or engine-specific origin/ephemeral keys.
            const json: Json = JSON.parse(JSON.stringify(next))
            await ctx.storage.set(CACHE_KEY, json).catch(() => {})
            if (!current()) return
            await publish(records(next))
            if (current()) retry.reset()
          } catch (error) {
            if (!current()) return
            if (error instanceof DenAuthError) {
              if (error.status === 403) revoked()
              else unauthorized()
            } else {
              retry.schedule()
              await publish(records(inventory))
            }
          }
        })().catch(() => {}).finally(() => {
          running = null
          if (queued) { queued = false; void refresh() }
        })
        return running
      }
      // A slow or failed local check is not a sign-out. On unknown, keep the
      // session, providers, cache and stream; the next tick asks again.
      // Inference stays safe: the local bridge re-checks identity per request.
      const applySession = async (check: SessionCheck) => {
        if (lifetime.signal.aborted || check.kind === "unknown") return
        const next = check.kind === "session" ? check.value : null
        const nextKey = next ? digest({ apiBaseUrl: next.apiBaseUrl, identity: next.identity, orgId: next.orgId }) : ""
        if (nextKey === key) {
          if (session) session = next
          // A failed reload is independent of the network subscription and remains retryable.
          await publish(records(inventory)).catch(() => {})
          return
        }
        epoch++
        retry.reset()
        refreshController.abort()
        refreshController = new AbortController()
        stream?.abort()
        stream = null
        session = next
        key = nextKey
        inventory = null
        // Drop stale providers before reading cache or issuing any new-account request.
        await publish([]).catch(() => {})
        if (!next) {
          await ctx.storage.remove(CACHE_KEY).catch(() => {})
          return
        }
        const cached = parseInventory(await ctx.storage.get(CACHE_KEY).catch(() => undefined))
        if (cached?.connectionKey === key && cached.gateway?.apiKey === "ow_local_catalog" && !lifetime.signal.aborted) {
          inventory = cached
          await publish(records(cached)).catch(() => {})
        }
        if (lifetime.signal.aborted) return
        const controller = new AbortController()
        stream = controller
        // Re-resolve the handoff on reconnect, rather than retaining an expired token.
        void subscribeSharedInventory({
          identity: inventorySession(next),
          unauthorized,
          revoked,
          fetch: inventoryFetch(next),
          signal: AbortSignal.any([lifetime.signal, controller.signal]),
          session: async () => {
            await pollSession()
            return controller.signal.aborted || !session ? null : inventorySession(session)
          },
          changed: () => { void refresh() },
        })
        void refresh()
      }
      // Checks are applied one at a time, in order; a burst collapses to the latest.
      let pending: SessionCheck | null = null
      let applying: Promise<void> | null = null
      const receive = (check: SessionCheck) => {
        if (lifetime.signal.aborted) return
        pending = check
        applying ??= (async () => {
          while (pending && !lifetime.signal.aborted) {
            const current = pending
            pending = null
            await applySession(current)
          }
        })().catch(() => {}).finally(() => {
          applying = null
          if (pending) receive(pending)
        })
      }
      // This local-only check detects sign-out/account/org/token changes without
      // polling Den inventory. One poll per process serves every Location.
      const checkNow = joinDesktopSessionPoll(endpoint, capability, {
        check: signal => checkDesktopSession(fetcher, endpoint, capability, signal),
        receive,
        intervalMs: deps.sessionIntervalMs ?? 1000,
        signal: lifetime.signal,
      })
      const pollSession = async () => {
        await checkNow()
        await applying
      }
      void pollSession()
      return () => {
        epoch++
        retry.reset()
        lifetime.abort()
        refreshController.abort()
        stream?.abort()
      }
    },
  }
}

export default createDesktopProviderPlugin()
