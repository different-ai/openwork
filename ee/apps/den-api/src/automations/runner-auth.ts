import { createHmac, timingSafeEqual } from "node:crypto"
import { env } from "../env.js"

const TOKEN_TTL_MS = 12 * 60 * 60_000

export type AutomationRunnerIdentity = {
  organizationId: string
  ownerMemberId: string
  runnerId: string
  expiresAt: number
}

export class AutomationRunnerAuth {
  private readonly connections = new Map<string, number>()
  constructor(private readonly secret = env.betterAuthSecret) {}

  private sign(payload: string) {
    return createHmac("sha256", this.secret)
      .update(`openwork-automation-runner-v1.${payload}`)
      .digest("base64url")
  }

  issue(scope: Omit<AutomationRunnerIdentity, "expiresAt">) {
    const expiresAt = Date.now() + TOKEN_TTL_MS
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      o: scope.organizationId,
      m: scope.ownerMemberId,
      r: scope.runnerId,
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
      if (
        decoded.v !== 1
        || typeof decoded.o !== "string"
        || typeof decoded.m !== "string"
        || typeof decoded.r !== "string"
        || typeof decoded.e !== "number"
        || !Number.isSafeInteger(decoded.e)
        || decoded.e <= Date.now()
      ) return null
      return {
        organizationId: decoded.o,
        ownerMemberId: decoded.m,
        runnerId: decoded.r,
        expiresAt: decoded.e,
      }
    } catch {
      return null
    }
  }

  private connectionKey(scope: Pick<AutomationRunnerIdentity, "organizationId" | "ownerMemberId">) {
    return `${scope.organizationId}:${scope.ownerMemberId}`
  }

  connected(scope: AutomationRunnerIdentity) {
    const key = this.connectionKey(scope)
    this.connections.set(key, (this.connections.get(key) ?? 0) + 1)
    return () => {
      const remaining = (this.connections.get(key) ?? 1) - 1
      if (remaining > 0) this.connections.set(key, remaining)
      else this.connections.delete(key)
    }
  }

  hasConnected(scope: Pick<AutomationRunnerIdentity, "organizationId" | "ownerMemberId">) {
    return (this.connections.get(this.connectionKey(scope)) ?? 0) > 0
  }
}

export const automationRunnerAuth = new AutomationRunnerAuth()
