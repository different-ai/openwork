import { createHmac, timingSafeEqual } from "node:crypto"
import { diagnosticsRedisConfig } from "./config"

export const mockAuthorizationLifetimeMs = 5 * 60 * 1000
export const mockAuthorizationChallengeLifetimeMs = 2 * 60 * 1000

const redisKeyPrefix = "openwork:diagnostics:mock-authorization:v1"
const subjectPattern = /^[a-f0-9]{64}$/u

declare global {
  var __openworkDiagnosticsMockAuthorizations: Map<string, number> | undefined
}

const localAuthorizations = globalThis.__openworkDiagnosticsMockAuthorizations ??= new Map()

type RedisReply = { result?: unknown; error?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRedisReply(value: unknown): value is RedisReply {
  return isRecord(value)
}

function mockAuthorizationKey(subject: string): string {
  return `${redisKeyPrefix}:${subject}`
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
    throw new Error("The diagnostics mock authorization store rejected the operation.")
  }
  return reply.result
}

function challengeSignature(payload: string, signingSecret: string): string {
  return createHmac("sha256", signingSecret).update(payload).digest("base64url")
}

function signaturesMatch(left: string, right: string): boolean {
  const supplied = Buffer.from(left)
  const expected = Buffer.from(right)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function createMockAuthorizationChallenge(subject: string, signingSecret: string, now = Date.now()): string {
  if (!subjectPattern.test(subject)) throw new Error("Invalid diagnostics mock authorization subject.")
  const payload = Buffer.from(JSON.stringify({
    exp: now + mockAuthorizationChallengeLifetimeMs,
    kind: "diagnostics-mock-authorization",
    subject,
    version: 1,
  }), "utf8").toString("base64url")
  return `${payload}.${challengeSignature(payload, signingSecret)}`
}

export function verifyMockAuthorizationChallenge(
  challenge: string,
  signingSecret: string,
  now = Date.now(),
): string | null {
  const [payload, suppliedSignature, extra] = challenge.split(".")
  if (!payload || !suppliedSignature || extra !== undefined) return null
  if (!signaturesMatch(suppliedSignature, challengeSignature(payload, signingSecret))) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (!isRecord(value)
      || value.version !== 1
      || value.kind !== "diagnostics-mock-authorization"
      || typeof value.exp !== "number"
      || value.exp <= now
      || typeof value.subject !== "string"
      || !subjectPattern.test(value.subject)) return null
    return value.subject
  } catch {
    return null
  }
}

export function createMockAuthorizationUrl(input: {
  publicOrigin: string
  signingSecret: string
  subject: string
  now?: number
}): string {
  const url = new URL("/mcp/mock-auth", input.publicOrigin)
  url.searchParams.set("challenge", createMockAuthorizationChallenge(input.subject, input.signingSecret, input.now))
  return url.toString()
}

export async function authorizeMockSubject(subject: string, now = Date.now()): Promise<number> {
  if (!subjectPattern.test(subject)) throw new Error("Invalid diagnostics mock authorization subject.")
  const expiresAt = now + mockAuthorizationLifetimeMs
  if (!diagnosticsRedisConfig()) {
    localAuthorizations.set(subject, expiresAt)
    return expiresAt
  }
  await redisCommand(["SET", mockAuthorizationKey(subject), expiresAt, "PX", mockAuthorizationLifetimeMs])
  return expiresAt
}

export async function mockSubjectIsAuthorized(subject: string, now = Date.now()): Promise<boolean> {
  if (!subjectPattern.test(subject)) return false
  if (!diagnosticsRedisConfig()) {
    const expiresAt = localAuthorizations.get(subject)
    if (expiresAt === undefined) return false
    if (expiresAt > now) return true
    localAuthorizations.delete(subject)
    return false
  }
  const result = await redisCommand(["GET", mockAuthorizationKey(subject)])
  if (typeof result !== "string") return false
  const expiresAt = Number(result)
  return Number.isFinite(expiresAt) && expiresAt > now
}

export async function resetMockAuthorization(subject: string): Promise<void> {
  if (!subjectPattern.test(subject)) return
  localAuthorizations.delete(subject)
  if (diagnosticsRedisConfig()) await redisCommand(["DEL", mockAuthorizationKey(subject)])
}
