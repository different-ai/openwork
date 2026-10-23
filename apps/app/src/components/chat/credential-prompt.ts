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

type PromptTargetType = CredentialPrompt["target"]["type"]

/**
 * Den's own operations that answer with a credential prompt, and the kinds of
 * key each may ask for. Results of an organization's MCP servers, plugins or
 * Workflows also pass through execute_capability, but under prefixed names
 * (mcp:..., plugin:...), so they can never match and cannot forge a key field.
 */
const DEN_PROMPT_OPERATIONS = new Map<string, ReadonlySet<PromptTargetType>>([
  ["postMcpConnections", new Set(["mcp_connection_key"])],
  ["putMcpConnectionsByKeyByExternalKey", new Set(["mcp_connection_key"])],
  ["postMcpConnectionsCredentialPrompt", new Set(["mcp_connection_key", "mcp_connection_member_key", "mcp_connection_shared_switch"])],
  ["postPluginsMcpConnections", new Set(["plugin_connection_key"])],
  ["postInferenceProviders", new Set(["gateway_provider_key", "gateway_provider_credential"])],
  ["postEnvironmentVariablesValuePrompt", new Set(["environment_variable_member_value"])],
])

function denPromptTargets(part: DynamicToolUIPart): ReadonlySet<PromptTargetType> | null {
  if (!isOpenworkCloudCapabilityTool(part.toolName) || !/(?:^|_)execute_capability$/.test(part.toolName)) return null
  const name = isRecord(part.input) ? part.input.name : undefined
  return typeof name === "string" ? DEN_PROMPT_OPERATIONS.get(name) ?? null : null
}

/**
 * The one credential prompt an OpenWork Cloud tool result carries, if any.
 * Only Den's own prompt-creating operations are read, and only the exact
 * schema is accepted, so another MCP server or a model cannot draw a key field.
 */
export function credentialPromptFromToolPart(part: DynamicToolUIPart): CredentialPrompt | null {
  const targets = part.state === "output-available" ? denPromptTargets(part) : null
  if (!targets) return null
  const metadata = isRecord(part.callProviderMetadata) && isRecord(part.callProviderMetadata.openwork)
    ? part.callProviderMetadata.openwork.mcpResult
    : undefined
  const found = new Map<string, CredentialPrompt>()
  for (const record of [...records(part.output), ...records(metadata)]) {
    for (const candidate of [record.credentialPrompt, record.kind === "credential_prompt" ? record : undefined]) {
      if (candidate === undefined) continue
      const parsed = credentialPromptSchema.safeParse(candidate)
      if (parsed.success && targets.has(parsed.data.target.type)) found.set(JSON.stringify(parsed.data.target), parsed.data)
    }
  }
  return found.size === 1 ? found.values().next().value ?? null : null
}

/**
 * The call that carries a credential prompt: the part itself, or (OpenCode v2)
 * one of the OpenWork Cloud calls its Code Mode script made.
 */
export function credentialPromptCall(part: ToolUIPart | DynamicToolUIPart): DynamicToolUIPart | null {
  if (part.type !== "dynamic-tool") return null
  if (credentialPromptFromToolPart(part)) return part
  const inner = (codeModeToolCalls(part) ?? []).filter(call => credentialPromptFromToolPart(call) !== null)
  return inner.length === 1 ? inner[0] ?? null : null
}

export function isCredentialPromptPart(part: ToolUIPart | DynamicToolUIPart): boolean {
  return credentialPromptCall(part) !== null
}
