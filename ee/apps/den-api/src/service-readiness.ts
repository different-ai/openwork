import { createHmac } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { headlessRunnerConfig } from "@openwork-ee/headless-protocol"
import { gatewayOrigin } from "@openwork-ee/utils/gateway-env"
import { headlessServiceHealthSchema, workbotServiceHealthSchema } from "@openwork/types/den/service-health"
import { serviceIdSchema, type DeploymentServiceReadiness, type DeploymentServiceStatus, type OrganizationServiceReadiness, type ServiceId, type ServiceNote, type ServiceReadinessReason, type ServiceReadinessState } from "@openwork/types/den/service-readiness"
import type { EmailTransportCheck } from "@openwork/email"
import { z } from "zod"
import { isPrivateAddress } from "./capability-sources/url-guard.js"

export const SERVICE_READINESS_TTL_MS = 60_000
export const SERVICE_READINESS_TIMEOUT_MS = 2_000
/** SMTP sign-in (connect, STARTTLS, AUTH) needs longer than a health GET, but stays bounded. */
export const EMAIL_READINESS_TIMEOUT_MS = 8_000
export const SERVICE_READINESS_RATE_KEY = "service-readiness:deployment:check:v1"
export const SERVICE_READINESS_RATE_WINDOW_MS = 30_000
const MAX_BODY_BYTES = 16_384

type Environment = Readonly<Record<string, string | undefined>>
export type ReadinessFetch = (url: string, init: RequestInit) => Promise<Response>
export type ServiceProbeDependencies = {
  env: Environment
  /** Configured/derived public Den origin, never the incoming request origin. */
  denOrigin?: string
  database: (signal: AbortSignal) => Promise<unknown>
  fetch: ReadinessFetch
  /** Live mail transport check; never sends a message. Omitted: complete settings stay unverified. */
  verifyEmail?: (signal: AbortSignal) => Promise<EmailTransportCheck>
  timeoutMs?: number
  emailTimeoutMs?: number
  /** Monotonic milliseconds for check durations. */
  clock?: () => number
}
type Fact = Pick<DeploymentServiceStatus, "configured" | "state" | "reason" | "missingSettings" | "notes" | "durationMs">
type ProbeFacts = { services: Map<ServiceId, Fact>; drained?: Promise<void> }
export type ServiceProbeFact = Fact
export type ServiceProbeResult = ProbeFacts
type TrackProbe = (operation: Promise<unknown>) => void

function fact(state: ServiceReadinessState, reason: ServiceReadinessReason, configured = true, missingSettings: string[] = [], notes: ServiceNote[] = []): Fact {
  return { state, reason, configured, missingSettings, notes, durationMs: null }
}
function configuration(source: Environment, names: string[]): Fact | null {
  const missing = names.filter((name) => !source[name]?.trim())
  if (missing.length === names.length) return fact("not_configured", "not_configured", false)
  return missing.length ? fact("misconfigured", "missing_configuration", false, missing) : null
}

/** Trusted operator settings only. Reuses the deployment origin validator, with a stricter HTTP boundary. */
export function readinessServiceOrigin(raw: string): string {
  const origin = gatewayOrigin(raw, "service origin", false)
  const url = new URL(origin)
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const internal = !isIP(host) && (!host.includes(".") || /\.(?:internal|local|svc|cluster\.local)$/.test(host))
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host)
  if ((url.protocol === "http:" && !internal && !loopback) || blockedMetadataAddress(host) || host === "metadata.google.internal"
    || (isIP(host) && isPrivateAddress(host) && !supportedInternalAddress(host))) {
    throw new Error("invalid_configuration")
  }
  return origin
}

function blockedMetadataAddress(address: string): boolean {
  let host = address.toLowerCase().replace(/^\[|\]$/g, "")
  try { if (isIP(host) === 6) host = new URL(`http://[${host}]`).hostname.slice(1, -1) } catch { return true }
  return /^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/.test(host) || host === "fd00:ec2::254"
    || host === "::" || host === "0.0.0.0" || /^::ffff:a9fe:/.test(host)
    || /^::ffff:0:a9fe:/.test(host) || /^64:ff9b::a9fe:/.test(host)
}

