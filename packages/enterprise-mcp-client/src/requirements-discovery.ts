import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js"
import type {
  DiscoverEnterpriseMcpConnectionRequirementsInput,
  EnterpriseMcpAuthorizationServerRequirement,
  EnterpriseMcpConnectionRequirements,
  EnterpriseMcpFetch,
} from "./contracts.js"
import { isEquivalentOAuthResourceAlias } from "./oauth-resource-alias.js"

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_AUTHORIZATION_SERVERS = 5
const DEFAULT_MAX_TOOLS = 100
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_TOOL_PAGES = 5

function boundedResponse(response: Response): Response {
  const advertisedLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_RESPONSE_BYTES) {
    void response.body?.cancel()
    throw new Error("The MCP discovery response exceeded the 1 MiB limit.")
  }
  if (!response.body) return response

  const reader = response.body.getReader()
  let bytesRead = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read()
      if (result.done) {
        controller.close()
        return
      }
      bytesRead += result.value.byteLength
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        controller.error(new Error("The MCP discovery response exceeded the 1 MiB limit."))
        return
      }
      controller.enqueue(result.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
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
    const response = boundedResponse(await input.fetch(url, { ...init, signal }))
    input.observe(response)
    return response
  }
}

function metadataRequirement(
  advertisedIssuer: string,
  metadata: AuthorizationServerMetadata,
  resource: string | undefined,
): EnterpriseMcpAuthorizationServerRequirement | null {
  // Some providers advertise the protected resource itself as a scoped
  // metadata discovery alias. Accept that alias, including the equivalent
  // trailing root slash form, while retaining the metadata issuer as the
  // canonical issuer used by the OAuth flow.
  if (metadata.issuer !== advertisedIssuer && !isEquivalentOAuthResourceAlias(advertisedIssuer, resource)) return null
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
  let lastStatus: number | undefined
  let resourceMetadataUrl: URL | undefined
  let challengeScope: string | undefined
  const fetch = scopedFetch({
    fetch: input.fetch,
    signal: controller.signal,
    observe: (response) => {
      lastStatus = response.status
      if (response.status !== 401 && response.status !== 403) return
      const challenge = extractWWWAuthenticateParams(response)
      resourceMetadataUrl = challenge.resourceMetadataUrl ?? resourceMetadataUrl
      challengeScope = challenge.scope ?? challengeScope
    },
  })

  const warnings: EnterpriseMcpConnectionRequirements["warnings"] = []
  const tools: NonNullable<EnterpriseMcpConnectionRequirements["tools"]["items"]> = []
  let initialize: EnterpriseMcpConnectionRequirements["server"]["initialize"] = "failed"
  let authenticationRequired = false
  let client: Client | undefined
  try {
    client = new Client({ name: "OpenWork requirements discovery", version: "1.0.0" }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(serverUrl, { fetch })
    await client.connect(transport, { signal: controller.signal })
    initialize = "succeeded"
    let cursor: string | undefined
    const maxTools = input.maxTools ?? DEFAULT_MAX_TOOLS
    for (let page = 0; page < MAX_TOOL_PAGES && tools.length < maxTools; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { signal: controller.signal })
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
    authenticationRequired = lastStatus === 401 || lastStatus === 403
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

  let resourceMetadata: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>> | undefined
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      serverUrl,
      resourceMetadataUrl ? { resourceMetadataUrl } : undefined,
      fetch,
    )
  } catch (error) {
    if (authenticationRequired) {
      warnings.push({
        code: "oauth_resource_metadata_unavailable",
        message: error instanceof Error ? error.message : "Protected-resource metadata could not be discovered.",
      })
    }
  }

  const advertisedIssuers = (resourceMetadata?.authorization_servers ?? [])
    .slice(0, input.maxAuthorizationServers ?? DEFAULT_MAX_AUTHORIZATION_SERVERS)
  const authorizationServers: EnterpriseMcpAuthorizationServerRequirement[] = []
  for (const issuer of advertisedIssuers) {
    try {
      const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn: fetch })
      if (!metadata) {
        warnings.push({ code: "oauth_server_metadata_unavailable", message: `No OAuth metadata was found for issuer ${issuer}.` })
        continue
      }
      const requirement = metadataRequirement(issuer, metadata, resourceMetadata?.resource)
      if (!requirement) {
        warnings.push({ code: "oauth_issuer_mismatch", message: `OAuth metadata did not return the advertised issuer ${issuer}.` })
        continue
      }
      authorizationServers.push(requirement)
    } catch (error) {
      warnings.push({
        code: "oauth_server_metadata_unavailable",
        message: error instanceof Error ? error.message : `OAuth metadata could not be loaded for issuer ${issuer}.`,
      })
    }
  }

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
        : authenticationRequired
          ? "manual_action_required"
          : "unsupported"

  try {
    return {
      status,
      server: { url: serverUrl.toString(), initialize },
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
  }
}
