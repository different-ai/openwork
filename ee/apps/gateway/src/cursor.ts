// Cursor through the AI Gateway (feature `gatewayMemberApiKeys`). Cursor's only way to another
// provider is its OpenAI key and base URL override, so every model, whatever its provider speaks,
// has to answer as OpenAI Chat Completions under one base URL, by a name a person can type.
//
// GET  /api/v1/cursor/models            the member's models under their Cursor names
// POST /api/v1/cursor/chat/completions  Chat Completions in and out
// POST /api/v1/cursor/responses         Responses in and out (read as a chat request, answered as
//                                       a Responses object or event stream)
// Both resolve the name, rewrite the request for the model's own protocol under the member's
// Gateway alias, and hand it to the normal Gateway pipeline, which authorizes, meters and forwards
// it, so any model works through either API whatever its provider speaks.
import { createGatewayModelAlias } from "@openwork-ee/utils/gateway-routing"
import { AUTO_ROUTER_THINKING_LEVELS, autoRouterThinkingLevels, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import { cursorModelName, matchCursorModel, parseCursorModelName } from "@openwork/types/den/gateway-cursor"
import {
  accessPriority, forwardedHeaders, maxOutputTokens, translateResponse, translatorFor, type AutoTarget,
} from "./auto-router/handler.js"
import { isJsonObject, type JsonObject } from "./auto-router/chat.js"
import { chatToolCallIds, type AutoTranslator } from "./auto-router/protocol.js"
import type { ReasoningStore } from "./auto-router/reasoning-store.js"
import type { GatewayContext } from "./middleware/gateway-auth.js"
import { classifyProtocolFamily } from "./protocols.js"
import type { GatewayMemberAccessRow } from "./provider-access.js"
import type { ProviderCatalog } from "./provider-catalog.js"
import { isEventStreamContentType, isJsonContentType } from "./relay.js"
import { chatStreamToResponses, chatToResponses, responsesReasoningEffort, responsesToChat } from "./cursor-responses.js"

export const cursorPathPrefix = "/api/v1/cursor"
export const cursorModelsPath = `${cursorPathPrefix}/models`
/** Cursor's OpenAI override sends a model through Chat Completions or the Responses API. */
export const cursorApiPaths = {
  [`${cursorPathPrefix}/chat/completions`]: "chat",
  [`${cursorPathPrefix}/responses`]: "responses",
} as const satisfies Record<string, CursorApi>
export type CursorApi = "chat" | "responses"

export type CursorDependencies = {
  loadMemberGatewayAccess: (identity: GatewayContext) => Promise<GatewayMemberAccessRow[]>
  catalog: ProviderCatalog
  reasoningStore: ReasoningStore
  /** The normal Gateway pipeline for a rewritten request. */
  forward: (target: AutoTarget) => Promise<Response>
}

type CursorModel = {
  /** The model's `ipm_…` id: what a Cursor name's ending is matched against. */
  modelId: string
  name: string
  row: GatewayMemberAccessRow
  translator: AutoTranslator
  thinkingLevels: AutoRouterThinkingLevel[]
}

/**
 * The member's models Cursor can call: one per model, however many groups and credential sets
 * grant it, through the most specific grant (member, then team, then organization). Models whose
 * provider has no Chat Completions translation are left out.
 */
export function cursorModels(rows: GatewayMemberAccessRow[], catalog: ProviderCatalog): CursorModel[] {
  const best = new Map<string, GatewayMemberAccessRow>()
  for (const row of rows) {
    if (!row.model || row.model.gateway_provider_id !== row.provider.id) continue
    const current = best.get(row.model.id)
    if (!current || accessPriority(row) > accessPriority(current)
      || (accessPriority(row) === accessPriority(current) && row.grant.id.localeCompare(current.grant.id) < 0)) best.set(row.model.id, row)
  }
  const models: CursorModel[] = []
  for (const row of best.values()) {
    if (!row.model) continue
    const catalogProvider = catalog.getCatalogProvider(row.provider.provider_id)
    const family = classifyProtocolFamily(catalogProvider)
    const translator = family ? translatorFor(family, catalogProvider?.npm ?? null) : null
    if (!translator) continue
    models.push({
      modelId: row.model.id,
      name: row.model.name || row.model.model_id,
      row,
      translator,
      thinkingLevels: autoRouterThinkingLevels(row.model.model_id, row.model.model_config),
    })
  }
  return models.sort((a, b) => a.name.localeCompare(b.name) || a.modelId.localeCompare(b.modelId))
}

/** The OpenAI List Models shape, with each model's Cursor name as its id. */
export function listCursorModels(models: CursorModel[]) {
  return {
    object: "list" as const,
    data: models.map((model) => ({
      id: cursorModelName(model),
      object: "model" as const,
      created: model.row.model ? Math.floor(model.row.model.created_at.getTime() / 1000) : 0,
      owned_by: model.row.provider.provider_id,
      name: model.name,
      openwork: {
        provider_name: model.row.provider.name,
        /** Append `:<level>` to the id to ask for one; `default` is the id alone. */
        thinking_levels: model.thinkingLevels,
      },
    })),
  }
}

function cursorError(status: number, code: string, message: string) {
  return Response.json({ error: { message, type: status >= 500 ? "api_error" : "invalid_request_error", code } }, { status })
}

/**
 * Cursor sends tools in the Responses API's flat shape (`{ type, name, parameters }`) to
 * /chat/completions; Chat Completions and every translator expect them under `function`.
 */
export function normalizeCursorChatBody(body: JsonObject): JsonObject {
  const next: JsonObject = { ...body }
  if (Array.isArray(body.tools)) {
    next.tools = body.tools.map((tool) => {
      if (!isJsonObject(tool) || tool.type !== "function" || isJsonObject(tool.function) || typeof tool.name !== "string") return tool
      const { type, name, description, parameters, strict, ...rest } = tool
      return { ...rest, type, function: {
        name,
        ...(description === undefined ? {} : { description }),
        ...(parameters === undefined ? {} : { parameters }),
        ...(strict === undefined ? {} : { strict }),
      } }
    })
  }
  const choice = body.tool_choice
  if (isJsonObject(choice) && choice.type === "function" && !isJsonObject(choice.function) && typeof choice.name === "string") {
    next.tool_choice = { type: "function", function: { name: choice.name } }
  }
  return next
}

/** The level a Responses request's `reasoning.effort` names, when the model has it. */
function requestedEffort(body: JsonObject, levels: readonly AutoRouterThinkingLevel[]): AutoRouterThinkingLevel | null {
  const effort = responsesReasoningEffort(body)
  return AUTO_ROUTER_THINKING_LEVELS.find((level) => level === effort && levels.includes(level)) ?? null
}

/** A Chat Completions answer as the Responses API's. Errors already share the `{error}` shape. */
async function asResponses(response: Response, model: string): Promise<Response> {
  if (!response.ok) return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const contentType = response.headers.get("content-type")
  if (response.body && isEventStreamContentType(contentType)) {
    headers.set("content-type", "text/event-stream; charset=utf-8")
    return new Response(chatStreamToResponses(response.body, model), { status: response.status, headers })
  }
  if (isJsonContentType(contentType)) {
    const body: unknown = await response.json().catch(() => null)
    headers.set("content-type", "application/json")
    return new Response(JSON.stringify(chatToResponses(body, model)), { status: response.status, headers })
  }
  return response
}

export async function handleCursorChat(input: {
  request: Request
  body: JsonObject
  api: CursorApi
  identity: GatewayContext
  dependencies: CursorDependencies
}): Promise<Response> {
  const { request, identity, dependencies, api } = input
  const requested = input.body.model
  const parsed = parseCursorModelName(requested)
  if (!parsed) {
    return cursorError(400, "invalid_cursor_model", "model must be an OpenWork model name for Cursor, such as openwork/claude-opus-5.5-k3f9. Copy it from Set up Cursor in your OpenWork Library.")
  }
  const models = cursorModels(await dependencies.loadMemberGatewayAccess(identity), dependencies.catalog)
  const match = matchCursorModel(parsed, models)
  if (match.kind === "ambiguous") {
    return cursorError(400, "ambiguous_cursor_model", `More than one of your models matches ${String(requested)}. Copy the name again from Set up Cursor in your OpenWork Library.`)
  }
  // Same answer for a model that does not exist and one this member cannot use.
  if (match.kind === "none" || !match.model.row.model) {
    return cursorError(404, "model_not_found", `${String(requested)} is not one of your OpenWork models. Copy the name from Set up Cursor in your OpenWork Library.`)
  }
  const { model } = match
  const row = model.row
  const providerModel = match.model.row.model
  // A level in the name wins; otherwise a Responses request may carry one.
  const thinking = parsed.thinking === "default" && api === "responses" ? requestedEffort(input.body, model.thinkingLevels) ?? "default" : parsed.thinking
  if (!model.thinkingLevels.includes(thinking)) {
    const levels = model.thinkingLevels.filter((level) => level !== "default")
    return cursorError(400, "unsupported_thinking_level", levels.length
      ? `${model.name} doesn't have a ${parsed.thinking} thinking level. Use one of: ${levels.join(", ")}, or leave the level off.`
      : `${model.name} doesn't take a thinking level. Remove :${parsed.thinking} from the model name.`)
  }

  const body = normalizeCursorChatBody(api === "responses" ? responsesToChat(input.body) : input.body)
  const alias = createGatewayModelAlias({ modelGroupId: row.group.id, credentialSetId: row.credentialSet.id, gatewayProviderModelId: providerModel.id })
  const translated = model.translator.toUpstream({
    body,
    model: alias,
    upstreamModel: providerModel.model_id,
    thinkingLevel: thinking,
    thinkingLevels: model.thinkingLevels,
    maxOutputTokens: maxOutputTokens(row),
    reasoning: await dependencies.reasoningStore.recall(identity.organizationId, chatToolCallIds(body)),
  })
  const response = await dependencies.forward({
    inferenceProviderId: row.provider.id,
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
  const chat = await translateResponse(response, model.translator, {
    route: { provider: row.provider.provider_id, model: providerModel.model_id, thinking, reason: "cursor", name: model.name },
    stream: body.stream === true,
    remember: (toolCallIds, payload) => { void dependencies.reasoningStore.remember(identity.organizationId, toolCallIds, payload) },
  }, { smart: false })
  return api === "responses" ? asResponses(chat, typeof requested === "string" ? requested : model.name) : chat
}
