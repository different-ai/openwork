import type { ConnectorCheck, ConnectorsDiagnostics, ProviderCheck, ProvidersDiagnostics } from "@openwork/types/den/diagnostics"
import type { GoogleApiCheck } from "../routes/org/google-api-check.js"
import { googleConnectorCheck, slackConnectorCheck, type SlackLiveResult } from "./connector-checks.js"
import type { ConnectorTargets, GoogleConnectorTarget } from "./connectors.js"
import { mapLimited, type EvaluatedProvider } from "./provider-checks.js"

/**
 * Per-replica caches and admission for live diagnostics checks. Live results
 * are kept in memory for CACHE_TTL_MS and reused only while the provider's
 * configuration and credential are unchanged; a durable rate limit allows one
 * live refresh per organization (connectors: per member) per REFRESH_WINDOW_MS
 * across replicas. Reads never wait for a live check.
 */

export const DIAGNOSTICS_CACHE_TTL_MS = 10 * 60_000
export const DIAGNOSTICS_REFRESH_WINDOW_MS = 30_000
const MAX_CACHE_ENTRIES = 2_000
const CONNECTOR_CONCURRENCY = 4

export type DiagnosticsRuntimeDeps = {
  now: () => number
  /** Durable admission: null when admitted, else Retry-After seconds. */
  admit: (key: string, windowMs: number) => Promise<number | null>
  evaluateProviders: (organizationId: string, live: boolean, previousSuccess: ReadonlyMap<string, string>) => Promise<EvaluatedProvider[]>
  loadConnectors: (organizationId: string) => Promise<ConnectorTargets>
  checkSlack: (connectionId: string) => Promise<{ result: SlackLiveResult; version: string }>
  checkGoogle: (organizationId: string, orgMembershipId: string, target: GoogleConnectorTarget) => Promise<GoogleApiCheck[] | null>
  onError?: (scope: string, error: unknown) => void
}

/** Pending, admitted, or Retry-After seconds when another check ran recently. */
export type RefreshAdmission = "started" | "running" | "nothing_to_check" | number

type ProviderCacheEntry = { checkedAt: number; rows: Map<string, { version: string; check: ProviderCheck }> }
type SlackCacheEntry = { checkedAt: number; rows: Map<string, { version: string; result: SlackLiveResult }> }
type GoogleCacheEntry = { checkedAt: number; rows: Map<string, GoogleApiCheck[] | null> }

