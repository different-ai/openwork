import type { HeadlessServiceHealth } from "@openwork/types/den/service-health"
import type { Config } from "./config.js"

export type ServiceHealthConfig = Pick<Config, "model" | "selfResume">

function expectedOrigin(value: string) {
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(value) || /[\s\\,@%]/u.test(value)) return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null
    if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return url.origin
  } catch {
  }
  return null
}

function denOriginMatches(expected: string | null, configured: string | undefined) {
  if (expected === null || configured === undefined) return null
  const origin = expectedOrigin(expected)
  if (!origin) return false
  try {
    const actual = new URL(configured)
    return !actual.username && !actual.password && expectedOrigin(actual.origin) === origin
  } catch {
    return false
  }
}

export function serviceHealthResponse(request: Request, config?: ServiceHealthConfig) {
  const body: HeadlessServiceHealth = {
    version: 1,
    service: "headless-runner",
    modelConfigured: Boolean(config?.model.protocol && config.model.baseUrl && config.model.model),
    resumeConfigured: Boolean(config?.selfResume),
    denOriginMatches: denOriginMatches(request.headers.get("X-OpenWork-Den-Origin"), config?.selfResume?.denApiUrl),
  }
  return Response.json(body, { headers: { "Cache-Control": "no-store" } })
}
