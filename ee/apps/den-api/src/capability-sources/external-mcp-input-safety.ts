const sensitiveExternalMcpCredentialKeys = new Set([
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "auth",
  "authkey",
  "authorization",
  "authtoken",
  "bearer",
  "clientsecret",
  "code",
  "codeverifier",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "jwt",
  "key",
  "pass",
  "passwd",
  "password",
  "proxyauth",
  "proxyauthorization",
  "proxypassword",
  "proxyusername",
  "refreshtoken",
  "securitytoken",
  "secret",
  "sessionid",
  "sessiontoken",
  "setcookie",
  "sig",
  "signature",
  "token",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "xapikey",
  "xauthtoken",
])

const manifestPlaceholderPattern = /^(?:(?:Bearer|Basic)\s+)?(?:\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*|\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}|\{[A-Za-z_][A-Za-z0-9_]*\})$/i
const utf8 = new TextEncoder()

export const EXTERNAL_MCP_MANIFEST_INSPECTION_LIMITS = {
  bytes: 256 * 1024,
  depth: 32,
  nodes: 5_000,
} as const

export type ExternalMcpManifestInspection =
  | { status: "safe" }
  | { status: "credential" }
  | { status: "limit_exceeded"; limit: "bytes" | "depth" | "nodes" }

function normalizedExternalMcpCredentialKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Treat publisher-controlled key spelling uniformly across URL queries,
 * headers, environment declarations, and nested manifest objects. Exact
 * names cover common protocols while suffixes catch provider-specific forms
 * such as githubToken, signingKey, and databasePassword.
 */
export function isSensitiveExternalMcpCredentialKey(value: string): boolean {
  const normalized = normalizedExternalMcpCredentialKey(value)
  return sensitiveExternalMcpCredentialKeys.has(normalized)
    || /(?:token|secret|password|passwd|credential|credentials|signature|authorization|cookie)$/.test(normalized)
    || /(?:api|access|auth|security|session|signing)key(?:id)?$/.test(normalized)
}

export function isExternalMcpManifestPlaceholder(value: string): boolean {
  return manifestPlaceholderPattern.test(value.trim())
}

export function externalMcpUrlContainsCredential(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password) return true
  for (const parameter of url.searchParams.keys()) {
    if (isSensitiveExternalMcpCredentialKey(parameter)) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringBytes(value: string): number {
  return utf8.encode(value).byteLength
}

type ManifestValueTask = {
  depth: number
  fieldName: string
  value: unknown
}

/**
 * Inspect publisher JSON without recursion or unbounded entry materialization.
 * The request body is already parsed at this boundary, but limiting visited
 * nodes, nesting, and inspected UTF-8 bytes prevents adversarial manifests
 * from monopolizing the event loop or overflowing the call stack.
 */
export function inspectExternalMcpManifest(value: unknown): ExternalMcpManifestInspection {
  const limits = EXTERNAL_MCP_MANIFEST_INSPECTION_LIMITS
  const tasks: ManifestValueTask[] = [{ depth: 0, fieldName: "", value }]
  const seen = new WeakSet<object>()
  let nodes = 1
  let bytes = 0

  while (tasks.length > 0) {
    const task = tasks.pop()
    if (!task) break
    if (task.depth > limits.depth) return { status: "limit_exceeded", limit: "depth" }

    if (typeof task.value === "string") {
      bytes += stringBytes(task.value)
      if (bytes > limits.bytes) return { status: "limit_exceeded", limit: "bytes" }
      if (externalMcpUrlContainsCredential(task.value)) return { status: "credential" }
      if (
        isSensitiveExternalMcpCredentialKey(task.fieldName)
        && task.value.trim()
        && !isExternalMcpManifestPlaceholder(task.value)
      ) return { status: "credential" }
      continue
    }
    if (typeof task.value !== "object" || task.value === null) continue
    if (seen.has(task.value)) continue
    seen.add(task.value)

    if (Array.isArray(task.value)) {
      const normalizedField = normalizedExternalMcpCredentialKey(task.fieldName)
      const argumentsField = normalizedField === "args" || normalizedField === "arguments" || normalizedField === "command"
      let expectsCredentialValue = false
      for (const key in task.value) {
        if (!Object.prototype.hasOwnProperty.call(task.value, key)) continue
        if (task.depth >= limits.depth) return { status: "limit_exceeded", limit: "depth" }
        const index = Number(key)
        if (!Number.isSafeInteger(index) || index < 0) continue
        nodes += 1
        if (nodes > limits.nodes) return { status: "limit_exceeded", limit: "nodes" }
        bytes += stringBytes(key)
        if (bytes > limits.bytes) return { status: "limit_exceeded", limit: "bytes" }
        const entry = task.value[index]
        if (typeof entry === "string") {
          bytes += stringBytes(entry)
          if (bytes > limits.bytes) return { status: "limit_exceeded", limit: "bytes" }
          if (externalMcpUrlContainsCredential(entry)) return { status: "credential" }
          if (
            isSensitiveExternalMcpCredentialKey(task.fieldName)
            && entry.trim()
            && !isExternalMcpManifestPlaceholder(entry)
          ) return { status: "credential" }
          if (argumentsField) {
            if (expectsCredentialValue && entry.trim() && !isExternalMcpManifestPlaceholder(entry)) {
              return { status: "credential" }
            }
            expectsCredentialValue = false
            const assignment = entry.match(/^--?([^=]+)=(.+)$/)
            if (assignment && isSensitiveExternalMcpCredentialKey(assignment[1])) {
              if (!isExternalMcpManifestPlaceholder(assignment[2])) return { status: "credential" }
              continue
            }
            expectsCredentialValue = isSensitiveExternalMcpCredentialKey(entry.replace(/^-+/, ""))
          }
          continue
        }
        expectsCredentialValue = false
        tasks.push({ depth: task.depth + 1, fieldName: task.fieldName, value: entry })
      }
      continue
    }

    if (!isRecord(task.value)) continue
    const record = task.value
    const declaredName = typeof record.name === "string"
      ? record.name
      : typeof record.key === "string"
        ? record.key
        : null
    if (declaredName && stringBytes(declaredName) > limits.bytes - bytes) {
      return { status: "limit_exceeded", limit: "bytes" }
    }
    const declaredSecret = record.secret === true
      || record.isSecret === true
      || Boolean(declaredName && isSensitiveExternalMcpCredentialKey(declaredName))
    if (declaredSecret || isSensitiveExternalMcpCredentialKey(task.fieldName)) {
      for (const candidate of [record.value, record.default]) {
        if (typeof candidate === "string" && stringBytes(candidate) > limits.bytes - bytes) {
          return { status: "limit_exceeded", limit: "bytes" }
        }
        if (
          typeof candidate === "string"
          && candidate.trim()
          && !isExternalMcpManifestPlaceholder(candidate)
        ) return { status: "credential" }
      }
    }

    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue
      if (task.depth >= limits.depth) return { status: "limit_exceeded", limit: "depth" }
      nodes += 1
      if (nodes > limits.nodes) return { status: "limit_exceeded", limit: "nodes" }
      bytes += stringBytes(key)
      if (bytes > limits.bytes) return { status: "limit_exceeded", limit: "bytes" }
      tasks.push({ depth: task.depth + 1, fieldName: key, value: record[key] })
    }
  }
  return { status: "safe" }
}

export function containsExternalMcpManifestCredentialValue(value: unknown): boolean {
  return inspectExternalMcpManifest(value).status === "credential"
}
