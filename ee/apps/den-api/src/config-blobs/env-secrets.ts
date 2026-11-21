import type { ConfigDeployment } from "@openwork/types/den/config-blobs"

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/

export const CONFIG_SECRET_ENV_NAMESPACE = "OPENWORK_IMPORT_"

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
const RESERVED_WORDS = ["SECRET", "PASSWORD", "TOKEN", "PRIVATE_KEY", "ENCRYPTION_KEY", "API_KEY"]

export function isReservedEnvName(name: string): boolean {
  if (RESERVED_NAMES.has(name)) return true
  if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) return true
  if (name.startsWith(CONFIG_SECRET_ENV_NAMESPACE)) return false
  return RESERVED_WORDS.some((word) => name.includes(word))
}

export function isImportableEnvName(name: string): boolean {
  return ENV_NAME.test(name)
    && name.startsWith(CONFIG_SECRET_ENV_NAMESPACE)
    && name.length > CONFIG_SECRET_ENV_NAMESPACE.length
    && !isReservedEnvName(name)
}

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

export function configSecretEnvAllowed(name: string, allowlist: readonly string[]): boolean {
  if (!isImportableEnvName(name)) return false
  return allowlist.some((entry) => {
    if (configSecretEnvEntryProblem(entry) !== null) return false
    const pattern = entry.trim()
    if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1))
    return pattern === name
  })
}

export function configSecretEnvPolicy(deployment: ConfigDeployment, allowlist: readonly string[]): (name: string) => boolean {
  if (deployment !== "self_hosted" || allowlist.length === 0) return () => false
  return (name) => configSecretEnvAllowed(name, allowlist)
}

export function readConfigSecretEnv(
  name: string,
  allowed: (name: string) => boolean,
  source: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!allowed(name) || !isImportableEnvName(name)) return null
  const value = source[name]
  return value && value.length > 0 ? value : null
}
