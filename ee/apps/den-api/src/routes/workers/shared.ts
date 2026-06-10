import { randomBytes } from "node:crypto"
import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"
import { and, asc, desc, eq, inArray, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  AuditEventTable,
  AuthUserTable,
  DaytonaSandboxTable,
  MemberTable,
  WorkerBundleTable,
  WorkerInstanceTable,
  WorkerTable,
  WorkerTokenTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { requireCloudWorkerAccess } from "../../billing/polar.js"
import { db, dbClient } from "../../db.js"
import { env } from "../../env.js"
import type { OrganizationContextVariables, UserOrganizationsContext } from "../../middleware/index.js"
import { denTypeIdSchema } from "../../openapi.js"
import { getOrganizationLimitStatus } from "../../organization-limits.js"
import type { AuthContextVariables } from "../../session.js"
import {
  checkStaticWorkerHealth,
  deprovisionWorker,
  getStaticWorkerTokenPairForUrl,
  normalizeStaticWorkerUrl,
  provisionWorker,
  selectStaticWorkerUrlFromPool,
  verifyStaticWorkerRuntimeAccess,
} from "../../workers/provisioner.js"
import { fetchStaticHttpTarget } from "../../workers/static-fetch.js"
import { customDomainForWorker } from "../../workers/vanity-domain.js"

export const createWorkerSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  destination: z.enum(["local", "cloud"]),
  source: z.enum(["manual", "signup_auto"]).optional(),
  workspacePath: z.string().optional(),
  sandboxBackend: z.string().optional(),
  imageVersion: z.string().optional(),
})

export function shouldUseSignupAutoExistingWorker(input: {
  destination: "local" | "cloud"
  source?: "manual" | "signup_auto"
}) {
  return input.destination === "cloud" && input.source === "signup_auto"
}

export const attachStaticWorkerSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(1024).optional(),
  url: z.string().url(),
  clientToken: z.string().trim().min(1).max(128),
  hostToken: z.string().trim().min(1).max(128),
  activityToken: z.string().trim().min(1).max(128).optional(),
})

export const updateWorkerSchema = z.object({
  name: z.string().trim().min(1).max(255),
})

export const listWorkersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const activityHeartbeatSchema = z.object({
  sentAt: z.string().datetime().optional(),
  isActiveRecently: z.boolean(),
  lastActivityAt: z.string().datetime().optional().nullable(),
  openSessionCount: z.number().int().min(0).optional(),
})

export const workerIdParamSchema = z.object({
  id: denTypeIdSchema("worker"),
})

export type WorkerRouteVariables = AuthContextVariables & Partial<UserOrganizationsContext>
  & Partial<OrganizationContextVariables>

type WorkerRow = typeof WorkerTable.$inferSelect
type WorkerInstanceRow = typeof WorkerInstanceTable.$inferSelect
export type WorkerId = WorkerRow["id"]
type OrgId = typeof MemberTable.$inferSelect.organizationId
type UserId = typeof AuthUserTable.$inferSelect.id
type StaticAssignmentDb = Pick<typeof db, "execute" | "insert" | "select" | "update">
type MySqlLockConnection = {
  query: (statement: string, values?: unknown[]) => Promise<unknown>
  release: () => void
}
type MySqlLockPool = {
  getConnection: () => Promise<MySqlLockConnection>
}

export const token = () => randomBytes(32).toString("hex")

export function parseWorkerIdParam(value: string): WorkerId {
  return normalizeDenTypeId("worker", value)
}

export function normalizeWorkerRuntimeUrl(value: string): string {
  const parsed = new URL(value.trim())
  parsed.hash = ""
  parsed.search = ""
  parsed.username = ""
  parsed.password = ""
  parsed.pathname = parsed.pathname.replace(/\/+$/, "")
  return parsed.toString().replace(/\/+$/, "")
}

export type StaticWorkerAttachUrlPolicy = {
  allowPrivate: boolean
  allowedHosts: readonly string[]
  allowedCidrs: readonly string[]
}

export type DnsLookupAddress = {
  address: string
  family: 4 | 6
}