function supportedInternalAddress(address: string): boolean {
  const host = address.toLowerCase()
  if (isIP(host) === 4) {
    const [first, second] = host.split(".").map(Number)
    return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127)
  }
  // Reject transition/mapped/reserved IPv6, even for trusted service DNS. Only
  // native loopback and unique-local service networks need private access.
  return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host)
}

/** Build only from validated operator settings, never from a request or redirect destination. */
export function readinessServiceHosts(source: Environment): ReadonlySet<string> {
  const hosts = new Set<string>()
  const gateway = source.GATEWAY_ENABLED === "false" ? undefined : source.GATEWAY_PROXY_BASE_URL ?? source.INFERENCE_PROXY_BASE_URL
  for (const raw of [gateway, source.DEN_HEADLESS_RUNNER_URL, source.DEN_WORKBOT_URL]) {
    if (!raw) continue
    try { hosts.add(new URL(readinessServiceOrigin(raw)).hostname.replace(/^\[|\]$/g, "").toLowerCase()) } catch { /* Invalid settings never grant network access. */ }
  }
  return hosts
}

type ServiceAddresses = Array<{ address: string; family: number }>
const resolveServiceAddresses = (hostname: string) => lookup(hostname, { all: true, verbatim: true })
const noPrivateServiceHosts: ReadonlySet<string> = new Set()
/** Used by the transport's DNS lookup itself (not a vulnerable resolve-then-fetch preflight).
 * Default policy is public-only. Native private/loopback networks require an
 * exact hostname explicitly derived from the operator's validated service origins.
 */
export async function readinessLookup(hostname: string, resolve: (hostname: string) => Promise<ServiceAddresses> = resolveServiceAddresses, allowedPrivateHosts: ReadonlySet<string> = noPrivateServiceHosts): Promise<ServiceAddresses> {
  const addresses = await resolve(hostname)
  const trusted = allowedPrivateHosts.has(hostname.toLowerCase())
  if (!addresses.length || addresses.some(({ address }) => blockedMetadataAddress(address)
    || (isPrivateAddress(address) && (!trusted || !supportedInternalAddress(address))))) {
    throw new Error("invalid_configuration")
  }
  return addresses
}

// Include every setting that influences a probe or configuration-derived fact.
// Never expose the fingerprint, inputs or resulting Redis key in a response/log.
const readinessConfigurationSettings = [
  "DB_MODE", "DATABASE_URL", "DATABASE_HOST", "DATABASE_USERNAME", "DATABASE_PASSWORD",
  "GATEWAY_ENABLED", "GATEWAY_PROXY_BASE_URL", "INFERENCE_PROXY_BASE_URL", "GATEWAY_PUBLIC_BASE_URL",
  "DEN_HEADLESS_RUNNER_URL", "DEN_HEADLESS_RUNNER_TOKEN", "DEN_HEADLESS_RUNNER_CALLBACK_TOKEN", "DEN_WORKBOT_URL",
  "DEN_API_PUBLIC_URL", "EMAIL_FROM", "RESEND_API_KEY", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE", "OPENWORK_DEV_MODE",
]
/** Internal namespace only: rolling replicas with changed settings cannot reuse old Ready facts.
 * The existing deployment encryption key also prevents dictionary-testing weak
 * individual settings against a visible cache key. No new secret is required.
 */
export function readinessConfigurationFingerprint(source: Environment, denOrigin?: string): string {
  const inputs = readinessConfigurationSettings.map((name) => [name, source[name] ?? null])
  const key = source.DEN_DB_ENCRYPTION_KEY
  if (!key) throw new Error("invalid_configuration")
  return createHmac("sha256", key)
    .update(JSON.stringify({ version: 2, denOrigin: denOrigin ?? null, settings: inputs }))
    .digest("hex")
}

