// The Codex CLI through the AI Gateway. Codex reaches another
// provider through a `[model_providers.<id>]` block in ~/.codex/config.toml with
// `wire_api = "responses"`, and speaks only the OpenAI Responses API, so every model has to answer
// as Responses, by a name a person can set as `model`.
//
// GET  /api/v1/codex/models     the member's models in Codex's own catalog shape
//                               (`{ models: [ModelInfo] }`), which Codex fetches with
//                               `?client_version=` when the provider authenticates by command
// POST /api/v1/codex/responses  resolves the name. A model whose provider speaks Responses (OpenAI,
//                               Azure OpenAI) gets the request as it is (encrypted reasoning,
//                               custom and hosted tools intact); any other is translated through
//                               Chat Completions and back. Both run the normal Gateway pipeline
//                               under the member's own alias.
import { createGatewayModelAlias } from "@openwork-ee/utils/gateway-routing"
import type { AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import { cursorModelName, matchCursorModel, parseCursorModelName } from "@openwork/types/den/gateway-cursor"
import { forwardedHeaders } from "./auto-router/handler.js"
import { isJsonObject, type JsonObject } from "./auto-router/chat.js"
import { CODEX_BASE_INSTRUCTIONS } from "./codex-instructions.js"
import { asResponses, cursorError, cursorModels, requestedEffort, sendTranslatedChat, type CursorDependencies, type CursorModel } from "./cursor.js"
import { responsesToChat, responsesToolNames } from "./cursor-responses.js"
import type { GatewayContext } from "./middleware/gateway-auth.js"
import type { ProtocolFamily } from "./protocols.js"
import { resolveSmartRouter, smartAcceptsImages, smartContextWindow, type SmartToolRouter } from "./smart-tools.js"

export const codexPathPrefix = "/api/v1/codex"
export const codexModelsPath = `${codexPathPrefix}/models`
export const codexResponsesPath = `${codexPathPrefix}/responses`

export type CodexDependencies = CursorDependencies

/** Providers that take a Responses request as it is, and the path they take it on. */
const RESPONSES_FAMILIES: ReadonlyMap<ProtocolFamily, string> = new Map([["openai", "responses"], ["azure", "v1/responses"]])

/** The fewest output tokens OpenAI accepts. */
const MIN_OUTPUT_TOKENS = 16

const EFFORT_DESCRIPTIONS: Record<Exclude<AutoRouterThinkingLevel, "default">, string> = {
  none: "No reasoning",
  minimal: "Fastest, least reasoning",
  low: "Fast, light reasoning",
  medium: "Balanced speed and reasoning",
  high: "Deeper reasoning for harder tasks",
  xhigh: "Extra deep reasoning",
  max: "The most reasoning the model allows",
}

export function codexModelName(model: CursorModel) {
  return cursorModelName({ name: model.name, modelId: model.modelId })
}

function modelLimit(model: CursorModel, key: "context" | "output"): number | null {
  const limit = model.row.model?.model_config.limit
  const value = isJsonObject(limit) ? limit[key] : null
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

function acceptsImages(model: CursorModel): boolean {
  const modalities = model.row.model?.model_config.modalities
  const input = isJsonObject(modalities) ? modalities.input : null
  return Array.isArray(input) ? input.includes("image") : true
}

/**
 * Whether Codex should offer its `apply_patch` tool as a custom (freeform) tool. OpenAI takes custom
 * tools from GPT-5 on and refuses them before. Translated models could take it as a function with the
 * patch text, but in the live check Claude Haiku wrote patches with lost indentation that way; with
 * no tool they edit through Codex's shell tool, which they did correctly.
 */
function freeformPatch(model: CursorModel): boolean {
  return RESPONSES_FAMILIES.has(model.family) && /^gpt-([5-9]|\d{2,})/.test(model.row.model?.model_id ?? "")
}

function effortLevels(model: CursorModel) {
  return model.thinkingLevels.flatMap((level) => level === "default" ? [] : [level])
}

/**
 * Codex's catalog shape (codex-rs `ModelsResponse`): every field Codex requires, the rest left to
 * its defaults. Each model gets Codex's own base instructions, so it behaves as it would on Codex's
 * fallback, plus its real context window, reasoning levels and name for the /model picker.
 */
export function listCodexModels(models: CursorModel[], routers: SmartToolRouter[] = []) {
  return {
    models: [...models.map((model, index) => {
      const levels = effortLevels(model)
      const context = modelLimit(model, "context")
      return {
        slug: codexModelName(model),
        display_name: model.name,
        description: `${model.row.provider.name} through OpenWork`,
        default_reasoning_level: levels.includes("medium") ? "medium" : levels[0] ?? null,
        supported_reasoning_levels: levels.map((effort) => ({ effort, description: EFFORT_DESCRIPTIONS[effort] })),
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        // Codex lists its own OpenAI models in /model too (they only work when the member has one
        // by that id); a lower priority puts the member's models first.
        priority: index - 10_000,
        availability_nux: null,
        upgrade: null,
        base_instructions: CODEX_BASE_INSTRUCTIONS,
        model_messages: { instructions_template: CODEX_BASE_INSTRUCTIONS },
        supports_reasoning_summary_parameter: RESPONSES_FAMILIES.has(model.family) && levels.length > 0,
        default_reasoning_summary: "auto",
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: freeformPatch(model) ? "freeform" : null,
        truncation_policy: { mode: "bytes", limit: 10_000 },
        ...(context ? { context_window: context, max_context_window: context } : {}),
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: acceptsImages(model) ? ["text", "image"] : ["text"],
      }
    }), ...routers.map((router, index) => smartCatalogEntry(router, models.length + index))],
  }
}

/**
 * A Smart Router in Codex's catalog: like a translated model, with no reasoning levels (Smart picks
 * the model and its level per prompt, so Codex's effort is ignored), the smallest context window of
 * its models, and images only when every one of them reads them.
 */
function smartCatalogEntry(router: SmartToolRouter, index: number) {
  const context = smartContextWindow(router)
  return {
    slug: router.toolName,
    display_name: router.name,
    description: "Smart Model Router through OpenWork: picks one of your models for each prompt",
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: index - 10_000,
    availability_nux: null,
    upgrade: null,
    base_instructions: CODEX_BASE_INSTRUCTIONS,
    model_messages: { instructions_template: CODEX_BASE_INSTRUCTIONS },
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: "bytes", limit: 10_000 },
    ...(context ? { context_window: context, max_context_window: context } : {}),
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: smartAcceptsImages(router) ? ["text", "image"] : ["text"],
  }
}

/**
 * The model a request names. Codex may also send a model id of its own (a background task on a
 * model it prefers, for example): that resolves when one of the member's models has that catalog id.
 */
function resolveModel(requested: unknown, models: CursorModel[], smartError?: () => Response): { model: CursorModel; thinking: AutoRouterThinkingLevel } | { error: Response } {
  const parsed = parseCursorModelName(requested)
  if (parsed) {
    const match = matchCursorModel(parsed, models)
    if (match.kind === "found") return { model: match.model, thinking: parsed.thinking }
    if (match.kind === "ambiguous") return { error: cursorError(400, "ambiguous_model", `More than one of your models matches ${String(requested)}. Copy the config again from Set up Codex in your OpenWork Library.`) }
  }
  const raw = typeof requested === "string" ? requested.trim().toLowerCase() : ""
  const byCatalogId = raw ? models.filter((model) => model.row.model?.model_id.toLowerCase() === raw) : []
  if (byCatalogId.length === 1 && byCatalogId[0]) return { model: byCatalogId[0], thinking: "default" }
  if (smartError) return { error: smartError() }
  // Same answer for a model that does not exist and one this member cannot use.
  return { error: cursorError(404, "model_not_found", `${String(requested)} is not one of your OpenWork models. Copy the config from Set up Codex in your OpenWork Library, or pick a model with /model.`) }
}

/** Client-executed tools the Gateway passes to a provider; hosted ones (web search and the like) it doesn't. */
function isClientTool(tool: unknown): boolean {
  if (!isJsonObject(tool)) return false
  if (tool.type === "function" || tool.type === "custom") return true
  return tool.type === "namespace" && Array.isArray(tool.tools) && tool.tools.every((inner) => isJsonObject(inner) && (inner.type === "function" || inner.type === "custom"))
}

/** Calls of hosted tools Codex keeps in its history: their results live with the provider. */
const HOSTED_CALL_ITEMS = new Set(["web_search_call", "image_generation_call", "tool_search_call", "tool_search_output", "file_search_call", "code_interpreter_call", "mcp_call", "computer_call"])

/**
 * Codex's conversation for a provider that speaks Responses. Codex sends the whole conversation
 * (`store: false`), so item ids name nothing stored: they are dropped, except on reasoning items,
 * which carry their encrypted content. Reasoning without it, and hosted tool calls, can't be replayed.
 */
function passThroughInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input
  return input.flatMap((item) => {
    if (!isJsonObject(item)) return [item]
    if (typeof item.type === "string" && HOSTED_CALL_ITEMS.has(item.type)) return []
    if (item.type === "reasoning") return typeof item.encrypted_content === "string" && item.encrypted_content ? [item] : []
    const next: JsonObject = { ...item }
    delete next.id
    return [next]
  })
}