export type StaticWorkerDnsLookup = (hostname: string) => Promise<DnsLookupAddress[]>

export type ValidatedStaticWorkerAttachUrl = {
  ok: true
  url: string
  resolvedAddresses: DnsLookupAddress[]
}

export function canAttachStaticWorkerForMember(payload: { currentMember: { isOwner: boolean; role: string } }) {
  return payload.currentMember.isOwner || payload.currentMember.role.split(",").map((role) => role.trim()).includes("admin")
}

export function canReadStaticWorkerTokensForMember(payload: {
  worker: Pick<WorkerRow, "created_by_user_id">
  userId: UserId
  currentMember?: { isOwner: boolean; role: string } | null
}) {
  return payload.worker.created_by_user_id === payload.userId || (payload.currentMember ? canAttachStaticWorkerForMember({ currentMember: payload.currentMember }) : false)
}

function parseIpv4(value: string) {
  const parts = value.split(".")
  if (parts.length !== 4) {
    return null
  }
  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null
    }
    const octet = Number(part)
    if (octet < 0 || octet > 255) {
      return null
    }
    result = (result << 8) + octet
  }
  return result >>> 0
}

function ipv4InCidr(host: string, cidr: string) {
  const [base, prefixRaw] = cidr.split("/")
  const ip = parseIpv4(host)
  const baseIp = parseIpv4(base ?? "")
  const prefix = Number(prefixRaw)
  if (ip === null || baseIp === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ip & mask) === (baseIp & mask)
}

function parseIpv6(value: string): bigint | null {
  const normalized = value.toLowerCase()
  const zoneIndex = normalized.indexOf("%")
  const withoutZone = zoneIndex === -1 ? normalized : normalized.slice(0, zoneIndex)
  const [headRaw, tailRaw, extra] = withoutZone.split("::")
  if (extra !== undefined) {
    return null
  }

  const parsePart = (part: string) => {
    if (!part) {
      return [] as number[]
    }
    const entries = part.split(":")
    const words: number[] = []
    for (const entry of entries) {
      if (!entry) {
        return null
      }
      if (entry.includes(".")) {
        const ipv4 = parseIpv4(entry)
        if (ipv4 === null) {
          return null
        }
        words.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(entry)) {
        return null
      }
      words.push(Number.parseInt(entry, 16))
    }
    return words
  }

  const head = parsePart(headRaw ?? "")
  const tail = parsePart(tailRaw ?? "")
  if (!head || !tail) {
    return null
  }

  const missing = tailRaw === undefined ? 0 : 8 - head.length - tail.length
  if (missing < 0) {
    return null
  }
  const words = [...head, ...Array.from({ length: missing }, () => 0), ...tail]
  if (words.length !== 8) {
    return null
  }

  return words.reduce((result, word) => (result << 16n) + BigInt(word), 0n)
}

function ipv6InCidr(host: string, cidr: string) {
  const [base, prefixRaw] = cidr.split("/")
  const ip = parseIpv6(host)
  const baseIp = parseIpv6(base ?? "")
  const prefix = Number(prefixRaw)
  if (ip === null || baseIp === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
    return false
  }
  const hostBits = 128 - prefix
  const mask = prefix === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(hostBits)) - 1n)
  return (ip & mask) === (baseIp & mask)
}

function ipInCidr(host: string, cidr: string) {
  return isIP(host) === 4 ? ipv4InCidr(host, cidr) : isIP(host) === 6 ? ipv6InCidr(host, cidr) : false
}

function isPrivateIpv4(hostname: string) {
  const ip = parseIpv4(hostname)
  if (ip === null) {
    return false
  }
  return ipv4InCidr(hostname, "10.0.0.0/8")
    || ipv4InCidr(hostname, "172.16.0.0/12")
    || ipv4InCidr(hostname, "192.168.0.0/16")
    || ipv4InCidr(hostname, "127.0.0.0/8")
    || ipv4InCidr(hostname, "169.254.0.0/16")
    || ip === 0
}

