import { z } from "zod"
import type { ModelPromotionTerms } from "@openwork/types/den/model-promotions"
import { PromotionError } from "./index.js"

const functionCall = z.object({ id: z.string().max(200), type: z.literal("function"), function: z.object({ name: z.string().max(200), arguments: z.string() }).strict() }).strict()
const message = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }).strict())]).nullable().optional(),
  name: z.string().max(200).optional(), tool_call_id: z.string().max(200).optional(), tool_calls: z.array(functionCall).max(64).optional(),
}).strict()
const requestSchema = z.object({
  model: z.string(), messages: z.array(message).min(1).max(1000),
  stream: z.boolean().optional(), stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
  max_tokens: z.number().int().positive().optional(), max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string().max(1000), z.array(z.string().max(1000)).max(4)]).optional(),
  tools: z.array(z.object({ type: z.literal("function"), function: z.object({ name: z.string().max(200), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).strict() }).strict()).max(128).optional(),
  tool_choice: z.union([z.enum(["none", "auto", "required"]), z.object({ type: z.literal("function"), function: z.object({ name: z.string().max(200) }).strict() }).strict()]).optional(),
  parallel_tool_calls: z.boolean().optional(),
}).strict()

export function preparePromotionRequest(input: unknown, terms: ModelPromotionTerms, requestId: string) {
  const parsed = requestSchema.safeParse(input)
  if (!parsed.success) throw new PromotionError("unsupported_promotion_request", "This offer supports text and client function tools. Routing overrides, paid server tools, media, caching controls, and other request extensions are not supported.", 400)
  const body = parsed.data
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8")
  if (bytes > terms.maxInputBytes) throw new PromotionError("promotion_input_limit", "This request exceeds the offer's input limit. Shorten the conversation or choose another model.", 400)
  const output = Math.min(body.max_completion_tokens ?? body.max_tokens ?? terms.maxOutputTokens, terms.maxOutputTokens)
  // A byte bound plus serialization overhead is deliberately more conservative
  // than an average characters/token estimate. Only text and client tools enter.
  const inputBound = bytes * 2 + body.messages.length * 64 + (body.tools?.length ?? 0) * 256 + 4096
  const reserveMicrousd = Math.ceil((inputBound * terms.inputUsdPerMillion + output * terms.outputUsdPerMillion) * (1 + terms.feeReserveBps / 10000))
  const { max_completion_tokens: _completion, ...rest } = body
  return { reserveMicrousd, body: JSON.stringify({ ...rest, model: terms.upstreamModel, max_tokens: output,
    ...(body.stream ? { stream_options: { include_usage: true } } : {}),
    provider: { only: [terms.provider], allow_fallbacks: false, require_parameters: true,
      max_price: { prompt: terms.inputUsdPerMillion, completion: terms.outputUsdPerMillion } },
    user: requestId, session_id: requestId,
    trace: { trace_id: requestId, trace_name: "OpenWork model offer", openwork_promotion_request_id: requestId },
  }) }
}

export const usageSchema = z.object({ cost: z.number().finite().nonnegative(), is_byok: z.boolean(),
  cost_details: z.object({ upstream_inference_cost: z.number().finite().nonnegative().nullable().optional() }).optional() })
export function promotionUsageCost(input: unknown): number | null {
  const usage = usageSchema.safeParse(input)
  if (!usage.success) return null
  const provider = usage.data.cost_details?.upstream_inference_cost
  if (usage.data.is_byok && provider == null) return null
  return Math.ceil((usage.data.cost + (usage.data.is_byok ? provider ?? 0 : 0)) * 1000000)
}

export async function validatePromotionKey(key: string, terms: ModelPromotionTerms, fetcher: typeof fetch = fetch, base = "https://openrouter.ai/api/v1") {
  const response = await fetcher(`${base}/key`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new PromotionError("provider_key_invalid", "OpenRouter could not validate the campaign key.", 400)
  const parsed = z.object({ data: z.object({ limit: z.number().positive(), limit_remaining: z.number().nonnegative(), limit_reset: z.null(), include_byok_in_limit: z.literal(true),
    expires_at: z.string().nullable().optional(), is_management_key: z.boolean().optional() }) }).safeParse(await response.json())
  if (!parsed.success || parsed.data.data.is_management_key) throw new PromotionError("provider_key_unbounded", "Use a dedicated inference key with a non-resetting USD limit and BYOK usage included in the limit.", 400)
  const data = parsed.data.data
  if (data.limit * 1000000 > terms.budgetMicrousd || data.limit_remaining <= 0) throw new PromotionError("provider_budget_mismatch", "The key must have remaining credit and its total limit cannot exceed the campaign budget.", 400)
  const end = Date.parse(terms.endsAt) + (terms.activationDays * 86400 + terms.durationSeconds) * 1000
  if (data.expires_at && Date.parse(data.expires_at) < end) throw new PromotionError("provider_key_expires_early", "The key expires before the last customer's credit can finish.", 400)
  const modelResponse = await fetcher(`${base}/models/${terms.upstreamModel}/endpoints`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })
  if (!modelResponse.ok) throw new PromotionError("provider_model_unavailable", "OpenRouter could not find the configured underlying model.", 400)
  const endpoints = z.object({ data: z.object({ endpoints: z.array(z.object({ tag: z.string().optional(), provider_name: z.string(), pricing: z.object({ prompt: z.coerce.number().nonnegative(), completion: z.coerce.number().nonnegative(), request: z.coerce.number().nonnegative().optional() }) })) }) }).parse(await modelResponse.json())
  if (!endpoints.data.endpoints.some((e) => (e.tag === terms.provider || e.provider_name.toLowerCase() === terms.provider.toLowerCase()) && (e.pricing.request ?? 0) === 0 && e.pricing.prompt * 1000000 <= terms.inputUsdPerMillion && e.pricing.completion * 1000000 <= terms.outputUsdPerMillion))
    throw new PromotionError("provider_price_mismatch", "No endpoint matches the selected provider and price ceilings.", 400)
}
