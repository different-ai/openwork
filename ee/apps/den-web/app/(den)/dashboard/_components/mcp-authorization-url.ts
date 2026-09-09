function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") return true
  const octets = normalized.split(".")
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127
}

export function safeMcpAuthorizationUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error("The MCP provider returned an invalid authorization URL.")
  }
  const allowedProtocol = url.protocol === "https:"
    || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
  if (!allowedProtocol || url.username || url.password) {
    throw new Error("The MCP provider returned an unsafe authorization URL.")
  }
  return url.toString()
}

export type McpAuthorizationDebugDetails = {
  /** "unavailable" when the browser never let the page read a response (network failure or CORS-blocked answer). */
  httpStatus: number | "unavailable"
  errorCode?: string
  diagnosticCode?: string
  redirectUri?: string
  clientMetadataUrl?: string
  diagnosticReference?: string
  phase?: string
  category?: string
  highestPassed?: string
  retryable?: boolean
  actionOwner?: string
  operatorAction?: string
  providerStatus?: number
  providerRequestId?: string
  providerCode?: string
  responseJson: string
}

export type McpAuthorizationFailure = {
  message: string
  details?: McpAuthorizationDebugDetails
}

export type McpAuthorizationTabState = {
  connectionId: string
  connectionName: string
  outcome: "pending" | "failed"
  failure?: McpAuthorizationFailure
}