function isUnsafeIpv6(hostname: string) {
  const ip = parseIpv6(hostname)
  if (ip === null) {
    return false
  }
  return ip === 0n
    || ip === 1n
    || ipv6InCidr(hostname, "fc00::/7")
    || ipv6InCidr(hostname, "fe80::/10")
    || ipv6InCidr(hostname, "::ffff:0:0/96")
}

function isUnsafeAddress(hostname: string) {
  return isPrivateIpv4(hostname) || isUnsafeIpv6(hostname)
}

function isLocalHostname(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized.endsWith(".local") || normalized.endsWith(".localhost")
}

export function validateStaticWorkerAttachUrl(value: string, policy: StaticWorkerAttachUrlPolicy) {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return { ok: false as const, message: "Worker URL must be a valid URL." }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false as const, message: "Worker URL must use http or https." }
  }
  if (parsed.username || parsed.password) {
    return { ok: false as const, message: "Worker URL must not include credentials." }
  }
  if (parsed.search || parsed.hash) {
    return { ok: false as const, message: "Worker URL must not include query parameters or fragments." }
  }

  const hostname = parsed.hostname.toLowerCase()
  const allowedHosts = new Set(policy.allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean))
  const hostExplicitlyAllowed = allowedHosts.has(hostname)
  const cidrAllowed = policy.allowedCidrs.some((cidr) => ipInCidr(hostname, cidr.trim()))
  const cidrPolicyPresent = policy.allowedCidrs.some((cidr) => cidr.trim())
  const privateOrLocal = isUnsafeAddress(hostname) || isLocalHostname(hostname)

  if (privateOrLocal && !policy.allowPrivate && !hostExplicitlyAllowed && !cidrAllowed && !(isLocalHostname(hostname) && cidrPolicyPresent)) {
    return {
      ok: false as const,
      message: "Private and LAN worker URLs require explicit on-prem attach policy or an allowed host/CIDR.",
    }
  }

  return { ok: true as const, url: normalizeWorkerRuntimeUrl(value), resolvedAddresses: [] as DnsLookupAddress[] }
}

async function defaultDnsLookup(hostname: string) {
  if (isIP(hostname)) {
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
  }
  return dnsLookup(hostname, { all: true }) as Promise<DnsLookupAddress[]>
}

export async function validateResolvedStaticWorkerAttachUrl(
  value: string,
  policy: StaticWorkerAttachUrlPolicy,
  lookup: StaticWorkerDnsLookup = defaultDnsLookup,
) {
  const basic = validateStaticWorkerAttachUrl(value, policy)
  if (!basic.ok) {
    return basic
  }

  const parsed = new URL(basic.url)
  const hostname = parsed.hostname.toLowerCase()
  const allowedHosts = new Set(policy.allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean))
  const hostExplicitlyAllowed = allowedHosts.has(hostname)

  let addresses: DnsLookupAddress[]
  try {
    addresses = await lookup(hostname)
  } catch {
    return { ok: false as const, message: "Worker URL hostname could not be resolved." }
  }

  if (addresses.length === 0) {
    return { ok: false as const, message: "Worker URL hostname could not be resolved." }
  }

  if (parsed.protocol === "https:" && !isIP(hostname) && !hostExplicitlyAllowed) {
    return {
      ok: false as const,
      message: "HTTPS static worker attach hostnames must be explicitly allowed by on-prem attach policy.",
    }
  }

  for (const entry of addresses) {
    const address = entry.address.toLowerCase()
    const cidrAllowed = policy.allowedCidrs.some((cidr) => ipInCidr(address, cidr.trim()))
    if (isUnsafeAddress(address) && !policy.allowPrivate && !cidrAllowed) {
      return {
        ok: false as const,
        message: "Worker URL resolves to a private, loopback, link-local, or metadata address that is not explicitly allowed.",
      }
    }
  }

  return { ...basic, resolvedAddresses: addresses }
}

