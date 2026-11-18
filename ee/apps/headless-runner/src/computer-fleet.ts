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
 *
 * One computer in full (`readComputer`) is the provider's own record, its placement decision and the lifecycle
 * events it recorded. Nothing is run on the computer to answer either: a command would count as use and keep an
 * idle computer awake, or wake a paused one.
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
  /** What it was built from: the gateway's template or snapshot, or the provider's snapshot. */
  image: string | null
  /** Whether that is what this runner builds new computers from now; null when the provider does not say what it was built from. */
  imageCurrent: boolean | null
  /** The provider's own idle rule, in seconds; null when it has none or does not say. */
  idleTimeoutSeconds: number | null
  /** Gateway only: set while it is stopped or paused for being idle. */
  idledAt: string | null
  /** Gateway only: set while a resume waits for a free slot or for a pause to finish. */
  resumeRequestedAt: string | null
  /** Gateway only: a paused sandbox that holds no pool slot until it resumes. */
  slotReleased: boolean | null
  /** Gateway only: `private` or `external`. */
  trust: string | null
  /** Seconds it has spent running over its whole life, where the provider counts them. */
  runSeconds: number | null
}
/** How this runner treats one source's computers: what new ones are built from, and when it pauses and deletes them. */
export type ComputerFleetSettings = { image: string | null; idlePauseSeconds: number; keepDays: number; persistent: boolean }
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
  settings: ComputerFleetSettings | null
}
/** A lifecycle event the provider recorded. Never a command, a path or a port: those say what a conversation did. */
export type ComputerEvent = { at: string | null; action: string; outcome: string | null; details: Record<string, string> }
export type ComputerPlacement = {
  pool: string | null
  strategy: string | null
  /** `placed`, `waiting` or `rejected`. */
  outcome: string | null
  reason: string | null
  evaluatedAt: string | null
  policies: string[]
  candidates: Array<{ pool: string; trust: string | null; eligible: boolean | null; hasCapacity: boolean | null; rank: number | null; reasons: string[] }>
}
/** The provider's limits on one computer, in its own units; null where it has none or does not say. */
export type ComputerLimits = {
  profile: string | null
  classification: string | null
  capabilities: string[]
  preemptible: boolean | null
  ttlSeconds: number | null
  maxRunSeconds: number | null
  maxPausedSeconds: number | null
  autoDeleteSeconds: number | null
  /** Seconds it has spent running over its whole life, where the provider counts them. */
  totalRunSeconds: number | null
}
export type ComputerDetail = {
  version: 1
  generatedAt: string
  computer: ComputerFleetSandbox
  limits: ComputerLimits
  settings: ComputerFleetSettings | null
  /** Gateway only: where it was placed and why, with every pool that was weighed. */
  placement: ComputerPlacement | null
  /** Newest first; null when the provider keeps none or they could not be read. */
  events: ComputerEvent[] | null
  /** Why `events` is null: `unsupported`, or a read code such as `http_403`. */
  eventsError: string | null
}
export type ComputerDetailResult = { ok: true; detail: ComputerDetail } | { ok: false; status: 400 | 404 | 502; error: string; code?: string }
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
/** Events read to find a computer's lifecycle: commands and file calls are in the same log and far outnumber it. */
const EVENT_PAGE = 200
const EVENT_PAGES = 2
export const COMPUTER_EVENT_LIMIT = 40
/** Actions that say what a conversation did on the computer, and their details. Left out. */
const CONTENT_ACTION = /^sandbox\.(exec|file_|port_)/
/** The only details returned: where, what and why, as the gateway's own words. */
const EVENT_DETAILS = ["pool", "action", "by", "to", "after", "reason", "error", "waitedSeconds"]
const COMPUTER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/
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
  template: text,
  fromSnapshot: text,
  trust: text,
  idleTimeoutSeconds: count,
  idledAt: text,
  resumeRequestedAt: text,
  slotReleased: z.boolean().nullish(),
  profile: text,
  classification: text,
  capabilities: z.array(z.string().max(200)).max(100).nullish(),
  preemptible: z.boolean().nullish(),
  ttlSeconds: count,
  maxRunSeconds: count,
  maxPausedSeconds: count,
  decision: z.object({
    pool: text,
    strategy: text,
    outcome: text,
    reason: text,
    evaluatedAt: text,
    policies: z.array(z.string().max(200)).max(50).nullish(),
    candidates: z.array(z.object({
      pool: z.string().max(200),
      trust: text,
      eligible: z.boolean().nullish(),
      hasCapacity: z.boolean().nullish(),
      rank: count,
      reasons: z.array(z.string().max(2_000)).max(20).nullish(),
    }).loose()).max(50).nullish(),
  }).loose().nullish(),
}).loose()
type GatewaySandbox = z.infer<typeof gatewaySandbox>
const gatewayEvents = z.object({
  items: z.array(z.object({
    time: text,
    action: z.string().max(200),
    outcome: text,
    details: z.record(z.string(), z.string()).nullish(),
  }).loose()),
  nextCursor: z.string().nullish(),
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
  snapshotId: text,
  sourceSnapshotSlug: text,
  sourceSnapshotSlugAtCreate: text,
  idleTimeoutSeconds: count,
  autoDeleteSeconds: count,
  ttlSeconds: count,
  maxRunSeconds: count,
  totalRunSeconds: count,
}).loose()
type FreestyleVm = z.infer<typeof freestyleVm>
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