class ProbeFailure extends Error {
  constructor(readonly state: ServiceReadinessState, readonly reason: ServiceReadinessReason) { super(reason) }
}
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, track?: TrackProbe): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new ProbeFailure("unreachable", "timeout"))
    }, timeoutMs)
  })
  try {
    const pending = operation(controller.signal)
    track?.(pending)
    return await Promise.race([pending, timeout])
  } finally { clearTimeout(timer) }
}
async function jsonBody(response: Response): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    void response.body?.cancel().catch(() => undefined)
    throw new ProbeFailure("unknown", "unexpected_response")
  }
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES || !response.body) {
    void response.body?.cancel().catch(() => undefined)
    throw new ProbeFailure("unknown", "unexpected_response")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_BODY_BYTES) throw new ProbeFailure("unknown", "unexpected_response")
      chunks.push(chunk.value)
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      return parsed
    } catch { throw new ProbeFailure("unknown", "unexpected_response") }
  } finally {
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
type ProbeContext = ServiceProbeDependencies & { track: TrackProbe; begin?: () => void }
async function health<T>(deps: ProbeContext, raw: string, path: "/health" | "/ready" | "/v1/health" | "/internal/readiness", schema: z.ZodType<T>, token?: string): Promise<T> {
  let origin: string
  try { origin = readinessServiceOrigin(raw) } catch { throw new ProbeFailure("misconfigured", "invalid_configuration") }
  // The live check starts at the first network call, not at configuration validation.
  deps.begin?.()
  return bounded(async (signal) => {
    const headers: Record<string, string> = { accept: "application/json" }
    if (token) headers.authorization = `Bearer ${token}`
    if (deps.denOrigin && token) headers["X-OpenWork-Den-Origin"] = new URL(deps.denOrigin).origin
    const response = await deps.fetch(`${origin}${path}`, { method: "GET", headers, signal, redirect: "manual" })
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined)
      if (response.status === 401 || response.status === 403) throw new ProbeFailure("misconfigured", "authentication_failed")
      if (response.status === 404) throw new ProbeFailure("unknown", "incompatible_service")
      if (response.status >= 500) throw new ProbeFailure("unreachable", "request_failed")
      throw new ProbeFailure("unknown", "unexpected_response")
    }
    const result = schema.safeParse(await jsonBody(response))
    if (!result.success) throw new ProbeFailure("unknown", "incompatible_service")
    return result.data
  }, deps.timeoutMs ?? SERVICE_READINESS_TIMEOUT_MS, deps.track)
}
async function protect(probe: () => Promise<Fact>): Promise<Fact> {
  try { return await probe() } catch (error) {
    // Never serialize, log or retain upstream errors: they can contain URLs, headers and bodies.
    return error instanceof ProbeFailure ? fact(error.state, error.reason) : fact("unreachable", "request_failed")
  }
}
/** durationMs covers the first network/database call until completion; null when none ran. */
async function timed(clock: () => number, probe: (begin: () => void) => Promise<Fact>): Promise<Fact> {
  let started: number | null = null
  const result = await protect(() => probe(() => { started ??= clock() }))
  return started === null ? result : { ...result, durationMs: Math.max(0, Math.round(clock() - started)) }
}
const gatewayHealth = z.object({ ok: z.literal(true), service: z.literal("gateway") })
const gatewayReady = z.object({ ok: z.literal(true), service: z.literal("gateway"), checks: z.object({ database: z.literal("ok") }) })