/**
 * The request for a provider that speaks Responses: as Codex sent it, under the member's alias,
 * within what the Gateway forwards (client tools, an inline conversation, no Codex telemetry).
 * A level in the model name sets the effort; a model without reasoning loses the reasoning options
 * Codex always sends (OpenAI refuses them there).
 */
function passThroughBody(body: JsonObject, alias: string, model: CursorModel, thinking: AutoRouterThinkingLevel): JsonObject {
  const next: JsonObject = { ...body, model: alias, input: passThroughInput(body.input) }
  delete next.client_metadata
  if (Array.isArray(body.tools)) next.tools = body.tools.filter(isClientTool)
  if (effortLevels(model).length === 0) {
    delete next.reasoning
    if (Array.isArray(body.include)) next.include = body.include.filter((value) => value !== "reasoning.encrypted_content")
  } else if (thinking !== "default") {
    next.reasoning = { ...(isJsonObject(body.reasoning) ? body.reasoning : {}), effort: thinking }
  }
  if (typeof body.max_output_tokens === "number") next.max_output_tokens = Math.max(MIN_OUTPUT_TOKENS, body.max_output_tokens)
  return next
}

export async function handleCodexResponses(input: {
  request: Request
  body: JsonObject
  identity: GatewayContext
  dependencies: CodexDependencies
}): Promise<Response> {
  const { request, body, identity, dependencies } = input
  const smart = await resolveSmartRouter(body.model, identity, dependencies.smart)
  if (smart.kind === "router" && dependencies.smart) {
    // Like a translated model: no stored responses, Codex's effort ignored (Smart picks the level).
    if (typeof body.previous_response_id === "string" && body.previous_response_id) {
      return cursorError(400, "previous_response_not_supported", "Smart models can't continue a stored response. Send the whole conversation (Codex does unless it is set to store responses).")
    }
    const chat = await dependencies.smart.route({ request, body: responsesToChat(body), routerId: smart.routerId })
    return asResponses(chat, typeof body.model === "string" ? body.model : "smart", responsesToolNames(body))
  }
  const models = cursorModels(await dependencies.loadMemberGatewayAccess(identity), dependencies.catalog)
  const resolved = resolveModel(body.model, models, smart.kind === "unavailable" ? smart.error : undefined)
  if ("error" in resolved) return resolved.error
  const { model } = resolved
  const providerModel = model.row.model
  if (!providerModel) return cursorError(404, "model_not_found", `${String(body.model)} is not one of your OpenWork models.`)
  // A level in the name wins over Codex's model_reasoning_effort.
  const thinking = resolved.thinking !== "default" ? resolved.thinking : requestedEffort(body, model.thinkingLevels) ?? "default"
  if (!model.thinkingLevels.includes(thinking)) {
    const levels = effortLevels(model)
    return cursorError(400, "unsupported_thinking_level", levels.length
      ? `${model.name} doesn't have a ${thinking} thinking level. Use one of: ${levels.join(", ")}.`
      : `${model.name} doesn't take a thinking level. Remove :${thinking} from the model name.`)
  }
  const alias = createGatewayModelAlias({ modelGroupId: model.row.group.id, credentialSetId: model.row.credentialSet.id, gatewayProviderModelId: providerModel.id })

  const rest = RESPONSES_FAMILIES.get(model.family)
  if (rest) {
    return dependencies.forward({
      inferenceProviderId: model.row.provider.id,
      request: new Request(request.url, {
        method: "POST",
        headers: forwardedHeaders(request, {}),
        body: JSON.stringify(passThroughBody(body, alias, model, thinking)),
        signal: request.signal,
      }),
      model: alias,
      rest,
      search: "",
      protocol: "openai_responses",
    })
  }

  // Translated models keep no response state; Codex sends the whole conversation (store: false).
  if (typeof body.previous_response_id === "string" && body.previous_response_id) {
    return cursorError(400, "previous_response_not_supported", `${model.name} can't continue a stored response. Send the whole conversation (Codex does unless it is set to store responses).`)
  }
  const chat = await sendTranslatedChat({ request, body: responsesToChat(body), model, thinking, identity, dependencies, reason: "codex" })
  return asResponses(chat, typeof body.model === "string" ? body.model : codexModelName(model), responsesToolNames(body))
}
