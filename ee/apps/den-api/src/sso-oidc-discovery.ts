import { z } from "zod"
import { PrivateUrlError } from "./capability-sources/url-guard.js"

/**
 * ssoOidcSetupCheck: reads an identity provider's OIDC discovery document
 * from what the administrator typed, which is either the issuer or the
 * discovery URL itself (the address most provider docs hand out).
 *
 * - An address ending in /.well-known/openid-configuration is fetched as it
 *   is, and the issuer is the one the document names.
 * - Anything else is an issuer: the well-known path is appended and the
 *   document must name that same issuer.
 *
 * Nothing here is stored; a failed check is reported with the exact address
 * that was tried so the administrator can correct it.
 */

const DISCOVERY_SUFFIX = "/.well-known/openid-configuration"
const DISCOVERY_TIMEOUT_MS = 10_000

const discoveryDocumentSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  userinfo_endpoint: z.string().url().optional(),
})

export type OidcDiscoveryFetch = (url: string | URL, init?: RequestInit) => Promise<Response>

export type OidcDiscoveryFound = {
  ok: true
  /** The issuer to save: what the discovery document names. */
  issuer: string
  /** The address the document was read from. */
  discoveryUrl: string
  /** True when the administrator gave the discovery URL rather than the issuer. */
  fromDiscoveryUrl: boolean
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksEndpoint: string
  userInfoEndpoint: string | null
}

export type OidcDiscoveryFailure = {
  ok: false
  code: "invalid_url" | "not_found" | "http_error" | "unreachable" | "blocked" | "invalid_document" | "issuer_mismatch"
  message: string
  discoveryUrl: string | null
  /** HTTP status the provider answered with, for not_found and http_error. */
  status: number | null
  /** issuer_mismatch: the issuer the document names, offered as the correction. */
  reportedIssuer: string | null
}

export type OidcDiscoveryResult = OidcDiscoveryFound | OidcDiscoveryFailure

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "")
}

/** True when the address is a discovery document URL, not an issuer. */
export function isOidcDiscoveryUrl(value: string) {
  try {
    return trimTrailingSlash(new URL(value.trim()).pathname).endsWith(DISCOVERY_SUFFIX)
  } catch {
    return false
  }
}

/**
 * The issuer an address names: a discovery URL loses its well-known suffix,
 * anything else is returned trimmed. Administrators often paste the
 * discovery URL where the issuer belongs; appending the suffix again 404s.
 */
export function oidcIssuerFromInput(value: string) {
  const typed = value.trim()
  if (!isOidcDiscoveryUrl(typed)) return typed
  const url = new URL(typed)
  url.hash = ""
  url.search = ""
  url.pathname = trimTrailingSlash(url.pathname).slice(0, -DISCOVERY_SUFFIX.length) || "/"
  return trimTrailingSlash(url.toString())
}

function failure(code: OidcDiscoveryFailure["code"], message: string, extra: Partial<Pick<OidcDiscoveryFailure, "discoveryUrl" | "status" | "reportedIssuer">> = {}): OidcDiscoveryFailure {
  return { ok: false, code, message, discoveryUrl: extra.discoveryUrl ?? null, status: extra.status ?? null, reportedIssuer: extra.reportedIssuer ?? null }
}

/**
 * fetchImpl is the caller's guarded fetch: a hosted deployment must not be
 * made to read private addresses, and this check reports what it read.
 */
export async function checkOidcDiscovery(input: string, fetchImpl: OidcDiscoveryFetch): Promise<OidcDiscoveryResult> {
  const typed = input.trim()
  let url: URL
  try {
    url = new URL(typed)
  } catch {
    return failure("invalid_url", "Enter the full address, starting with https://.")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return failure("invalid_url", "Enter the full address, starting with https://.")
  }

  const fromDiscoveryUrl = isOidcDiscoveryUrl(typed)
  url.hash = ""
  const discoveryUrl = fromDiscoveryUrl ? url.toString() : `${trimTrailingSlash(`${url.origin}${url.pathname}`)}${DISCOVERY_SUFFIX}${url.search}`

  let response: Response
  try {
    response = await fetchImpl(discoveryUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
  } catch (error) {
    if (error instanceof PrivateUrlError) {
      return failure("blocked", "OpenWork can only reach identity providers on a public https:// address.", { discoveryUrl })
    }
    return failure("unreachable", `OpenWork could not reach ${discoveryUrl}. Check the address, or enter the endpoints yourself.`, { discoveryUrl })
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    const code = response.status === 404 ? "not_found" : "http_error"
    return failure(code, `No sign-in settings at ${discoveryUrl} (${response.status}). Check the address, or enter the endpoints yourself.`, { discoveryUrl, status: response.status })
  }

  const body: unknown = await response.json().catch(() => null)
  const parsed = discoveryDocumentSchema.safeParse(body)
  if (!parsed.success) {
    return failure("invalid_document", `${discoveryUrl} did not return sign-in settings OpenWork can use. Check the address, or enter the endpoints yourself.`, { discoveryUrl })
  }

  const document = parsed.data
  if (!fromDiscoveryUrl && trimTrailingSlash(document.issuer) !== trimTrailingSlash(typed)) {
    return failure("issuer_mismatch", `This provider reports its issuer as ${document.issuer}.`, { discoveryUrl, reportedIssuer: document.issuer })
  }

  return {
    ok: true,
    issuer: document.issuer,
    discoveryUrl,
    fromDiscoveryUrl,
    authorizationEndpoint: document.authorization_endpoint,
    tokenEndpoint: document.token_endpoint,
    jwksEndpoint: document.jwks_uri,
    userInfoEndpoint: document.userinfo_endpoint ?? null,
  }
}
