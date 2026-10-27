// Auto (feature `autoRouter`): a desktop sends an OpenAI chat request with
// model `openwork-auto`. The gateway asks Jev which of the organization's
// routes and thinking levels fits the latest prompt, rewrites the request for
// that model's protocol under the member's own Gateway alias, and hands it to
// the normal Gateway pipeline, which authorizes, meters and forwards it as if
// the member had picked that model. Responses go back as Chat Completions.
import { createGatewayModelAlias } from "@openwork-ee/utils/gateway-routing"
import {
  AUTO_ROUTER_RESPONSE_MODEL_HEADER,
  AUTO_ROUTER_RESPONSE_MODEL_NAME_HEADER,
  AUTO_ROUTER_RESPONSE_PROVIDER_HEADER,
  AUTO_ROUTER_RESPONSE_REASON_HEADER,
  AUTO_ROUTER_RESPONSE_THINKING_HEADER,
} from "@openwork/types/den/auto-router"
import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"
import { classifyProtocolFamily, type ProtocolFamily } from "../protocols.js"
import type { GatewayMemberAccessRow } from "../provider-access.js"
import type { GatewayContext } from "../middleware/gateway-auth.js"
import type { ProviderCatalog } from "../provider-catalog.js"
import { isEventStreamContentType, isJsonContentType } from "../relay.js"
import { isAwsEventStreamContentType } from "../usage/bedrock-converse.js"
import { anthropicTranslator } from "./anthropic.js"
import { bedrockTranslator } from "./bedrock.js"
import { isJsonObject, openAiChatTranslator, readAutoPrompt, type AutoRouteInfo, type JsonObject } from "./chat.js"
import { googleTranslator } from "./google.js"
import { openAiResponsesTranslator } from "./openai-responses.js"
import { chatToolCallIds, type AutoTranslator, type TranslateResponseInput } from "./protocol.js"
import type { ReasoningStore } from "./reasoning-store.js"
import type { AutoRouterConfig, AutoRouterConfigRoute } from "./config.js"
import { decideAutoRoute, type AutoCandidate } from "./decide.js"
import type { AskJev } from "./jev.js"


export type AutoTarget = {
  inferenceProviderId: string
  request: Request
  model: string
  rest: string
  search: string
  protocol: GatewayRequestProtocol
}

export type AutoRouterDependencies = {
  loadConfig: (input: { organizationId: string }) => Promise<AutoRouterConfig | null>
  loadMemberGatewayAccess: (identity: GatewayContext) => Promise<GatewayMemberAccessRow[]>
  catalog: ProviderCatalog
  askJev: AskJev
  reasoningStore: ReasoningStore
  /** The normal Gateway pipeline for a rewritten request. */
  forward: (target: AutoTarget) => Promise<Response>
  onJevError?: (error: unknown) => void
}

type RoutedCandidate = AutoCandidate & {
  route: AutoRouterConfigRoute
  row: GatewayMemberAccessRow
  family: ProtocolFamily
  translator: AutoTranslator
}

/** The translator for a provider's protocol family, or null when Auto cannot reach it. */
export function translatorFor(family: ProtocolFamily, npm: string | null): AutoTranslator | null {
  switch (family) {
    case "anthropic":
    case "google_vertex_anthropic":
    case "microsoft_foundry":
      return anthropicTranslator
    case "openai":
      // The desktop calls OpenAI through Responses (reasoning effort, summaries,
      // encrypted reasoning); Chat Completions rejects tools with an effort.
      return openAiResponsesTranslator({ rest: "responses" })
    case "openai_compatible":
      return openAiChatTranslator({ rest: "chat/completions", reasoningStyle: npm === "@openrouter/ai-sdk-provider" ? "openrouter" : "reasoning_effort" })
    case "mistral":
      return openAiChatTranslator({ rest: "chat/completions", reasoningStyle: "none" })
    case "azure":
      // Azure OpenAI's v1 API takes the deployment as `model`; the desktop uses its Responses API too.
      return openAiResponsesTranslator({ rest: "v1/responses" })
    case "bedrock_mantle":
      return openAiChatTranslator({ rest: "chat/completions", reasoningStyle: "reasoning_effort" })
    case "google":
    case "google_vertex":
      return googleTranslator
    case "bedrock":
      return bedrockTranslator
  }
}

function accessPriority(row: GatewayMemberAccessRow) {
  return row.grant.org_membership_id !== null ? 3 : row.grant.team_id !== null ? 2 : 1
}

function autoError(status: number, code: string, message: string) {
  return Response.json({ error: { message, type: status >= 500 ? "api_error" : "invalid_request_error", code } }, { status })
}

function modelName(row: GatewayMemberAccessRow) {
  return row.model?.name ?? row.model?.model_id ?? "model"
}

function maxOutputTokens(row: GatewayMemberAccessRow) {
  const config = row.model?.model_config
  const limit = config && isJsonObject(config.limit) ? config.limit.output : null
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 128_000) : null
}

/** The routes this member can use right now, each tied to one of the member's access rows. */
export function autoCandidates(config: AutoRouterConfig, rows: GatewayMemberAccessRow[], catalog: ProviderCatalog): RoutedCandidate[] {
  const candidates: RoutedCandidate[] = []
  config.routes.forEach((route, routeIndex) => {
    const matches = rows
      .filter((row) => row.provider.id === route.providerId && row.model?.model_id === route.modelId && row.model.gateway_provider_id === row.provider.id)
      .sort((a, b) => accessPriority(b) - accessPriority(a) || a.grant.id.localeCompare(b.grant.id))
    const row = matches[0]
    if (!row) return
    const catalogProvider = catalog.getCatalogProvider(row.provider.provider_id)
    const family = classifyProtocolFamily(catalogProvider)
    const translator = family ? translatorFor(family, catalogProvider?.npm ?? null) : null
    if (!family || !translator) return
    candidates.push({
      routeIndex,
      routeId: route.id,
      modelName: modelName(row),
      prompt: route.prompt,
      thinkingLevels: route.thinkingLevels,
      route,
      row,
      family,
      translator,
    })
  })
  return candidates
}

