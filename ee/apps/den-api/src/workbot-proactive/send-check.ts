import { agentSendCheckRequest, decideSendCheck, type AgentSendCheckVerdict } from "@openwork/automations/proactive-brief"

/**
 * The send check (`workbotAgentSendCheck`): one request per message to a fast evaluation model (Jev, through Vercel AI
 * Gateway), which answers two yes-or-no questions with probabilities. It writes nothing: Den's rule (`decideSendCheck`)
 * turns the answers into send or hold. Every failure (no answer in time, a refused request, an unreadable body) sends
 * the message, exactly as without the check. One attempt, no retries, no redirects, and the provider keeps no data.
 *
 * Wire contract: POST {state, questions, providerOptions} with the evaluation headers below, as @ai-sdk/gateway 4.0.87
 * sends it (GatewayEvaluationModel.doEvaluate); answers are {type: "boolean", probability}.
 */

const ENDPOINT = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"
const MODEL = "typesafe-ai/jev"
const RESPONSE_BYTE_LIMIT = 64 * 1024
const DEFAULT_TIMEOUT_MS = 4_000

export type AgentSendCheckInput = { brief: string; message: string; update: boolean; toldToday: readonly string[] }
export type AgentSendCheckResult = {
  verdict: AgentSendCheckVerdict
  /** `unavailable`: the model gave no usable answer, so the message is sent. */
  status: "answered" | "unavailable"
  durationMs: number
  inputTokens: number | null
}
export type AgentSendCheck = (input: AgentSendCheckInput) => Promise<AgentSendCheckResult>

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

export function createAgentSendCheck(options: { apiKey: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }): AgentSendCheck {
  const send = options.fetch ?? globalThis.fetch
  return async (input) => {
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
        body: JSON.stringify({ ...agentSendCheckRequest(input), providerOptions: { gateway: { zeroDataRetention: true } } }),
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new Error("check model unavailable")
      }
      const body = await boundedJson(response)
      if (!isRecord(body) || !isRecord(body.answers)) throw new Error("unreadable answer")
      const usage = isRecord(body.usage) ? body.usage.inputTokens : null
      return {
        verdict: decideSendCheck(body.answers, input),
        status: "answered",
        durationMs: Math.round(performance.now() - started),
        inputTokens: typeof usage === "number" && Number.isSafeInteger(usage) && usage >= 0 ? usage : null,
      }
    } catch {
      // Never the provider's error text: it can quote the request.
      return { verdict: { kind: "send" }, status: "unavailable", durationMs: Math.round(performance.now() - started), inputTokens: null }
    }
  }
}