export function parseUserId(value: string): UserId {
  return normalizeDenTypeId("user", value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const normalizeUrl = normalizeWorkerRuntimeUrl
const STATIC_PROVISIONING_LOCK_NAME = "den_static_provisioner_assignment"

function parseWorkspaceSelection(payload: unknown): { workspaceId: string; openworkUrl: string } | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return null
  }

  const activeId = typeof payload.activeId === "string" ? payload.activeId : null
  let workspaceId = activeId

  if (!workspaceId) {
    for (const item of payload.items) {
      if (isRecord(item) && typeof item.id === "string" && item.id.trim()) {
        workspaceId = item.id
        break
      }
    }
  }

  const baseUrl = typeof payload.baseUrl === "string" ? normalizeUrl(payload.baseUrl) : ""
  if (!workspaceId || !baseUrl) {
    return null
  }

  return {
    workspaceId,
    openworkUrl: `${baseUrl}/w/${encodeURIComponent(workspaceId)}`,
  }
}

async function resolveConnectUrlFromWorker(instanceUrl: string, clientToken: string, staticWorker: boolean) {
  const baseUrl = normalizeUrl(instanceUrl)
  if (!baseUrl || !clientToken.trim()) {
    return null
  }

  try {
    const staticTarget = staticWorker ? await resolveStaticRuntimeFetchTarget(baseUrl) : null
    if (staticWorker && !staticTarget) {
      return null
    }
    const response = await fetchStaticHttpTarget(`${staticTarget?.url ?? baseUrl}/workspaces`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(env.staticWorkers.healthcheckTimeoutMs),
      headers: {
        Accept: "application/json",
        ...(staticTarget?.headers ?? {}),
        Authorization: `Bearer ${clientToken.trim()}`,
      },
    })

    if (!response.ok) {
      return null
    }

    const payload = (await response.json()) as unknown
    const selected = parseWorkspaceSelection({
      ...(isRecord(payload) ? payload : {}),
      baseUrl,
    })
    return selected
  } catch {
    return null
  }
}

function getConnectUrlCandidates(workerId: WorkerId, instanceUrl: string | null) {
  const candidates: string[] = []
  const vanityHostname = customDomainForWorker(workerId, env.render.workerPublicDomainSuffix)
  if (vanityHostname) {
    candidates.push(`https://${vanityHostname}`)
  }

  if (instanceUrl) {
    const normalized = normalizeUrl(instanceUrl)
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized)
    }
  }

  return candidates
}

export function readBearerToken(value: string | undefined) {
  const trimmed = value?.trim() ?? ""
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return null
  }
  const tokenValue = trimmed.slice(7).trim()
  return tokenValue ? tokenValue : null
}