function emailNotes(source: Environment): ServiceNote[] {
  if (source.SMTP_HOST?.trim()) return ["email_smtp"]
  return source.RESEND_API_KEY?.trim() ? ["email_resend"] : []
}
/** Configuration only. Complete SMTP/Resend settings are `not_checked` until the live check runs. */
export function emailReadiness(source: Environment): Fact {
  const present = (name: string) => Boolean(source[name]?.trim())
  const notes = emailNotes(source)
  // Match @openwork/email: SMTP_HOST > RESEND_API_KEY > development sink.
  if (present("SMTP_HOST")) {
    const missing = ["EMAIL_FROM", ...(present("SMTP_USER") ? ["SMTP_PASS"] : []), ...(present("SMTP_PASS") ? ["SMTP_USER"] : [])].filter((name) => !present(name))
    if (missing.length) return fact("misconfigured", "missing_configuration", false, missing, notes)
    const port = source.SMTP_PORT ?? "587"
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || (source.SMTP_SECURE !== undefined && !/^(true|false)$/i.test(source.SMTP_SECURE))) return fact("misconfigured", "invalid_configuration", false, [], notes)
    return fact("unknown", "not_checked", true, [], notes)
  }
  if (present("RESEND_API_KEY")) return present("EMAIL_FROM") ? fact("unknown", "not_checked", true, [], notes) : fact("misconfigured", "missing_configuration", false, ["EMAIL_FROM"], notes)
  if (["SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE"].some(present)) return fact("misconfigured", "missing_configuration", false, ["SMTP_HOST"])
  // The development sink only logs messages; no mail transport is set up.
  if (source.OPENWORK_DEV_MODE === "1") return fact("not_configured", "not_configured", false)
  if (present("EMAIL_FROM")) return fact("misconfigured", "missing_configuration", false, ["SMTP_HOST", "RESEND_API_KEY"])
  return fact("not_configured", "not_configured", false)
}
function emailFact(check: EmailTransportCheck, notes: ServiceNote[]): Fact {
  if (check.provider === "dev" || check.provider === "none") return fact("unknown", "configuration_only", true, [], notes)
  const live: ServiceNote[] = check.provider === "smtp" ? ["email_smtp"] : ["email_resend"]
  switch (check.outcome) {
    case "verified": return fact("ready", "email_verified", true, [], live)
    case "key_accepted": return fact("ready", "email_key_verified", true, [], live)
    case "sender_unverified": return fact("misconfigured", "email_sender_unverified", true, [], live)
    case "auth_failed": return fact("misconfigured", "authentication_failed", true, [], live)
    case "unreachable": return fact("unreachable", "request_failed", true, [], live)
    case "timeout": return fact("unreachable", "timeout", true, [], live)
    default: return fact("unknown", "unexpected_response", true, [], live)
  }
}

type RunnerHealth = z.infer<typeof headlessServiceHealthSchema>
type ResumeFacts = { note: ServiceNote | null; missingSettings: string[]; misconfigured: boolean }
/**
 * Resumable answers are part of the runner, not a service of their own. Den
 * cannot exercise the callback without a real turn, so this compares settings
 * on both sides. `health` is the runner's answer when it was reachable.
 */
function resumeFacts(source: Environment, denOrigin: string | undefined, health?: RunnerHealth): ResumeFacts {
  const callback = source.DEN_HEADLESS_RUNNER_CALLBACK_TOKEN?.trim()
  const broken = (missingSettings: string[] = []): ResumeFacts => ({ note: "resume_misconfigured", missingSettings, misconfigured: true })
  if (!callback) {
    if (health?.resumeConfigured) return broken(["DEN_HEADLESS_RUNNER_CALLBACK_TOKEN"])
    return { note: "resume_not_configured", missingSettings: [], misconfigured: false }
  }
  if (callback.length < 32 || callback === source.DEN_HEADLESS_RUNNER_TOKEN?.trim()) return broken()
  if (!denOrigin) return broken(["DEN_API_PUBLIC_URL"])
  // Without the runner's answer, configuration alone cannot show resume works.
  if (!health) return { note: null, missingSettings: [], misconfigured: false }
  if (!health.resumeConfigured || health.denOriginMatches === false) return broken()
  return { note: "resume_ready", missingSettings: [], misconfigured: false }
}
function withResume(runner: Fact, resume: ResumeFacts, healthy: boolean): Fact {
  const missingSettings = [...new Set([...runner.missingSettings, ...resume.missingSettings])]
  const notes = resume.note ? [...runner.notes, resume.note] : runner.notes
  if (healthy && resume.misconfigured) return { ...runner, state: "misconfigured", reason: "resume_misconfigured", missingSettings, notes }
  return { ...runner, missingSettings, notes }
}
function runnerSettings(source: Environment): Fact | null {
  const incomplete = configuration(source, ["DEN_HEADLESS_RUNNER_URL", "DEN_HEADLESS_RUNNER_TOKEN"])
  // A callback token without a runner is a partial runner setup, not an absent one.
  if (incomplete?.state === "not_configured" && source.DEN_HEADLESS_RUNNER_CALLBACK_TOKEN?.trim()) {
    return fact("misconfigured", "missing_configuration", false, ["DEN_HEADLESS_RUNNER_URL", "DEN_HEADLESS_RUNNER_TOKEN"])
  }
  return incomplete
}

