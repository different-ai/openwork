import {
  Client,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
  IssuerMismatchError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/client"
import type {
  DiscoverEnterpriseMcpConnectionRequirementsInput,
  EnterpriseMcpAuthorizationServerRequirement,
  EnterpriseMcpConnectionRequirements,
  EnterpriseMcpFetch,
  EnterpriseMcpDiscoveryCheck,
} from "./contracts.js"
import { isEquivalentOAuthDiscoveryAlias } from "./oauth-resource-alias.js"
import { OAuthMetadataSchema } from "@modelcontextprotocol/core"
import { manualOAuthEndpointSchema, manualOAuthEndpointsSchema, oauthIssuerMismatchMessage, safeOAuthIssuerLabel } from "./manual-oauth.js"

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_AUTHORIZATION_SERVERS = 5
const DEFAULT_MAX_TOOLS = 100
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_TOOL_PAGES = 5

/**
 * Select a canonical issuer only when fresh requirements discovery proves
 * that a stale configured value is either the same root issuer alias or the
 * protected resource's own discovery alias. Ambiguous and partially invalid
 * discovery results remain manual failures.
 */
export function selectRecoverableAuthorizationServerIssuer(input: {
  selectedIssuer: string
  requirements: Pick<EnterpriseMcpConnectionRequirements, "authentication" | "warnings">
}): string | undefined {
  if (
    input.requirements.authentication.kind !== "oauth"
    || input.requirements.authentication.authorizationServers.length !== 1
    || input.requirements.warnings.some((warning) => warning.code === "oauth_issuer_mismatch")
  ) return undefined

  const canonicalIssuer = input.requirements.authentication.authorizationServers[0]?.issuer
  if (!canonicalIssuer || canonicalIssuer === input.selectedIssuer) return undefined
  if (isEquivalentOAuthDiscoveryAlias(input.selectedIssuer, canonicalIssuer)) return canonicalIssuer
  return isEquivalentOAuthDiscoveryAlias(input.selectedIssuer, input.requirements.authentication.resource)
    ? canonicalIssuer
    : undefined
}

function boundedResponse(response: Response, signal: AbortSignal): Response {
  const advertisedLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_RESPONSE_BYTES) {
    void response.body?.cancel()
    throw new Error("The MCP discovery response exceeded the 1 MiB limit.")
  }
  if (!response.body) return response

  const reader = response.body.getReader()
  let bytesRead = 0
  let finished = false
  let abortBody: (() => void) | undefined
  const cleanup = () => {
    finished = true
    if (abortBody) signal.removeEventListener("abort", abortBody)
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abortBody = () => {
        if (finished) return
        cleanup()
        controller.error(signal.reason)
        void reader.cancel(signal.reason).catch(() => {})
      }
      signal.addEventListener("abort", abortBody, { once: true })
      if (signal.aborted) abortBody()
    },
    async pull(controller) {
      try {
        const result = await reader.read()
        if (finished) return
        if (result.done) {
          cleanup()
          controller.close()
          return
        }
        bytesRead += result.value.byteLength
        if (bytesRead > MAX_RESPONSE_BYTES) {
          cleanup()
          controller.error(new Error("The MCP discovery response exceeded the 1 MiB limit."))
          await reader.cancel()
          return
        }
        controller.enqueue(result.value)
      } catch (error) {
        if (finished) return
        cleanup()
        controller.error(error)
      }
    },
    async cancel(reason) {
      cleanup()
      await reader.cancel(reason)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/** DNS guards and injected fetch ports may finish after cancellation. Fence them too. */
function abortableResponse(pending: Promise<Response>, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    let aborted = false
    const abort = () => {
      aborted = true
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    void pending.then(response => {
      signal.removeEventListener("abort", abort)
      if (aborted) {
        void response.body?.cancel().catch(() => {})
      } else resolve(response)
    }, error => {
      signal.removeEventListener("abort", abort)
      reject(error)
    })
  })
}

function scopedFetch(input: {
  fetch: EnterpriseMcpFetch
  signal: AbortSignal
  observe: (response: Response) => void
}): EnterpriseMcpFetch {
  return async (url, init) => {
    const signal = init?.signal
      ? AbortSignal.any([init.signal, input.signal])
      : input.signal
    signal.throwIfAborted()
    const response = boundedResponse(await abortableResponse(input.fetch(url, { ...init, signal, redirect: "manual", credentials: "omit" }), signal), signal)
    signal.throwIfAborted()
    input.observe(response)
    return response
  }
}

function metadataRequirement(metadata: AuthorizationServerMetadata): EnterpriseMcpAuthorizationServerRequirement | undefined {
  // Issuer verification is not permission to disclose credentials embedded in a
  // published URL. Keep exact trusted identifiers only when all URLs are safe.
  const urls = [metadata.issuer, metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]
  if (urls.some((url) => url !== undefined && !manualOAuthEndpointSchema.safeParse(url).success)) return undefined
  return {
    issuer: metadata.issuer,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint,
    clientIdMetadataDocumentSupported: metadata.client_id_metadata_document_supported === true,
    scopesSupported: metadata.scopes_supported,
    grantTypesSupported: metadata.grant_types_supported,
    codeChallengeMethodsSupported: metadata.code_challenge_methods_supported,
    tokenEndpointAuthMethodsSupported: metadata.token_endpoint_auth_methods_supported,
  }
}

async function discoverBoundAuthorizationServerMetadata(input: {
  advertisedIssuer: string
  resource: string | undefined
  fetch: EnterpriseMcpFetch
}): Promise<AuthorizationServerMetadata | null> {
  let canonicalIssuer: string
  let mismatch: IssuerMismatchError
  try {
    return await discoverAuthorizationServerMetadata(input.advertisedIssuer, { fetchFn: input.fetch }) ?? null
  } catch (error) {
    if (
      !(error instanceof IssuerMismatchError)
      || !isEquivalentOAuthDiscoveryAlias(input.advertisedIssuer, input.resource)
      || typeof error.received !== "string"
      || !error.received
    ) throw error
    canonicalIssuer = error.received
    mismatch = error
  }

  // A few providers advertise the protected resource as a discovery alias.
  // The strict SDK mismatch exposes only the parsed issuer identifier. Treat
  // that value as a pointer, independently rediscover it with RFC 8414 issuer
  // validation enabled, and never consume endpoints from the alias document.
  const canonical = await discoverAuthorizationServerMetadata(canonicalIssuer, { fetchFn: input.fetch })
  if (!canonical) throw mismatch
  return canonical
}

function uniqueScopes(value: string | undefined): string[] {
  if (!value) return []
  return [...new Set(value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))]
}

