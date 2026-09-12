export function validatedUpstreamId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null
}

export function terminalErrorCode(value: unknown) {
  switch (value) {
    case null: case undefined: return null
    case "upstream_malformed_stream": case "upstream_malformed_response": case "upstream_incomplete":
    case "upstream_interrupted": case "upstream_timeout": case "request_cancelled":
    case "upstream_stream_error": case "upstream_error": case "upstream_unreachable":
    case "upstream_unavailable": case "upstream_access_denied": case "upstream_quota_exhausted":
    case "upstream_rate_limited": case "context_length_exceeded": case "upstream_request_rejected":
    case "upstream_model_unavailable": return value
    default: return "unknown"
  }
}

export type GenerationOutcome = "completed" | "content_filtered" | "refused" | "length_limited" | "tool_calls" | "unknown"
export type ProviderTerminalReason = "stop" | "length" | "tool_calls" | "content_filter" | "end_turn" | "stop_sequence" | "max_tokens" | "tool_use" | "refusal" | "completed" | "incomplete" | "max_output_tokens" | "unknown"

export type GenerationTerminal = {
  generationOutcome: GenerationOutcome
  providerTerminalReason: ProviderTerminalReason
}

export function providerTerminalReason(value: unknown): ProviderTerminalReason {
  switch (value) {
    case "stop": case "length": case "tool_calls": case "content_filter":
    case "end_turn": case "stop_sequence": case "max_tokens": case "tool_use":
    case "refusal": case "completed": case "incomplete": case "max_output_tokens":
      return value
    default: return "unknown"
  }
}

const priority: Record<GenerationOutcome, number> = { completed: 0, tool_calls: 1, length_limited: 2, unknown: 3, refused: 4, content_filtered: 5 }

export function mergeGenerationTerminals(left: GenerationTerminal, right: GenerationTerminal): GenerationTerminal {
  if (priority[left.generationOutcome] !== priority[right.generationOutcome]) return priority[left.generationOutcome] > priority[right.generationOutcome] ? left : right
  return { generationOutcome: left.generationOutcome, providerTerminalReason: left.providerTerminalReason === right.providerTerminalReason ? left.providerTerminalReason : "unknown" }
}

export function generationTerminal(value: unknown): GenerationTerminal {
  const reason = providerTerminalReason(value)
  let generationOutcome: GenerationOutcome
  switch (reason) {
    case "stop": case "end_turn": case "stop_sequence": case "completed": generationOutcome = "completed"; break
    case "content_filter": generationOutcome = "content_filtered"; break
    case "refusal": generationOutcome = "refused"; break
    case "length": case "max_tokens": case "max_output_tokens": generationOutcome = "length_limited"; break
    case "tool_calls": case "tool_use": generationOutcome = "tool_calls"; break
    default: generationOutcome = "unknown"
  }
  return { generationOutcome, providerTerminalReason: reason }
}
