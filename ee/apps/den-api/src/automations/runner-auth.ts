import { createHmac, timingSafeEqual } from "node:crypto"
import {
  automationDesktopRunnerCapabilitySchema,
  type AutomationDesktopRunnerCapability,
} from "@openwork/types/automations"
import { z } from "zod"
import { env } from "../env.js"
import { firstForwardedValue, publicRequestUrl, trustedForwardedOrigin } from "../request-url.js"

const TOKEN_TTL_MS = 12 * 60 * 60_000
const TOKEN_ROUTE_SUFFIX = "/v1/automation-runners/token"
const DEN_WEB_PROXY_PREFIX = "/api/den"

export type AutomationRunnerIdentity = {
  organizationId: string
  ownerMemberId: string
  runnerId: string
  capabilities: AutomationDesktopRunnerCapability[]
  audience: string | null
  expiresAt: number
}

function normalizeRunnerAudience(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null
    parsed.search = ""
    parsed.hash = ""
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "")
  } catch {
    return null
  }
}

export function automationRunnerAudienceFromRequestUrl(requestUrl: string): string {
  const parsed = new URL(requestUrl)
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.pathname.endsWith(TOKEN_ROUTE_SUFFIX)) {
    throw new Error("automation_runner_audience_invalid")
  }
  parsed.pathname = parsed.pathname.slice(0, -TOKEN_ROUTE_SUFFIX.length) || "/"
  parsed.search = ""
  parsed.hash = ""
  const audience = normalizeRunnerAudience(parsed.toString())
  if (!audience) throw new Error("automation_runner_audience_invalid")
  return audience
}

/**
 * Bind proxied runner credentials to the public Den route the desktop will
 * actually use. The Den Web proxy strips caller-supplied forwarding headers
 * and writes its own, while trustedForwardedOrigin limits the destination to
 * configured first-party origins. Direct API requests keep their request URL,
 * resolved through the public scheme because hosted deployments terminate TLS
 * ahead of this process: desktops reject a plaintext runner destination, so an
 * http audience would silently disconnect every runner behind such a proxy.
 */
export function automationRunnerAudienceFromRequest(
  request: Request,
  options: { trustedOrigins: readonly string[] },
): string {
  const forwardedPrefix = firstForwardedValue(request.headers.get("x-forwarded-prefix"))
    ?.replace(/\/+$/, "")
  if (forwardedPrefix === DEN_WEB_PROXY_PREFIX) {
    const forwarded = trustedForwardedOrigin(request, { trustedOrigins: options.trustedOrigins })
    if (forwarded) return `${forwarded.origin}${DEN_WEB_PROXY_PREFIX}`
  }
  return automationRunnerAudienceFromRequestUrl(
    publicRequestUrl(request, { trustedOrigins: options.trustedOrigins }).toString(),
  )
}

export class AutomationRunnerAuth {
  constructor(private readonly secret = env.betterAuthSecret) {}

  private sign(payload: string) {
    return createHmac("sha256", this.secret)
      .update(`openwork-automation-runner-v1.${payload}`)
      .digest("base64url")
  }

  issue(scope: Omit<AutomationRunnerIdentity, "audience" | "expiresAt">, audience: string) {
    const normalizedAudience = normalizeRunnerAudience(audience)
    if (!normalizedAudience) throw new Error("automation_runner_audience_invalid")
    const expiresAt = Date.now() + TOKEN_TTL_MS
    const payload = Buffer.from(JSON.stringify({
      v: 2,
      o: scope.organizationId,
      m: scope.ownerMemberId,
      r: scope.runnerId,
      c: scope.capabilities,
      a: normalizedAudience,
      e: expiresAt,
    })).toString("base64url")
    const token = `${payload}.${this.sign(payload)}`
    return { token, expiresAt, eventsPath: "/v1/automation-runners/events" as const }
  }

  authenticate(authorization: string | undefined): AutomationRunnerIdentity | null {
    const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "")
    const token = match?.[1]?.trim()
    if (!token) return null
    const [payload, signature, extra] = token.split(".")
    if (!payload || !signature || extra) return null
    const expected = new TextEncoder().encode(this.sign(payload))
    const actual = new TextEncoder().encode(signature)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>
      const audience = decoded.v === 2 && typeof decoded.a === "string"
        ? normalizeRunnerAudience(decoded.a)
        : null
      const parsedCapabilities = z.array(automationDesktopRunnerCapabilitySchema).max(2).safeParse(decoded.c ?? [])
      const capabilities = parsedCapabilities.success ? parsedCapabilities.data : null
      if (
        (decoded.v !== 1 && decoded.v !== 2)
        || typeof decoded.o !== "string"
        || typeof decoded.m !== "string"
        || typeof decoded.r !== "string"
        || capabilities === null
        || (decoded.v === 2 && !audience)
        || typeof decoded.e !== "number"
        || !Number.isSafeInteger(decoded.e)
        || decoded.e <= Date.now()
      ) return null
      return {
        organizationId: decoded.o,
        ownerMemberId: decoded.m,
        runnerId: decoded.r,
        capabilities,
        audience,
        expiresAt: decoded.e,
      }
    } catch {
      return null
    }
  }

}

export const automationRunnerAuth = new AutomationRunnerAuth()