function manualRequirements(input: {
  authorizationServers: EnterpriseMcpAuthorizationServerRequirement[]
  authenticationRequired: boolean
}): EnterpriseMcpConnectionRequirements["manualRequirements"] {
  const requirements: EnterpriseMcpConnectionRequirements["manualRequirements"] = [
    {
      code: "provider_access",
      label: "Provider access",
      reason: "Provider roles, licenses, tenant access, and administrator consent are not described by MCP OAuth metadata.",
      required: false,
    },
    {
      code: "network_trust",
      label: "Network trust",
      reason: "Private routing, proxy, firewall, and private CA requirements must be confirmed in the Den deployment environment.",
      required: false,
    },
  ]
  if (input.authorizationServers.length > 1) {
    requirements.unshift({
      code: "authorization_server_selection",
      label: "Choose an authorization server",
      reason: "The protected resource advertises more than one issuer, so an administrator must bind this connection to one.",
      required: true,
    })
  }
  if (
    input.authenticationRequired
    && !input.authorizationServers.some((server) => server.clientIdMetadataDocumentSupported || server.registrationEndpoint)
  ) {
    requirements.unshift({
      code: "oauth_client_registration",
      label: "Register an OAuth client",
      reason: "The authorization server does not advertise client metadata documents or dynamic registration.",
      required: true,
    })
  }
  return requirements
}

