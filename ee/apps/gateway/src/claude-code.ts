// Claude Code through the AI Gateway. Claude Code reaches another
// provider through ANTHROPIC_BASE_URL and speaks only the Anthropic Messages API, so every model
// has to answer as Messages, by a name a person can set in its settings.
//
// GET  /api/v1/claude-code/v1/models                the member's models under their names (Claude
//                                                   Code's gateway model picker)
// POST /api/v1/claude-code/v1/messages              resolves the name. A model whose provider speaks
//                                                   Messages gets the request as it is (thinking,
//                                                   cache control and betas intact); any other is
//                                                   translated through Chat Completions and back.
//                                                   Both run the normal Gateway pipeline under the
//                                                   member's own alias.
// POST /api/v1/claude-code/v1/messages/count_tokens an estimate; nothing is sent upstream.
import { createGatewayModelAlias } from "@openwork-ee/utils/gateway-routing"
import { AUTO_ROUTER_THINKING_LEVELS, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import { claudeCodeModelName, matchCursorModel, parseClaudeCodeModelName } from "@openwork/types/den/gateway-cursor"
import { forwardedHeaders, maxOutputTokens, translateResponse, type AutoTarget } from "./auto-router/handler.js"
import { isJsonObject, type JsonObject } from "./auto-router/chat.js"
import { chatToolCallIds } from "./auto-router/protocol.js"
import type { ReasoningStore } from "./auto-router/reasoning-store.js"
import { chatErrorToMessages, chatStreamToMessages, chatToMessages, estimateMessagesTokens, messagesReasoningEffort, messagesToChat } from "./claude-code-messages.js"
import { cursorModels, type CursorModel } from "./cursor.js"
import type { GatewayContext } from "./middleware/gateway-auth.js"
import type { ProtocolFamily } from "./protocols.js"
import type { GatewayMemberAccessRow } from "./provider-access.js"
import type { ProviderCatalog } from "./provider-catalog.js"
import { isEventStreamContentType, isJsonContentType } from "./relay.js"
import { resolveSmartRouter, type SmartToolDependencies, type SmartToolRouter } from "./smart-tools.js"

export const claudeCodePathPrefix = "/api/v1/claude-code"
export const claudeCodeModelsPath = `${claudeCodePathPrefix}/v1/models`
export const claudeCodeMessagesPath = `${claudeCodePathPrefix}/v1/messages`
export const claudeCodeCountTokensPath = `${claudeCodePathPrefix}/v1/messages/count_tokens`

export type ClaudeCodeDependencies = {
  loadMemberGatewayAccess: (identity: GatewayContext) => Promise<GatewayMemberAccessRow[]>
  catalog: ProviderCatalog
  reasoningStore: ReasoningStore
  /** The normal Gateway pipeline for a rewritten request. */
  forward: (target: AutoTarget) => Promise<Response>
  /** Smart Routers: listed and routed when given. */
  smart?: SmartToolDependencies
}

/** Providers that take a Messages request as it is. */
const MESSAGES_FAMILIES: ReadonlySet<ProtocolFamily> = new Set(["anthropic", "google_vertex_anthropic", "microsoft_foundry"])

/** Headers Claude Code sends that Messages providers act on. */
const MESSAGES_HEADERS = ["anthropic-version", "anthropic-beta"]

/** An Anthropic error body, which Claude Code shows as it is. */
export function claudeCodeError(status: number, type: string, message: string) {
  return Response.json({ type: "error", error: { type, message } }, { status })
}

function contextWindow(model: CursorModel): number | null {
  const limit = model.row.model?.model_config.limit
  const context = isJsonObject(limit) ? limit.context : null
  return typeof context === "number" && Number.isFinite(context) ? context : null
}

export function claudeCodeName(model: CursorModel) {
  return claudeCodeModelName({ name: model.name, modelId: model.modelId, contextWindow: contextWindow(model) })
}

/**
 * The Anthropic List Models shape, with each model's name for Claude Code as its id, then the
 * member's Smart Routers (no `[1m]`: Smart may pick any of its models).
 */
export function listClaudeCodeModels(models: CursorModel[], routers: SmartToolRouter[] = []) {
  const data = [...models.map((model) => ({
    type: "model" as const,
    id: claudeCodeName(model),
    display_name: model.name,
    created_at: (model.row.model?.created_at ?? new Date(0)).toISOString(),
  })), ...routers.map((router) => ({
    type: "model" as const,
    id: router.toolName,
    display_name: router.name,
    created_at: new Date(0).toISOString(),
  }))]
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null }
}

/**
 * The model a request names. Claude Code may also send a model id of its own (a background task on
 * its default model, for example): that resolves when one of the member's models has that catalog id.
 */
function resolveModel(requested: unknown, models: CursorModel[], smartError?: () => Response): { model: CursorModel } | { error: Response } {
  const parsed = parseClaudeCodeModelName(requested)
  if (parsed) {
    const match = matchCursorModel(parsed, models)
    if (match.kind === "found") return { model: match.model }
    if (match.kind === "ambiguous") return { error: claudeCodeError(400, "invalid_request_error", `More than one of your models matches ${String(requested)}. Copy the settings again from Set up Claude Code in your OpenWork Library.`) }
  }
  const raw = typeof requested === "string" ? requested.replace(/\[[^\]]*\]\s*$/, "").trim().toLowerCase() : ""
  const byCatalogId = raw ? models.filter((model) => model.row.model?.model_id.toLowerCase() === raw) : []
  if (byCatalogId.length === 1 && byCatalogId[0]) return { model: byCatalogId[0] }
  if (smartError) return { error: smartError() }
  // Same answer for a model that does not exist and one this member cannot use.
  return { error: claudeCodeError(404, "not_found_error", `${String(requested)} is not one of your OpenWork models. Copy the settings from Set up Claude Code in your OpenWork Library, or pick a model with /model.`) }
}

