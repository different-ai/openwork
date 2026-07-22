import { createHmac, timingSafeEqual } from "node:crypto"
import { verifyAccessToken } from "./session"

function constantTimeEqual(left: string, right: string): boolean {
  const supplied = Buffer.from(left)
  const expected = Buffer.from(right)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function bearerAuthorized(request: Request, expectedToken: string): boolean {
  if (!expectedToken) return true
  const authorization = request.headers.get("authorization") ?? ""
  const prefix = "Bearer "
  return authorization.startsWith(prefix) && constantTimeEqual(authorization.slice(prefix.length), expectedToken)
}

export function mcpBearerAuthorized(request: Request, expectedToken: string, signingSecret: string): boolean {
  return mcpAuthorizationSubject(request, expectedToken, signingSecret) !== null
}

export function mcpAuthorizationSubject(request: Request, expectedToken: string, signingSecret: string): string | null {
  const authorization = request.headers.get("authorization") ?? ""
  if (!authorization.startsWith("Bearer ")) return null
  const token = authorization.slice(7)
  if (!constantTimeEqual(token, expectedToken) && !verifyAccessToken(token, signingSecret)) return null
  return createHmac("sha256", signingSecret).update(`diagnostics-mock-authorization:${token}`).digest("hex")
}

export function oauthBasicAuthorized(request: Request, expectedSecret: string): boolean {
  const authorization = request.headers.get("authorization") ?? ""
  if (!authorization.startsWith("Basic ")) return false
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8")
    const separator = decoded.indexOf(":")
    if (separator < 0) return false
    return constantTimeEqual(decoded.slice(0, separator), "openwork-diagnostics")
      && constantTimeEqual(decoded.slice(separator + 1), expectedSecret)
  } catch {
    return false
  }
}
