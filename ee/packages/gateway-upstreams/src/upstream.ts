import type { GatewayAwsKeysSecret, GatewayProviderCredentialKind, GatewayRequestProtocol } from "@openwork/types/den/gateway"
import { isGatewayCustomProviderId } from "@openwork/types/den/gateway-custom-providers"
import { isMicrosoftFoundryOverrideAllowed, type CatalogProvider } from "@openwork-ee/gateway-catalog"
import { bedrockMantleService, bedrockService, signAwsRequest } from "@openwork-ee/gateway-upstreams/aws-sigv4"
import { bedrockMantleHost, bedrockRuntimeHost, inferenceEgressAllowedOrigins, isAwsRegion, validateInferenceUrl } from "@openwork-ee/gateway-upstreams/egress"
import { buildAuthHeader, classifyProtocolFamily, classifyRequestProtocol, defaultBaseUrl, filterQuery, stripApiVersionPrefix, vertexPublisherBase, type AuthHeader, type ProtocolFamily } from "@openwork-ee/gateway-upstreams/protocols"

/** The saved provider fields upstream resolution reads. */
export type UpstreamProvider = {
  provider_id: string
  provider_config: Record<string, unknown>
  settings: Record<string, unknown>
}

/** A credential ready to send: a secret for a header, or AWS keys to sign with. */
export type UpstreamCredential =
  | { kind: "secret"; credentialKind: GatewayProviderCredentialKind; secret: string }
  | { kind: "aws_keys"; awsKeys: GatewayAwsKeysSecret }

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export type ResolvedUpstream = {
  family: ProtocolFamily
  protocol: GatewayRequestProtocol
  url: URL
  regionDerived: boolean
}

export type UpstreamAuth =
  | { kind: "header"; header: AuthHeader }
  | { kind: "signer"; host: string; sign: (request: { method: string; url: URL; headers: Headers; body: string | Uint8Array<ArrayBuffer> | null }) => void }

function readBaseUrl(provider: UpstreamProvider, catalog: CatalogProvider | null, family: ProtocolFamily) {
  const override = provider.settings.upstreamBaseUrl
  if (typeof override === "string" && override) return override
  if (isGatewayCustomProviderId(provider.provider_id)) return null
  const config = provider.provider_config
  const options = isJsonObject(config.options) ? config.options : null
  if (options && typeof options.baseURL === "string" && options.baseURL) return options.baseURL
  if (typeof config.api === "string" && config.api) return config.api
  if (catalog?.api) return catalog.api
  return defaultBaseUrl(family, provider.settings)
}

export function isAwsFamily(family: ProtocolFamily): family is "bedrock" | "bedrock_mantle" {
  return family === "bedrock" || family === "bedrock_mantle"
}

function awsOperatorOverride(settings: Record<string, unknown>) {
  const override = settings.upstreamBaseUrl
  if (typeof override !== "string" || !override) return undefined
  try {
    return inferenceEgressAllowedOrigins().has(new URL(override).origin) ? override : null
  } catch { return null }
}

function awsUpstreamBase(family: "bedrock" | "bedrock_mantle", settings: Record<string, unknown>) {
  const override = awsOperatorOverride(settings)
  return override === undefined ? defaultBaseUrl(family, settings) : override
}

function foundryUpstreamBase(settings: Record<string, unknown>) {
  const override = settings.upstreamBaseUrl
  if (typeof override !== "string" || !override) return defaultBaseUrl("microsoft_foundry", settings)
  return isMicrosoftFoundryOverrideAllowed(settings.resourceName, override, inferenceEgressAllowedOrigins()) ? override : null
}

function upstreamBase(provider: UpstreamProvider, catalog: CatalogProvider | null, family: ProtocolFamily) {
  if (family === "google_vertex") return vertexPublisherBase(provider.settings, "google")
  if (family === "google_vertex_anthropic") return vertexPublisherBase(provider.settings, "anthropic")
  if (isAwsFamily(family)) return awsUpstreamBase(family, provider.settings)
  if (family === "microsoft_foundry") return foundryUpstreamBase(provider.settings)
  return readBaseUrl(provider, catalog, family)
}

export function resolveUpstream(provider: UpstreamProvider, catalog: CatalogProvider | null, rest: string, search: string): ResolvedUpstream | { error: string } {
  const family = classifyProtocolFamily(catalog)
  if (!family) return { error: `Provider ${provider.provider_id} has no supported SDK protocol in the models.dev catalog.` }
  const base = upstreamBase(provider, catalog, family)
  if (!base) {
    return {
      error: family === "google_vertex" || family === "google_vertex_anthropic"
        ? "Vertex providers require settings.project and settings.location."
        : family === "microsoft_foundry"
          ? "Microsoft Foundry providers reach their own resource; settings.resourceName is required and a custom upstream URL must be an operator-approved origin."
          : `Provider ${provider.provider_id} has no upstream base URL.`,
    }
  }
  const forwardedRest = family === "google_vertex" || family === "google_vertex_anthropic" || family === "bedrock_mantle" ? stripApiVersionPrefix(rest) : rest
  if (rest.includes("\\") || rest.split("/").some((part) => /^(?:\.|%2e){1,2}$/i.test(part))) return { error: "Invalid upstream path." }
  const protocol = classifyRequestProtocol(family, forwardedRest)
  let url: URL
  try {
    validateInferenceUrl(base, { base: true })
    url = new URL(`${base.replace(/\/+$/, "")}${forwardedRest ? `/${forwardedRest}` : ""}${filterQuery(family, search)}`)
    validateInferenceUrl(url)
    if (url.origin !== new URL(base).origin) return { error: "Invalid upstream origin." }
  } catch {
    return { error: `Provider ${provider.provider_id} has an invalid upstream base URL.` }
  }
  return { family, protocol, url, regionDerived: isAwsFamily(family) && awsOperatorOverride(provider.settings) === undefined }
}

export function materializeAuth(credential: UpstreamCredential, provider: UpstreamProvider, family: ProtocolFamily, now: Date): UpstreamAuth | { error: string } {
  if (!isAwsFamily(family)) {
    if (credential.kind === "aws_keys") return { error: `AWS credentials are only supported for Amazon Bedrock providers, not ${provider.provider_id}.` }
    return { kind: "header", header: buildAuthHeader(family, credential.secret, credential.credentialKind === "oauth_azure") }
  }
  const settingsRegion = typeof provider.settings.region === "string" && provider.settings.region ? provider.settings.region : null
  const region = (credential.kind === "aws_keys" ? credential.awsKeys.region : undefined) ?? settingsRegion
  if (!isAwsRegion(region)) return { error: "Bedrock providers require a valid AWS region." }
  if (credential.kind === "secret") return { kind: "header", header: buildAuthHeader(family, credential.secret) }
  const credentials = credential.awsKeys
  return {
    kind: "signer",
    host: family === "bedrock_mantle" ? bedrockMantleHost(region) : bedrockRuntimeHost(region),
    sign(request) {
      signAwsRequest({ ...request, credentials, region, service: family === "bedrock_mantle" ? bedrockMantleService : bedrockService, now })
    },
  }
}
