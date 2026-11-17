import { z } from "zod"
import type { Config } from "./config.js"

/**
 * Every computer this runner's conversations have, as the providers report them now: the sandbox gateway's
 * (Differently) and the direct provider's (Freestyle), whichever are configured. Nothing here is kept by the runner:
 * a conversation's computer is found again by its key at the provider, so the providers are the only place that
 * knows the whole fleet, and only the runner holds their keys. Den reads this for its admin page.
 *
 * Read only: two list calls at the gateway (sandboxes, pools) and one paged list at the provider. A source that
 * fails is reported as unreachable with a code; the other is still returned. No key, label value or URL is returned.
 */
export type ComputerFleetConfig = Pick<Config, "computer" | "computerGateway">
export type ComputerFleetSandbox = {
  /** The provider's id for the sandbox. */
  id: string
  /** `hc-` and a hash of the conversation's session id: what ties a sandbox to its conversation (Computers.slug). */
  key: string | null
  source: "gateway" | "direct"
  provider: string
  /** The provider's own word: queued, provisioning, starting, running, pausing, paused, stopped, terminating, failed. */
  status: string
  statusReason: string | null
  /** Gateway only: the pool it was placed on and the backend that runs it. */
  pool: string | null
  backend: string | null
  region: string | null
  cpu: number | null
  memoryMb: number | null
  diskGb: number | null
  createdAt: string | null
  /** When the provider last changed the record: for a sandbox mid-step, about when that step began. */
  updatedAt: string | null
  startedAt: string | null
  pausedAt: string | null
  lastActivityAt: string | null
  expiresAt: string | null
  endedAt: string | null
  attempts: number | null
}
export type ComputerFleetPool = { name: string; backend: string | null; region: string | null; enabled: boolean; health: string }
export type ComputerFleetSource = {
  source: "gateway" | "direct"
  provider: string
  status: "ok" | "unreachable" | "unsupported"
  /** A code (`http_503`, `timeout`, `invalid_response`, `unreachable`), never a message. */
  error: string | null
  /** More sandboxes exist than were read. */
  truncated: boolean
  pools: ComputerFleetPool[]
}
export type ComputerFleet = { version: 1; generatedAt: string; sources: ComputerFleetSource[]; sandboxes: ComputerFleetSandbox[] }
export type ComputerFleetDeps = { fetch: typeof fetch; now?: () => Date }

const KIND = "headless-computer"
const SCOPE_LABEL = "openwork.sandbox.scope"
const KEY_LABEL = "openwork.sandbox.key"
const TIMEOUT_MS = 8_000
/** Per source. A fleet past this is reported as truncated, never read without end. */
export const COMPUTER_FLEET_LIMIT = 2_000
const GATEWAY_PAGE = 500
const FREESTYLE_PAGE = 100
const FREESTYLE_URL = "https://api.freestyle.sh"
/** Everything not ended, and failures (an ended failure is how a computer that never started shows up). */
const GATEWAY_STATUSES = "queued,provisioning,running,pausing,paused,stopped,terminating,failed"

const text = z.string().max(2_000).nullish()
const count = z.number().finite().nullish()
const gatewaySandbox = z.object({
  id: z.string().min(1).max(200),
  status: z.string().min(1).max(40),
  statusReason: text,
  pool: text,
  adapter: text,
  region: text,
  resources: z.object({ cpu: count, memoryMiB: count, diskGiB: count }).loose().nullish(),
  labels: z.record(z.string(), z.string()).nullish(),
  createdAt: text,
  updatedAt: text,
  startedAt: text,
  pausedAt: text,
  lastActivityAt: text,
  expiresAt: text,
  endedAt: text,
  attempts: count,
}).loose()
const gatewayPage = z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullish() }).loose()
const gatewayPools = z.object({
  items: z.array(z.object({ pool: z.string().max(200), adapter: text, region: text, enabled: z.boolean(), health: z.string().max(40) }).loose()),
}).loose()
const freestyleVm = z.object({
  id: z.string().min(1).max(200),
  state: z.string().min(1).max(40),
  slug: text,
  resources: z.object({ cpu: count, memory: count, storage: count }).loose().nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  createdAt: text,
  updatedAt: text,
  lastNetworkActivity: text,
}).loose()
const freestylePage = z.object({ vms: z.array(z.unknown()), totalCount: z.number().nullish() }).loose()

