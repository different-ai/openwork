export const AGENT_PLUGIN_V1_PUBLISHED_VERSION = "1.0.0"
export const AGENT_PLUGIN_V1_WORKING_DRAFT_VERSION = "1.1.0"
export const AGENT_PLUGIN_V1_SUPPORTED_VERSIONS = [
  AGENT_PLUGIN_V1_PUBLISHED_VERSION,
  AGENT_PLUGIN_V1_WORKING_DRAFT_VERSION,
] as const
export type AgentPluginV1Version = (typeof AGENT_PLUGIN_V1_SUPPORTED_VERSIONS)[number]

export const AGENT_PLUGIN_V1_VERSION = AGENT_PLUGIN_V1_PUBLISHED_VERSION
export const AGENT_PLUGIN_V1_MANIFEST_SCHEMA = `https://agent-plugins.org/schemas/${AGENT_PLUGIN_V1_VERSION}/plugin.schema.json` as const
export const AGENT_PLUGIN_V1_MCP_SCHEMA = `https://agent-plugins.org/schemas/${AGENT_PLUGIN_V1_VERSION}/mcp.schema.json` as const
export const AGENT_PLUGIN_V1_WORKING_DRAFT_MANIFEST_SCHEMA = `https://agent-plugins.org/schemas/${AGENT_PLUGIN_V1_WORKING_DRAFT_VERSION}/plugin.schema.json` as const
export const AGENT_PLUGIN_V1_WORKING_DRAFT_MCP_SCHEMA = `https://agent-plugins.org/schemas/${AGENT_PLUGIN_V1_WORKING_DRAFT_VERSION}/mcp.schema.json` as const

const AGENT_PLUGIN_SCHEMA_PREFIX = "https://agent-plugins.org/schemas/"
const AGENT_PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const PLUGIN_MANIFEST_KEYS = new Set([
  "$schema",
  "author",
  "description",
  "extensions",
  "homepage",
  "keywords",
  "license",
  "name",
  "repository",
  "version",
])

type AgentPluginAuthor = {
  email?: string
  name?: string
  url?: string
}

export type AgentPluginV1Manifest = {
  $schema: typeof AGENT_PLUGIN_V1_MANIFEST_SCHEMA | typeof AGENT_PLUGIN_V1_WORKING_DRAFT_MANIFEST_SCHEMA
  author?: AgentPluginAuthor
  description?: string
  extensions?: Record<string, unknown>
  homepage?: string
  keywords?: string[]
  license?: string
  name: string
  repository?: string
  version?: string
}

export type AgentPluginV1ManifestResult =
  | { errors: string[]; ok: false; warnings: string[] }
  | { manifest: AgentPluginV1Manifest; ok: true; schemaVersion: AgentPluginV1Version; warnings: string[] }

export type AgentPluginV1McpServerEntry = {
  config: Record<string, unknown>
  errors: string[]
  name: string
  valid: boolean
}

export type AgentPluginV1McpResult =
  | { errors: string[]; ok: false }
  | { entries: AgentPluginV1McpServerEntry[]; ok: true; schemaVersion: AgentPluginV1Version }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyStringValues(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")
}

function validateOptionalStrings(input: Record<string, unknown>, keys: string[], errors: string[]) {
  for (const key of keys) {
    if (input[key] !== undefined && typeof input[key] !== "string") {
      errors.push(`${key} must be a string when provided.`)
    }
  }
}

function isContainedPathSuffix(value: string, requireLeaf: boolean) {
  let depth = 0
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (depth === 0) return false
      depth -= 1
      continue
    }
    depth += 1
  }
  return !requireLeaf || depth > 0
}

function isValidStdioCommand(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) return false
  if (value.startsWith("./")) return isContainedPathSuffix(value.slice(2), true)
  return !value.includes("/")
}

function isValidStdioCwd(value: unknown) {
  if (typeof value !== "string" || value.includes("\\")) return false
  if (value.startsWith("./")) return isContainedPathSuffix(value.slice(2), false)
  for (const root of ["${PLUGIN_ROOT}", "${PLUGIN_DATA}"]) {
    if (value === root) return true
    if (value.startsWith(`${root}/`)) return isContainedPathSuffix(value.slice(root.length + 1), false)
  }
  return false
}

