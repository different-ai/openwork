import { setTimeout as delay } from "node:timers/promises"
import type { checkFixedWindowRateLimit } from "../../utils/rate-limit.js"

const active = new Map<string, number>()
const MAX_ACTIVE = 4
const MAX_PER_MINUTE = 60

function limited(seconds: number) {
  return new Response(null, { status: 429, headers: { "Retry-After": String(seconds) } })
}

function retrySeconds(value: string | null) {
  if (!value) return null
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : null
}

export async function fetchGoogleSheet(memberId: string, method: string, signal: AbortSignal,
  send: () => Promise<Response>, claim: typeof checkFixedWindowRateLimit): Promise<Response> {
  const count = active.get(memberId) ?? 0
  if (count >= MAX_ACTIVE) return limited(1)
  active.set(memberId, count + 1)
  const read = method === "GET"
  const key = `sheets:${read ? "read" : "write"}:${memberId}`
  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      const wait = await claim(key, MAX_PER_MINUTE, 60_000, Date.now())
      if (wait !== null) return limited(wait)
      const response = await send()
      if (response.status !== 429) return response
      const seconds = retrySeconds(response.headers.get("Retry-After"))
      await response.body?.cancel()
      if (!read || attempt > 0 || (seconds !== null && seconds > 2)) return limited(seconds ?? 60)
      await delay((seconds ?? 1) * 1000 + Math.random() * 250, undefined, { signal })
    }
  } finally {
    const remaining = (active.get(memberId) ?? 1) - 1
    if (remaining) active.set(memberId, remaining)
    else active.delete(memberId)
  }
}
