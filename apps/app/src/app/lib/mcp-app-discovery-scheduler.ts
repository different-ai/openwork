import { mcpAppResolutionRetryDelayMs } from "./mcp-app-resolution"
import { OpenworkServerError, type OpenworkMcpAppLaunchReference, type OpenworkMcpAppResource } from "./openwork-server"
import type { McpAppOrigin } from "../../components/chat/mcp-app-origin"

// Canonical JSON also keeps equivalent React inputs from restarting discovery.
export function mcpAppDiscoverySignature(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
  }) ?? "null"
}

type Outcome = { app: null } | { error: unknown }
type Scope = { busy: boolean; cached?: { outcome: Outcome; until: number }; manualAfter: number }
type Job = { scope: Scope; start: () => void }

/** Only negative outcomes are shared. A successful resource/lease belongs to one subscriber. */
export function createMcpAppDiscoveryScheduler(now = Date.now) {
  const clients = new WeakMap<object, Map<string, Scope>>()
  const queue = new Set<Job>()
  let active = 0
  const drain = () => {
    for (const job of queue) {
      if (active >= 2) break
      if (job.scope.busy) continue
      queue.delete(job)
      job.start()
    }
  }
  return function schedule(
    origin: McpAppOrigin,
    toolName: string,
    launch: OpenworkMcpAppLaunchReference | null,
    manual: boolean,
    receive: (app: OpenworkMcpAppResource | null) => void,
    fail: (error: unknown) => void,
    credentialRevision = 0,
  ): () => void {
    let scopes = clients.get(origin.client)
    if (!scopes) { scopes = new Map(); clients.set(origin.client, scopes) }
    // Client objects capture endpoint/auth at construction. Never merge clients by URL.
    // Cloud credentials can be replaced behind the same local-server client.
    const key = mcpAppDiscoverySignature([origin.workspaceId, origin.sessionId, origin.engine, origin.readOnly, toolName, launch, credentialRevision])
    const queuedScopes = new Set([...queue].map(job => job.scope))
    for (const [key, scope] of scopes) {
      if (!scope.busy && !queuedScopes.has(scope)
        && (scope.cached?.until ?? 0) <= now() && scope.manualAfter <= now()) scopes.delete(key)
    }
    let scope = scopes.get(key)
    if (!scope) { scope = { busy: false, manualAfter: 0 }; scopes.set(key, scope) }
    const state = scope
    // One explicit bypass per exact scope per second, not one per historical frame.
    const bypass = manual && now() >= state.manualAfter && !state.busy
    if (bypass) { state.cached = undefined; state.manualAfter = now() + 1_000 }
    let cancelled = false
    let timer: number | undefined
    let finish: (() => void) | undefined
    const publish = (outcome: Outcome) => {
      if (cancelled) return
      if ("error" in outcome) fail(outcome.error)
      else receive(null)
    }
    const job: Job = { scope: state, start: () => {
      if (state.cached && state.cached.until > now()) { publish(state.cached.outcome); return }
      active++
      state.busy = true
      let finished = false
      finish = () => {
        if (finished) return
        finished = true
        active--
        state.busy = false
        queueMicrotask(drain)
      }
      const negative = (outcome: Outcome) => {
        state.cached = { outcome, until: now() + 30_000 }
        publish(outcome)
        finish?.()
      }
      const attempt = (index: number) => {
        void origin.client.resolveMcpApp(origin.workspaceId, toolName, launch ?? undefined, origin).then(({ app }) => {
          if (!app) { negative({ app: null }); return }
          // Never retain a successful launch, including when its original view went away.
          if (cancelled) {
            if (app.launchId) void origin.client.releaseMcpApp(origin.workspaceId, app.launchId).catch(() => undefined)
          } else receive(app)
          finish?.()
        }, error => {
          if (cancelled) { finish?.(); return }
          const auth = error instanceof OpenworkServerError && ["mcp_auth_required", "mcp_access_denied"].includes(error.code)
          const delay = auth ? null : mcpAppResolutionRetryDelayMs(error, index)
          if (delay === null) { negative({ error }); return }
          timer = window.setTimeout(() => { timer = undefined; attempt(index + 1) }, delay)
        })
      }
      attempt(0)
    } }
    queue.add(job)
    drain()
    return () => {
      cancelled = true
      queue.delete(job)
      if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; finish?.() }
      // An already dispatched request retains its slot until it settles.
    }
  }
}

export const scheduleMcpAppDiscovery = createMcpAppDiscoveryScheduler()