type Gateway = NonNullable<ComputerFleetConfig["computerGateway"]>
type Direct = NonNullable<ComputerFleetConfig["computer"]>

const gatewaySettings = (gateway: Gateway): ComputerFleetSettings => ({ image: gateway.template, idlePauseSeconds: Math.round(gateway.idlePauseMs / 1000), keepDays: gateway.keepDays, persistent: gateway.persistent === true })
const directSettings = (computer: Direct): ComputerFleetSettings => ({ image: orNull(computer.snapshot), idlePauseSeconds: Math.round(computer.idlePauseMs / 1000), keepDays: computer.keepDays, persistent: computer.persistent === true })

/** Whether a record is one of this runner's computers: the labels it puts on each one it creates. */
const ours = (labels: Record<string, string> | null | undefined, scope: string | undefined) => labels?.kind === KIND && (!scope || labels[SCOPE_LABEL] === scope)

function fromGateway(value: GatewaySandbox, gateway: Gateway): ComputerFleetSandbox {
  const provider = gateway.kind
  const image = orNull(value.template) ?? orNull(value.fromSnapshot)
  return {
    id: value.id,
    key: orNull(value.labels?.[KEY_LABEL]),
    source: "gateway",
    provider,
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
    image,
    imageCurrent: image === null ? null : image === gateway.template,
    idleTimeoutSeconds: orNull(value.idleTimeoutSeconds),
    idledAt: orNull(value.idledAt),
    resumeRequestedAt: orNull(value.resumeRequestedAt),
    slotReleased: orNull(value.slotReleased),
    trust: orNull(value.trust),
    runSeconds: null,
  }
}

function fromFreestyle(value: FreestyleVm, computer: Direct): ComputerFleetSandbox {
  const provider = computer.kind
  // The runner's setting may be the snapshot's id or its name, and a snapshot can be renamed after a computer was made.
  const built = [value.snapshotId, value.sourceSnapshotSlug, value.sourceSnapshotSlugAtCreate].flatMap((name) => (name ? [name] : []))
  return {
    id: value.id,
    key: orNull(value.slug),
    source: "direct",
    provider,
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
    // The slug names the image and guest a snapshot was built from; the id says nothing a person can read.
    image: orNull(value.sourceSnapshotSlug) ?? orNull(value.sourceSnapshotSlugAtCreate) ?? orNull(value.snapshotId),
    imageCurrent: built.length === 0 || !computer.snapshot ? null : built.includes(computer.snapshot),
    // The provider writes "never" as a negative number.
    idleTimeoutSeconds: typeof value.idleTimeoutSeconds === "number" && value.idleTimeoutSeconds > 0 ? value.idleTimeoutSeconds : null,
    idledAt: null,
    resumeRequestedAt: null,
    slotReleased: null,
    trust: null,
    runSeconds: typeof value.totalRunSeconds === "number" && value.totalRunSeconds >= 0 ? value.totalRunSeconds : null,
  }
}