function requestedEffort(body: JsonObject, levels: readonly AutoRouterThinkingLevel[]): AutoRouterThinkingLevel {
  const effort = messagesReasoningEffort(body)
  return AUTO_ROUTER_THINKING_LEVELS.find((level) => level === effort && levels.includes(level)) ?? "default"
}

/** A Gateway error on a Messages route, in the Anthropic error shape Claude Code reads. */
async function asMessagesError(response: Response): Promise<Response> {
  if (response.ok || !isJsonContentType(response.headers.get("content-type"))) return response
  const body: unknown = await response.json().catch(() => null)
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const converted = isJsonObject(body) && body.type === "error" ? body : chatErrorToMessages(body, response.status)
  return new Response(JSON.stringify(converted), { status: response.status, headers })
}

/** A Chat Completions answer as the Messages API's. */
async function asMessages(response: Response, model: string): Promise<Response> {
  if (!response.ok) return asMessagesError(response)
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const contentType = response.headers.get("content-type")
  if (response.body && isEventStreamContentType(contentType)) {
    headers.set("content-type", "text/event-stream; charset=utf-8")
    return new Response(chatStreamToMessages(response.body, model), { status: response.status, headers })
  }
  if (isJsonContentType(contentType)) {
    const body: unknown = await response.json().catch(() => null)
    headers.set("content-type", "application/json")
    return new Response(JSON.stringify(chatToMessages(body, model)), { status: response.status, headers })
  }
  return response
}

function messagesHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const name of MESSAGES_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers[name] = value
  }
  return headers
}

export async function handleClaudeCodeMessages(input: {
  request: Request
  body: JsonObject
  identity: GatewayContext
  dependencies: ClaudeCodeDependencies
}): Promise<Response> {
  const { request, body, identity, dependencies } = input
  const smart = await resolveSmartRouter(body.model, identity, dependencies.smart)
  if (smart.kind === "router" && dependencies.smart) {
    const answer = await dependencies.smart.route({ request, body: messagesToChat(body), routerId: smart.routerId })
    return asMessages(answer, typeof body.model === "string" ? body.model : "smart")
  }
  const models = cursorModels(await dependencies.loadMemberGatewayAccess(identity), dependencies.catalog)
  const resolved = resolveModel(body.model, models, smart.kind === "unavailable" ? smart.error : undefined)
  if ("error" in resolved) return asMessagesError(resolved.error)
  const { model } = resolved
  const providerModel = model.row.model
  if (!providerModel) return claudeCodeError(404, "not_found_error", `${String(body.model)} is not one of your OpenWork models.`)
  const alias = createGatewayModelAlias({ modelGroupId: model.row.group.id, credentialSetId: model.row.credentialSet.id, gatewayProviderModelId: providerModel.id })
  const requestedName = typeof body.model === "string" ? body.model : claudeCodeName(model)

  if (MESSAGES_FAMILIES.has(model.family)) {
    const response = await dependencies.forward({
      inferenceProviderId: model.row.provider.id,
      request: new Request(request.url, {
        method: "POST",
        headers: forwardedHeaders(request, messagesHeaders(request)),
        body: JSON.stringify({ ...body, model: alias }),
        signal: request.signal,
      }),
      model: alias,
      rest: "messages",
      search: "",
      protocol: "anthropic_messages",
    })
    return asMessagesError(response)
  }

  const chat = messagesToChat(body)
  const thinking = requestedEffort(body, model.thinkingLevels)
  const translated = model.translator.toUpstream({
    body: chat,
    model: alias,
    upstreamModel: providerModel.model_id,
    thinkingLevel: thinking,
    thinkingLevels: model.thinkingLevels,
    maxOutputTokens: maxOutputTokens(model.row),
    reasoning: await dependencies.reasoningStore.recall(identity.organizationId, chatToolCallIds(chat)),
  })
  const response = await dependencies.forward({
    inferenceProviderId: model.row.provider.id,
    request: new Request(request.url, {
      method: "POST",
      headers: forwardedHeaders(request, translated.headers),
      body: JSON.stringify(translated.body),
      signal: request.signal,
    }),
    model: alias,
    rest: translated.rest,
    search: translated.search,
    protocol: translated.protocol,
  })
  const answer = await translateResponse(response, model.translator, {
    route: { provider: model.row.provider.provider_id, model: providerModel.model_id, thinking, reason: "claude-code", name: model.name },
    stream: chat.stream === true,
    remember: (toolCallIds, payload) => { void dependencies.reasoningStore.remember(identity.organizationId, toolCallIds, payload) },
  }, { smart: false })
  return asMessages(answer, requestedName)
}

export function claudeCodeCountTokens(body: JsonObject) {
  return { input_tokens: estimateMessagesTokens(body) }
}