function remember<K, V>(map: Map<K, V>, key: K, value: V) {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

export function createDiagnosticsRuntime(deps: DiagnosticsRuntimeDeps) {
  const providerCache = new Map<string, ProviderCacheEntry>()
  const providerSuccess = new Map<string, Map<string, string>>()
  const providerRuns = new Map<string, Promise<void>>()
  const slackCache = new Map<string, SlackCacheEntry>()
  const googleCache = new Map<string, GoogleCacheEntry>()
  const connectorRuns = new Map<string, Promise<void>>()

  const fresh = <T extends { checkedAt: number }>(entry: T | undefined) => entry && deps.now() - entry.checkedAt < DIAGNOSTICS_CACHE_TTL_MS ? entry : undefined
  const report = (scope: string) => (error: unknown) => deps.onError?.(scope, error)

  async function admitRun(runs: Map<string, Promise<void>>, key: string, rateKey: string, run: () => Promise<void>): Promise<RefreshAdmission> {
    if (runs.has(key)) return "running"
    const retryAfter = await deps.admit(rateKey, DIAGNOSTICS_REFRESH_WINDOW_MS)
    if (retryAfter !== null) return retryAfter
    if (runs.has(key)) return "running"
    const pending = run().catch(report(rateKey)).finally(() => runs.delete(key))
    runs.set(key, pending)
    return "started"
  }

  // ── Providers ───────────────────────────────────────────────────────────

  function refreshProviders(organizationId: string): Promise<RefreshAdmission> {
    return admitRun(providerRuns, organizationId, `diagnostics:providers:${organizationId}`, async () => {
      const success = providerSuccess.get(organizationId) ?? new Map<string, string>()
      const results = await deps.evaluateProviders(organizationId, true, success)
      const rows = new Map<string, { version: string; check: ProviderCheck }>()
      for (const result of results) {
        if (result.probed) rows.set(result.check.id, { version: result.version, check: result.check })
        if (result.check.lastSuccessAt) success.set(result.check.id, result.check.lastSuccessAt)
      }
      remember(providerSuccess, organizationId, success)
      remember(providerCache, organizationId, { checkedAt: deps.now(), rows })
    })
  }

  /**
   * Stored facts now, merged with the latest live results. With `refresh`, a
   * missing or expired live result starts a background check (rate limited).
   */
  async function providers(organizationId: string, options: { include: (check: ProviderCheck) => boolean; refresh: boolean }): Promise<ProvidersDiagnostics> {
    const stored = await deps.evaluateProviders(organizationId, false, providerSuccess.get(organizationId) ?? new Map())
    const cache = fresh(providerCache.get(organizationId))
    let stale = false
    const items = stored.map((row) => {
      if (!row.probed) return row.check
      const cached = cache?.rows.get(row.check.id)
      if (!cached || cached.version !== row.version) {
        stale = true
        return row.check
      }
      // Live outcome, with today's model count and member counts.
      return { ...cached.check, members: row.check.members, models: { ...cached.check.models, configured: row.check.models.configured } }
    })
    if (options.refresh && stale) await refreshProviders(organizationId).catch(report("providers.refresh"))
    return {
      access: "granted",
      checkedAt: cache ? new Date(cache.checkedAt).toISOString() : null,
      checking: providerRuns.has(organizationId),
      items: items.filter(options.include).slice(0, 100),
    }
  }

  // ── Connectors ──────────────────────────────────────────────────────────

  const memberKey = (organizationId: string, orgMembershipId: string) => `${organizationId}:${orgMembershipId}`

  function refreshConnectors(organizationId: string, orgMembershipId: string, known?: ConnectorTargets): Promise<RefreshAdmission> {
    const key = memberKey(organizationId, orgMembershipId)
    return admitRun(connectorRuns, key, `diagnostics:connectors:${key}`, async () => {
      const targets = known ?? await deps.loadConnectors(organizationId)
      const slack = targets.slack.filter((target) => target.needsLiveCheck)
      const [slackResults, googleResults] = await Promise.all([
        mapLimited(slack, CONNECTOR_CONCURRENCY, async (target) => [target.id, await deps.checkSlack(target.connectionId)] as const),
        mapLimited(targets.google, CONNECTOR_CONCURRENCY, async (target) => [target.id, await deps.checkGoogle(organizationId, orgMembershipId, target)] as const),
      ])
      const checkedAt = deps.now()
      if (slack.length) remember(slackCache, organizationId, { checkedAt, rows: new Map(slackResults) })
      remember(googleCache, key, { checkedAt, rows: new Map(googleResults) })
    })
  }

  async function connectors(organizationId: string, orgMembershipId: string, options: { refresh: boolean }): Promise<ConnectorsDiagnostics & { checking: boolean }> {
    const key = memberKey(organizationId, orgMembershipId)
    const targets = await deps.loadConnectors(organizationId)
    const slack = fresh(slackCache.get(organizationId))
    const google = fresh(googleCache.get(key))
    let stale = false
    const items: ConnectorCheck[] = []
    for (const target of targets.slack) {
      const cached = slack?.rows.get(target.id)
      const live = cached && cached.version === target.version ? { result: cached.result, checkedAt: new Date(slack?.checkedAt ?? 0).toISOString() } : null
      if (target.needsLiveCheck && !live) stale = true
      items.push(slackConnectorCheck({ ...target, live }))
    }
    for (const target of targets.google) {
      const known = google?.rows.has(target.id) ?? false
      if (!known) stale = true
      const live = google && known ? { checks: google.rows.get(target.id) ?? null, checkedAt: new Date(google.checkedAt).toISOString() } : null
      items.push(googleConnectorCheck({ ...target, live }))
    }
    if (options.refresh && stale) await refreshConnectors(organizationId, orgMembershipId, targets).catch(report("connectors.refresh"))
    const times = [slack?.checkedAt, google?.checkedAt].filter((value): value is number => value !== undefined)
    return {
      access: "granted",
      checkedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      items: items.slice(0, 100),
      checking: connectorRuns.has(key),
    }
  }

  async function hasConnectorsToCheck(organizationId: string): Promise<ConnectorTargets | null> {
    const targets = await deps.loadConnectors(organizationId)
    return targets.google.length || targets.slack.some((target) => target.needsLiveCheck) ? targets : null
  }

  return {
    providers,
    connectors,
    /** POST /check: start a live provider check unless one ran recently. */
    async checkProviders(organizationId: string): Promise<RefreshAdmission> {
      return refreshProviders(organizationId)
    },
    /** POST /check: start the caller's connector check unless one ran recently. */
    async checkConnectors(organizationId: string, orgMembershipId: string): Promise<RefreshAdmission> {
      const targets = await hasConnectorsToCheck(organizationId)
      return targets ? refreshConnectors(organizationId, orgMembershipId, targets) : "nothing_to_check"
    },
    /** Test seam: wait for background checks to finish. */
    async settle() {
      await Promise.all([...providerRuns.values(), ...connectorRuns.values()])
    },
  }
}

export type DiagnosticsRuntime = ReturnType<typeof createDiagnosticsRuntime>
