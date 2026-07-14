import {
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import { env } from "../env.js"
import { EXTERNAL_MCP_PRESETS, type ExternalMcpPreset } from "./external-mcp-presets.js"
import { createGuardedFetch, createRealmSafeFetch } from "./url-guard.js"

const DISCOVERY_TIMEOUT_MS = 10_000
const DISCOVERY_RESPONSE_LIMIT_BYTES = 64 * 1024
const DISCOVERY_REQUEST_ID = "openwork-mcp-discovery"
const DISCOVERY_SCOPE_LIMIT = 100
const DISCOVERY_SCOPE_LENGTH_LIMIT = 512
const DISCOVERY_SCOPE_TOTAL_LENGTH_LIMIT = 8_192
const DISCOVERY_INPUT_LIMIT = 100
const DISCOVERY_TEXT_LIMIT = 2_048
const DISCOVERY_LABEL_LIMIT = 255
const DISCOVERY_WARNING_LIMIT = 50
const DISCOVERY_WARNING_LENGTH_LIMIT = 512

export type ExternalMcpDiscoveryEvidenceSource =
  | "live_protocol"
  | "oauth_metadata"
  | "plugin_manifest"
  | "openwork_preset"
  | "unknown"

export type ExternalMcpDiscoveryConfidence =
  | "verified"
  | "declared"
  | "curated"
  | "inferred"
  | "unknown"

export type ExternalMcpDiscoveryInput = {
  id: string
  label: string
  placement: "api_key" | "argument" | "environment" | "header" | "oauth_client_id" | "oauth_client_secret" | "url"
  required: boolean
  secret: boolean
  source: ExternalMcpDiscoveryEvidenceSource
  supported: boolean
  variable: string | null
}

export type ExternalMcpOAuthDiscovery = {
  authorizationServer: string | null
  clientIdRequired: boolean
  clientSecretRequired: boolean
  documentationUrl: string | null
  pkce: "s256" | "missing" | "unknown"
  registration: "dynamic" | "client_metadata_document" | "pre_registered" | "unknown"
  scopes: string[]
  scopesSource: "challenge" | "protected_resource" | "plugin_manifest" | "authorization_server" | "none"
}

export type ExternalMcpConfigurationDiscovery = {
  auth: {
    confidence: ExternalMcpDiscoveryConfidence
    kind: "apikey" | "none" | "oauth" | "unknown"
    source: ExternalMcpDiscoveryEvidenceSource
  }
  inputs: ExternalMcpDiscoveryInput[]
  oauth: ExternalMcpOAuthDiscovery | null
  support: {
    status: "auto_configurable" | "needs_manual_oauth_client" | "needs_review" | "needs_values" | "unsupported"
  }
  transport: {
    kind: "remote_http"
    supported: boolean
    url: string
  }
  warnings: string[]
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

type ManifestEvidence = {
  auth: ExternalMcpConfigurationDiscovery["auth"]
  inputs: ExternalMcpDiscoveryInput[]
  oauthClientIdDeclared: boolean
  oauthClientSecretDeclared: boolean
  scopes: string[]
  transportSupported: boolean
  warnings: string[]
}

type McpProbe = {
  bearerChallenge: boolean
  resourceMetadataUrl?: URL
  scope: string[]
  validInitialize: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, DISCOVERY_TEXT_LIMIT) : null
}

function readStringArray(value: unknown): string[] {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : []
  const result: string[] = []
  const seen = new Set<string>()
  let totalLength = 0
  for (const entry of values) {
    const raw = readString(entry)
    if (!raw) continue
    for (const candidate of raw.split(/\s+/g)) {
      const scope = candidate.trim()
      if (!scope || scope.length > DISCOVERY_SCOPE_LENGTH_LIMIT || seen.has(scope)) continue
      const separatorLength = result.length > 0 ? 1 : 0
      if (totalLength + separatorLength + scope.length > DISCOVERY_SCOPE_TOTAL_LENGTH_LIMIT) continue
      seen.add(scope)
      result.push(scope)
      totalLength += separatorLength + scope.length
      if (result.length >= DISCOVERY_SCOPE_LIMIT) return result
    }
  }
  return result
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function boundedOAuthScopes(values: string[]): string[] {
  const scopes: string[] = []
  const seen = new Set<string>()
  let totalLength = 0
  for (const candidate of values) {
    const scope = candidate.trim()
    if (!scope || scope.length > DISCOVERY_SCOPE_LENGTH_LIMIT || seen.has(scope)) continue
    const separatorLength = scopes.length > 0 ? 1 : 0
    if (totalLength + separatorLength + scope.length > DISCOVERY_SCOPE_TOTAL_LENGTH_LIMIT) continue
    seen.add(scope)
    scopes.push(scope)
    totalLength += separatorLength + scope.length
    if (scopes.length >= DISCOVERY_SCOPE_LIMIT) break
  }
  return scopes
}

function safeHttpUrl(value: unknown): string | null {
  const raw = readString(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null
  } catch {
    return null
  }
}

function comparableMcpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`
  } catch {
    return null
  }
}

export function externalMcpPresetForUrl(url: string): ExternalMcpPreset | null {
  const comparable = comparableMcpUrl(url)
  if (!comparable) return null
  return EXTERNAL_MCP_PRESETS.find((preset) => comparableMcpUrl(preset.url) === comparable) ?? null
}

function authKind(value: unknown): ExternalMcpConfigurationDiscovery["auth"]["kind"] | null {
  const normalized = readString(value)?.toLowerCase().replaceAll("-", "_")
  if (normalized === "oauth" || normalized === "oauth2" || normalized === "oauth_2") return "oauth"
  if (normalized === "apikey" || normalized === "api_key" || normalized === "bearer" || normalized === "token") return "apikey"
  if (normalized === "none" || normalized === "no_auth" || normalized === "public") return "none"
  return null
}

function declaredAuthKind(config: Record<string, unknown>): ExternalMcpConfigurationDiscovery["auth"]["kind"] | null {
  const direct = authKind(config.authType) ?? authKind(config.authentication)
  if (direct) return direct
  if (!isRecord(config.auth)) return null
  return authKind(config.auth.type) ?? authKind(config.auth.kind)
}

type BoundedItems<TItem> = {
  items: TItem[]
  truncated: boolean
}

function boundedTemplateVariables(value: string, limit: number): BoundedItems<string> {
  const items: string[] = []
  const seen = new Set<string>()
  const matches = value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)|\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g)
  for (const match of matches) {
    const variable = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (!variable || seen.has(variable)) continue
    if (items.length >= limit) return { items, truncated: true }
    seen.add(variable)
    items.push(variable)
  }
  return { items, truncated: false }
}

function boundedRecordKeys(value: Record<string, unknown>, limit: number): BoundedItems<string> {
  const items: string[] = []
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (items.length >= limit) return { items, truncated: true }
    items.push(key)
  }
  return { items, truncated: false }
}

function boundedConfigurationVariables(input: {
  fallback: string
  limit: number
  rawValue: string | null
  variables: Record<string, unknown>
}): BoundedItems<string> {
  const template = input.rawValue
    ? boundedTemplateVariables(input.rawValue, input.limit)
    : { items: [], truncated: false }
  const declared = boundedRecordKeys(input.variables, input.limit)
  const items: string[] = []
  const seen = new Set<string>()
  let truncated = template.truncated || declared.truncated
  for (const variable of [...template.items, ...declared.items]) {
    if (seen.has(variable)) continue
    if (items.length >= input.limit) {
      truncated = true
      break
    }
    seen.add(variable)
    items.push(variable)
  }
  if (!input.rawValue && declared.items.length === 0) items.push(input.fallback)
  return { items, truncated }
}

function isExactTemplatePlaceholder(value: string): boolean {
  return /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*|\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(value.trim())
}

function variableFromTemplate(value: string): string | null {
  return boundedTemplateVariables(readString(value) ?? "", 1).items[0] ?? null
}

function declaredServerConfiguration(config: Record<string, unknown>, url: string): Record<string, unknown> {
  const comparable = comparableMcpUrl(url)
  const matchByUrl = (entries: unknown[]) => entries
    .filter(isRecord)
    .find((entry) => comparableMcpUrl(readString(entry.url) ?? "") === comparable)

  // Official Registry server.json: a server may publish one or more remote
  // transports alongside package/stdio alternatives.
  if (Array.isArray(config.remotes)) {
    const remote = matchByUrl(config.remotes) ?? config.remotes.find(isRecord)
    if (remote) return { ...config, ...remote }
  }

  // Claude/plugin manifests commonly wrap named servers in mcpServers/mcp.
  for (const key of ["mcpServers", "mcp"] as const) {
    const container = config[key]
    if (!isRecord(container)) continue
    const entries = Object.values(container)
    const server = matchByUrl(entries) ?? entries.find(isRecord)
    if (server) return { ...config, ...server }
  }

  return config
}

function labelForVariable(variable: string | null, fallback: string): string {
  if (!variable) return fallback
  return variable
    .replace(/_+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function inputId(placement: ExternalMcpDiscoveryInput["placement"], name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "value"
  return `${placement}:${slug}`
}

function configurationInput(input: Omit<ExternalMcpDiscoveryInput, "id">): ExternalMcpDiscoveryInput {
  return {
    ...input,
    id: inputId(input.placement, input.variable ?? input.label),
    label: input.label.slice(0, DISCOVERY_LABEL_LIMIT),
    variable: input.variable?.slice(0, DISCOVERY_LABEL_LIMIT) ?? null,
  }
}

function manifestScopes(config: Record<string, unknown>): string[] {
  const oauth = isRecord(config.oauth) ? config.oauth : null
  const auth = isRecord(config.auth) ? config.auth : null
  return boundedOAuthScopes([
    ...readStringArray(config.scopes),
    ...readStringArray(oauth?.scopes),
    ...readStringArray(auth?.scopes),
  ])
}

type ManifestHeaderEntry = {
  description: string | null
  name: string
  rawValue: string | null
  required: boolean
  secret: boolean
  variables: Record<string, unknown>
}

function headerEntries(value: unknown, limit: number): BoundedItems<ManifestHeaderEntry> {
  const items: ManifestHeaderEntry[] = []
  let scanned = 0
  const append = (name: string, raw: unknown) => {
    if (typeof raw === "string") {
      items.push({ description: null, name, rawValue: readString(raw), required: true, secret: true, variables: {} })
      return
    }
    if (!isRecord(raw)) return
    items.push({
      description: readString(raw.description),
      name,
      rawValue: readString(raw.value) ?? readString(raw.default),
      required: raw.isRequired !== false && raw.required !== false,
      secret: raw.isSecret !== false && raw.secret !== false,
      variables: isRecord(raw.variables) ? raw.variables : {},
    })
  }
  if (isRecord(value)) {
    for (const name in value) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) continue
      if (scanned >= limit) return { items, truncated: true }
      scanned += 1
      append(name, value[name])
    }
    return { items, truncated: false }
  }
  if (!Array.isArray(value)) return { items, truncated: false }
  for (let index = 0; index < value.length; index += 1) {
    if (scanned >= limit) return { items, truncated: true }
    scanned += 1
    const raw: unknown = value[index]
    if (!isRecord(raw)) continue
    const name = readString(raw.name) ?? readString(raw.key)
    if (name) append(name, raw)
  }
  return { items, truncated: false }
}

function genericInputs(
  value: unknown,
  placement: "argument" | "environment" | "url",
  limit: number,
): BoundedItems<ExternalMcpDiscoveryInput> {
  const items: ExternalMcpDiscoveryInput[] = []
  let scanned = 0
  let truncated = false
  const append = (name: string, raw: unknown) => {
    const record = isRecord(raw) ? raw : null
    const rawValue = typeof raw === "string" ? readString(raw) : readString(record?.value) ?? readString(record?.default)
    const declaredVariables = isRecord(record?.variables) ? record.variables : {}
    const variables = boundedConfigurationVariables({
      fallback: name,
      limit: Math.max(1, limit - items.length),
      rawValue,
      variables: declaredVariables,
    })
    if (variables.truncated) truncated = true
    for (const variable of variables.items.length > 0 ? variables.items : [null]) {
      if (items.length >= limit) {
        truncated = true
        return
      }
      const variableInput = variable && isRecord(record?.variables)
        && isRecord(record.variables[variable])
        ? record.variables[variable]
        : null
      const secret = variableInput?.isSecret === true
        || variableInput?.secret === true
        || record?.isSecret === true
        || record?.secret === true
        || /secret|token|key|password/i.test(variable ?? name)
      items.push(configurationInput({
        label: readString(variableInput?.description) ?? readString(record?.description) ?? labelForVariable(variable, name),
        placement,
        required: variableInput?.isRequired !== false
          && variableInput?.required !== false
          && record?.isRequired !== false
          && record?.required !== false,
        secret,
        source: "plugin_manifest",
        supported: false,
        variable,
      }))
    }
  }
  if (isRecord(value)) {
    for (const name in value) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) continue
      if (scanned >= limit || items.length >= limit) return { items, truncated: true }
      scanned += 1
      append(name, value[name])
    }
    return { items, truncated }
  }
  if (!Array.isArray(value)) return { items, truncated }
  for (let index = 0; index < value.length; index += 1) {
    if (scanned >= limit || items.length >= limit) return { items, truncated: true }
    scanned += 1
    const raw: unknown = value[index]
    if (typeof raw === "string") {
      append(variableFromTemplate(raw) ?? `${placement}-${index + 1}`, raw)
      continue
    }
    if (!isRecord(raw)) continue
    const name = readString(raw.name) ?? readString(raw.key) ?? readString(raw.valueHint)
    if (name) append(name, raw)
  }
  return { items, truncated }
}

function oauthDeclaration(config: Record<string, unknown>): { clientId: boolean; clientSecret: boolean } {
  const oauth = isRecord(config.oauth) ? config.oauth : null
  const client = oauth && isRecord(oauth.client) ? oauth.client : null
  return {
    clientId: Boolean(readString(oauth?.clientId) ?? readString(client?.id)),
    clientSecret: Boolean(readString(oauth?.clientSecret) ?? readString(client?.secret)),
  }
}

export function inferExternalMcpManifestConfiguration(input: {
  config?: Record<string, unknown> | null
  preset?: ExternalMcpPreset | null
  url: string
}): ManifestEvidence {
  const config = declaredServerConfiguration(input.config ?? {}, input.url)
  const preset = input.preset ?? externalMcpPresetForUrl(input.url)
  const warnings: string[] = []
  const inputs: ExternalMcpDiscoveryInput[] = []
  let inputsTruncated = false
  const appendInput = (configuration: ExternalMcpDiscoveryInput) => {
    if (inputs.length >= DISCOVERY_INPUT_LIMIT) {
      inputsTruncated = true
      return
    }
    inputs.push(configuration)
  }
  const type = readString(config.type)?.toLowerCase()
  const hasCommand = Boolean(readString(config.command)) || Array.isArray(config.command)
  const packageOnly = Array.isArray(config.packages)
    && config.packages.length > 0
    && (!Array.isArray(config.remotes) || config.remotes.length === 0)
  const legacySse = type === "sse"
  const transportSupported = !hasCommand
    && !packageOnly
    && (!type || ["http", "remote", "streamable-http"].includes(type))
  if (!transportSupported) {
    warnings.push(legacySse
      ? "This declaration uses the legacy SSE transport. OpenWork Cloud currently supports remote Streamable HTTP MCP servers."
      : "This declaration starts a local process or uses an unsupported transport. OpenWork Cloud can only host remote Streamable HTTP MCP servers.")
  }

  let manifestApiKey = false
  const manifestHeaders = headerEntries(config.headers, DISCOVERY_INPUT_LIMIT)
  if (manifestHeaders.truncated) inputsTruncated = true
  for (const header of manifestHeaders.items) {
    const remainingInputCount = DISCOVERY_INPUT_LIMIT - inputs.length
    if (remainingInputCount <= 0) {
      inputsTruncated = true
      break
    }
    const normalizedName = header.name.toLowerCase()
    const boundedVariables = boundedConfigurationVariables({
      fallback: header.name,
      limit: remainingInputCount,
      rawValue: header.rawValue,
      variables: header.variables,
    })
    if (boundedVariables.truncated) inputsTruncated = true
    const variables = boundedVariables.items
    const hasSingleCompleteVariable = variables.length === 1 && !boundedVariables.truncated
    const bearer = normalizedName === "authorization" && Boolean(header.rawValue?.match(/^\s*Bearer\s+/i))
    const bearerValue = bearer ? header.rawValue?.replace(/^\s*Bearer\s+/i, "").trim() ?? "" : ""
    const exactBearerPlaceholder = bearer && isExactTemplatePlaceholder(bearerValue)
    const apiKeyHeader = bearer || ["api-key", "apikey", "x-api-key", "x-auth-token"].includes(normalizedName)
    if (apiKeyHeader && variables.length > 0) {
      manifestApiKey = true
      for (const variable of variables) {
        const variableInput = isRecord(header.variables[variable]) ? header.variables[variable] : null
        appendInput(configurationInput({
          label: readString(variableInput?.description) ?? header.description ?? labelForVariable(variable, "API key"),
          placement: "api_key",
          required: variableInput?.isRequired !== false
            && variableInput?.required !== false
            && header.required,
          secret: variableInput?.isSecret !== false && variableInput?.secret !== false,
          source: "plugin_manifest",
          supported: exactBearerPlaceholder && hasSingleCompleteVariable,
          variable,
        }))
      }
      if (!bearer) warnings.push(`The required ${header.name} header is declared, but Den currently supports only Authorization: Bearer API keys.`)
      if (bearer && !hasSingleCompleteVariable) warnings.push("The Authorization header combines multiple inputs. Den can only apply one Bearer token value.")
      if (bearer && hasSingleCompleteVariable && !exactBearerPlaceholder) warnings.push("The Authorization Bearer value contains fixed text around its variable. Den only supports a single exact secret placeholder as the Bearer token.")
      continue
    }
    if (header.rawValue && variables.length === 0 && header.secret) {
      warnings.push(`The plugin declares a literal value for ${header.name}. OpenWork will not copy or expose committed credentials.`)
    }
    for (const variable of variables.length > 0 ? variables : [null]) {
      const variableInput = variable && isRecord(header.variables[variable]) ? header.variables[variable] : null
      appendInput(configurationInput({
        label: readString(variableInput?.description) ?? header.description ?? labelForVariable(variable, header.name),
        placement: "header",
        required: variableInput?.isRequired !== false
          && variableInput?.required !== false
          && header.required,
        secret: variableInput?.isSecret === true || variableInput?.secret === true || header.secret,
        source: "plugin_manifest",
        supported: false,
        variable,
      }))
    }
  }

  const appendGenericInputs = (
    value: unknown,
    placement: "argument" | "environment" | "url",
  ) => {
    const inferred = genericInputs(value, placement, DISCOVERY_INPUT_LIMIT - inputs.length)
    if (inferred.truncated) inputsTruncated = true
    for (const configuration of inferred.items) appendInput(configuration)
  }
  appendGenericInputs(config.env ?? config.environmentVariables, "environment")
  appendGenericInputs(config.arguments ?? config.args ?? config.packageArguments ?? config.runtimeArguments, "argument")
  appendGenericInputs(config.variables, "url")

  const oauthConfig = isRecord(config.oauth) ? config.oauth : null
  if (readString(oauthConfig?.authServerMetadataUrl)) {
    appendInput(configurationInput({
      label: "Custom OAuth metadata URL",
      placement: "url",
      required: true,
      secret: false,
      source: "plugin_manifest",
      supported: false,
      variable: null,
    }))
    warnings.push("This declaration overrides OAuth metadata discovery. OpenWork does not apply publisher-supplied authorization-server URLs because they require a separate trust decision.")
  }
  if (readString(config.headersHelper)) {
    appendInput(configurationInput({
      label: "Dynamic authentication header helper",
      placement: "header",
      required: true,
      secret: true,
      source: "plugin_manifest",
      supported: false,
      variable: null,
    }))
    warnings.push("This declaration runs a dynamic header command. OpenWork Cloud will not execute commands from a marketplace manifest.")
  }

  const declared = declaredAuthKind(config)
  const oauth = oauthDeclaration(config)
  const kind = manifestApiKey ? "apikey" : declared ?? preset?.authType ?? "unknown"
  const source: ExternalMcpDiscoveryEvidenceSource = manifestApiKey || declared
    ? "plugin_manifest"
    : preset
      ? "openwork_preset"
      : "unknown"
  const confidence: ExternalMcpDiscoveryConfidence = source === "plugin_manifest"
    ? "declared"
    : source === "openwork_preset"
      ? "curated"
      : "unknown"

  let boundedInputs = inputs
  if (inputsTruncated) {
    warnings.push(`This declaration contains more than ${DISCOVERY_INPUT_LIMIT} configuration inputs. OpenWork will not auto-configure an oversized manifest.`)
    boundedInputs = [
      ...inputs.slice(0, DISCOVERY_INPUT_LIMIT - 1),
      configurationInput({
        label: "Additional publisher configuration inputs",
        placement: "environment",
        required: true,
        secret: false,
        source: "plugin_manifest",
        supported: false,
        variable: null,
      }),
    ]
  }

  return {
    auth: { confidence, kind, source },
    inputs: boundedInputs,
    oauthClientIdDeclared: oauth.clientId || preset?.requiresOAuthClient === true,
    oauthClientSecretDeclared: oauth.clientSecret || preset?.requiresOAuthClient === true,
    scopes: manifestScopes(config),
    transportSupported,
    warnings: unique(warnings.map((warning) => warning.slice(0, DISCOVERY_WARNING_LENGTH_LIMIT))).slice(0, DISCOVERY_WARNING_LIMIT),
  }
}

function combineSignal(signal: AbortSignal | null | undefined, timeoutSignal: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

function withTimeout(fetchImpl: FetchLike, timeoutSignal: AbortSignal): FetchLike {
  return (url, init) => fetchImpl(url, {
    ...init,
    signal: combineSignal(init?.signal, timeoutSignal),
  })
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let output = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > DISCOVERY_RESPONSE_LIMIT_BYTES) {
        throw new Error(`MCP discovery responses must not exceed ${DISCOVERY_RESPONSE_LIMIT_BYTES} bytes.`)
      }
      output += decoder.decode(chunk.value, { stream: true })
    }
    output += decoder.decode()
    return output
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function withResponseLimit(fetchImpl: FetchLike): FetchLike {
  return async (url, init) => {
    const response = await fetchImpl(url, init)
    if (!response.body) return response
    const body = await boundedResponseText(response)
    const headers = new Headers(response.headers)
    headers.delete("content-length")
    const responseAllowsBody = response.status !== 204 && response.status !== 205 && response.status !== 304
    return new globalThis.Response(responseAllowsBody && body ? body : null, {
      headers,
      status: response.status,
      statusText: response.statusText,
    })
  }
}

function hasUsableOAuthMetadata(
  info: Awaited<ReturnType<typeof discoverOAuthServerInfo>> | null,
): boolean {
  const metadata = info?.authorizationServerMetadata
  return Boolean(readString(metadata?.authorization_endpoint) && readString(metadata?.token_endpoint))
}

function isInitializeResult(value: unknown): boolean {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || value.id !== DISCOVERY_REQUEST_ID || !isRecord(value.result)) return false
  return typeof value.result.protocolVersion === "string" && isRecord(value.result.serverInfo)
}

function parseInitializePayload(text: string): boolean {
  const candidates = [text, ...text.split(/\r?\n/g).flatMap((line) => line.startsWith("data:") ? [line.slice(5).trim()] : [])]
  return candidates.some((candidate) => {
    try {
      const parsed: unknown = JSON.parse(candidate)
      return isInitializeResult(parsed)
    } catch {
      return false
    }
  })
}

async function probeExternalMcp(url: string, fetchImpl: FetchLike): Promise<McpProbe> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: DISCOVERY_REQUEST_ID,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "openwork-discovery", version: "1.0.0" },
      },
    }),
  })
  const challenge = extractWWWAuthenticateParams(response)
  const bearerChallenge = /(?:^|,)\s*Bearer(?:\s|,|$)/i.test(response.headers.get("www-authenticate") ?? "")
  const validInitialize = response.ok && parseInitializePayload(await boundedResponseText(response))
  if (!response.ok) await response.body?.cancel().catch(() => undefined)
  return {
    bearerChallenge,
    ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
    scope: readStringArray(challenge.scope),
    validInitialize,
  }
}

function oauthInputs(input: {
  clientIdRequired: boolean
  clientSecretRequired: boolean
  existing: ExternalMcpDiscoveryInput[]
}): ExternalMcpDiscoveryInput[] {
  const output = [...input.existing]
  if (input.clientIdRequired && !output.some((field) => field.placement === "oauth_client_id")) {
    output.push(configurationInput({
      label: "OAuth client ID",
      placement: "oauth_client_id",
      required: true,
      secret: false,
      source: "oauth_metadata",
      supported: true,
      variable: null,
    }))
  }
  if (input.clientSecretRequired && !output.some((field) => field.placement === "oauth_client_secret")) {
    output.push(configurationInput({
      label: "OAuth client secret",
      placement: "oauth_client_secret",
      required: true,
      secret: true,
      source: "oauth_metadata",
      supported: true,
      variable: null,
    }))
  }
  return output
}

function apiKeyInputs(existing: ExternalMcpDiscoveryInput[]): ExternalMcpDiscoveryInput[] {
  if (existing.some((field) => field.placement === "api_key")) return existing
  return [...existing, configurationInput({
    label: "API key",
    placement: "api_key",
    required: true,
    secret: true,
    source: "openwork_preset",
    supported: true,
    variable: null,
  })]
}

function supportStatus(input: {
  authConfidence: ExternalMcpConfigurationDiscovery["auth"]["confidence"]
  authKind: ExternalMcpConfigurationDiscovery["auth"]["kind"]
  inputs: ExternalMcpDiscoveryInput[]
  oauth: ExternalMcpOAuthDiscovery | null
  oauthTokenAuthSupported: boolean
  transportSupported: boolean
}): ExternalMcpConfigurationDiscovery["support"]["status"] {
  if (
    !input.transportSupported
    || !input.oauthTokenAuthSupported
    || input.oauth?.pkce === "missing"
    || input.inputs.some((field) => field.required && !field.supported)
  ) return "unsupported"
  if (input.authKind === "unknown") return "needs_review"
  // initialize is intentionally public on some otherwise authenticated MCP
  // servers. Until a later authenticated method proves the full server is
  // public, require the admin to confirm rather than claiming no-auth is
  // automatically ready.
  if (input.authKind === "none" && input.authConfidence === "inferred") return "needs_review"
  if (input.oauth?.clientIdRequired) return "needs_manual_oauth_client"
  if (input.inputs.some((field) => field.required)) return "needs_values"
  return "auto_configurable"
}

export async function discoverExternalMcpConfiguration(input: {
  config?: Record<string, unknown> | null
  fetch?: FetchLike
  preset?: ExternalMcpPreset | null
  timeoutMs?: number
  url: string
}): Promise<ExternalMcpConfigurationDiscovery> {
  const preset = input.preset === undefined ? externalMcpPresetForUrl(input.url) : input.preset
  const manifest = inferExternalMcpManifestConfiguration({ config: input.config, preset, url: input.url })
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? DISCOVERY_TIMEOUT_MS)
  const guardedFetch = input.fetch ?? (env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch())
  // The SDK parses OAuth protected-resource/authorization-server documents
  // with response.json(). Bound every response before it reaches the SDK, not
  // just the initial MCP initialize probe.
  const discoveryFetch = withResponseLimit(withTimeout(guardedFetch, timeoutSignal))
  const warnings = [...manifest.warnings]
  let probe: McpProbe | null = null
  let oauthServerInfo: Awaited<ReturnType<typeof discoverOAuthServerInfo>> | null = null

  try {
    probe = await probeExternalMcp(input.url, discoveryFetch)
  } catch {
    warnings.push("OpenWork could not verify the MCP endpoint without credentials.")
  }

  const manifestWins = manifest.auth.source === "plugin_manifest" && manifest.auth.kind === "apikey"
  if (!manifestWins && !probe?.validInitialize) {
    try {
      oauthServerInfo = await discoverOAuthServerInfo(input.url, {
        ...(probe?.resourceMetadataUrl ? { resourceMetadataUrl: probe.resourceMetadataUrl } : {}),
        fetchFn: discoveryFetch,
      })
    } catch {
      warnings.push("OpenWork could not verify the server's OAuth metadata.")
    }
  }

  let auth = manifest.auth
  const usableOAuthMetadata = hasUsableOAuthMetadata(oauthServerInfo)
  if (probe?.validInitialize) {
    // initialize proves that one protocol phase was public, but a server may
    // still require authorization for tools/list or tools/call.
    auth = { confidence: "inferred", kind: "none", source: "live_protocol" }
  } else if (!manifestWins && probe?.bearerChallenge && usableOAuthMetadata) {
    auth = { confidence: "verified", kind: "oauth", source: "live_protocol" }
  } else if (!manifestWins && usableOAuthMetadata) {
    auth = { confidence: "inferred", kind: "oauth", source: "oauth_metadata" }
  } else if (probe?.bearerChallenge && auth.kind === "unknown") {
    warnings.push("The server returned a Bearer challenge but no usable OAuth metadata. Bearer alone may mean an API key, so OpenWork will not guess the authentication flow.")
  }

  const metadata = oauthServerInfo?.authorizationServerMetadata
  const resourceMetadata = oauthServerInfo?.resourceMetadata
  const challengeScopes = probe?.scope ?? []
  // Metadata is publisher-controlled too. Apply the same count and length
  // bounds as challenge/manifest scopes before returning or persisting it.
  const resourceScopes = readStringArray(resourceMetadata?.scopes_supported)
  const authorizationServerScopes = readStringArray(metadata?.scopes_supported)
  const scopes = challengeScopes.length > 0
    ? challengeScopes
    : resourceScopes.length > 0
      ? resourceScopes
      : manifest.scopes.length > 0
        ? manifest.scopes
        : authorizationServerScopes
  const scopesSource: ExternalMcpOAuthDiscovery["scopesSource"] = challengeScopes.length > 0
    ? "challenge"
    : resourceScopes.length > 0
      ? "protected_resource"
      : manifest.scopes.length > 0
        ? "plugin_manifest"
        : authorizationServerScopes.length > 0
          ? "authorization_server"
          : "none"

  const advertisedDynamicRegistration = Boolean(metadata?.registration_endpoint)
  const advertisedClientMetadataDocument = metadata?.client_id_metadata_document_supported === true
  // RFC 8414 defaults an omitted token_endpoint_auth_methods_supported to
  // client_secret_basic. CIMD URL clients have no client secret, so only use
  // that registration plane when the authorization server explicitly accepts
  // public (`none`) clients. Den/the MCP SDK support none/basic/post, but not
  // private_key_jwt or other assertion methods.
  const tokenAuthMethods = metadata
    ? (metadata.token_endpoint_auth_methods_supported?.length
        ? metadata.token_endpoint_auth_methods_supported
        : ["client_secret_basic"])
    : []
  const supportedTokenAuthMethods = tokenAuthMethods.filter((method) => (
    method === "none" || method === "client_secret_basic" || method === "client_secret_post"
  ))
  const oauthTokenAuthSupported = !metadata || supportedTokenAuthMethods.length > 0
  const supportsPublicClient = supportedTokenAuthMethods.includes("none")
  const supportsSecretClient = supportedTokenAuthMethods.includes("client_secret_basic")
    || supportedTokenAuthMethods.includes("client_secret_post")
  const hasClientMetadataDocument = advertisedClientMetadataDocument && supportsPublicClient
  const hasDynamicRegistration = advertisedDynamicRegistration && oauthTokenAuthSupported
  const manualClientDeclared = manifest.oauthClientIdDeclared || manifest.oauthClientSecretDeclared || preset?.requiresOAuthClient === true
  const needsPreRegisteredClient = auth.kind === "oauth" && (
    manualClientDeclared || (!hasClientMetadataDocument && !hasDynamicRegistration)
  )
  const clientSecretRequired = needsPreRegisteredClient && (
    manifest.oauthClientSecretDeclared
    || (!supportsPublicClient && supportsSecretClient)
  )
  const registration: ExternalMcpOAuthDiscovery["registration"] = manualClientDeclared
    ? "pre_registered"
    : hasClientMetadataDocument
      ? "client_metadata_document"
      : hasDynamicRegistration
        ? "dynamic"
        : needsPreRegisteredClient
          ? "pre_registered"
          : "unknown"
  const pkceMethods = metadata?.code_challenge_methods_supported
  const pkce: ExternalMcpOAuthDiscovery["pkce"] = pkceMethods?.includes("S256")
    ? "s256"
    : metadata
      ? "missing"
      : "unknown"
  if (auth.kind === "oauth" && pkce === "missing") {
    warnings.push("The authorization server did not advertise required PKCE S256 support. OpenWork will not start OAuth until the provider fixes its metadata.")
  }
  if (auth.kind === "oauth" && advertisedClientMetadataDocument && !hasClientMetadataDocument) {
    warnings.push("The authorization server advertises Client ID Metadata Documents but does not accept public token clients, so OpenWork will use another compatible registration method.")
  }
  if (auth.kind === "oauth" && !oauthTokenAuthSupported) {
    warnings.push("The authorization server only advertises token endpoint client authentication methods OpenWork does not support.")
  }
  if (resourceMetadata?.authorization_servers && resourceMetadata.authorization_servers.length > 1) {
    warnings.push("The protected resource advertises multiple authorization servers. OpenWork will use the first compatible server returned by the MCP SDK.")
  }
  if (scopesSource === "authorization_server") {
    warnings.push("These scopes are an authorization-server catalog, not confirmed requirements for this MCP server.")
  }
  if (auth.kind === "unknown") {
    warnings.push("The MCP protocol did not advertise a setup method. Choose authentication manually and verify it with the provider.")
  }
  if (auth.kind === "none" && auth.confidence === "inferred") {
    warnings.push("The server allowed MCP initialization without credentials, but later methods may still require authentication. Confirm the provider's setup before saving.")
  }

  const oauth: ExternalMcpOAuthDiscovery | null = auth.kind === "oauth" ? {
    authorizationServer: oauthServerInfo?.authorizationServerUrl ?? null,
    clientIdRequired: needsPreRegisteredClient,
    clientSecretRequired,
    documentationUrl: safeHttpUrl(resourceMetadata?.resource_documentation) ?? safeHttpUrl(metadata?.service_documentation),
    pkce,
    registration,
    scopes: boundedOAuthScopes(scopes),
    scopesSource,
  } : null

  let inputs = manifest.inputs
  if (auth.kind === "apikey") inputs = apiKeyInputs(inputs)
  if (auth.kind === "oauth") {
    inputs = oauthInputs({
      clientIdRequired: oauth?.clientIdRequired ?? false,
      clientSecretRequired: oauth?.clientSecretRequired ?? false,
      existing: inputs,
    })
  }

  return {
    auth,
    inputs,
    oauth,
    support: { status: supportStatus({ authConfidence: auth.confidence, authKind: auth.kind, inputs, oauth, oauthTokenAuthSupported, transportSupported: manifest.transportSupported }) },
    transport: { kind: "remote_http", supported: manifest.transportSupported, url: input.url },
    warnings: unique(warnings.map((warning) => warning.slice(0, DISCOVERY_WARNING_LENGTH_LIMIT))).slice(0, DISCOVERY_WARNING_LIMIT),
  }
}
