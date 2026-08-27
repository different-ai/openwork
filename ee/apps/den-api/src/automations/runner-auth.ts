import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import {
  AUTOMATION_MODEL_ATTENTION_CAPABILITY,
  type AutomationDesktopRunnerCapability,
} from "@openwork/types/automations"
import { firstForwardedValue, publicRequestUrl, trustedForwardedOrigin } from "../request-url.js"

const TOKEN_TTL_MS = 12 * 60 * 60_000
const TOKEN_ROUTE_SUFFIX = "/v1/automation-runners/token"
const RUNNER_ROUTE_MARKER = "/v1/automation-"
const DEN_WEB_PROXY_PREFIX = "/api/den"
const MAX_TOKEN_LENGTH = 16_384

export type AutomationRunnerIdentity = {
  organizationId: string
  ownerMemberId: string
  runnerId: string
  capabilities: AutomationDesktopRunnerCapability[]
  audience: string | null
  expiresAt: number
}

export type AutomationRunnerClaimedIdentity = {
  credentialVersion?: number
  organizationId?: string
  ownerMemberId?: string
  runnerId?: string
  expiresAt?: number
}

export type AutomationRunnerRejectionReason =
  | "missing_authorization"
  | "malformed_authorization"
  | "malformed_token"
  | "malformed_payload"
  | "bad_signature"
  | "unsupported_version"
  | "invalid_claims"
  | "expired"
  | "audience_mismatch"
  | "owner_inactive"

export type AutomationRunnerRejection = {
  reason: AutomationRunnerRejectionReason
  claims: AutomationRunnerClaimedIdentity
}

export type AutomationRunnerAuthentication =
  | { ok: true; identity: AutomationRunnerIdentity }
  | { ok: false; rejection: AutomationRunnerRejection }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function claimedIdentity(decoded: Record<string, unknown>): AutomationRunnerClaimedIdentity {
  return {
    credentialVersion: typeof decoded.v === "number" && Number.isSafeInteger(decoded.v) ? decoded.v : undefined,
    organizationId: typeof decoded.o === "string" ? decoded.o : undefined,
    ownerMemberId: typeof decoded.m === "string" ? decoded.m : undefined,
    runnerId: typeof decoded.r === "string" ? decoded.r : undefined,
    expiresAt: typeof decoded.e === "number" && Number.isSafeInteger(decoded.e) ? decoded.e : undefined,
  }
}

function reject(
  reason: AutomationRunnerRejectionReason,
  claims: AutomationRunnerClaimedIdentity = {},
): AutomationRunnerAuthentication {
  return { ok: false, rejection: { reason, claims } }
}

function fingerprint(value: string | undefined) {
  if (value === undefined) return undefined
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`
}

export function automationRunnerRejectionLogFields(rejection: AutomationRunnerRejection) {
  return {
    reason: rejection.reason,
    claimed_runner_id_fingerprint: fingerprint(rejection.claims.runnerId),
    claimed_organization_id_fingerprint: fingerprint(rejection.claims.organizationId),
    claimed_owner_member_id_fingerprint: fingerprint(rejection.claims.ownerMemberId),
    runner_auth_version: rejection.claims.credentialVersion,
    runner_auth_expires_at_ms: rejection.claims.expiresAt,
  }
}

export function automationRunnerOwnerInactiveRejection(
  identity: AutomationRunnerIdentity,
): AutomationRunnerRejection {
  return {
    reason: "owner_inactive",
    claims: {
      credentialVersion: identity.audience === null ? 1 : 2,
      organizationId: identity.organizationId,
      ownerMemberId: identity.ownerMemberId,
      runnerId: identity.runnerId,
      expiresAt: identity.expiresAt,
    },
  }
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

function automationRunnerAudienceFromApiRequestUrl(requestUrl: string): string {
  const parsed = new URL(requestUrl)
  const routeIndex = parsed.pathname.lastIndexOf(RUNNER_ROUTE_MARKER)
  if (!["http:", "https:"].includes(parsed.protocol) || routeIndex < 0) {
    throw new Error("automation_runner_audience_invalid")
  }
  parsed.pathname = parsed.pathname.slice(0, routeIndex) || "/"
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
  return automationRunnerAudienceFromApiRequestUrl(
    publicRequestUrl(request, { trustedOrigins: options.trustedOrigins }).toString(),
  )
}

export class AutomationRunnerAuth {
  constructor(private readonly secret: string) {}

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

  authenticate(authorization: string | undefined, expectedAudience: string): AutomationRunnerAuthentication {
    const normalizedAuthorization = authorization?.trim() ?? ""
    if (!normalizedAuthorization) return reject("missing_authorization")
    const match = /^Bearer\s+(.+)$/i.exec(normalizedAuthorization)
    const token = match?.[1]?.trim()
    if (!token) return reject("malformed_authorization")
    if (token.length > MAX_TOKEN_LENGTH) return reject("malformed_token")
    const [payload, signature, extra] = token.split(".")
    if (!payload || !signature || extra) return reject("malformed_token")
    let decoded: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
      if (!isRecord(parsed)) return reject("malformed_payload")
      decoded = parsed
    } catch {
      return reject("malformed_payload")
    }
    const claims = claimedIdentity(decoded)
    const expected = new TextEncoder().encode(this.sign(payload))
    const actual = new TextEncoder().encode(signature)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return reject("bad_signature", claims)
    }
    if (decoded.v !== 1 && decoded.v !== 2) return reject("unsupported_version", claims)
    const audience = decoded.v === 2 && typeof decoded.a === "string"
      ? normalizeRunnerAudience(decoded.a)
      : null
    const capabilities: AutomationDesktopRunnerCapability[] | null = decoded.c === undefined
      ? []
      : Array.isArray(decoded.c)
          && decoded.c.length <= 1
          && decoded.c.every((capability) => capability === AUTOMATION_MODEL_ATTENTION_CAPABILITY)
        ? decoded.c.map(() => AUTOMATION_MODEL_ATTENTION_CAPABILITY)
        : null
    if (
      typeof decoded.o !== "string"
      || typeof decoded.m !== "string"
      || typeof decoded.r !== "string"
      || capabilities === null
      || (decoded.v === 2 && !audience)
      || typeof decoded.e !== "number"
      || !Number.isSafeInteger(decoded.e)
    ) return reject("invalid_claims", claims)
    if (decoded.e <= Date.now()) return reject("expired", claims)
    if (decoded.v === 2 && audience !== normalizeRunnerAudience(expectedAudience)) {
      return reject("audience_mismatch", claims)
    }
    return {
      ok: true,
      identity: {
        organizationId: decoded.o,
        ownerMemberId: decoded.m,
        runnerId: decoded.r,
        capabilities,
        audience,
        expiresAt: decoded.e,
      },
    }
  }

}
