import { z } from "zod"
import type { Config } from "./config.js"

export type ComputerFleetConfig = Pick<Config, "computer">
export type ComputerFleetSandbox = {
  id: string
  key: string | null
  source: "gateway" | "direct"
  provider: string
  status: string
  statusReason: string | null
  pool: string | null
  backend: string | null
  region: string | null
  cpu: number | null
  memoryMb: number | null
  diskGb: number | null
  createdAt: string | null
  updatedAt: string | null
  startedAt: string | null
  pausedAt: string | null
  lastActivityAt: string | null
  expiresAt: string | null
  endedAt: string | null
  attempts: number | null
  image: string | null
  imageCurrent: boolean | null
  idleTimeoutSeconds: number | null
  idledAt: string | null
  resumeRequestedAt: string | null
  slotReleased: boolean | null
  trust: string | null
  runSeconds: number | null
}
export type ComputerFleetSettings = { image: string | null; idlePauseSeconds: number; keepDays: number; persistent: boolean }
export type ComputerFleetPool = { name: string; backend: string | null; region: string | null; enabled: boolean; health: string }
export type ComputerFleetSource = {
  source: "gateway" | "direct"
  provider: string
  status: "ok" | "unreachable" | "unsupported"
  error: string | null
  truncated: boolean
  pools: ComputerFleetPool[]
  settings: ComputerFleetSettings | null
}
export type ComputerEvent = { at: string | null; action: string; outcome: string | null; details: Record<string, string> }
export type ComputerPlacement = {
  pool: string | null
  strategy: string | null
  outcome: string | null
  reason: string | null
  evaluatedAt: string | null
  policies: string[]
  candidates: Array<{ pool: string; trust: string | null; eligible: boolean | null; hasCapacity: boolean | null; rank: number | null; reasons: string[] }>
}
export type ComputerLimits = {
  profile: string | null
  classification: string | null
  capabilities: string[]
  preemptible: boolean | null
  ttlSeconds: number | null
  maxRunSeconds: number | null
  maxPausedSeconds: number | null
  autoDeleteSeconds: number | null
  totalRunSeconds: number | null
}
export type ComputerDetail = {
  version: 1
  generatedAt: string
  computer: ComputerFleetSandbox
  limits: ComputerLimits
  settings: ComputerFleetSettings | null
  placement: ComputerPlacement | null
  events: ComputerEvent[] | null
  eventsError: string | null
}
export type ComputerDetailResult = { ok: true; detail: ComputerDetail } | { ok: false; status: 400 | 404 | 502; error: string; code?: string }
export type ComputerFleet = { version: 1; generatedAt: string; sources: ComputerFleetSource[]; sandboxes: ComputerFleetSandbox[] }
export type ComputerFleetDeps = { fetch: typeof fetch; now?: () => Date }

const KIND = "headless-computer"
const SCOPE_LABEL = "openwork.sandbox.scope"
const TIMEOUT_MS = 8_000
export const COMPUTER_FLEET_LIMIT = 2_000
const FREESTYLE_PAGE = 100
const FREESTYLE_URL = "https://api.freestyle.sh"
const COMPUTER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/

const text = z.string().max(2_000).nullish()
const count = z.number().finite().nullish()
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

type Direct = NonNullable<ComputerFleetConfig["computer"]>

const directSettings = (computer: Direct): ComputerFleetSettings => ({ image: orNull(computer.snapshot), idlePauseSeconds: Math.round(computer.idlePauseMs / 1000), keepDays: computer.keepDays, persistent: computer.persistent === true })

const ours = (labels: Record<string, string> | null | undefined, scope: string | undefined) => labels?.kind === KIND && (!scope || labels[SCOPE_LABEL] === scope)

function fromFreestyle(value: FreestyleVm, computer: Direct): ComputerFleetSandbox {
  const provider = computer.kind
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
    image: orNull(value.sourceSnapshotSlug) ?? orNull(value.sourceSnapshotSlugAtCreate) ?? orNull(value.snapshotId),
    imageCurrent: built.length === 0 || !computer.snapshot ? null : built.includes(computer.snapshot),
    idleTimeoutSeconds: typeof value.idleTimeoutSeconds === "number" && value.idleTimeoutSeconds > 0 ? value.idleTimeoutSeconds : null,
    idledAt: null,
    resumeRequestedAt: null,
    slotReleased: null,
    trust: null,
    runSeconds: typeof value.totalRunSeconds === "number" && value.totalRunSeconds >= 0 ? value.totalRunSeconds : null,
  }
}

async function readFreestyle(computer: Direct, deps: ComputerFleetDeps): Promise<{ source: ComputerFleetSource; sandboxes: ComputerFleetSandbox[] }> {
  const source: ComputerFleetSource = { source: "direct", provider: computer.kind, status: "ok", error: null, truncated: false, pools: [], settings: directSettings(computer) }
  const sandboxes: ComputerFleetSandbox[] = []
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

export async function readComputerFleet(config: ComputerFleetConfig, deps: ComputerFleetDeps): Promise<ComputerFleet> {
  const reads: Array<Promise<{ source: ComputerFleetSource; sandboxes: ComputerFleetSandbox[] }>> = []
  if (config.computer?.kind === "freestyle") reads.push(readFreestyle(config.computer, deps))
  else if (config.computer) reads.push(Promise.resolve({ source: { source: "direct", provider: config.computer.kind, status: "unsupported", error: null, truncated: false, pools: [], settings: directSettings(config.computer) }, sandboxes: [] }))
  const results = await Promise.all(reads)
  return {
    version: 1,
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    sources: results.map((result) => result.source),
    sandboxes: results.flatMap((result) => result.sandboxes),
  }
}

export async function computerFleetResponse(config: ComputerFleetConfig | undefined, deps: ComputerFleetDeps): Promise<Response> {
  const fleet = config ? await readComputerFleet(config, deps) : { version: 1 as const, generatedAt: (deps.now?.() ?? new Date()).toISOString(), sources: [], sandboxes: [] }
  return Response.json(fleet, { headers: { "Cache-Control": "no-store" } })
}

const NO_LIMITS: ComputerLimits = { profile: null, classification: null, capabilities: [], preemptible: null, ttlSeconds: null, maxRunSeconds: null, maxPausedSeconds: null, autoDeleteSeconds: null, totalRunSeconds: null }
const positive = (value: number | null | undefined) => (typeof value === "number" && value > 0 ? value : null)

const missing = { ok: false as const, status: 404 as const, error: "unknown_computer" }
const failed = (error: unknown): ComputerDetailResult => {
  const code = error instanceof FleetReadError ? error.code : "unreachable"
  return code === "http_404" ? missing : { ok: false, status: 502, error: "provider_unreachable", code }
}

export async function readComputer(config: ComputerFleetConfig, deps: ComputerFleetDeps, source: string, id: string): Promise<ComputerDetailResult> {
  if ((source !== "gateway" && source !== "direct") || !COMPUTER_ID.test(id)) return { ok: false, status: 400, error: "invalid_computer" }
  const generatedAt = (deps.now?.() ?? new Date()).toISOString()
  if (source === "gateway") return missing
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

export async function computerDetailResponse(config: ComputerFleetConfig | undefined, deps: ComputerFleetDeps, source: string, id: string): Promise<Response> {
  const result: ComputerDetailResult = config ? await readComputer(config, deps, source, id) : missing
  const headers = { "Cache-Control": "no-store" }
  if (result.ok) return Response.json(result.detail, { headers })
  return Response.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status, headers })
}
