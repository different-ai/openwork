import type { WireExchange } from "./contracts"

const historyKey = "openwork:diagnostics:wire-history:v1"
const maximumHistory = 200
const retentionSeconds = 86_400

declare global {
  var __openworkDiagnosticsLocalHistory: WireExchange[] | undefined
}

const localHistory = globalThis.__openworkDiagnosticsLocalHistory ??= []

type RedisReply = { result?: unknown; error?: string }

function redisConfig(): { token: string; url: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
  return url && token ? { token, url: url.replace(/\/$/u, "") } : null
}

async function redisCommand(command: readonly (string | number)[]): Promise<unknown> {
  const config = redisConfig()
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
  const config = redisConfig()
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
  if (!redisConfig()) {
    localHistory.unshift(exchange)
    localHistory.splice(maximumHistory)
    return
  }
  await redisPipeline([
    ["LPUSH", historyKey, JSON.stringify(exchange)],
    ["LTRIM", historyKey, 0, maximumHistory - 1],
    ["EXPIRE", historyKey, retentionSeconds],
  ])
}

export async function listWireHistory(): Promise<readonly WireExchange[]> {
  if (!redisConfig()) return [...localHistory]
  const result = await redisCommand(["LRANGE", historyKey, 0, maximumHistory - 1])
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
  if (redisConfig()) await redisCommand(["DEL", historyKey])
}
