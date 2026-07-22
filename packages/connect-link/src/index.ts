import { z } from "zod"
import {
  CONNECT_LINK_AUDIENCE,
  CONNECT_LINK_ROUTE,
  CONNECT_LINK_VERSION,
  type ConnectLinkClaims,
} from "@openwork/types/connect-link"

export {
  CONNECT_LINK_ALGORITHM,
  CONNECT_LINK_AUDIENCE,
  CONNECT_LINK_DEFAULT_TTL_HOURS,
  CONNECT_LINK_EXCHANGE_TTL_MINUTES,
  CONNECT_LINK_MAX_TTL_HOURS,
  CONNECT_LINK_ROUTE,
  CONNECT_LINK_VERSION,
} from "@openwork/types/connect-link"
export type {
  ConnectLinkBrand,
  ConnectLinkClaims,
  ConnectLinkDenTarget,
  ConnectLinkOrg,
  ConnectLinkTransport,
  ConnectLinkVerifyErrorCode,
  ConnectLinkVerifyFailure,
  ConnectLinkVerifyResult,
  ConnectLinkVerifySuccess,
} from "@openwork/types/connect-link"

export const connectLinkClaimsSchema = z.object({
  iss: z.string().trim().url(),
  aud: z.literal(CONNECT_LINK_AUDIENCE),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  jti: z.string().trim().min(8),
  v: z.literal(CONNECT_LINK_VERSION),
  org: z.object({
    name: z.string().trim().min(1).max(128),
  }),
  brand: z.object({
    appName: z.string().trim().min(1).max(64),
    logoUrl: z.string().trim().url().nullable(),
    iconUrl: z.string().trim().url().nullable(),
  }),
  den: z.object({
    baseUrl: z.string().trim().url(),
    apiBaseUrl: z.string().trim().url().nullish(),
  }),
  requireSignin: z.boolean(),
}).meta({ ref: "ConnectLinkClaims" }) satisfies z.ZodType<ConnectLinkClaims>

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

export function isLoopbackUrl(rawUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(rawUrl).hostname)
  } catch {
    return false
  }
}

/** Returns the first claim URL refused by the transport policy. */
export function findRefusedConnectLinkUrl(
  claims: ConnectLinkClaims,
  allowInsecureLoopback = false,
): string | null {
  const candidates = [
    claims.den.baseUrl,
    claims.den.apiBaseUrl ?? null,
    claims.brand.logoUrl,
    claims.brand.iconUrl,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      return candidate
    }
    if (parsed.protocol !== "https:" && !(allowInsecureLoopback && isLoopbackUrl(candidate))) {
      return candidate
    }
  }
  return null
}

/** Returns the first non-HTTPS claim URL, including loopback URLs. */
export function findInsecureConnectLinkUrl(claims: ConnectLinkClaims): string | null {
  return findRefusedConnectLinkUrl(claims)
}

export function buildConnectDeepLink(token: string, scheme = "openwork"): string {
  return `${scheme}://${CONNECT_LINK_ROUTE}?token=${encodeURIComponent(token)}`
}

export function buildConnectExchangeDeepLink(code: string, apiBaseUrl: string, scheme = "openwork"): string {
  const url = new URL(`${scheme}://${CONNECT_LINK_ROUTE}`)
  url.searchParams.set("code", code)
  url.searchParams.set("apiBaseUrl", apiBaseUrl)
  return url.toString()
}