export type McpAuthorizationFailureDescription = {
  title: string
  description: string
  advice: string[]
  retryable: boolean
  copyable: { label: string; value: string }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseFailurePayload(value: string | null): McpAuthorizationFailure | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed) || typeof parsed.message !== "string") return undefined
    const details = isRecord(parsed.details) ? parsed.details : undefined
    const httpStatus = details?.httpStatus
    const responseJson = details?.responseJson
    if (details) {
      if ((typeof httpStatus === "number" || httpStatus === "unavailable") && typeof responseJson === "string") {
        return { message: parsed.message, details: parseDebugDetails(details, httpStatus, responseJson) }
      }
      return { message: parsed.message }
    }
    return { message: parsed.message }
  } catch {
    return undefined
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parseDebugDetails(
  value: Record<string, unknown>,
  httpStatus: number | "unavailable",
  responseJson: string,
): McpAuthorizationDebugDetails {
  const retryable = typeof value.retryable === "boolean" ? value.retryable : undefined
  return {
    httpStatus,
    ...(optionalString(value.errorCode) ? { errorCode: optionalString(value.errorCode) } : {}),
    ...(optionalString(value.diagnosticCode) ? { diagnosticCode: optionalString(value.diagnosticCode) } : {}),
    ...(optionalString(value.redirectUri) ? { redirectUri: optionalString(value.redirectUri) } : {}),
    ...(optionalString(value.clientMetadataUrl) ? { clientMetadataUrl: optionalString(value.clientMetadataUrl) } : {}),
    ...(optionalString(value.diagnosticReference) ? { diagnosticReference: optionalString(value.diagnosticReference) } : {}),
    ...(optionalString(value.phase) ? { phase: optionalString(value.phase) } : {}),
    ...(optionalString(value.category) ? { category: optionalString(value.category) } : {}),
    ...(optionalString(value.highestPassed) ? { highestPassed: optionalString(value.highestPassed) } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(optionalString(value.actionOwner) ? { actionOwner: optionalString(value.actionOwner) } : {}),
    ...(optionalString(value.operatorAction) ? { operatorAction: optionalString(value.operatorAction) } : {}),
    ...(optionalNumber(value.providerStatus) !== undefined ? { providerStatus: optionalNumber(value.providerStatus) } : {}),
    ...(optionalString(value.providerRequestId) ? { providerRequestId: optionalString(value.providerRequestId) } : {}),
    ...(optionalString(value.providerCode) ? { providerCode: optionalString(value.providerCode) } : {}),
    responseJson,
  }
}

export function mcpAuthorizationTabUrl(state: {
  connectionId: string
  connectionName: string
  failure?: McpAuthorizationFailure
}): string {
  const searchParams = new URLSearchParams({
    connection: state.connectionId,
    name: state.connectionName,
  })
  if (state.failure) {
    searchParams.set("outcome", "failed")
    searchParams.set("failure", JSON.stringify(state.failure))
  }
  return `/connect/oauth?${searchParams.toString()}`
}

export function parseMcpAuthorizationTabState(searchParams: URLSearchParams): McpAuthorizationTabState {
  const connectionId = searchParams.get("connection")?.trim() ?? ""
  const connectionName = searchParams.get("name")?.trim() || "this provider"
  const failure = searchParams.get("outcome") === "failed"
    ? parseFailurePayload(searchParams.get("failure"))
    : undefined
  return {
    connectionId,
    connectionName,
    outcome: failure ? "failed" : "pending",
    ...(failure ? { failure } : {}),
  }
}

export function describeMcpAuthorizationFailure(input: {
  connectionName: string
  message: string
  details?: McpAuthorizationDebugDetails
}): McpAuthorizationFailureDescription {
  const { connectionName, message, details } = input
  if (details?.diagnosticCode === "MCP_OAUTH_REDIRECT_URI_NOT_ALLOWED") {
    return {
      title: `${connectionName} hasn't approved OpenWork yet`,
      description: `${connectionName}'s sign-in server only accepts apps it has pre-approved, and OpenWork's sign-in address isn't on its list yet. Retrying won't help — ${connectionName} has to add OpenWork.`,
      advice: [
        details.redirectUri
          ? `Ask ${connectionName} to allowlist this redirect URI: ${details.redirectUri}`
          : `Ask ${connectionName} to allowlist OpenWork's redirect URI.`,
        "Share the diagnostic reference with them.",
        "Ask a workspace admin whether the provider offers a pre-registered OAuth app to configure instead.",
      ],
      retryable: false,
      copyable: [
        ...(details.redirectUri ? [{ label: "Redirect URI", value: details.redirectUri }] : []),
        ...(details.diagnosticReference ? [{ label: "Reference", value: details.diagnosticReference }] : []),
      ],
    }
  }

  if (details?.errorCode === "response_unreadable") {
    return {
      title: "OpenWork couldn't read its own API's answer",
      description: message,
      advice: [
        "Try again.",
        "If it keeps happening, tell a workspace admin the time of this attempt.",
      ],
      retryable: true,
      copyable: [],
    }
  }

  const retryable = details?.retryable !== false
  const ownerAdvice = details?.actionOwner === "provider_admin"
    ? `${connectionName} has to fix this on their side; share the reference below with them.`
    : details?.actionOwner === "organization_admin"
      ? "Ask your workspace admin to review this connection's setup."
      : details?.actionOwner === "member"
        ? retryable ? "Try connecting again." : undefined
        : details?.actionOwner === "openwork"
          ? "Contact OpenWork support with the reference below."
          : undefined
  return {
    title: `Couldn't start the ${connectionName} sign-in`,
    description: message,
    advice: ownerAdvice ? [ownerAdvice] : retryable ? ["Try again."] : [],
    retryable,
    copyable: details?.diagnosticReference
      ? [{ label: "Reference", value: details.diagnosticReference }]
      : [],
  }
}

export function showMcpAuthorizationFailure(
  tab: Window | null,
  input: {
    connectionId: string
    connectionName: string
    message: string
    details?: McpAuthorizationDebugDetails
  },
): void {
  if (!tab || tab.closed) return
  try {
    const failureUrl = new URL(mcpAuthorizationTabUrl({
      connectionId: input.connectionId,
      connectionName: input.connectionName,
      failure: {
        message: input.message,
        ...(input.details ? { details: input.details } : {}),
      },
    }), window.location.origin)
    tab.location.replace(failureUrl.toString())
  } catch {
    // Leave an isolated provider tab open so its own error remains available.
  }
}

export function openMcpAuthorizationTab(input: {
  connectionId: string
  connectionName: string
}): Window {
  const tabName = `openwork-mcp-authorization-${crypto.randomUUID()}`
  const tab = window.open(mcpAuthorizationTabUrl(input), tabName)
  if (!tab) {
    throw new Error("OpenWork could not open the sign-in tab. Allow popups for OpenWork, then try again.")
  }
  tab.opener = null
  return tab
}
