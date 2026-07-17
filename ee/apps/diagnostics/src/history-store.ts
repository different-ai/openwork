import type { WireExchange } from "./contracts"
import { diagnosticsRedisConfig } from "./config"

const historyKey = "openwork:diagnostics:wire-history:v1"
const historyRunsKey = "openwork:diagnostics:wire-history-runs:v1"
const maximumHistory = 200
const maximumRunHistory = 50
const retentionSeconds = 86_400

declare global {
  var __openworkDiagnosticsLocalHistory: WireExchange[] | undefined
  var __openworkDiagnosticsLocalRunHistory: Map<string, WireExchange[]> | undefined
}

const localHistory = globalThis.__openworkDiagnosticsLocalHistory ??= []
const localRunHistory = globalThis.__openworkDiagnosticsLocalRunHistory ??= new Map()

function runHistoryKey(runId: string): string {
  return `${historyKey}:run:${runId}`
}

type RedisReply = { result?: unknown; error?: string }

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
    throw new Error("The diagnostics history store rejected the operation.")
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
    throw new Error("The diagnostics history store rejected the operation.")
  }
}

function isRedisReply(value: unknown): value is RedisReply {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isWireExchange(value: unknown): value is WireExchange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return "id" in value && typeof value.id === "string"
    && "receivedAt" in value && typeof value.receivedAt === "string"
    && "request" in value && typeof value.request === "object" && value.request !== null
    && "response" in value && typeof value.response === "object" && value.response !== null
}

export async function recordWireExchange(exchange: WireExchange): Promise<void> {
  if (!diagnosticsRedisConfig()) {
    localHistory.unshift(exchange)
    localHistory.splice(maximumHistory)
    if (exchange.runId) {
      const runHistory = localRunHistory.get(exchange.runId) ?? []
      runHistory.unshift(exchange)
      runHistory.splice(maximumRunHistory)
      localRunHistory.set(exchange.runId, runHistory)
    }
    return
  }
  const commands: (readonly (string | number)[])[] = [
    ["LPUSH", historyKey, JSON.stringify(exchange)],
    ["LTRIM", historyKey, 0, maximumHistory - 1],
    ["EXPIRE", historyKey, retentionSeconds],
  ]
  if (exchange.runId) {
    const key = runHistoryKey(exchange.runId)
    commands.push(
      ["LPUSH", key, JSON.stringify(exchange)],
      ["LTRIM", key, 0, maximumRunHistory - 1],
      ["EXPIRE", key, retentionSeconds],
      ["SADD", historyRunsKey, exchange.runId],
      ["EXPIRE", historyRunsKey, retentionSeconds],
    )
  }
  await redisPipeline(commands)
}

export async function listWireHistory(runId?: string): Promise<readonly WireExchange[]> {
  if (!diagnosticsRedisConfig()) return runId ? [...(localRunHistory.get(runId) ?? [])] : [...localHistory]
  const result = await redisCommand(["LRANGE", runId ? runHistoryKey(runId) : historyKey, 0, runId ? maximumRunHistory - 1 : maximumHistory - 1])
  if (!Array.isArray(result)) return []
  const history: WireExchange[] = []
  for (const item of result) {
    if (typeof item !== "string") continue
    try {
      const parsed: unknown = JSON.parse(item)
      if (isWireExchange(parsed)) history.push(parsed)
    } catch {
      // Ignore malformed history rows rather than exposing store details.
    }
  }
  return history
}

export async function clearWireHistory(): Promise<void> {
  localHistory.splice(0, localHistory.length)
  localRunHistory.clear()
  if (!diagnosticsRedisConfig()) return
  const runIds = await redisCommand(["SMEMBERS", historyRunsKey])
  const keys = [historyKey, historyRunsKey]
  if (Array.isArray(runIds)) {
    for (const runId of runIds) {
      if (typeof runId === "string") keys.push(runHistoryKey(runId))
    }
  }
  await redisCommand(["DEL", ...keys])
}