function validateHttpHeaders(value: unknown, errors: string[]) {
  if (!hasOnlyStringValues(value)) {
    errors.push("Remote server headers must contain only string values.")
    return
  }

  const names = new Set<string>()
  for (const [name, headerValue] of Object.entries(value)) {
    const normalizedName = name.toLowerCase()
    if (!HTTP_HEADER_NAME_PATTERN.test(name)) {
      errors.push(`Remote server header name ${JSON.stringify(name)} is invalid.`)
    }
    if (names.has(normalizedName)) {
      errors.push(`Remote server header name ${JSON.stringify(name)} is duplicated case-insensitively.`)
    }
    if (/[\0-\x08\x0a-\x1f\x7f]/.test(headerValue)) {
      errors.push(`Remote server header ${JSON.stringify(name)} contains an invalid value.`)
    }
    names.add(normalizedName)
  }
}

export function isAgentPluginManifestSchema(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith(AGENT_PLUGIN_SCHEMA_PREFIX)
    && value.endsWith("/plugin.schema.json")
}

function supportedSchemaVersion(value: unknown, filename: "mcp.schema.json" | "plugin.schema.json"): AgentPluginV1Version | null {
  if (typeof value !== "string") return null
  for (const version of AGENT_PLUGIN_V1_SUPPORTED_VERSIONS) {
    if (value === `${AGENT_PLUGIN_SCHEMA_PREFIX}${version}/${filename}`) return version
  }
  return null
}

export function agentPluginV1ManifestSchemaVersion(value: unknown) {
  return supportedSchemaVersion(value, "plugin.schema.json")
}

export function agentPluginV1McpSchemaVersion(value: unknown) {
  return supportedSchemaVersion(value, "mcp.schema.json")
}

function supportedSchemaList(filename: "mcp.schema.json" | "plugin.schema.json") {
  return AGENT_PLUGIN_V1_SUPPORTED_VERSIONS
    .map((version) => `${AGENT_PLUGIN_SCHEMA_PREFIX}${version}/${filename}`)
    .join(" or ")
}

export function validateAgentPluginV1Manifest(value: unknown): AgentPluginV1ManifestResult {
  if (!isRecord(value)) {
    return { errors: ["plugin.json must contain a JSON object."], ok: false, warnings: [] }
  }

  const errors: string[] = []
  const warnings = Object.keys(value)
    .filter((key) => !PLUGIN_MANIFEST_KEYS.has(key))
    .map((key) => `Ignored unknown plugin.json field \"${key}\".`)

  const schemaVersion = agentPluginV1ManifestSchemaVersion(value.$schema)
  if (!schemaVersion) {
    errors.push(`$schema must be ${supportedSchemaList("plugin.schema.json")}.`)
  }
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 64 || !AGENT_PLUGIN_NAME_PATTERN.test(value.name)) {
    errors.push("name must be 1-64 lowercase letters, numbers, hyphens, or periods without leading, trailing, or consecutive separators.")
  }
  validateOptionalStrings(value, ["version", "description", "homepage", "repository", "license"], errors)

  if (value.author !== undefined) {
    if (!isRecord(value.author)) {
      errors.push("author must be an object when provided.")
    } else {
      const unknownAuthorKeys = Object.keys(value.author).filter((key) => !["email", "name", "url"].includes(key))
      if (unknownAuthorKeys.length > 0) {
        errors.push(`author contains unsupported field${unknownAuthorKeys.length === 1 ? "" : "s"}: ${unknownAuthorKeys.join(", ")}.`)
      }
      validateOptionalStrings(value.author, ["email", "name", "url"], errors)
    }
  }

  if (value.keywords !== undefined && (!Array.isArray(value.keywords) || !value.keywords.every((entry) => typeof entry === "string"))) {
    errors.push("keywords must be an array of strings when provided.")
  }

  if (value.extensions !== undefined && !isRecord(value.extensions)) {
    warnings.push("Ignored non-object plugin.json field \"extensions\".")
  }

  if (errors.length > 0 || typeof value.name !== "string" || !schemaVersion) {
    return { errors, ok: false, warnings }
  }

  const manifest: AgentPluginV1Manifest = {
    $schema: schemaVersion === AGENT_PLUGIN_V1_PUBLISHED_VERSION
      ? AGENT_PLUGIN_V1_MANIFEST_SCHEMA
      : AGENT_PLUGIN_V1_WORKING_DRAFT_MANIFEST_SCHEMA,
    name: value.name,
  }
  if (isRecord(value.author)) {
    const author: AgentPluginAuthor = {}
    if (typeof value.author.email === "string") author.email = value.author.email
    if (typeof value.author.name === "string") author.name = value.author.name
    if (typeof value.author.url === "string") author.url = value.author.url
    manifest.author = author
  }
  if (typeof value.description === "string") manifest.description = value.description
  if (isRecord(value.extensions)) manifest.extensions = value.extensions
  if (typeof value.homepage === "string") manifest.homepage = value.homepage
  if (Array.isArray(value.keywords)) manifest.keywords = value.keywords.filter((entry): entry is string => typeof entry === "string")
  if (typeof value.license === "string") manifest.license = value.license
  if (typeof value.repository === "string") manifest.repository = value.repository
  if (typeof value.version === "string") manifest.version = value.version
  return { manifest, ok: true, schemaVersion, warnings }
}

