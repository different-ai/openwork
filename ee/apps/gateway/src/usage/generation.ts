import { generationTerminal, mergeGenerationTerminals } from "../generation-outcome.js"
import type { GenerationTerminal } from "../generation-outcome.js"
import { isRecord } from "./shared.js"

export const maxGenerationChoices = 128

export function createChatGenerationObserver(expectedChoices?: number) {
  const choices = new Map<number, GenerationTerminal | null>()
  let invalid = expectedChoices !== undefined && (!Number.isSafeInteger(expectedChoices) || expectedChoices < 1 || expectedChoices > maxGenerationChoices)
  return (event: unknown): GenerationTerminal => {
    if (isRecord(event) && Array.isArray(event.choices)) {
      if (event.choices.length > maxGenerationChoices) invalid = true
      if (!invalid) {
        const indices = new Set<number>()
        for (const choice of event.choices) {
          if (!isRecord(choice) || typeof choice.index !== "number" || !Number.isSafeInteger(choice.index) || choice.index < 0 || choice.index >= (expectedChoices ?? maxGenerationChoices) || indices.has(choice.index)) { invalid = true; break }
          indices.add(choice.index)
          if (!choices.has(choice.index)) choices.set(choice.index, null)
          if (choice.finish_reason == null) continue
          const reason = typeof choice.finish_reason === "string" && ["stop", "length", "tool_calls", "content_filter"].includes(choice.finish_reason) ? choice.finish_reason : "unknown"
          const next = generationTerminal(reason)
          const previous = choices.get(choice.index)
          choices.set(choice.index, previous && previous.providerTerminalReason !== next.providerTerminalReason ? generationTerminal("unknown") : next)
        }
      }
    }
    if (invalid) { choices.clear(); return generationTerminal("unknown") }
    let result: GenerationTerminal | null = expectedChoices !== undefined && choices.size !== expectedChoices ? generationTerminal("unknown") : null
    for (const terminal of choices.values()) result = result ? mergeGenerationTerminals(result, terminal ?? generationTerminal("unknown")) : terminal ?? generationTerminal("unknown")
    return result ?? generationTerminal("unknown")
  }
}

export function anthropicGeneration(reason: unknown): GenerationTerminal {
  return generationTerminal(typeof reason === "string" && ["refusal", "max_tokens", "end_turn", "tool_use", "stop_sequence"].includes(reason) ? reason : "unknown")
}

export function responsesGeneration(response: unknown): GenerationTerminal {
  if (!isRecord(response) || (response.status !== "completed" && response.status !== "incomplete")) return generationTerminal("unknown")
  if (response.status === "incomplete") {
    const reason = isRecord(response.incomplete_details) ? response.incomplete_details.reason : null
    return generationTerminal(reason === "content_filter" || reason === "max_output_tokens" ? reason : "unknown")
  }
  if (!Array.isArray(response.output) || response.output.length > maxGenerationChoices) return generationTerminal("unknown")
  let result = generationTerminal("completed")
  for (const item of response.output) {
    if (!isRecord(item)) return generationTerminal("unknown")
    if (item.type === "function_call") result = mergeGenerationTerminals(result, generationTerminal("tool_calls"))
    else if (item.type === "message") {
      if (!Array.isArray(item.content) || item.content.length > maxGenerationChoices) return generationTerminal("unknown")
      for (const part of item.content) {
        if (!isRecord(part)) return generationTerminal("unknown")
        if (part.type === "refusal") result = mergeGenerationTerminals(result, generationTerminal("refusal"))
        else if (part.type !== "output_text") result = mergeGenerationTerminals(result, generationTerminal("unknown"))
      }
    } else if (item.type !== "reasoning") result = mergeGenerationTerminals(result, generationTerminal("unknown"))
  }
  return result
}
