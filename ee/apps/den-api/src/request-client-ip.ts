import {
  clientIpRateLimitKey,
  DEFAULT_CLIENT_IP_HEADERS,
  resolveClientIp,
  withResolvedClientIp,
  type ClientIpResolution,
} from "./client-ip.js"
import { env } from "./env.js"

const options = {
  headers: DEFAULT_CLIENT_IP_HEADERS,
  trustedProxies: env.trustedProxies,
  signedClientIpSecret: env.webClientIpSecret,
}

export function resolveRequestClientIp(headers: Headers): ClientIpResolution {
  return resolveClientIp(headers, { ...options, now: Date.now() })
}

export function requestClientIpKey(headers: Headers) {
  return clientIpRateLimitKey(resolveRequestClientIp(headers))
}

/** Every request handed to Better Auth goes through here, so its rate limits see the same address as Den's. */
export function betterAuthRequest(request: Request) {
  return withResolvedClientIp(request, resolveRequestClientIp(request.headers))
}
