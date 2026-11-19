import { or, eq, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import type { SsoConnectionTable, SsoProviderTable } from "@openwork-ee/den-db/schema"

/**
 * The email domains an SSO connection covers. Stored on `sso_connection.domain`
 * and its Better Auth provider's `domain` as one lower-case, comma-separated
 * value without spaces ("example.com,example.org"), which is the format Better
 * Auth already reads for multi-domain providers (sign-in, email checks and DNS
 * verification of every domain).
 */

/** Both columns are varchar(255). */
const MAX_SERIALIZED_LENGTH = 255
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

export type SsoDomainsResult =
  | { ok: true; domains: string[] }
  | { ok: false; message: string }

/** Lower-case, de-duplicated domains from a comma or whitespace separated value or a list. */
export function normalizeSsoDomains(value: string | readonly string[]): SsoDomainsResult {
  const entries = (typeof value === "string" ? [value] : value)
    .flatMap((entry) => entry.split(/[\s,]+/))
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, ""))
    .filter(Boolean)
  const domains = [...new Set(entries)]
  if (domains.length === 0) return { ok: false, message: "Enter at least one email domain." }
  const invalid = domains.find((domain) => !DOMAIN_PATTERN.test(domain))
  if (invalid) return { ok: false, message: `"${invalid}" is not a valid email domain. Enter domains like example.com.` }
  if (serializeSsoDomains(domains).length > MAX_SERIALIZED_LENGTH) {
    return { ok: false, message: "These domains are too long together. Split them across two SSO connections." }
  }
  return { ok: true, domains }
}

export function serializeSsoDomains(domains: readonly string[]) {
  return domains.join(",")
}

/** The domains a stored value covers. */
export function parseSsoDomains(value: string | null | undefined): string[] {
  if (!value) return []
  return [...new Set(value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))]
}

export function ssoDomainsCover(value: string | null | undefined, domain: string) {
  return parseSsoDomains(value).includes(domain.trim().toLowerCase())
}

/**
 * SQL: the stored domains include this one. Exact domains only, as Den has
 * always matched them (no subdomains). The plain comparison keeps single-domain
 * rows written before the comma format matching exactly as before.
 */
export function ssoDomainColumnCovers(column: typeof SsoConnectionTable.domain | typeof SsoProviderTable.domain, domain: string): SQL {
  const normalized = domain.trim().toLowerCase()
  return or(eq(column, normalized), sql`FIND_IN_SET(${normalized}, ${column}) > 0`) ?? sql`FALSE`
}

const KNOWN_IDENTITY_PROVIDERS: ReadonlyArray<{ name: string; matches: (host: string) => boolean }> = [
  { name: "Microsoft Entra ID", matches: (host) => host === "login.microsoftonline.com" || host === "sts.windows.net" || host.endsWith(".microsoftonline.com") },
  { name: "Google Workspace", matches: (host) => host === "accounts.google.com" || host.endsWith(".google.com") },
  { name: "Okta", matches: (host) => host.endsWith(".okta.com") || host.endsWith(".oktapreview.com") || host.endsWith(".okta-emea.com") },
  { name: "OneLogin", matches: (host) => host.endsWith(".onelogin.com") },
  { name: "JumpCloud", matches: (host) => host.endsWith(".jumpcloud.com") || host === "jumpcloud.com" },
  { name: "Auth0", matches: (host) => host.endsWith(".auth0.com") },
  { name: "Ping Identity", matches: (host) => host.endsWith(".pingidentity.com") || host.endsWith(".pingone.com") },
  { name: "AWS IAM Identity Center", matches: (host) => host.endsWith(".amazonaws.com") || host.endsWith(".awsapps.com") },
  { name: "Keycloak", matches: (host) => host.includes("keycloak") },
]

/** A readable name for a connection without one: the identity provider when known, else the issuer's host. */
export function defaultSsoConnectionName(issuer: string) {
  let host = ""
  try {
    host = new URL(issuer).hostname.toLowerCase()
  } catch {
    return "SSO"
  }
  return KNOWN_IDENTITY_PROVIDERS.find((provider) => provider.matches(host))?.name ?? (host || "SSO")
}

/** The name sign-in buttons and the SSO page show. */
export function ssoConnectionDisplayName(connection: { name: string | null; issuer: string }) {
  return connection.name?.trim() || defaultSsoConnectionName(connection.issuer)
}
