import { Resolver } from "node:dns/promises"

/**
 * ssoOidcSetupCheck: why a domain check failed, in terms an administrator can
 * act on. Better Auth only says it could not verify; this looks the record up
 * again to tell a missing record from one with another value.
 */
export type DomainVerificationProblem = {
  reason: "record_missing" | "value_mismatch" | "lookup_failed" | "expired"
  /** The domain whose record failed; null when the value itself expired. */
  domain: string | null
  dnsName: string | null
  /** The value found at dnsName, shortened (value_mismatch only). */
  found: string | null
  checkedAt: string
  message: string
}

/** Better Auth's code when no unexpired verification value exists. */
export const NO_PENDING_VERIFICATION = "NO_PENDING_VERIFICATION"

export type TxtLookup = (name: string) => Promise<string[][]>

const NOT_FOUND_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"])

function defaultLookup(): TxtLookup {
  const resolver = new Resolver({ timeout: 2500, tries: 2 })
  return (name) => resolver.resolveTxt(name)
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null
}

/** Long values keep their ends: enough to compare against the expected value. */
export function shortenRecordValue(value: string) {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value
}

export async function explainDomainVerificationFailure(input: {
  /** Better Auth's error code, when it gave one. */
  failureCode: string | null
  records: Array<{ domain: string; dnsName: string }>
  /** The current verification value; null when it could not be read. */
  expected: string | null
  /** The record name prefix: Better Auth also accepts "<prefix>=<value>". */
  identifier: string
  lookup?: TxtLookup
  now?: Date
}): Promise<DomainVerificationProblem | null> {
  const checkedAt = (input.now ?? new Date()).toISOString()
  if (input.failureCode === NO_PENDING_VERIFICATION) {
    return {
      reason: "expired",
      domain: null,
      dnsName: null,
      found: null,
      checkedAt,
      message: "This verification value has expired. Get a new value, update the TXT record, then verify again.",
    }
  }

  const lookup = input.lookup ?? defaultLookup()
  for (const { domain, dnsName } of input.records) {
    let values: string[]
    try {
      values = (await lookup(dnsName)).map((chunks) => chunks.join("").trim())
    } catch (error) {
      const code = errorCode(error)
      if (code && NOT_FOUND_CODES.has(code)) {
        values = []
      } else {
        return {
          reason: "lookup_failed",
          domain,
          dnsName,
          found: null,
          checkedAt,
          message: `OpenWork could not look up ${dnsName}. Try again in a few minutes.`,
        }
      }
    }

    if (values.length === 0) {
      return {
        reason: "record_missing",
        domain,
        dnsName,
        found: null,
        checkedAt,
        message: `No TXT record found at ${dnsName} yet. New DNS records can take up to an hour to appear. If someone else manages DNS for ${domain}, send them the record.`,
      }
    }

    const matches = input.expected !== null && values.some((value) => value === input.expected || value === `${input.identifier}=${input.expected}`)
    if (!matches && input.expected !== null) {
      const found = shortenRecordValue(values[0] ?? "")
      return {
        reason: "value_mismatch",
        domain,
        dnsName,
        found,
        checkedAt,
        message: `The TXT record at ${dnsName} has a different value (${found}). Replace it with the current value, then verify again.`,
      }
    }
  }

  // Every record looks right from here: nothing more specific to say.
  return null
}
