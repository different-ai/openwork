import type { DynamicToolUIPart, ToolUIPart } from "ai"
import { credentialPromptSchema, type CredentialPrompt } from "@openwork/types/den/credential-prompt"
import { isOpenworkCloudCapabilityTool } from "@/components/tools/error-attribution"
import { codeModeToolCalls } from "@/lib/code-mode-tools"

const MAX_PARSED_RESULT_LENGTH = 256 * 1_024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function records(value: unknown): Record<string, unknown>[] {
  if (isRecord(value)) {
    const nested = Array.isArray(value.content)
      ? value.content.filter(isRecord).flatMap(item => item.type === "text" ? records(item.text) : [])
      : []
    return [value, ...(isRecord(value.structuredContent) ? [value.structuredContent] : []), ...nested]
  }
  if (typeof value !== "string" || value.length > MAX_PARSED_RESULT_LENGTH) return []
  const start = value.indexOf("{")
  const end = value.lastIndexOf("}")
  if (start < 0 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(value.slice(start, end + 1))
    return isRecord(parsed) ? records(parsed) : []
  } catch {
    return []
  }
}

/**
 * Den's own operations that answer with a credential prompt. Results of an
 * organization's MCP servers, plugins or Workflows also pass through
 * execute_capability, but under prefixed names (mcp:..., plugin:...), so they
 * can never match and cannot forge a key field.
 */
const DEN_PROMPT_OPERATIONS = new Set(["postMcpConnections", "postInferenceProviders", "postPluginsMcpConnections"])

function isDenPromptCall(part: DynamicToolUIPart): boolean {
  if (!isOpenworkCloudCapabilityTool(part.toolName) || !/(?:^|_)execute_capability$/.test(part.toolName)) return false
  const name = isRecord(part.input) ? part.input.name : undefined
  return typeof name === "string" && DEN_PROMPT_OPERATIONS.has(name)
}

/**
 * The one credential prompt an OpenWork Cloud tool result carries, if any.
 * Only Den's own prompt-creating operations are read, and only the exact
 * schema is accepted, so another MCP server or a model cannot draw a key field.
 */
export function credentialPromptsFromToolPart(part: DynamicToolUIPart): CredentialPrompt[] {
  if (part.state !== "output-available" || !isDenPromptCall(part)) return []
  const metadata = isRecord(part.callProviderMetadata) && isRecord(part.callProviderMetadata.openwork)
    ? part.callProviderMetadata.openwork.mcpResult
    : undefined
  const found = new Map<string, CredentialPrompt>()
  for (const record of [...records(part.output), ...records(metadata)]) {
    for (const candidate of [record.credentialPrompt, record.kind === "credential_prompt" ? record : undefined]) {
      if (candidate === undefined) continue
      const parsed = credentialPromptSchema.safeParse(candidate)
      if (parsed.success) found.set(JSON.stringify(parsed.data.target), parsed.data)
    }
  }
  return [...found.values()]
}

/** Compatibility reader for consumers that explicitly require one target. */
export function credentialPromptFromToolPart(part: DynamicToolUIPart): CredentialPrompt | null {
  const prompts = credentialPromptsFromToolPart(part)
  return prompts.length === 1 ? prompts[0] ?? null : null
}

/** Validated Den prompts, deduplicated by target across the script's calls. */
export function credentialPromptCalls(part: ToolUIPart | DynamicToolUIPart): Array<{ part: DynamicToolUIPart; prompt: CredentialPrompt }> {
  if (part.type !== "dynamic-tool") return []
  const found = new Map<string, { part: DynamicToolUIPart; prompt: CredentialPrompt }>()
  for (const call of [part, ...(codeModeToolCalls(part) ?? [])]) {
    for (const prompt of credentialPromptsFromToolPart(call)) found.set(JSON.stringify(prompt.target), { part: call, prompt })
  }
  return [...found.values()]
}

/**
 * The call that carries a credential prompt: the part itself, or (OpenCode v2)
 * one of the OpenWork Cloud calls its Code Mode script made.
 */
export function credentialPromptCall(part: ToolUIPart | DynamicToolUIPart): DynamicToolUIPart | null {
  const calls = credentialPromptCalls(part)
  return calls.length === 1 ? calls[0]?.part ?? null : null
}

export function isCredentialPromptPart(part: ToolUIPart | DynamicToolUIPart): boolean {
  return credentialPromptCalls(part).length > 0
}
