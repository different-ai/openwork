// Asks Jev (TypeSafe System One, https://docs.typesafe.ai/primitives/score)
// how well a prompt fits each of a Smart Router's tasks, and how much
// reasoning it needs. One request: one Score question per task, plus one for
// the thinking level. Scores come back normalized to 0..1. Jev sees task names
// and the conversation, never provider or model ids.

export type JevTask = {
  /** Opaque question key, `task_<n>`. */
  key: string
  /** The task as the admin named it, for example "code review". */
  name: string
}

export type JevScores = {
  /** Each task's score, 0 (unrelated) to 1 (clearly this task), by key. */
  tasks: Map<string, number>
  /** How much reasoning the prompt needs, 0 (none) to 1 (deep); null when Jev gave none. */
  thinking: number | null
  model: string | null
}

export type AskJev = (input: { prompt: string; context: string | null; tasks: JevTask[]; signal?: AbortSignal }) => Promise<JevScores | null>

/** Prompts longer than this are trimmed (start and end kept); routing rarely needs more. */
const PROMPT_LIMIT = 12_000

/** The question key for the thinking level; task keys are `task_<n>`, so it cannot collide. */
export const JEV_THINKING_KEY = "thinking"

/** Thinking levels, low to high; the gateway maps the score onto the model's own levels. */
export const JEV_THINKING_CRITERIA = [
  "None: a greeting, a quick fact, or a simple lookup or rewrite that needs no reasoning",
  "Light: a short answer or a small, clear change that needs a little thought",
  "Moderate: several steps, some analysis, or a non-trivial change",
  "Deep: a hard multi-step problem, complex code or debugging, careful analysis or planning",
] as const

function trimmed(text: string) {
  if (text.length <= PROMPT_LIMIT) return text
  const half = Math.floor(PROMPT_LIMIT / 2)
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`
}

type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] }

function taskQuestion(name: string): ScoreQuestion {
  return {
    type: "score",
    instructions: `An AI assistant must answer latest_request. How much is latest_request this kind of task: "${name}"?`,
    criteria: [
      `Unrelated: latest_request is not "${name}"`,
      `Partly: latest_request involves some "${name}", but it is mainly something else`,
      `Clearly: latest_request is "${name}"`,
    ],
  }
}

export function jevRequestBody(input: { prompt: string; context: string | null; tasks: JevTask[]; model: string }) {
  const questions: Record<string, ScoreQuestion> = Object.fromEntries(input.tasks.map((task) => [task.key, taskQuestion(task.name)]))
  questions[JEV_THINKING_KEY] = {
    type: "score",
    instructions: "An AI assistant must answer latest_request. How much careful reasoning does a good answer need?",
    criteria: [...JEV_THINKING_CRITERIA],
  }
  return {
    model: input.model,
    state: {
      latest_request: trimmed(input.prompt),
      ...(input.context ? { earlier_conversation: trimmed(input.context) } : {}),
    },
    questions,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A Score answer as 0..1: its score divided by the top level number. */
function normalizedScore(answer: unknown, levels: number): number | null {
  if (!isRecord(answer) || typeof answer.score !== "number" || !Number.isFinite(answer.score) || levels < 2) return null
  return Math.min(1, Math.max(0, answer.score / (levels - 1)))
}

export function readJevScores(body: unknown, tasks: JevTask[]): JevScores | null {
  const answers = isRecord(body) && isRecord(body.answers) ? body.answers : null
  if (!answers) return null
  const scores = new Map<string, number>()
  for (const task of tasks) {
    const score = normalizedScore(answers[task.key], 3)
    if (score !== null) scores.set(task.key, score)
  }
  const thinking = normalizedScore(answers[JEV_THINKING_KEY], JEV_THINKING_CRITERIA.length)
  if (scores.size === 0 && thinking === null) return null
  return { tasks: scores, thinking, model: isRecord(body) && typeof body.model === "string" ? body.model : null }
}

export function createJevClient(config: {
  apiKey: string | null
  baseUrl: string
  model: string
  timeoutMs: number
  fetch: typeof fetch
}): AskJev {
  return async ({ prompt, context, tasks, signal }) => {
    if (!config.apiKey) return null
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const response = await config.fetch(`${config.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(jevRequestBody({ prompt, context, tasks, model: config.model })),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`jev_http_${response.status}`)
    }
    return readJevScores(await response.json(), tasks)
  }
}