/** At most five concurrent read-only probes; all other statuses derive from these same facts. Nothing is sent or invoked. */
export async function probeDeploymentServices(deps: ServiceProbeDependencies): Promise<ProbeFacts> {
  const operations: Promise<unknown>[] = []
  const track: TrackProbe = (operation) => { operations.push(operation) }
  const tracked = { ...deps, track }
  const source = deps.env
  const clock = deps.clock ?? (() => performance.now())
  const runnerConfig = headlessRunnerConfig(source)
  let runnerHealth: RunnerHealth | undefined
  const database = timed(clock, async (begin) => {
    begin()
    await bounded(deps.database, deps.timeoutMs ?? SERVICE_READINESS_TIMEOUT_MS, track)
    return fact("ready", "database_verified")
  })
  const gateway = timed(clock, async (begin) => {
    const raw = source.GATEWAY_PROXY_BASE_URL ?? source.INFERENCE_PROXY_BASE_URL
    if (source.GATEWAY_ENABLED === "false" || (!raw && source.GATEWAY_ENABLED !== "true")) return fact("not_configured", "not_configured", false)
    if (!raw) return fact("misconfigured", "missing_configuration", false, ["GATEWAY_PROXY_BASE_URL"])
    await health({ ...tracked, begin }, raw, "/health", gatewayHealth)
    await health({ ...tracked, begin }, raw, "/ready", gatewayReady)
    return fact("ready", "health_verified")
  })
  const runner = timed(clock, async (begin) => {
    const incomplete = runnerSettings(source)
    if (incomplete) return incomplete
    if (!runnerConfig) return fact("misconfigured", "invalid_configuration", false)
    runnerHealth = await health({ ...tracked, begin }, runnerConfig.url, "/v1/health", headlessServiceHealthSchema, runnerConfig.token)
    // Per-member credentials may supply models; no model invocation or provider catalog lookup here.
    // A Den origin mismatch only affects resumable answers and is reported there.
    return fact("ready", "health_verified")
  })
  const workbot = timed(clock, async (begin) => {
    if (!source.DEN_WORKBOT_URL?.trim()) return fact("not_configured", "not_configured", false)
    if (!source.DEN_HEADLESS_RUNNER_TOKEN?.trim()) return fact("misconfigured", "missing_configuration", false, ["DEN_HEADLESS_RUNNER_TOKEN"])
    if (source.DEN_HEADLESS_RUNNER_TOKEN.trim().length < 32) return fact("misconfigured", "invalid_configuration", false)
    const result = await health({ ...tracked, begin }, source.DEN_WORKBOT_URL, "/internal/readiness", workbotServiceHealthSchema, source.DEN_HEADLESS_RUNNER_TOKEN.trim())
    if (result.denOriginMatches === false || !result.runnerConfigured) return fact("misconfigured", "invalid_configuration")
    if (result.denOriginMatches === null || !deps.denOrigin) return fact("unknown", "configuration_only")
    return fact("ready", "health_verified")
  })
  const email = timed(clock, async (begin) => {
    const configured = emailReadiness(source)
    if (configured.reason !== "not_checked") return configured
    const verify = deps.verifyEmail
    if (!verify) return { ...configured, reason: "configuration_only" }
    begin()
    try {
      return emailFact(await bounded(verify, deps.emailTimeoutMs ?? EMAIL_READINESS_TIMEOUT_MS, track), configured.notes)
    } catch (error) {
      const failed = error instanceof ProbeFailure ? fact(error.state, error.reason) : fact("unreachable", "request_failed")
      return { ...failed, notes: configured.notes }
    }
  })
  const [databaseFact, gatewayFact, runnerFact, workbotFact, emailResult] = await Promise.all([database, gateway, runner, workbot, email])
  const runnerHealthy = runnerFact.state === "ready"
  const services = new Map<ServiceId, Fact>([
    ["database", databaseFact],
    ["gateway", gatewayFact],
    ["headlessRunner", withResume(runnerFact, resumeFacts(source, deps.denOrigin, runnerHealthy ? runnerHealth : undefined), runnerHealthy)],
    // Workbot needs a reachable runner, not resumable answers.
    ["workbot", workbotFact.state === "ready" && !runnerHealthy ? { ...workbotFact, state: "unknown", reason: "dependency_unavailable" } : workbotFact],
    ["email", emailResult],
  ])
  return { services, drained: Promise.allSettled(operations).then(() => undefined) }
}

