/**
 * `env` secret decisions (format.md › Secrets): a `$secret` resolved on the
 * server from an environment variable. Only on self-hosted deployments, and
 * only for names the operator allowlisted in
 * `DEN_CONFIG_BLOB_SECRET_ENV_ALLOWLIST` (comma-separated; a trailing `*`
 * matches a prefix, e.g. `OPENWORK_IMPORT_*`). Cloud never reads its own
 * environment for a tenant.
 *
 * Only variables in a dedicated namespace can ever be read: names starting
 * with `OPENWORK_IMPORT_`. Allowlist entries outside it (an exact name such as
 * `DATABASE_URL`, or a prefix such as `D*` or `OPENWORK_*` that reaches past
 * it) are ignored, and the server warns about them at startup. On top of
 * that, names Den API itself reads (`DATABASE_*`, `DEN_*`, `BETTER_AUTH_*`,
 * provider and mail credentials…) are refused whatever the allowlist says.
 */
import type { ConfigDeployment } from "@openwork/types/den/config-blobs"

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/

/** The only names an import may read. */
export const CONFIG_SECRET_ENV_NAMESPACE = "OPENWORK_IMPORT_"

/**
 * Den API's own settings and credentials (src/env.ts and the services it
 * configures). Refused even inside the namespace: defense in depth should a
 * Den setting ever be named into it.
 */
const RESERVED_PREFIXES = [
  "BETTER_AUTH_",
  "CLOUD_",
  "DATABASE_",
  "DAYTONA_",
  "DB_",
  "DEN_",
  "GITHUB_",
  "GOOGLE_",
  "LINEAR_",
  "LOOPS_",
  "OPENROUTER_",
  "RENDER_",
  "RESEND_",
  "SMTP_",
  "STRIPE_",
  "VERCEL_",
  "WORKER_",
]
const RESERVED_NAMES = new Set(["DATABASE_URL", "DEN_DB_ENCRYPTION_KEY", "BETTER_AUTH_SECRET", "OPENWORK_DEV_MODE", "OPENWORK_DAYTONA_ENV_PATH"])
/** Words that mark a Den setting as a credential, wherever they sit in a name outside the namespace. */
const RESERVED_WORDS = ["SECRET", "PASSWORD", "TOKEN", "PRIVATE_KEY", "ENCRYPTION_KEY", "API_KEY"]

/** Whether `name` is one of Den API's own variables (or looks like one of its credentials outside the import namespace). */
export function isReservedEnvName(name: string): boolean {
  if (RESERVED_NAMES.has(name)) return true
  if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) return true
  if (name.startsWith(CONFIG_SECRET_ENV_NAMESPACE)) return false
  return RESERVED_WORDS.some((word) => name.includes(word))
}

/** Whether a variable may be read at all: a valid name, inside the namespace (with something after it), not reserved. */
export function isImportableEnvName(name: string): boolean {
  return ENV_NAME.test(name)
    && name.startsWith(CONFIG_SECRET_ENV_NAMESPACE)
    && name.length > CONFIG_SECRET_ENV_NAMESPACE.length
    && !isReservedEnvName(name)
}

/**
 * Why an allowlist entry is ignored, or null when it is usable: an exact
 * importable name, or `PREFIX*` where the prefix starts with the namespace
 * (so it can only ever match names inside it).
 */
export function configSecretEnvEntryProblem(entry: string): string | null {
  const pattern = entry.trim()
  if (!pattern) return "empty entry"
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1)
    if (prefix.includes("*")) return "only one trailing * is allowed"
    if (!prefix.startsWith(CONFIG_SECRET_ENV_NAMESPACE)) return `prefixes must start with ${CONFIG_SECRET_ENV_NAMESPACE}`
    if (!/^[A-Z][A-Z0-9_]*$/.test(prefix)) return "not a valid variable name prefix"
    return null
  }
  if (!ENV_NAME.test(pattern)) return "not a valid variable name"
  if (!pattern.startsWith(CONFIG_SECRET_ENV_NAMESPACE) || pattern.length === CONFIG_SECRET_ENV_NAMESPACE.length) return `names must start with ${CONFIG_SECRET_ENV_NAMESPACE}`
  if (isReservedEnvName(pattern)) return "Den API's own variables can't be read"
  return null
}

/** The allowlist split into usable entries and ignored ones (with why), for startup. */
export function partitionConfigSecretEnvAllowlist(entries: readonly string[]): { allowed: string[]; ignored: Array<{ entry: string; problem: string }> } {
  const allowed: string[] = []
  const ignored: Array<{ entry: string; problem: string }> = []
  for (const entry of entries) {
    const problem = configSecretEnvEntryProblem(entry)
    if (problem) ignored.push({ entry, problem })
    else allowed.push(entry.trim())
  }
  return { allowed, ignored }
}

/** Whether `name` is on the allowlist. Entries are exact names or `PREFIX*` inside the namespace; anything else never matches. */
export function configSecretEnvAllowed(name: string, allowlist: readonly string[]): boolean {
  if (!isImportableEnvName(name)) return false
  return allowlist.some((entry) => {
    if (configSecretEnvEntryProblem(entry) !== null) return false
    const pattern = entry.trim()
    if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1))
    return pattern === name
  })
}

/** The engine's `allowEnv`: nothing on cloud or with an empty allowlist. */
export function configSecretEnvPolicy(deployment: ConfigDeployment, allowlist: readonly string[]): (name: string) => boolean {
  if (deployment !== "self_hosted" || allowlist.length === 0) return () => false
  return (name) => configSecretEnvAllowed(name, allowlist)
}

/** The value of an allowed variable at apply time, or null when it is not allowed, unset or empty. */
export function readConfigSecretEnv(
  name: string,
  allowed: (name: string) => boolean,
  source: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!allowed(name) || !isImportableEnvName(name)) return null
  const value = source[name]
  return value && value.length > 0 ? value : null
}
