import type { ModelCatalogEntry } from "./model-catalog.js"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validate the managed Chat Completions contract without rewriting conversation content. */
export function validateChatRequest(body: Record<string, unknown>, model: ModelCatalogEntry): string | null {
  const capabilities = model.capabilities
  if (!Array.isArray(body.messages) || body.messages.length === 0) return "Include at least one message."
  if (body.stream !== undefined && typeof body.stream !== "boolean") return "stream must be a boolean."
  if (body.n !== undefined && body.n !== 1) return "OpenWork supports one completion per request; set n to 1."
  if (body.transforms !== undefined || body.plugins !== undefined) return "Message transforms and server plugins are not supported by OpenWork Models."
  if (body.provider !== undefined && !record(body.provider)) return "provider must be an object."
  if (record(body.provider)) {
    if (body.provider.allow_fallbacks === true) return "Provider fallback is disabled for OpenWork Models. Retry the selected model explicitly."
    if (body.provider.require_parameters === false) return "OpenWork requires providers to honor the requested capabilities."
  }
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) return "Use only one of max_tokens and max_completion_tokens."
  const outputLimit = body.max_tokens ?? body.max_completion_tokens
  if (outputLimit !== undefined && (typeof outputLimit !== "number" || !Number.isInteger(outputLimit) || outputLimit <= 0 || outputLimit > capabilities.outputTokens)) {
    return `The output limit must be an integer between 1 and ${capabilities.outputTokens} tokens for this model.`
  }
  if (body.reasoning !== undefined && !record(body.reasoning)) return "reasoning must be an object."
  const reasoning = record(body.reasoning) ? body.reasoning : {}
  if (body.reasoning_effort !== undefined && Object.keys(reasoning).length) return "Use reasoning or reasoning_effort, not both."
  if (reasoning.effort !== undefined && reasoning.max_tokens !== undefined) return "Choose a reasoning effort or a reasoning token budget, not both."
  const effort = body.reasoning_effort ?? reasoning.effort
  if (reasoning.enabled === false && (reasoning.max_tokens !== undefined || (effort !== undefined && effort !== "none"))) return "Do not combine disabled reasoning with a reasoning effort or token budget."
  if (effort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(effort))) return "Unsupported reasoning effort. Use the model default or a supported effort."
  if (capabilities.reasoning.mandatory && (effort === "none" || reasoning.enabled === false)) return "This model requires reasoning. Use its default reasoning settings or choose another model."
  if (effort !== undefined && capabilities.reasoning.supportedEfforts !== null && !capabilities.reasoning.supportedEfforts.includes(String(effort))) return "This model does not accept that reasoning effort. Use its default or one of the efforts in the model catalog."
  if (reasoning.max_tokens !== undefined && !capabilities.reasoning.supportsTokenBudget) return "This model does not expose a reasoning token budget. Use its default or a supported reasoning effort."
  if (reasoning.max_tokens !== undefined && (typeof reasoning.max_tokens !== "number" || !Number.isInteger(reasoning.max_tokens) || reasoning.max_tokens <= 0 || reasoning.max_tokens >= Number(outputLimit ?? capabilities.outputTokens))) {
    return "The reasoning token budget must be positive and smaller than the total output limit."
  }
  for (const field of ["enabled", "exclude"]) {
    if (reasoning[field] !== undefined && typeof reasoning[field] !== "boolean") return `reasoning.${field} must be a boolean.`
  }
  if ((body.reasoning !== undefined || body.reasoning_effort !== undefined) && !capabilities.supportedParameters.includes("reasoning")) return "This model does not support reasoning controls. Choose the model default."
  if (body.tools !== undefined && !Array.isArray(body.tools)) return "tools must be an array of function definitions."
  const tools = Array.isArray(body.tools) ? body.tools : []
  if (tools.length && !capabilities.supportedParameters.includes("tools")) return "This model cannot call tools. Choose a model with tool support."
  const names = new Set<string>()
  for (const tool of tools) {
    if (!record(tool) || tool.type !== "function" || !record(tool.function) || typeof tool.function.name !== "string" || !tool.function.name.trim() || (tool.function.parameters !== undefined && !record(tool.function.parameters))) return "Each tool needs a function name and, when provided, a JSON Schema parameters object."
    if (names.has(tool.function.name)) return "Tool function names must be unique."
    names.add(tool.function.name)
  }
  if (record(body.tool_choice) && (body.tool_choice.type !== "function" || !record(body.tool_choice.function) || !names.has(String(body.tool_choice.function.name)))) return "tool_choice must name a function included in tools."
  if (body.tool_choice !== undefined && !record(body.tool_choice) && !["auto", "none", "required"].includes(String(body.tool_choice))) return "tool_choice must be auto, none, required, or a function included in tools."
  if (body.tool_choice === "required" && !tools.length) return "Include tools before requiring a tool call."
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") return "parallel_tool_calls must be a boolean."
  const pendingTools = new Set<string>()
  for (const message of body.messages) {
    if (!record(message) || !["system", "developer", "user", "assistant", "tool"].includes(String(message.role))) return "Each message needs a supported role."
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string" || !pendingTools.delete(message.tool_call_id)) return "A tool result must match an outstanding assistant tool call."
    } else if (pendingTools.size) return "Include the result of every assistant tool call before the next message."
    if (message.tool_calls != null && !Array.isArray(message.tool_calls)) return "Assistant tool_calls must be an array."
    if (Array.isArray(message.tool_calls)) {
      if (message.role !== "assistant") return "Only assistant messages can contain tool calls."
      for (const call of message.tool_calls) {
        if (!record(call) || typeof call.id !== "string" || !call.id || pendingTools.has(call.id) || call.type !== "function" || !record(call.function) || typeof call.function.name !== "string" || typeof call.function.arguments !== "string") return "Assistant tool calls need unique IDs, function names, and JSON argument strings."
        try { JSON.parse(call.function.arguments) } catch { return "Assistant tool-call arguments must contain complete JSON before sending a tool result." }
        pendingTools.add(call.id)
      }
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!record(part)) return "Message content parts must be objects."
        if (part.type === "text" && typeof part.text === "string") continue
        if (part.type === "image_url") {
          if (!capabilities.inputModalities.includes("image")) return "This model accepts text only. Choose an image-capable model or remove the image."
          if (!record(part.image_url) || typeof part.image_url.url !== "string") return "An image needs an image_url object with a URL."
          continue
        }
        return "OpenWork Models accepts text and supported images. Audio, video, and raw files require another input path."
      }
    } else if (message.content !== null && message.content !== undefined && typeof message.content !== "string") return "Message content must be text or supported content parts."
  }
  if (pendingTools.size) return "Include the result of every outstanding tool call before requesting another completion."
  return null
}

export function prepareChatParameters(body: Record<string, unknown>) {
  if (body.max_completion_tokens !== undefined) {
    body.max_tokens = body.max_completion_tokens
    delete body.max_completion_tokens
  }
  if (body.reasoning_effort !== undefined) {
    body.reasoning = { effort: body.reasoning_effort }
    delete body.reasoning_effort
  }
  body.provider = { ...(record(body.provider) ? body.provider : {}), require_parameters: true, allow_fallbacks: false }
  // Never implicitly trim the conversation to make an oversized request fit.
  body.transforms = []
}