export function parseHeartbeatTimestamp(value: string | null | undefined) {
  if (!value) {
    return null
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return parsed
}

export function newerDate(current: Date | null | undefined, candidate: Date | null | undefined) {
  if (!candidate) {
    return current ?? null
  }
  if (!current) {
    return candidate
  }
  return candidate.getTime() > current.getTime() ? candidate : current
}

async function resolveConnectUrlFromCandidates(workerId: WorkerId, instanceUrl: string | null, clientToken: string, staticWorker: boolean) {
  const candidates = getConnectUrlCandidates(workerId, instanceUrl)
  for (const candidate of candidates) {
    const resolved = await resolveConnectUrlFromWorker(candidate, clientToken, staticWorker)
    if (resolved) {
      return resolved
    }
  }
  return null
}

async function getWorkerRuntimeAccess(workerId: WorkerId) {
  const instance = await getLatestWorkerInstance(workerId)
  const tokenRows = await db
    .select()
    .from(WorkerTokenTable)
    .where(and(eq(WorkerTokenTable.worker_id, workerId), isNull(WorkerTokenTable.revoked_at)))
    .orderBy(asc(WorkerTokenTable.created_at))

  const hostToken = tokenRows.find((entry) => entry.scope === "host")?.token ?? null
  const clientToken = tokenRows.find((entry) => entry.scope === "client")?.token ?? null
  if (!instance?.url || !hostToken || !clientToken) {
    return null
  }

  return {
    instance,
    hostToken,
    clientToken,
    candidates: getConnectUrlCandidates(workerId, instance.url),
  }
}

function formatIpForUrl(address: string) {
  return address.includes(":") ? `[${address}]` : address
}

async function resolveStaticRuntimeFetchTarget(url: string) {
  const validated = await validateResolvedStaticWorkerAttachUrl(url, {
    allowPrivate: env.staticWorkers.allowPrivateAttach,
    allowedHosts: env.staticWorkers.attachAllowedHosts,
    allowedCidrs: env.staticWorkers.attachAllowedCidrs,
  })
  if (!validated.ok) {
    return null
  }

  const original = new URL(validated.url)
  const resolvedAddress = original.protocol === "http:" ? validated.resolvedAddresses[0]?.address : undefined
  if (!resolvedAddress) {
    return { url: validated.url, headers: {} as Record<string, string> }
  }

  const pinned = new URL(validated.url)
  pinned.hostname = formatIpForUrl(resolvedAddress)
  const hostHeader = original.port ? `${original.hostname}:${original.port}` : original.hostname
  return {
    url: pinned.toString().replace(/\/+$/, ""),
    headers: { Host: hostHeader },
  }
}

export async function fetchWorkerRuntimeJson(input: {
  workerId: WorkerId
  path: string
  method?: "GET" | "POST"
  body?: unknown
  auth?: "client" | "host"
}) {
  const access = await getWorkerRuntimeAccess(input.workerId)
  if (!access) {
    return {
      ok: false as const,
      status: 409,
      payload: {
        error: "worker_runtime_unavailable",
        message: "Worker runtime access is not ready yet. Wait for provisioning to finish and try again.",
      },
    }
  }

  let lastPayload: unknown = null
  let lastStatus = 502

  for (const candidate of access.candidates) {
    try {
      const staticTarget = access.instance.provider === "static"
        ? await resolveStaticRuntimeFetchTarget(candidate)
        : null
      if (access.instance.provider === "static" && !staticTarget) {
        lastPayload = { message: "Static worker runtime URL failed attach policy validation." }
        continue
      }
      const baseUrl = staticTarget?.url ?? normalizeUrl(candidate)
      const response = await fetchStaticHttpTarget(`${baseUrl}${input.path}`, {
        method: input.method ?? "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(env.staticWorkers.healthcheckTimeoutMs),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(staticTarget?.headers ?? {}),
          ...(input.auth === "client"
            ? { Authorization: `Bearer ${access.clientToken}` }
            : { "X-OpenWork-Host-Token": access.hostToken }),
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      })

      const text = await response.text()
      lastStatus = response.status
      try {
        lastPayload = text ? JSON.parse(text) : null
      } catch {
        lastPayload = text ? { message: text } : null
      }

      if (response.ok) {
        return { ok: true as const, status: response.status, payload: lastPayload }
      }
    } catch (error) {
      lastPayload = { message: error instanceof Error ? error.message : "worker_request_failed" }
    }
  }

  return { ok: false as const, status: lastStatus, payload: lastPayload }
}

export async function countUserCloudWorkers(userId: UserId) {
  const rows = await db
    .select({ id: WorkerTable.id })
    .from(WorkerTable)
    .where(and(eq(WorkerTable.created_by_user_id, userId), eq(WorkerTable.destination, "cloud")))
    .limit(2)

  return rows.length
}

export async function getLatestWorkerInstance(workerId: WorkerId) {
  const rows = await db
    .select()
    .from(WorkerInstanceTable)
    .where(eq(WorkerInstanceTable.worker_id, workerId))
    .orderBy(desc(WorkerInstanceTable.created_at))
    .limit(1)

  return rows[0] ?? null
}

async function getUnavailableStaticWorkerUrls() {
  if (env.provisionerMode !== "static") {
    return []
  }

  const rows = await db
    .select({ url: WorkerInstanceTable.url })
    .from(WorkerInstanceTable)
    .where(
      and(
        eq(WorkerInstanceTable.provider, "static"),
        inArray(WorkerInstanceTable.status, ["provisioning", "healthy"]),
      ),
    )

  return rows.map((row) => normalizeUrl(row.url)).filter(Boolean)
}

function staticReservationStaleBefore() {
  return new Date(Date.now() - env.staticWorkers.reservationTtlMs)
}

async function markStaleStaticReservationsFailed(tx: StaticAssignmentDb) {
  const staleRows = await tx
    .select({ workerId: WorkerInstanceTable.worker_id })
    .from(WorkerInstanceTable)
    .where(
      and(
        eq(WorkerInstanceTable.provider, "static"),
        eq(WorkerInstanceTable.status, "provisioning"),
        sql`${WorkerInstanceTable.updated_at} < ${staticReservationStaleBefore()}`,
      ),
    )
  const staleWorkerIds = [...new Set(staleRows.map((row) => row.workerId))]
  if (staleWorkerIds.length > 0) {
    await tx
      .update(WorkerTable)
      .set({ status: "failed" })
      .where(inArray(WorkerTable.id, staleWorkerIds))
  }

  await tx
    .update(WorkerInstanceTable)
    .set({ status: "failed" })
    .where(
      and(
        eq(WorkerInstanceTable.provider, "static"),
        eq(WorkerInstanceTable.status, "provisioning"),
        sql`${WorkerInstanceTable.updated_at} < ${staticReservationStaleBefore()}`,
      ),
    )
}

export function readMySqlLockAcquired(result: unknown) {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result
  if (!Array.isArray(rows)) {
    return 0
  }
  const first = rows[0]
  if (first && typeof first === "object" && "acquired" in first) {
    return Number((first as { acquired: unknown }).acquired)
  }
  return 0
}

function getMySqlLockPool(): MySqlLockPool {
  if (dbClient && typeof dbClient === "object" && "getConnection" in dbClient && typeof dbClient.getConnection === "function") {
    return dbClient as MySqlLockPool
  }
  throw new Error("Static worker assignment locking requires MySQL DB_MODE")
}

export async function withStaticAssignmentLockUsing<T>(input: {
  pool: MySqlLockPool
  transaction: (run: (tx: StaticAssignmentDb) => Promise<T>) => Promise<T>
  run: (tx: StaticAssignmentDb) => Promise<T>
}) {
  const connection = await input.pool.getConnection()
  let lockAcquired = false

  try {
    const lockRows = await connection.query(`SELECT GET_LOCK(?, 10) AS acquired`, [STATIC_PROVISIONING_LOCK_NAME])
    const acquired = readMySqlLockAcquired(lockRows)

    if (acquired !== 1) {
      throw new Error("Timed out waiting for static worker assignment lock")
    }

    lockAcquired = true
    return await input.transaction(input.run)
  } finally {
    try {
      if (lockAcquired) {
        await connection.query(`SELECT RELEASE_LOCK(?)`, [STATIC_PROVISIONING_LOCK_NAME])
      }
    } finally {
      connection.release()
    }
  }
}

export async function withStaticAssignmentMutex<T>(run: () => Promise<T>) {
  const connection = await getMySqlLockPool().getConnection()
  let lockAcquired = false

  try {
    const lockRows = await connection.query(`SELECT GET_LOCK(?, 10) AS acquired`, [STATIC_PROVISIONING_LOCK_NAME])
    const acquired = readMySqlLockAcquired(lockRows)

    if (acquired !== 1) {
      throw new Error("Timed out waiting for static worker assignment lock")
    }

    lockAcquired = true
    return await run()
  } finally {
    try {
      if (lockAcquired) {
        await connection.query(`SELECT RELEASE_LOCK(?)`, [STATIC_PROVISIONING_LOCK_NAME])
      }
    } finally {
      connection.release()
    }
  }
}

export async function withStaticAssignmentLock<T>(run: (tx: StaticAssignmentDb) => Promise<T>) {
  return withStaticAssignmentLockUsing({
    pool: getMySqlLockPool(),
    transaction: (callback) => db.transaction(callback),
    run,
  })
}

async function reserveStaticWorkerInstance(input: {
  workerId: WorkerId
  orgId: OrgId
  staticLockHeld?: boolean
}) {
  const reserve = async (tx: StaticAssignmentDb) => {
    const workerLimit = await getOrganizationLimitStatus(input.orgId, "workers")
    if (workerLimit.currentCount > workerLimit.limit) {
      throw new Error("Organization worker limit exceeded")
    }

    await markStaleStaticReservationsFailed(tx)

    const rows = await tx
      .select({ url: WorkerInstanceTable.url })
      .from(WorkerInstanceTable)
      .where(
        and(
          eq(WorkerInstanceTable.provider, "static"),
          inArray(WorkerInstanceTable.status, ["provisioning", "healthy"]),
        ),
      )

    const url = normalizeStaticWorkerUrl(selectStaticWorkerUrlFromPool(input.workerId, {
      ...env.staticWorkers,
      unavailableUrls: rows.map((row) => row.url),
    }))
    const tokens = getStaticWorkerTokenPairForUrl(url, env.staticWorkers)
    const instanceId = createDenTypeId("workerInstance")

    await tx.insert(WorkerInstanceTable).values({
      id: instanceId,
      worker_id: input.workerId,
      provider: "static",
      region: "on-prem",
      url,
      status: "provisioning",
    })

    await tx
      .update(WorkerTokenTable)
      .set({ token: tokens.hostToken })
      .where(and(eq(WorkerTokenTable.worker_id, input.workerId), eq(WorkerTokenTable.scope, "host")))

    await tx
      .update(WorkerTokenTable)
      .set({ token: tokens.clientToken })
      .where(and(eq(WorkerTokenTable.worker_id, input.workerId), eq(WorkerTokenTable.scope, "client")))

    return { instanceId, url, tokens }
  }

  return input.staticLockHeld ? db.transaction(reserve) : withStaticAssignmentLock(reserve)
}

export async function reserveStaticWorkerForCreatedWorker(input: {
  workerId: WorkerId
  orgId: OrgId
}) {
  return reserveStaticWorkerInstance({ workerId: input.workerId, orgId: input.orgId, staticLockHeld: true })
}

export async function verifyReservedStaticWorker(input: {
  workerId: WorkerId
  reservation: Awaited<ReturnType<typeof reserveStaticWorkerInstance>>
}) {
  try {
    const staticTarget = await resolveStaticRuntimeFetchTarget(input.reservation.url)
    if (!staticTarget) {
      throw new Error("Static worker URL failed attach policy validation")
    }
    await checkStaticWorkerHealth(staticTarget, env.staticWorkers)
    await verifyStaticWorkerRuntimeAccess(staticTarget, input.reservation.tokens, env.staticWorkers)

    await db.transaction(async (tx) => {
      await tx
        .update(WorkerTable)
        .set({ status: "healthy" })
        .where(eq(WorkerTable.id, input.workerId))

      await tx
        .update(WorkerInstanceTable)
        .set({ status: "healthy" })
        .where(eq(WorkerInstanceTable.id, input.reservation.instanceId))
    })
  } catch (error) {
    await db.transaction(async (tx) => {
      await tx
        .update(WorkerTable)
        .set({ status: "failed" })
        .where(eq(WorkerTable.id, input.workerId))

      await tx
        .update(WorkerInstanceTable)
        .set({ status: "failed" })
        .where(eq(WorkerInstanceTable.id, input.reservation.instanceId))
    })
    throw error
  }
}

async function continueStaticCloudProvisioning(input: {
  workerId: WorkerId
  name: string
  orgId: OrgId
  staticLockHeld?: boolean
  hostToken: string
  clientToken: string
  activityToken: string
}) {
  const reservation = await reserveStaticWorkerInstance({ workerId: input.workerId, orgId: input.orgId, staticLockHeld: input.staticLockHeld })
  await verifyReservedStaticWorker({ workerId: input.workerId, reservation })
}

export function toInstanceResponse(instance: WorkerInstanceRow | null) {
  if (!instance) {
    return null
  }

  return {
    provider: instance.provider,
    region: instance.region,
    url: instance.url,
    status: instance.status,
    createdAt: instance.created_at,
    updatedAt: instance.updated_at,
  }
}

export function toWorkerResponse(row: WorkerRow, userId: string) {
  return {
    id: row.id,
    orgId: row.org_id,
    createdByUserId: row.created_by_user_id,
    isMine: row.created_by_user_id === userId,
    name: row.name,
    description: row.description,
    destination: row.destination,
    status: row.status,
    imageVersion: row.image_version,
    workspacePath: row.workspace_path,
    sandboxBackend: row.sandbox_backend,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function continueCloudProvisioning(input: {
  workerId: WorkerId
  name: string
  orgId: OrgId
  staticLockHeld?: boolean
  hostToken: string
  clientToken: string
  activityToken: string
}) {
  try {
    if (env.provisionerMode === "static") {
      await continueStaticCloudProvisioning(input)
      return
    }

    const provisioned = await provisionWorker({
      workerId: input.workerId,
      name: input.name,
      hostToken: input.hostToken,
      clientToken: input.clientToken,
      activityToken: input.activityToken,
      unavailableStaticWorkerUrls: await getUnavailableStaticWorkerUrls(),
    })

    await db
      .update(WorkerTable)
      .set({ status: provisioned.status })
      .where(eq(WorkerTable.id, input.workerId))

    await db.insert(WorkerInstanceTable).values({
      id: createDenTypeId("workerInstance"),
      worker_id: input.workerId,
      provider: provisioned.provider,
      region: provisioned.region,
      url: provisioned.url,
      status: provisioned.status,
    })
  } catch (error) {
    await db
      .update(WorkerTable)
      .set({ status: "failed" })
      .where(eq(WorkerTable.id, input.workerId))

    const message = error instanceof Error ? error.message : "provisioning_failed"
    console.error(`[workers] provisioning failed for ${input.workerId}: ${message}`)
    if (env.provisionerMode === "static") {
      throw error
    }
  }
}

export async function requireCloudAccessOrPayment(input: {
  userId: UserId
  email: string
  name: string
}) {
  return requireCloudWorkerAccess(input)
}

export async function getWorkerTokensAndConnect(worker: WorkerRow) {
  const tokenRows = await db
    .select()
    .from(WorkerTokenTable)
    .where(and(eq(WorkerTokenTable.worker_id, worker.id), isNull(WorkerTokenTable.revoked_at)))
    .orderBy(asc(WorkerTokenTable.created_at))

  const hostToken = tokenRows.find((entry) => entry.scope === "host")?.token ?? null
  const clientToken = tokenRows.find((entry) => entry.scope === "client")?.token ?? null

  if (!hostToken || !clientToken) {
    return {
      error: {
        status: 409,
        body: {
          error: "worker_tokens_unavailable",
          message: "Worker tokens are missing for this worker. Launch a new worker and try again.",
        },
      },
    }
  }

  const instance = await getLatestWorkerInstance(worker.id)
  const connect = await resolveConnectUrlFromCandidates(worker.id, instance?.url ?? null, clientToken, instance?.provider === "static")

  return {
    tokens: {
      owner: hostToken,
      host: hostToken,
      client: clientToken,
    },
    connect: connect ?? (instance?.url ? { openworkUrl: instance.url, workspaceId: null } : null),
  }
}

export async function deleteWorkerCascade(worker: WorkerRow) {
  const instance = await getLatestWorkerInstance(worker.id)

  if (worker.destination === "cloud") {
    try {
      await deprovisionWorker({
        workerId: worker.id,
        instanceUrl: instance?.url ?? null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "deprovision_failed"
      console.warn(`[workers] deprovision warning for ${worker.id}: ${message}`)
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(WorkerTokenTable).where(eq(WorkerTokenTable.worker_id, worker.id))
    await tx.delete(DaytonaSandboxTable).where(eq(DaytonaSandboxTable.worker_id, worker.id))
    await tx.delete(WorkerInstanceTable).where(eq(WorkerInstanceTable.worker_id, worker.id))
    await tx.delete(WorkerBundleTable).where(eq(WorkerBundleTable.worker_id, worker.id))
    await tx.delete(AuditEventTable).where(eq(AuditEventTable.worker_id, worker.id))
    await tx.delete(WorkerTable).where(eq(WorkerTable.id, worker.id))
  })
}

export async function getWorkerByIdForOrg(workerId: WorkerId, orgId: OrgId) {
  const rows = await db
    .select()
    .from(WorkerTable)
    .where(and(eq(WorkerTable.id, workerId), eq(WorkerTable.org_id, orgId)))
    .limit(1)

  return rows[0] ?? null
}
