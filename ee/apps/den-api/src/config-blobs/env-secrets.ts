/**
 * `env` secret decisions (format.md › Secrets): a `$secret` resolved on the
 * server from an environment variable. Only on self-hosted deployments, and
 * only for names the operator allowlisted in
 * `DEN_CONFIG_BLOB_SECRET_ENV_ALLOWLIST` (comma-separated; a trailing `*`
 * matches a prefix, e.g. `OPENWORK_IMPORT_*`). Cloud never reads its own
 * environment for a tenant.
 */
import type { ConfigDeployment } from "@openwork/types/den/config-blobs"

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/

/** Whether `name` is on the allowlist. Entries are exact names or `PREFIX*`; anything else never matches. */
export function configSecretEnvAllowed(name: string, allowlist: readonly string[]): boolean {
  if (!ENV_NAME.test(name)) return false
  return allowlist.some((entry) => {
    const pattern = entry.trim()
    if (!pattern) return false
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1)
      // A bare "*" would expose every variable (database URL, auth secret…): refused.
      return prefix.length > 0 && !prefix.includes("*") && name.startsWith(prefix)
    }
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
  if (!allowed(name)) return null
  const value = source[name]
  return value && value.length > 0 ? value : null
}
