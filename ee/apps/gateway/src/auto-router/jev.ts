// Asks Jev (TypeSafe System One, https://docs.typesafe.ai/primitives/choice)
// which route and thinking level should answer a prompt. One Choice question;
// each option is one route at one thinking level, keyed by an opaque id. Jev
// sees the option keys and descriptions, never provider or model ids.
import { AUTO_ROUTER_THINKING_LABELS, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"

export type JevOption = {
  key: string
  modelName: string
  useWhen: string
  thinkingLevel: AutoRouterThinkingLevel
}

export type JevChoice = { key: string; confidence: number | null; model: string | null }

export type AskJev = (input: { prompt: string; context: string | null; options: JevOption[]; signal?: AbortSignal }) => Promise<JevChoice | null>

const THINKING_DESCRIPTIONS: Record<AutoRouterThinkingLevel, string> = {
  default: "the model's standard reasoning",
  none: "no extended reasoning; fastest, for trivial replies",
  minimal: "almost no reasoning; very fast, for simple replies",
  low: "light reasoning for straightforward tasks",
  medium: "moderate reasoning for typical tasks",
  high: "deep reasoning for complex, multi-step tasks",
  xhigh: "very deep reasoning for hard problems",
  max: "the most reasoning, for the hardest problems; slowest and most expensive",
}

/** Prompts longer than this are trimmed (start and end kept); routing rarely needs more. */
const PROMPT_LIMIT = 12_000

function trimmed(text: string) {
  if (text.length <= PROMPT_LIMIT) return text
  const half = Math.floor(PROMPT_LIMIT / 2)
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`
}

export function jevRequestBody(input: { prompt: string; context: string | null; options: JevOption[]; model: string }) {
  const criteria = Object.fromEntries(input.options.map((option) => [option.key, {
    model: option.modelName,
    use_when: option.useWhen,
    thinking: `${AUTO_ROUTER_THINKING_LABELS[option.thinkingLevel]}: ${THINKING_DESCRIPTIONS[option.thinkingLevel]}`,
  }]))
  return {
    model: input.model,
    state: {
      latest_request: trimmed(input.prompt),
      ...(input.context ? { earlier_conversation: trimmed(input.context) } : {}),
    },
    questions: {
      route: {
        type: "choice",
        instructions: "An AI assistant must answer latest_request. Which model and thinking level should answer it? Follow each option's use_when. Prefer the least thinking that will still answer well.",
        criteria,
      },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createJevClient(config: {
  apiKey: string | null
  baseUrl: string
  model: string
  timeoutMs: number
  fetch: typeof fetch
}): AskJev {
  return async ({ prompt, context, options, signal }) => {
    if (!config.apiKey || options.length === 0) return null
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const response = await config.fetch(`${config.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(jevRequestBody({ prompt, context, options, model: config.model })),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`jev_http_${response.status}`)
    }
    const body: unknown = await response.json()
    const answers = isRecord(body) && isRecord(body.answers) ? body.answers : null
    const answer = answers && isRecord(answers.route) ? answers.route : null
    const key = answer && typeof answer.choice === "string" ? answer.choice : null
    if (!key || !options.some((option) => option.key === key)) return null
    return {
      key,
      confidence: typeof answer?.confidence === "number" ? answer.confidence : null,
      model: isRecord(body) && typeof body.model === "string" ? body.model : null,
    }
  }
}
