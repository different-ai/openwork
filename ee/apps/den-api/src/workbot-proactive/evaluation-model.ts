/**
 * The fast evaluation model Your agent's check gate and send check ask (typesafe-ai/jev through Vercel AI Gateway). It
 * answers yes-or-no questions about a state with probabilities and writes nothing: what to do with an answer is plain
 * code in @openwork/automations/proactive-brief. One attempt, no retries, no redirects, a short time limit, and the
 * request asks the provider to keep nothing. Every failure (no answer in time, a refused request, an unreadable body)
 * is `answers: null`, which both callers treat as "carry on as without me".
 *
 * Wire contract: POST {state, questions, providerOptions} with the evaluation headers below, as @ai-sdk/gateway 4.0.87
 * sends it (GatewayEvaluationModel.doEvaluate); a boolean answer is {type: "boolean", probability}.
 */

const ENDPOINT = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"
const MODEL = "typesafe-ai/jev"
const RESPONSE_BYTE_LIMIT = 64 * 1024
const DEFAULT_TIMEOUT_MS = 4_000

export type EvaluationRequest = { state: unknown; questions: Record<string, { type: "boolean"; instructions: string }> }
export type EvaluationAnswer = {
  /** The model's answers by question id, unvalidated; null when it gave no usable answer. */
  answers: Record<string, unknown> | null
  durationMs: number
  inputTokens: number | null
}
export type EvaluationModel = (request: EvaluationRequest) => Promise<EvaluationAnswer>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get("content-length")) > RESPONSE_BYTE_LIMIT) throw new Error("unreadable body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > RESPONSE_BYTE_LIMIT) throw new Error("oversized body")
      chunks.push(chunk.value)
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
}

export function createEvaluationModel(options: { apiKey: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }): EvaluationModel {
  const send = options.fetch ?? globalThis.fetch
  return async (request) => {
    const started = performance.now()
    try {
      const response = await send(ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
          "ai-gateway-protocol-version": "0.0.1",
          "ai-gateway-auth-method": "api-key",
          "ai-evaluation-model-specification-version": "4",
          "ai-model-id": MODEL,
        },
        body: JSON.stringify({ state: request.state, questions: request.questions, providerOptions: { gateway: { zeroDataRetention: true } } }),
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new Error("evaluation model unavailable")
      }
      const body = await boundedJson(response)
      if (!isRecord(body) || !isRecord(body.answers)) throw new Error("unreadable answer")
      const usage = isRecord(body.usage) ? body.usage.inputTokens : null
      return {
        answers: body.answers,
        durationMs: Math.round(performance.now() - started),
        inputTokens: typeof usage === "number" && Number.isSafeInteger(usage) && usage >= 0 ? usage : null,
      }
    } catch {
      // Never the provider's error text: it can quote the request.
      return { answers: null, durationMs: Math.round(performance.now() - started), inputTokens: null }
    }
  }
}