class FleetReadError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

async function readJson(deps: ComputerFleetDeps, url: string, apiKey: string): Promise<unknown> {
  let response: Response
  try {
    response = await deps.fetch(url, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    throw new FleetReadError(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "unreachable")
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new FleetReadError(`http_${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new FleetReadError("invalid_response")
  }
}

const orNull = <T>(value: T | null | undefined): T | null => (value === undefined || value === null || value === "" ? null : value)
/** A short provider reason for the page; long ones are cut, since a backend can quote whatever it was sent. */
const reason = (value: string | null | undefined) => (value ? value.slice(0, 300) : null)

async function readGateway(gateway: NonNullable<ComputerFleetConfig["computerGateway"]>, deps: ComputerFleetDeps): Promise<{ source: ComputerFleetSource; sandboxes: ComputerFleetSandbox[] }> {
  const source: ComputerFleetSource = { source: "gateway", provider: gateway.kind, status: "ok", error: null, truncated: false, pools: [] }
  const sandboxes: ComputerFleetSandbox[] = []
  const base = gateway.url.replace(/\/+$/, "")
  try {
    const pools = gatewayPools.safeParse(await readJson(deps, `${base}/v1/capabilities`, gateway.apiKey))
    if (!pools.success) throw new FleetReadError("invalid_response")
    source.pools = pools.data.items.map((pool) => ({ name: pool.pool, backend: orNull(pool.adapter), region: orNull(pool.region), enabled: pool.enabled, health: pool.health }))
    let cursor: string | null = null
    do {
      const query = new URLSearchParams({ status: GATEWAY_STATUSES, limit: String(GATEWAY_PAGE) })
      query.append("label", `kind=${KIND}`)
      if (gateway.scope) query.append("label", `${SCOPE_LABEL}=${gateway.scope}`)
      if (cursor) query.set("cursor", cursor)
      const page = gatewayPage.safeParse(await readJson(deps, `${base}/v1/sandboxes?${query.toString()}`, gateway.apiKey))
      if (!page.success) throw new FleetReadError("invalid_response")
      for (const item of page.data.items) {
        const sandbox = gatewaySandbox.safeParse(item)
        // A record this runner can't read is skipped, not a reason to lose the rest.
        if (!sandbox.success) continue
        if (sandboxes.length >= COMPUTER_FLEET_LIMIT) {
          source.truncated = true
          break
        }
        const value = sandbox.data
        sandboxes.push({
          id: value.id,
          key: orNull(value.labels?.[KEY_LABEL]),
          source: "gateway",
          provider: gateway.kind,
          status: value.status,
          statusReason: reason(value.statusReason),
          pool: orNull(value.pool),
          backend: orNull(value.adapter),
          region: orNull(value.region),
          cpu: orNull(value.resources?.cpu),
          memoryMb: orNull(value.resources?.memoryMiB),
          diskGb: orNull(value.resources?.diskGiB),
          createdAt: orNull(value.createdAt),
          updatedAt: orNull(value.updatedAt),
          startedAt: orNull(value.startedAt),
          pausedAt: orNull(value.pausedAt),
          lastActivityAt: orNull(value.lastActivityAt),
          expiresAt: orNull(value.expiresAt),
          endedAt: orNull(value.endedAt),
          attempts: orNull(value.attempts),
        })
      }
      cursor = source.truncated ? null : orNull(page.data.nextCursor)
    } while (cursor)
  } catch (error) {
    source.status = "unreachable"
    source.error = error instanceof FleetReadError ? error.code : "unreachable"
  }
  return { source, sandboxes }
}

async function readFreestyle(computer: NonNullable<ComputerFleetConfig["computer"]>, deps: ComputerFleetDeps): Promise<{ source: ComputerFleetSource; sandboxes: ComputerFleetSandbox[] }> {
  const source: ComputerFleetSource = { source: "direct", provider: computer.kind, status: "ok", error: null, truncated: false, pools: [] }
  const sandboxes: ComputerFleetSandbox[] = []
  // The account can hold other machines (snapshot builders, other runners): only this runner's computers are asked for.
  const metadata = [`kind:${KIND}`, ...(computer.scope ? [`${SCOPE_LABEL}:${computer.scope}`] : [])].join(",")
  try {
    for (let offset = 0; ; offset += FREESTYLE_PAGE) {
      const query = new URLSearchParams({ metadata, limit: String(FREESTYLE_PAGE), offset: String(offset) })
      const page = freestylePage.safeParse(await readJson(deps, `${FREESTYLE_URL}/v5/vms?${query.toString()}`, computer.apiKey))
      if (!page.success) throw new FleetReadError("invalid_response")
      for (const item of page.data.vms) {
        const vm = freestyleVm.safeParse(item)
        if (!vm.success) continue
        const value = vm.data
        // Checked here too: a provider that ignored the filter must not put a stranger's machine on the page.
        if (value.metadata?.kind !== KIND || (computer.scope && value.metadata?.[SCOPE_LABEL] !== computer.scope)) continue
        if (sandboxes.length >= COMPUTER_FLEET_LIMIT) {
          source.truncated = true
          break
        }
        sandboxes.push({
          id: value.id,
          key: orNull(value.slug),
          source: "direct",
          provider: computer.kind,
          status: value.state,
          statusReason: null,
          pool: null,
          backend: null,
          region: null,
          cpu: orNull(value.resources?.cpu),
          memoryMb: orNull(value.resources?.memory),
          diskGb: value.resources?.storage ? Math.round(value.resources.storage / 1024) : null,
          createdAt: orNull(value.createdAt),
          updatedAt: orNull(value.updatedAt),
          startedAt: null,
          pausedAt: null,
          lastActivityAt: orNull(value.lastNetworkActivity),
          expiresAt: null,
          endedAt: null,
          attempts: null,
        })
      }
      const total = page.data.totalCount ?? 0
      if (source.truncated || page.data.vms.length < FREESTYLE_PAGE || offset + FREESTYLE_PAGE >= total) break
      if (offset + FREESTYLE_PAGE >= COMPUTER_FLEET_LIMIT * 2) {
        source.truncated = true
        break
      }
    }
  } catch (error) {
    source.status = "unreachable"
    source.error = error instanceof FleetReadError ? error.code : "unreachable"
  }
  return { source, sandboxes }
}

/** The fleet now, from every configured source at once. Never throws. */
export async function readComputerFleet(config: ComputerFleetConfig, deps: ComputerFleetDeps): Promise<ComputerFleet> {
  const reads: Array<Promise<{ source: ComputerFleetSource; sandboxes: ComputerFleetSandbox[] }>> = []
  if (config.computerGateway) reads.push(readGateway(config.computerGateway, deps))
  if (config.computer?.kind === "freestyle") reads.push(readFreestyle(config.computer, deps))
  // Daytona's list is one request per sandbox; it is named as a source and not read.
  else if (config.computer) reads.push(Promise.resolve({ source: { source: "direct", provider: config.computer.kind, status: "unsupported", error: null, truncated: false, pools: [] }, sandboxes: [] }))
  const results = await Promise.all(reads)
  return {
    version: 1,
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    sources: results.map((result) => result.source),
    sandboxes: results.flatMap((result) => result.sandboxes),
  }
}

/** `GET /v1/computers` on either host. */
export async function computerFleetResponse(config: ComputerFleetConfig | undefined, deps: ComputerFleetDeps): Promise<Response> {
  const fleet = config ? await readComputerFleet(config, deps) : { version: 1 as const, generatedAt: (deps.now?.() ?? new Date()).toISOString(), sources: [], sandboxes: [] }
  return Response.json(fleet, { headers: { "Cache-Control": "no-store" } })
}