function dependencies(id: ServiceId): ServiceId[] {
  if (id === "gateway") return ["database"]
  if (id === "workbot") return ["headlessRunner"]
  return []
}
function configurationHint(id: ServiceId, source: Environment, denOrigin?: string): Fact {
  const unchecked = fact("unknown", "not_checked")
  if (id === "database") return unchecked
  if (id === "email") return emailReadiness(source)
  if (id === "gateway") {
    const raw = source.GATEWAY_PROXY_BASE_URL ?? source.INFERENCE_PROXY_BASE_URL
    if (source.GATEWAY_ENABLED === "false" || (!raw && source.GATEWAY_ENABLED !== "true")) return fact("not_configured", "not_configured", false)
    if (!raw) return fact("misconfigured", "missing_configuration", false, ["GATEWAY_PROXY_BASE_URL"])
    try { readinessServiceOrigin(raw); return unchecked } catch { return fact("misconfigured", "invalid_configuration", false) }
  }
  if (id === "headlessRunner") {
    const resume = resumeFacts(source, denOrigin)
    const incomplete = runnerSettings(source)
    if (incomplete) return withResume(incomplete, resume, false)
    const config = headlessRunnerConfig(source)
    if (!config) return withResume(fact("misconfigured", "invalid_configuration", false), resume, false)
    try { readinessServiceOrigin(config.url); return withResume(unchecked, resume, false) } catch { return withResume(fact("misconfigured", "invalid_configuration", false), resume, false) }
  }
  if (!source.DEN_WORKBOT_URL?.trim()) return fact("not_configured", "not_configured", false)
  if (!source.DEN_HEADLESS_RUNNER_TOKEN?.trim()) return fact("misconfigured", "missing_configuration", false, ["DEN_HEADLESS_RUNNER_TOKEN"])
  if (source.DEN_HEADLESS_RUNNER_TOKEN.trim().length < 32) return fact("misconfigured", "invalid_configuration", false)
  try { readinessServiceOrigin(source.DEN_WORKBOT_URL); return unchecked } catch { return fact("misconfigured", "invalid_configuration", false) }
}
/** No outbound work. `server` stays null here and in the shared cache; read handlers fill it per replica. */
export function initialReadiness(source?: Environment, denOrigin?: string): DeploymentServiceReadiness {
  return { version: 2, checkedAt: null, checking: false, server: null, services: serviceIdSchema.options.map((id) => ({
    id, required: id === "database", ...(source ? configurationHint(id, source, denOrigin) : fact("unknown", "not_checked", false)), dependencies: dependencies(id), checkedAt: null, lastSuccessAt: null, stale: true,
  })) }
}
export function organizationReadiness(snapshot: DeploymentServiceReadiness): OrganizationServiceReadiness {
  return { version: 2, checkedAt: snapshot.checkedAt, checking: snapshot.checking, services: snapshot.services.map(({ required: _required, missingSettings: _missing, notes: _notes, durationMs: _duration, ...status }) => status) }
}
export type ReadinessControllerDependencies = {
  /** Durable shared admission; null admits, otherwise seconds until another check may be admitted. */
  admit: () => Promise<number | null>
  probe: () => Promise<ProbeFacts>
  now?: () => number
  initial?: DeploymentServiceReadiness
  load?: () => Promise<DeploymentServiceReadiness | null>
  save?: (snapshot: DeploymentServiceReadiness) => Promise<void>
}

