import { randomBytes } from "node:crypto"
import {
  buildConnectDeepLink,
  CONNECT_LINK_AUDIENCE,
  CONNECT_LINK_DEFAULT_TTL_HOURS,
  CONNECT_LINK_VERSION,
  type ConnectLinkClaims,
} from "@openwork/connect-link"
import { signConnectLinkToken } from "@openwork/connect-link/node"
import { env } from "./env.js"

export type DesktopConnectLinkInput = {
  organizationName: string
  appName: string
  logoUrl: string | null
  iconUrl: string | null
  webUrl: string
  apiUrl: string
}

/**
 * Mints the configuration handoff used by the Den install guide. The token
 * carries no identity or session; the desktop still requires normal sign-in.
 */
export function mintDesktopConnectLink(input: DesktopConnectLinkInput) {
  if (!env.connectLink) {
    return null
  }

  const nowEpochSeconds = Math.floor(Date.now() / 1000)
  const claims: ConnectLinkClaims = {
    iss: input.apiUrl,
    aud: CONNECT_LINK_AUDIENCE,
    iat: nowEpochSeconds,
    exp: nowEpochSeconds + CONNECT_LINK_DEFAULT_TTL_HOURS * 3600,
    jti: randomBytes(16).toString("base64url"),
    v: CONNECT_LINK_VERSION,
    org: { name: input.organizationName },
    brand: {
      appName: input.appName,
      logoUrl: input.logoUrl,
      iconUrl: input.iconUrl,
    },
    den: {
      baseUrl: input.webUrl,
      apiBaseUrl: input.apiUrl,
    },
    requireSignin: true,
  }
  const token = signConnectLinkToken({
    claims,
    privateKeyPem: env.connectLink.privateKeyPem,
    kid: env.connectLink.kid,
    allowInsecureUrls: env.devMode,
  })

  return {
    connectUrl: buildConnectDeepLink(token),
    connectExpiresAt: new Date(claims.exp * 1000).toISOString(),
  }
}