async function readGateway(gateway: Gateway, deps: ComputerFleetDeps): Promise<{ source: ComputerFleetSource; sandboxes: ComputerFleetSandbox[] }> {
  const source: ComputerFleetSource = { source: "gateway", provider: gateway.kind, status: "ok", error: null, truncated: false, pools: [], settings: gatewaySettings(gateway) }
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
        sandboxes.push(fromGateway(sandbox.data, gateway))
      }
      cursor = source.truncated ? null : orNull(page.data.nextCursor)
    } while (cursor)
  } catch (error) {
    source.status = "unreachable"
    source.error = error instanceof FleetReadError ? error.code : "unreachable"
  }
  return { source, sandboxes }
}

async function readFreestyle(computer: Direct, deps: ComputerFleetDeps): Promise<{ source: ComputerFleetSource; sandboxes: ComputerFleetSandbox[] }> {
  const source: ComputerFleetSource = { source: "direct", provider: computer.kind, status: "ok", error: null, truncated: false, pools: [], settings: directSettings(computer) }
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
        if (!ours(value.metadata, computer.scope)) continue
        if (sandboxes.length >= COMPUTER_FLEET_LIMIT) {
          source.truncated = true
          break
        }
        sandboxes.push(fromFreestyle(value, computer))
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
  else if (config.computer) reads.push(Promise.resolve({ source: { source: "direct", provider: config.computer.kind, status: "unsupported", error: null, truncated: false, pools: [], settings: directSettings(config.computer) }, sandboxes: [] }))
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

const NO_LIMITS: ComputerLimits = { profile: null, classification: null, capabilities: [], preemptible: null, ttlSeconds: null, maxRunSeconds: null, maxPausedSeconds: null, autoDeleteSeconds: null, totalRunSeconds: null }
const positive = (value: number | null | undefined) => (typeof value === "number" && value > 0 ? value : null)

/** The lifecycle events the gateway recorded for one sandbox, newest first. Needs a key that may read the audit log. */
async function gatewayEventsOf(gateway: Gateway, deps: ComputerFleetDeps, id: string): Promise<Pick<ComputerDetail, "events" | "eventsError">> {
  const base = gateway.url.replace(/\/+$/, "")
  const events: ComputerEvent[] = []
  try {
    let before: string | null = null
    for (let page = 0; page < EVENT_PAGES && events.length < COMPUTER_EVENT_LIMIT; page += 1) {
      const query = new URLSearchParams({ resource: id, order: "desc", limit: String(EVENT_PAGE) })
      if (before) query.set("beforeSeq", before)
      const read = gatewayEvents.safeParse(await readJson(deps, `${base}/v1/audit-events?${query.toString()}`, gateway.apiKey))
      if (!read.success) throw new FleetReadError("invalid_response")
      for (const item of read.data.items) {
        if (!item.action.startsWith("sandbox.") || CONTENT_ACTION.test(item.action)) continue
        const details: Record<string, string> = {}
        for (const name of EVENT_DETAILS) {
          const value = item.details?.[name]
          if (value) details[name] = value.slice(0, 300)
        }
        events.push({ at: orNull(item.time), action: item.action.slice("sandbox.".length), outcome: orNull(item.outcome), details })
        if (events.length >= COMPUTER_EVENT_LIMIT) break
      }
      before = orNull(read.data.nextCursor)
      if (!before) break
    }
    return { events, eventsError: null }
  } catch (error) {
    return { events: null, eventsError: error instanceof FleetReadError ? error.code : "unreachable" }
  }
}

const missing = { ok: false as const, status: 404 as const, error: "unknown_computer" }
const failed = (error: unknown): ComputerDetailResult => {
  const code = error instanceof FleetReadError ? error.code : "unreachable"
  return code === "http_404" ? missing : { ok: false, status: 502, error: "provider_unreachable", code }
}

/**
 * One computer in full, from the source that holds it. `unknown_computer` covers one the provider does not have and
 * one that is not this runner's (another runner's, or a machine that is not a conversation's computer at all).
 */
export async function readComputer(config: ComputerFleetConfig, deps: ComputerFleetDeps, source: string, id: string): Promise<ComputerDetailResult> {
  if ((source !== "gateway" && source !== "direct") || !COMPUTER_ID.test(id)) return { ok: false, status: 400, error: "invalid_computer" }
  const generatedAt = (deps.now?.() ?? new Date()).toISOString()
  if (source === "gateway") {
    const gateway = config.computerGateway
    if (!gateway) return missing
    let value: GatewaySandbox
    try {
      const read = gatewaySandbox.safeParse(await readJson(deps, `${gateway.url.replace(/\/+$/, "")}/v1/sandboxes/${encodeURIComponent(id)}`, gateway.apiKey))
      if (!read.success) throw new FleetReadError("invalid_response")
      value = read.data
    } catch (error) {
      return failed(error)
    }
    if (!ours(value.labels, gateway.scope)) return missing
    const decision = value.decision
    return {
      ok: true,
      detail: {
        version: 1,
        generatedAt,
        computer: fromGateway(value, gateway),
        limits: {
          ...NO_LIMITS,
          profile: orNull(value.profile),
          classification: orNull(value.classification),
          capabilities: value.capabilities ?? [],
          preemptible: orNull(value.preemptible),
          ttlSeconds: positive(value.ttlSeconds),
          maxRunSeconds: positive(value.maxRunSeconds),
          maxPausedSeconds: positive(value.maxPausedSeconds),
        },
        settings: gatewaySettings(gateway),
        placement: decision ? {
          pool: orNull(decision.pool),
          strategy: orNull(decision.strategy),
          outcome: orNull(decision.outcome),
          reason: reason(decision.reason),
          evaluatedAt: orNull(decision.evaluatedAt),
          policies: decision.policies ?? [],
          candidates: (decision.candidates ?? []).map((candidate) => ({
            pool: candidate.pool,
            trust: orNull(candidate.trust),
            eligible: orNull(candidate.eligible),
            hasCapacity: orNull(candidate.hasCapacity),
            rank: orNull(candidate.rank),
            reasons: (candidate.reasons ?? []).map((line) => line.slice(0, 300)),
          })),
        } : null,
        ...await gatewayEventsOf(gateway, deps, value.id),
      },
    }
  }
  const computer = config.computer
  if (!computer || computer.kind !== "freestyle") return missing
  let value: FreestyleVm
  try {
    const read = freestyleVm.safeParse(await readJson(deps, `${FREESTYLE_URL}/v5/vms/${encodeURIComponent(id)}`, computer.apiKey))
    if (!read.success) throw new FleetReadError("invalid_response")
    value = read.data
  } catch (error) {
    return failed(error)
  }
  if (!ours(value.metadata, computer.scope)) return missing
  return {
    ok: true,
    detail: {
      version: 1,
      generatedAt,
      computer: fromFreestyle(value, computer),
      limits: {
        ...NO_LIMITS,
        ttlSeconds: positive(value.ttlSeconds),
        maxRunSeconds: positive(value.maxRunSeconds),
        autoDeleteSeconds: positive(value.autoDeleteSeconds),
        totalRunSeconds: typeof value.totalRunSeconds === "number" && value.totalRunSeconds >= 0 ? value.totalRunSeconds : null,
      },
      settings: directSettings(computer),
      placement: null,
      events: null,
      eventsError: "unsupported",
    },
  }
}

/** `GET /v1/computers/:source/:id` on either host. */
export async function computerDetailResponse(config: ComputerFleetConfig | undefined, deps: ComputerFleetDeps, source: string, id: string): Promise<Response> {
  const result: ComputerDetailResult = config ? await readComputer(config, deps, source, id) : missing
  const headers = { "Cache-Control": "no-store" }
  if (result.ok) return Response.json(result.detail, { headers })
  return Response.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status, headers })
}