function forwardedHeaders(request: Request, extra: Record<string, string>) {
  const headers = new Headers()
  for (const name of ["content-type", "accept", "user-agent", "x-opencode-session-id", "x-openwork-session-id"]) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set("content-type", "application/json")
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  return headers
}

export function withRouteHeaders(response: Response, route: AutoRouteInfo, body: BodyInit | null, contentType?: string) {
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.set(AUTO_ROUTER_RESPONSE_PROVIDER_HEADER, route.provider)
  headers.set(AUTO_ROUTER_RESPONSE_MODEL_HEADER, route.model)
  headers.set(AUTO_ROUTER_RESPONSE_THINKING_HEADER, route.thinking)
  headers.set(AUTO_ROUTER_RESPONSE_REASON_HEADER, route.reason)
  if (route.name) headers.set(AUTO_ROUTER_RESPONSE_MODEL_NAME_HEADER, encodeURIComponent(route.name))
  if (contentType) headers.set("content-type", contentType)
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

async function translateResponse(response: Response, translator: AutoTranslator, input: TranslateResponseInput): Promise<Response> {
  const contentType = response.headers.get("content-type")
  const { route } = input
  if (!response.ok) {
    const body = isJsonContentType(contentType) ? await readJson(response) : (await response.body?.cancel().catch(() => {}), null)
    return withRouteHeaders(response, route, JSON.stringify(translator.errorToChat(body, response.status)), "application/json")
  }
  if (response.body && (isEventStreamContentType(contentType) || isAwsEventStreamContentType(contentType) || (input.stream && !isJsonContentType(contentType)))) {
    return withRouteHeaders(response, route, translator.streamToChat(response.body, input), "text/event-stream; charset=utf-8")
  }
  if (isJsonContentType(contentType)) {
    const body = await readJson(response)
    // Google streams a JSON array without alt=sse; translators accept it as a body.
    if (input.stream && Array.isArray(body)) {
      return withRouteHeaders(response, route, translator.streamToChat(new Response(`data: ${body.map((item) => JSON.stringify(item)).join("\n\ndata: ")}\n\n`).body ?? new ReadableStream(), input), "text/event-stream; charset=utf-8")
    }
    return withRouteHeaders(response, route, JSON.stringify(translator.jsonToChat(body, input)), "application/json")
  }
  return withRouteHeaders(response, route, response.body)
}

export async function handleAutoRequest(input: {
  request: Request
  body: JsonObject
  identity: GatewayContext
  dependencies: AutoRouterDependencies
}): Promise<Response> {
  const { request, body, identity, dependencies } = input
  const config = await dependencies.loadConfig({ organizationId: identity.organizationId })
  if (!config) return autoError(404, "auto_router_unavailable", "Auto isn't set up for your organization. Choose another model.")
  const candidates = autoCandidates(config, await dependencies.loadMemberGatewayAccess(identity), dependencies.catalog)
  if (!candidates.length) return autoError(403, "auto_router_no_models", "None of Auto's models are available to you. Choose another model, or ask your administrator for access.")

  const prompt = readAutoPrompt(body)
  const session = request.headers.get("x-opencode-session-id") ?? request.headers.get("x-openwork-session-id")
  const decision = await decideAutoRoute({
    candidates,
    prompt: prompt.prompt,
    context: prompt.context,
    continuation: prompt.continuation,
    turnKey: `${identity.gatewayKeyId}:${session ?? ""}:${prompt.turnFingerprint}`,
    askJev: dependencies.askJev,
    signal: request.signal,
    onJevError: dependencies.onJevError,
  })
  const chosen = decision ? candidates.find((candidate) => candidate.routeId === decision.candidate.routeId) : undefined
  if (!decision || !chosen?.row.model) return autoError(503, "auto_router_no_decision", "Auto couldn't choose a model. Try again, or choose a model yourself.")

  const alias = createGatewayModelAlias({ modelGroupId: chosen.row.group.id, credentialSetId: chosen.row.credentialSet.id, gatewayProviderModelId: chosen.row.model.id })
  const route: AutoRouteInfo = {
    provider: chosen.row.provider.provider_id,
    model: chosen.row.model.model_id,
    thinking: decision.thinkingLevel,
    reason: decision.reason,
    name: chosen.modelName,
  }
  const reasoning = await dependencies.reasoningStore.recall(identity.organizationId, chatToolCallIds(body))
  const translated = chosen.translator.toUpstream({
    body,
    model: alias,
    upstreamModel: chosen.row.model.model_id,
    thinkingLevel: decision.thinkingLevel,
    maxOutputTokens: maxOutputTokens(chosen.row),
    reasoning,
  })
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: forwardedHeaders(request, translated.headers),
    body: JSON.stringify(translated.body),
    signal: request.signal,
  })
  const response = await dependencies.forward({
    inferenceProviderId: chosen.row.provider.id,
    request: forwarded,
    model: alias,
    rest: translated.rest,
    search: translated.search,
    protocol: translated.protocol,
  })
  return translateResponse(response, chosen.translator, {
    route,
    stream: body.stream === true,
    remember: (toolCallIds, payload) => { void dependencies.reasoningStore.remember(identity.organizationId, toolCallIds, payload) },
  })
}
