import type { ProtocolFamily } from "@openwork-ee/gateway-upstreams/protocols"
import { bedrockGuardrailIdentifierSchema, bedrockGuardrailVersionSchema } from "@openwork/types/den/inference"

export function hasBedrockGuardrail(settings: Record<string, unknown>): boolean {
  return settings.guardrailIdentifier !== undefined || settings.guardrailVersion !== undefined
}

export function applyBedrockGuardrail(input: {
  enabled: boolean
  settings: Record<string, unknown>
  family: ProtocolFamily
  url: URL
  headers: Headers
  body: string | Uint8Array<ArrayBuffer> | null
}): { body: string | Uint8Array<ArrayBuffer> | null; applied: boolean } | { error: string } {
  if (!input.enabled || !hasBedrockGuardrail(input.settings)) return { body: input.body, applied: false }
  if (input.family !== "bedrock") {
    return { error: "This provider has an organization guardrail, but this endpoint cannot apply it. Ask your administrator to use a Bedrock Runtime provider instead of Bedrock Mantle." }
  }
  const { guardrailIdentifier, guardrailVersion } = input.settings
  if (typeof guardrailIdentifier !== "string" || !guardrailIdentifier || typeof guardrailVersion !== "string" || !guardrailVersion) {
    return { error: "This provider's guardrail settings are incomplete. Ask your administrator to save both the guardrail ID and version." }
  }
  const identifier = bedrockGuardrailIdentifierSchema.safeParse(guardrailIdentifier)
  const version = bedrockGuardrailVersionSchema.safeParse(guardrailVersion)
  if (!identifier.success || !version.success) return { error: "This provider's guardrail ID or version is invalid. Ask your administrator to copy both values from the AWS Bedrock console." }
  const operation = input.url.pathname.split("/").at(-1)
  if (operation === "invoke" || operation === "invoke-with-response-stream") {
    input.headers.set("X-Amzn-Bedrock-GuardrailIdentifier", identifier.data)
    input.headers.set("X-Amzn-Bedrock-GuardrailVersion", version.data)
    return { body: input.body, applied: true }
  }
  if (operation !== "converse" && operation !== "converse-stream") {
    return { error: "This Bedrock operation cannot apply your organization's guardrail. Choose a Bedrock Runtime chat model or contact your administrator." }
  }
  let body: unknown
  try { body = JSON.parse(typeof input.body === "string" ? input.body : input.body ? new TextDecoder().decode(input.body) : "") } catch {
    return { error: "A guardrail requires a JSON Bedrock request. Send a JSON object or contact your administrator." }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "A guardrail requires a JSON Bedrock request object." }
  return { body: JSON.stringify({ ...body, guardrailConfig: { guardrailIdentifier: identifier.data, guardrailVersion: version.data } }), applied: true }
}

const clientGuardrailHeaders = ["x-amzn-bedrock-guardrailidentifier", "x-amzn-bedrock-guardrailversion", "x-amzn-bedrock-trace"]
const clientGuardrailFields = new Set(["guardrailconfig", "guardrailidentifier", "guardrailversion", "guardcontent", "amazonbedrockguardrailconfig"])
const opaqueClientFields = new Set(["schema", "inputschema", "outputschema", "responseschema", "responsejsonschema", "responseformat", "parameters", "metadata", "json", "tooluse"])

export function hasClientBedrockGuardrail(headers: Headers, body?: unknown): boolean {
  if (clientGuardrailHeaders.some((name) => headers.has(name))) return true
  const pending: unknown[] = [body]
  while (pending.length) {
    const value = pending.pop()
    if (Array.isArray(value)) { pending.push(...value); continue }
    if (typeof value !== "object" || value === null) continue
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[_-]/g, "").toLowerCase()
      if (clientGuardrailFields.has(normalized)) return true
      if (opaqueClientFields.has(normalized) || (key === "input" && Reflect.get(value, "type") === "tool_use")) continue
      pending.push(child)
    }
  }
  return false
}