function unexpectedKeys(config: Record<string, unknown>, allowed: string[]) {
  return Object.keys(config).filter((key) => !allowed.includes(key))
}

function validateAgentPluginMcpServer(name: string, value: unknown): AgentPluginV1McpServerEntry {
  const errors: string[] = []
  if (!isRecord(value)) {
    return { config: {}, errors: ["Server configuration must be an object."], name, valid: false }
  }

  const type = value.type
  if (type === "stdio") {
    const unknown = unexpectedKeys(value, ["args", "command", "cwd", "env", "type"])
    if (unknown.length > 0) errors.push(`Unsupported stdio field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`)
    if (!isValidStdioCommand(value.command)) {
      errors.push("stdio command must be a non-empty bare executable name or a contained plugin-relative path.")
    }
    if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string"))) {
      errors.push("stdio args must be an array of strings.")
    }
    if (value.env !== undefined) {
      if (!hasOnlyStringValues(value.env)) {
        errors.push("stdio env must contain only string values.")
      } else if (Object.hasOwn(value.env, "PLUGIN_ROOT") || Object.hasOwn(value.env, "PLUGIN_DATA")) {
        errors.push("stdio env cannot override PLUGIN_ROOT or PLUGIN_DATA.")
      }
    }
    if (value.cwd !== undefined && !isValidStdioCwd(value.cwd)) {
      errors.push("stdio cwd must be a contained plugin-relative, PLUGIN_ROOT, or PLUGIN_DATA path.")
    }
  } else if (type === "streamable-http" || type === "sse") {
    const unknown = unexpectedKeys(value, ["headers", "type", "url"])
    if (unknown.length > 0) errors.push(`Unsupported remote server field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`)
    if (typeof value.url !== "string" || value.url.length === 0) {
      errors.push("Remote server url must be a non-empty string.")
    }
    if (value.headers !== undefined) validateHttpHeaders(value.headers, errors)
  } else {
    errors.push("Server type must be stdio, streamable-http, or sse.")
  }

  return { config: value, errors, name, valid: errors.length === 0 }
}

export function parseAgentPluginV1McpText(
  rawSourceText: string,
  expectedSchemaVersion?: AgentPluginV1Version | null,
): AgentPluginV1McpResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawSourceText)
  } catch {
    return { errors: ["mcp.json must contain valid JSON."], ok: false }
  }
  if (!isRecord(parsed)) {
    return { errors: ["mcp.json must contain a JSON object."], ok: false }
  }

  const errors: string[] = []
  const schemaVersion = agentPluginV1McpSchemaVersion(parsed.$schema)
  if (!schemaVersion) {
    errors.push(`$schema must be ${supportedSchemaList("mcp.schema.json")}.`)
  } else if (expectedSchemaVersion && schemaVersion !== expectedSchemaVersion) {
    errors.push(`mcp.json schema version ${schemaVersion} must match plugin.json schema version ${expectedSchemaVersion}.`)
  }
  const unknown = unexpectedKeys(parsed, ["$schema", "mcpServers"])
  if (unknown.length > 0) {
    errors.push(`mcp.json contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`)
  }
  if (!isRecord(parsed.mcpServers)) {
    errors.push("mcpServers must be an object.")
  }
  if (errors.length > 0 || !isRecord(parsed.mcpServers) || !schemaVersion) {
    return { errors, ok: false }
  }

  return {
    entries: Object.entries(parsed.mcpServers).map(([name, config]) => validateAgentPluginMcpServer(name, config)),
    ok: true,
    schemaVersion,
  }
}