export async function discoverConnectionRequirements(
  input: DiscoverEnterpriseMcpConnectionRequirementsInput,
): Promise<EnterpriseMcpConnectionRequirements> {
  const serverUrl = new URL(input.serverUrl)
  if (serverUrl.protocol !== "http:" && serverUrl.protocol !== "https:") {
    throw new Error("An enterprise MCP server URL must use HTTP or HTTPS.")
  }
  if (serverUrl.username || serverUrl.password || serverUrl.hash) {
    throw new Error("An enterprise MCP server URL cannot contain credentials or a fragment.")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("MCP requirements discovery timed out.")), input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal
  const emit = (check: EnterpriseMcpDiscoveryCheck) => {
    if (!input.signal?.aborted) input.onCheck?.(check)
  }
  try {
    signal.throwIfAborted()
    let negotiationHttpStatus: number | undefined
    let challengeHttpStatus: number | undefined
    let checkingServer = true
    let lastStatus: number | undefined
    let resourceMetadataUrl: URL | undefined
    let challengeScope: string | undefined
    const fetch = scopedFetch({
      fetch: input.fetch,
      signal,
      observe: (response) => {
        lastStatus = response.status
        if (checkingServer && (response.status === 401 || response.status === 403)) challengeHttpStatus = response.status
        if (response.status !== 401 && response.status !== 403) return
        const challenge = extractWWWAuthenticateParams(response)
        resourceMetadataUrl = challenge.resourceMetadataUrl ?? resourceMetadataUrl
        challengeScope = challenge.scope ?? challengeScope
      },
    })

    const warnings: EnterpriseMcpConnectionRequirements["warnings"] = []
    const tools: NonNullable<EnterpriseMcpConnectionRequirements["tools"]["items"]> = []
    let initialize: EnterpriseMcpConnectionRequirements["server"]["initialize"] = "failed"
    let protocolEra: EnterpriseMcpConnectionRequirements["server"]["protocolEra"]
    let protocolVersion: string | undefined
    let authenticationRequired = false
    let client: Client | undefined
    emit({ id: "server", status: "running" })
    let serverFinished = false
    try {
      client = new Client(
        { name: "OpenWork requirements discovery", version: "1.0.0" },
        { capabilities: {}, versionNegotiation: { mode: "auto" } },
      )
      const serverFetch: EnterpriseMcpFetch = async (url, init) => {
        let negotiation = false
        if (init?.method === "POST" && typeof init.body === "string") {
          try {
            const request: unknown = JSON.parse(init.body)
            negotiation = typeof request === "object" && request !== null && "method" in request
              && (request.method === "server/discover" || request.method === "initialize")
          } catch {
            // Unknown request bodies cannot supply a negotiation badge.
          }
        }
        // Follow the actual negotiation attempt, not a failed modern probe or
        // the initialized notification sent before client.connect resolves.
        if (negotiation) negotiationHttpStatus = undefined
        const response = await fetch(url, init)
        if (negotiation) negotiationHttpStatus = response.status
        return response
      }
      const transport = new StreamableHTTPClientTransport(serverUrl, { fetch: serverFetch })
      await client.connect(transport, { signal })
      checkingServer = false
      serverFinished = true
      emit({ id: "server", status: "passed", httpStatus: negotiationHttpStatus })
      initialize = "succeeded"
      protocolEra = client.getProtocolEra()
      protocolVersion = client.getNegotiatedProtocolVersion()
      let cursor: string | undefined
      const maxTools = input.maxTools ?? DEFAULT_MAX_TOOLS
      for (let page = 0; page < MAX_TOOL_PAGES && tools.length < maxTools; page += 1) {
        const result = await client.listTools(cursor ? { cursor } : undefined, { signal })
        for (const tool of result.tools) {
          if (tools.length >= maxTools) break
          tools.push({
            name: tool.name,
            readOnlyHint: tool.annotations?.readOnlyHint,
            destructiveHint: tool.annotations?.destructiveHint,
            openWorldHint: tool.annotations?.openWorldHint,
          })
        }
        cursor = result.nextCursor
        if (!cursor) break
      }
    } catch (error) {
      checkingServer = false
      authenticationRequired = lastStatus === 401 || lastStatus === 403
      const serverHttpStatus = authenticationRequired ? challengeHttpStatus : negotiationHttpStatus
      if (!serverFinished) emit({
        id: "server",
        status: authenticationRequired ? "passed" : "failed",
        ...(serverHttpStatus === undefined ? {} : { httpStatus: serverHttpStatus }),
        code: authenticationRequired ? "authentication_required" : serverHttpStatus === 200 && !signal.aborted ? "unsupported" : "unavailable",
      })
      initialize = authenticationRequired ? "authentication_required" : "failed"
      if (!authenticationRequired) {
        warnings.push({
          code: lastStatus ? `mcp_http_${lastStatus}` : "mcp_unreachable",
          message: error instanceof Error ? error.message : "The MCP endpoint could not be reached.",
        })
      }
    } finally {
      try {
        await client?.close()
      } catch {
        // Discovery results remain useful even when best-effort transport cleanup fails.
      }
    }

    input.signal?.throwIfAborted()
    emit({ id: "resource", status: "running" })
    let resourceMetadata: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>> | undefined
    let resourceHttpStatus: number | undefined
    const resourceFetch: EnterpriseMcpFetch = async (url, init) => {
      // A later network failure has no HTTP status; do not reuse a fallback's 404.
      resourceHttpStatus = undefined
      const response = await fetch(url, init)
      resourceHttpStatus = response.status
      return response
    }
    try {
      resourceMetadata = await discoverOAuthProtectedResourceMetadata(
        serverUrl,
        resourceMetadataUrl ? { resourceMetadataUrl } : undefined,
        resourceFetch,
      )
    } catch (error) {
      if (authenticationRequired) {
        warnings.push({
          code: "oauth_resource_metadata_unavailable",
          message: error instanceof Error ? error.message : "Protected-resource metadata could not be discovered.",
        })
      }
    }

    emit({ id: "resource", status: resourceMetadata ? "passed" : authenticationRequired ? "failed" : initialize === "succeeded" ? "skipped" : "failed",
      ...(resourceHttpStatus !== undefined && (resourceMetadata || initialize !== "succeeded") ? { httpStatus: resourceHttpStatus } : {}),
      ...(!resourceMetadata ? { code: authenticationRequired || initialize !== "succeeded" ? "unavailable" : "not_required" } : {}),
    })
    input.signal?.throwIfAborted()
    const advertisedIssuers = (resourceMetadata?.authorization_servers ?? [])
      .slice(0, input.maxAuthorizationServers ?? DEFAULT_MAX_AUTHORIZATION_SERVERS)
    const authorizationServers: EnterpriseMcpAuthorizationServerRequirement[] = []
    const publishedSignInAddresses: NonNullable<EnterpriseMcpConnectionRequirements["publishedSignInAddresses"]> = []
    // A bounded discovery must not claim to have validated issuers it did not inspect.
    let providerFailure: EnterpriseMcpDiscoveryCheck["code"] = (resourceMetadata?.authorization_servers?.length ?? 0) > advertisedIssuers.length
      ? "unsupported"
      : undefined
    const providerFailureStatuses: Array<number | undefined> = providerFailure ? [undefined] : []
    let providerValidatedHttpStatus: number | undefined
    const recordProviderFailure = (code: NonNullable<EnterpriseMcpDiscoveryCheck["code"]>, httpStatus: number | undefined) => {
      if (code === "issuer_mismatch") providerFailure = code
      else providerFailure ??= code
      providerFailureStatuses.push(httpStatus)
    }
    if (advertisedIssuers.length) emit({ id: "provider", status: "running" })
    else emit({ id: "provider", status: "skipped", code: providerFailure ?? (authenticationRequired ? "unavailable" : "not_required") })
    for (const issuer of advertisedIssuers) {
      // Observe the already-fetched document, separately from strict SDK validation.
      // Never follow a URL from a failed document to obtain these suggestions.
      const candidates: Array<{ authorizationEndpoint: string; tokenEndpoint: string; metadataIssuer: string }> = []
      let issuerHttpStatus: number | undefined
      let issuerSuccessfulHttpStatus: number | undefined
      const inspectFetch: EnterpriseMcpFetch = async (url, init) => {
        issuerHttpStatus = undefined
        const response = await fetch(url, { ...init, redirect: "manual", credentials: "omit" })
        issuerHttpStatus = response.status
        // Alias recovery can rethrow an earlier mismatch after canonical 404s.
        // That mismatch belongs to the successful document, not the later 404.
        if (response.ok) issuerSuccessfulHttpStatus = response.status
        if (response.status === 200 && response.headers.get("content-type")?.split(";", 1)[0]?.trim() === "application/json") {
          const metadata = OAuthMetadataSchema.safeParse(await response.clone().json().catch(() => undefined))
          if (metadata.success) {
            const endpoints = manualOAuthEndpointsSchema.safeParse({ authorizationEndpoint: metadata.data.authorization_endpoint, tokenEndpoint: metadata.data.token_endpoint })
            if (endpoints.success) candidates.push({ ...endpoints.data, metadataIssuer: safeOAuthIssuerLabel(metadata.data.issuer) })
          }
        }
        return response
      }
      try {
        const metadata = await discoverBoundAuthorizationServerMetadata({
          advertisedIssuer: issuer,
          resource: resourceMetadata?.resource,
          fetch: inspectFetch,
        })
        if (!metadata) {
          recordProviderFailure("unavailable", issuerHttpStatus)
          warnings.push({ code: "oauth_server_metadata_unavailable", message: `No OAuth metadata was found for issuer ${issuer}.` })
          continue
        }
        const requirement = metadataRequirement(metadata)
        if (!requirement) {
          recordProviderFailure("unsupported", issuerHttpStatus)
          warnings.push({ code: "oauth_sign_in_addresses_unsafe", message: "The server published sign-in URLs with credentials or unsupported URL components. Ask the server owner for safe sign-in addresses." })
          continue
        }
        if (!manualOAuthEndpointsSchema.safeParse({ authorizationEndpoint: requirement.authorizationEndpoint, tokenEndpoint: requirement.tokenEndpoint }).success) recordProviderFailure("unsupported", issuerHttpStatus)
        else providerValidatedHttpStatus = issuerHttpStatus
        authorizationServers.push(requirement)
      } catch (error) {
        recordProviderFailure(error instanceof IssuerMismatchError ? "issuer_mismatch" : "unavailable", error instanceof IssuerMismatchError ? issuerSuccessfulHttpStatus : issuerHttpStatus)
        warnings.push({
          code: error instanceof IssuerMismatchError ? "oauth_issuer_mismatch" : "oauth_server_metadata_unavailable",
          message: error instanceof IssuerMismatchError
            ? oauthIssuerMismatchMessage(error.expected, error.received)
            : error instanceof Error ? error.message : `OAuth metadata could not be loaded for issuer ${issuer}.`,
        })
      }
      for (const candidate of candidates) publishedSignInAddresses.push({ ...candidate, advertisedIssuer: safeOAuthIssuerLabel(issuer) })
    }

    // One badge must not hide mixed failures or borrow a successful issuer's status.
    const providerHttpStatus = providerFailure
      ? providerFailureStatuses.every(status => status === providerFailureStatuses[0]) ? providerFailureStatuses[0] : undefined
      : providerValidatedHttpStatus
    if (advertisedIssuers.length) emit({
      id: "provider", status: providerFailure ? "failed" : "passed",
      ...(providerHttpStatus !== undefined ? { httpStatus: providerHttpStatus } : {}),
      ...(providerFailure ? { code: providerFailure } : {}),
    })
    input.signal?.throwIfAborted()

    const requiredScopes = uniqueScopes(challengeScope)
    const refreshSupported = authorizationServers.some((server) => server.grantTypesSupported?.includes("refresh_token"))
    const offlineAccessSupported = authorizationServers.some((server) => server.scopesSupported?.includes("offline_access"))
    const recommendedScopes = requiredScopes.length > 0
      ? [...requiredScopes]
      : [...new Set(resourceMetadata?.scopes_supported ?? [])]
    if (refreshSupported && offlineAccessSupported && !recommendedScopes.includes("offline_access")) {
      recommendedScopes.push("offline_access")
    }

    const supportsClientMetadata = authorizationServers.some((server) => server.clientIdMetadataDocumentSupported)
    const supportsDynamic = authorizationServers.some((server) => Boolean(server.registrationEndpoint))
    const availableRegistrationMethods: EnterpriseMcpConnectionRequirements["authentication"]["availableRegistrationMethods"] = ["pre_registered"]
    if (supportsClientMetadata) availableRegistrationMethods.unshift("client_metadata")
    if (supportsDynamic) availableRegistrationMethods.push("dynamic")
    let recommendedRegistrationMethod: EnterpriseMcpConnectionRequirements["authentication"]["recommendedRegistrationMethod"] = "pre_registered"
    if (supportsClientMetadata) recommendedRegistrationMethod = "client_metadata"
    else if (supportsDynamic) recommendedRegistrationMethod = "dynamic"

    const oauthDetected = Boolean(resourceMetadata || authorizationServers.length > 0)
    const requirements = manualRequirements({ authorizationServers, authenticationRequired })
    const status: EnterpriseMcpConnectionRequirements["status"] = initialize === "succeeded"
      ? "ready"
      : !authenticationRequired && lastStatus === undefined
        ? "unreachable"
        : oauthDetected && !requirements.some((requirement) => requirement.required)
          ? "ready"
          : authenticationRequired || oauthDetected
            ? "manual_action_required"
            : "unsupported"

    return {
      status,
      ...(publishedSignInAddresses.length ? { publishedSignInAddresses } : {}),
      server: {
        url: serverUrl.toString(),
        initialize,
        ...(protocolEra ? { protocolEra } : {}),
        ...(protocolVersion ? { protocolVersion } : {}),
      },
      authentication: {
        kind: initialize === "succeeded" ? "none" : oauthDetected ? "oauth" : authenticationRequired ? "manual_bearer" : "unknown",
        resource: resourceMetadata?.resource,
        protectedResourceMetadataUrl: resourceMetadataUrl?.toString(),
        authorizationServers,
        requiredScopes,
        recommendedScopes,
        refreshSupport: refreshSupported ? "supported" : authorizationServers.length > 0 ? "not_advertised" : "unknown",
        availableRegistrationMethods,
        recommendedRegistrationMethod,
      },
      tools: initialize === "succeeded"
        ? { visibility: "available_without_auth", count: tools.length, items: tools }
        : authenticationRequired
          ? { visibility: "requires_auth" }
          : { visibility: "unavailable" },
      manualRequirements: requirements,
      warnings,
    }
  } finally {
    clearTimeout(timeout)
    // Release unconsumed challenge/cleanup bodies and fence late SDK work.
    controller.abort()
  }
}