/** Diagnostics are advisory: never an authorization input, never a startup or request dependency. */
export function createReadinessController(deps: ReadinessControllerDependencies) {
  const now = deps.now ?? Date.now
  let current = deps.initial ?? initialReadiness()
  let admission: Promise<number | null> | null = null
  let active: Promise<void> | null = null
  let sync: Promise<void> | null = null
  let lastSync = -Infinity
  function snapshot(): DeploymentServiceReadiness {
    return { ...current, server: null, checking: admission !== null || active !== null, services: current.services.map((status) => ({ ...status, missingSettings: [...status.missingSettings], dependencies: [...status.dependencies], notes: [...status.notes], stale: !status.checkedAt || now() - Date.parse(status.checkedAt) >= SERVICE_READINESS_TTL_MS })) }
  }
  async function run() {
    const result = await deps.probe()
    const checkedAt = new Date(now()).toISOString()
    current = { version: 2, checkedAt, checking: false, server: null, services: current.services.map((old) => {
      const next = result.services.get(old.id) ?? fact("unknown", "not_checked", false)
      return { ...old, ...next, checkedAt, stale: false, lastSuccessAt: next.state === "ready" ? checkedAt : old.lastSuccessAt }
    }) }
    if (deps.save) await bounded(() => deps.save?.(current) ?? Promise.resolve(), 250).catch(() => undefined)
    // A timeout publishes a fresh failed fact immediately, but an uncancellable
    // database/DNS/body operation must drain before another local check starts.
    await result.drained
  }
  async function loadCache() {
    if (!deps.load) return
    const cached = await bounded(() => deps.load?.() ?? Promise.resolve(null), 250).catch(() => null)
    if (cached?.checkedAt && (!current.checkedAt || cached.checkedAt > current.checkedAt) && !active) current = { ...cached, server: null }
  }
  function completedRecently() {
    if (!current.checkedAt || current.services.length !== serviceIdSchema.options.length) return false
    const age = now() - Date.parse(current.checkedAt)
    return age >= 0 && age < SERVICE_READINESS_RATE_WINDOW_MS
      && current.services.every((status) => status.checkedAt === current.checkedAt)
  }
  function refresh(): Promise<number | null> {
    if (admission) return admission
    if (active) return Promise.resolve(null)
    admission = (async () => {
      // A GET's recent background result is also the answer to Check now. Reuse
      // it without changing timestamps, spending quota or launching more work.
      // Loading first also preserves the previous replica's last-success facts.
      await loadCache()
      if (completedRecently()) return null
      const retryAfter = await deps.admit()
      if (retryAfter !== null) {
        // Another replica may finish between our cache read and quota claim.
        await loadCache()
        return completedRecently() ? null : retryAfter
      }
      active = run().catch(() => undefined).finally(() => { active = null })
      return null
    })().finally(() => { admission = null })
    return admission
  }
  function syncCache() {
    if (!deps.load || sync || now() - lastSync < 10_000) return
    lastSync = now()
    sync = loadCache().catch(() => undefined).finally(() => { sync = null })
  }
  return { snapshot, refresh, syncCache, async idle() { await admission; await active; await sync } }
}
