import {
  CONNECT_DIAGNOSTIC_RETENTION_SECONDS,
  storedConnectDiagnosticIncidentSchema,
  type ConnectDiagnosticIncident,
  type StoredConnectDiagnosticIncident,
} from "@openwork/types/den/connect-diagnostics"
import { diagnosticsRedisConfig } from "./config"

const incidentHistoryKey = "openwork:diagnostics:connect-incidents:v1"
const maximumIncidentHistory = 10_000
const retentionMs = CONNECT_DIAGNOSTIC_RETENTION_SECONDS * 1_000

declare global {
  var __openworkDiagnosticsConnectIncidents: StoredConnectDiagnosticIncident[] | undefined
}

const localIncidents = globalThis.__openworkDiagnosticsConnectIncidents ??= []

type RedisReply = { result?: unknown; error?: string }

function isRedisReply(value: unknown): value is RedisReply {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function redisCommand(command: readonly (string | number)[]): Promise<unknown> {
  const config = diagnosticsRedisConfig()
  if (!config) return null
  const response = await fetch(config.url, {
    body: JSON.stringify(command),
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    method: "POST",
    cache: "no-store",
  })
  const reply: unknown = await response.json()
  if (!response.ok || !isRedisReply(reply) || reply.error) {
    throw new Error("The diagnostics incident store rejected the operation.")
  }
  return reply.result
}

async function redisPipeline(commands: readonly (readonly (string | number)[])[]): Promise<void> {
  const config = diagnosticsRedisConfig()
  if (!config) return
  const response = await fetch(`${config.url}/pipeline`, {
    body: JSON.stringify(commands),
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    method: "POST",
    cache: "no-store",
  })
  const replies: unknown = await response.json()
  if (!response.ok || !Array.isArray(replies) || replies.some((reply) => !isRedisReply(reply) || reply.error)) {
    throw new Error("The diagnostics incident store rejected the operation.")
  }
}

function currentIncidents(values: readonly StoredConnectDiagnosticIncident[], now: number): StoredConnectDiagnosticIncident[] {
  const cutoff = now - retentionMs
  const deduplicated = new Map<string, StoredConnectDiagnosticIncident>()
  for (const incident of values) {
    if (Date.parse(incident.observedAt) < cutoff || deduplicated.has(incident.eventId)) continue
    deduplicated.set(incident.eventId, incident)
  }
  return [...deduplicated.values()]
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
    .slice(0, maximumIncidentHistory)
}

export async function recordConnectDiagnosticIncidents(
  incidents: readonly ConnectDiagnosticIncident[],
  receivedAt = new Date().toISOString(),
): Promise<void> {
  if (incidents.length === 0) return
  const stored = incidents.map((incident) => storedConnectDiagnosticIncidentSchema.parse({
    ...incident,
    receivedAt,
  }))
  if (!diagnosticsRedisConfig()) {
    localIncidents.unshift(...stored)
    localIncidents.splice(0, localIncidents.length, ...currentIncidents(localIncidents, Date.parse(receivedAt)))
    return
  }
  await redisPipeline([
    ...stored.map((incident) => ["LPUSH", incidentHistoryKey, JSON.stringify(incident)] as const),
    ["LTRIM", incidentHistoryKey, 0, maximumIncidentHistory - 1],
    ["EXPIRE", incidentHistoryKey, CONNECT_DIAGNOSTIC_RETENTION_SECONDS],
  ])
}

export async function listConnectDiagnosticIncidents(now = Date.now()): Promise<readonly StoredConnectDiagnosticIncident[]> {
  if (!diagnosticsRedisConfig()) return currentIncidents(localIncidents, now)
  const result = await redisCommand(["LRANGE", incidentHistoryKey, 0, maximumIncidentHistory - 1])
  if (!Array.isArray(result)) return []
  const incidents: StoredConnectDiagnosticIncident[] = []
  for (const item of result) {
    if (typeof item !== "string") continue
    try {
      const parsed = storedConnectDiagnosticIncidentSchema.safeParse(JSON.parse(item))
      if (parsed.success) incidents.push(parsed.data)
    } catch {
      // Ignore malformed stored rows instead of exposing storage details.
    }
  }
  return currentIncidents(incidents, now)
}

export async function clearConnectDiagnosticIncidents(): Promise<void> {
  localIncidents.splice(0, localIncidents.length)
  if (diagnosticsRedisConfig()) await redisCommand(["DEL", incidentHistoryKey])
}
