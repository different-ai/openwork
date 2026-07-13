import { createHmac, timingSafeEqual } from "node:crypto"

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url")
}

function createSignedToken(kind: "access" | "session", secret: string, lifetimeMs: number, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ exp: now + lifetimeMs, kind, version: 1 }), "utf8").toString("base64url")
  return `${payload}.${signature(payload, secret)}`
}

function verifySignedToken(token: string, secret: string, kind: "access" | "session", now = Date.now()): boolean {
  const [payload, suppliedSignature, extra] = token.split(".")
  if (!payload || !suppliedSignature || extra !== undefined) return false
  const expected = Buffer.from(signature(payload, secret))
  const supplied = Buffer.from(suppliedSignature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && "version" in value && value.version === 1
      && "kind" in value && value.kind === kind
      && "exp" in value && typeof value.exp === "number" && value.exp >= now
  } catch {
    return false
  }
}

export function createSessionToken(secret: string, now = Date.now()): string {
  return createSignedToken("session", secret, 60 * 60 * 1000, now)
}

export function verifySessionToken(token: string, secret: string, now = Date.now()): boolean {
  return verifySignedToken(token, secret, "session", now)
}

export function createAccessToken(secret: string, now = Date.now()): string {
  return createSignedToken("access", secret, 5 * 60 * 1000, now)
}

export function verifyAccessToken(token: string, secret: string, now = Date.now()): boolean {
  return verifySignedToken(token, secret, "access", now)
}
