// Picks the model and thinking level for one Smart request.
//
// Jev scores how well the prompt fits every task of the router (0..1 each).
// Each model's total is the sum of its tasks' scores, so a model with two
// good matches beats one with a single slightly better match. The highest
// total wins; ties go to the model listed first. Jev also scores how much
// reasoning the prompt needs, mapped onto the levels the chosen model allows.
//
// A turn starts with a user message and may continue through many requests
// (tool results). Jev is asked once per turn; continuations reuse the turn's
// choice so the model, its thinking and its prompt cache stay consistent.
import { autoRouterTaskKey, autoRouterTaskQuestionKey, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import type { AskJev, JevScores, JevTask } from "./jev.js"

export type AutoCandidate = {
  /** The model's position in the router; lower wins ties and is the fallback. */
  modelIndex: number
  /** The `auto_router_model` row id. */
  routeId: string
  modelName: string
  tasks: string[]
  /** The thinking levels this model allows (`default` plus its catalog efforts). */
  thinkingLevels: AutoRouterThinkingLevel[]
}

export type AutoDecision = {
  candidate: AutoCandidate
  thinkingLevel: AutoRouterThinkingLevel
  reason: "jev" | "turn" | "fallback"
  /** Each candidate's summed task score, by route id, when Jev answered. */
  totals?: Map<string, number>
}

type CachedChoice = { routeId: string; thinking: AutoRouterThinkingLevel; expires: number }

const TURN_CACHE_MS = 60 * 60_000
const TURN_CACHE_LIMIT = 20_000
const turnChoices = new Map<string, CachedChoice>()

/** Effort levels from least to most reasoning. `default` is not on the scale. */
const EFFORT_SCALE: AutoRouterThinkingLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
/** Where each Jev thinking level (none, light, moderate, deep) lands on the scale. */
const JEV_THINKING_TARGETS: AutoRouterThinkingLevel[] = ["none", "low", "medium", "high"]

/**
 * The model's own level closest to what Jev asked for; ties go to more
 * reasoning. `default` when the model takes no effort levels or Jev gave none.
 */
export function thinkingLevelFor(score: number | null, allowed: readonly AutoRouterThinkingLevel[]): AutoRouterThinkingLevel {
  const efforts = allowed.filter((level) => level !== "default")
  if (score === null || efforts.length === 0) return "default"
  const target = JEV_THINKING_TARGETS[Math.round(Math.min(1, Math.max(0, score)) * (JEV_THINKING_TARGETS.length - 1))] ?? "medium"
  const targetRank = EFFORT_SCALE.indexOf(target)
  let best: AutoRouterThinkingLevel = "default"
  let bestDistance = Number.POSITIVE_INFINITY
  for (const level of efforts) {
    const distance = Math.abs(EFFORT_SCALE.indexOf(level) - targetRank)
    if (distance < bestDistance || (distance === bestDistance && EFFORT_SCALE.indexOf(level) > EFFORT_SCALE.indexOf(best))) {
      best = level
      bestDistance = distance
    }
  }
  return best
}

/** The fallback: the first model the member can use, at the provider's default thinking. */
export function fallbackDecision(candidates: AutoCandidate[]): AutoDecision | null {
  const first = [...candidates].sort((a, b) => a.modelIndex - b.modelIndex)[0]
  return first ? { candidate: first, thinkingLevel: "default", reason: "fallback" } : null
}

/** One Jev question per distinct task (case-insensitive) across the candidates, in model order. */
export function jevTasks(candidates: AutoCandidate[]): { tasks: JevTask[]; keyOf: Map<string, string> } {
  const tasks: JevTask[] = []
  const keyOf = new Map<string, string>()
  for (const candidate of [...candidates].sort((a, b) => a.modelIndex - b.modelIndex)) {
    for (const name of candidate.tasks) {
      const taskKey = autoRouterTaskKey(name)
      if (!taskKey || keyOf.has(taskKey)) continue
      const key = autoRouterTaskQuestionKey(tasks.length)
      keyOf.set(taskKey, key)
      tasks.push({ key, name })
    }
  }
  return { tasks, keyOf }
}

/** Sums each candidate's task scores; the highest total wins, ties to the first listed. */
export function scoreCandidates(candidates: AutoCandidate[], scores: JevScores, keyOf: Map<string, string>) {
  const totals = new Map<string, number>()
  let best: AutoCandidate | null = null
  let bestTotal = Number.NEGATIVE_INFINITY
  for (const candidate of [...candidates].sort((a, b) => a.modelIndex - b.modelIndex)) {
    const seen = new Set<string>()
    let total = 0
    for (const name of candidate.tasks) {
      const key = keyOf.get(autoRouterTaskKey(name))
      if (!key || seen.has(key)) continue
      seen.add(key)
      total += scores.tasks.get(key) ?? 0
    }
    totals.set(candidate.routeId, total)
    if (total > bestTotal) {
      best = candidate
      bestTotal = total
    }
  }
  return { best, totals }
}

function remember(turnKey: string, chosen: AutoDecision, now: number) {
  turnChoices.delete(turnKey)
  turnChoices.set(turnKey, { routeId: chosen.candidate.routeId, thinking: chosen.thinkingLevel, expires: now + TURN_CACHE_MS })
  while (turnChoices.size > TURN_CACHE_LIMIT) {
    const oldest = turnChoices.keys().next().value
    if (oldest === undefined) break
    turnChoices.delete(oldest)
  }
}

export type TurnChoice = { routeId: string; thinking: AutoRouterThinkingLevel }

/**
 * The turn's choice shared by every gateway instance, so a continuation that
 * lands on another instance keeps the turn's model (and its replayable
 * reasoning) instead of asking Jev again.
 */
export type SharedTurnChoices = {
  recall(turnKey: string): Promise<TurnChoice | null>
  remember(turnKey: string, choice: TurnChoice): Promise<void>
}

export async function decideAutoRoute(input: {
  candidates: AutoCandidate[]
  prompt: string
  context: string | null
  /** True when the request continues a turn (its last message is not the user's). */
  continuation: boolean
  /** Identifies the conversation turn for reuse; null disables reuse. */
  turnKey: string | null
  askJev: AskJev
  signal?: AbortSignal
  now?: number
  onJevError?: (error: unknown) => void
  shared?: SharedTurnChoices
}): Promise<AutoDecision | null> {
  const now = input.now ?? Date.now()
  if (input.continuation && input.turnKey) {
    const cached = turnChoices.get(input.turnKey)
    const choice = cached && cached.expires > now ? cached : await input.shared?.recall(input.turnKey).catch(() => null) ?? null
    const candidate = choice ? input.candidates.find((entry) => entry.routeId === choice.routeId) : undefined
    if (candidate && choice) {
      const thinkingLevel = candidate.thinkingLevels.includes(choice.thinking) ? choice.thinking : "default"
      const decision: AutoDecision = { candidate, thinkingLevel, reason: "turn" }
      remember(input.turnKey, decision, now)
      return decision
    }
  }
  let chosen: AutoDecision | null = null
  if (input.candidates.length > 0 && input.prompt.trim()) {
    // One usable model: Jev only decides how much it should think.
    const { tasks, keyOf } = input.candidates.length === 1 ? { tasks: [], keyOf: new Map<string, string>() } : jevTasks(input.candidates)
    try {
      const scores = await input.askJev({ prompt: input.prompt, context: input.context, tasks, signal: input.signal })
      if (scores) {
        const { best, totals } = input.candidates.length === 1
          ? { best: input.candidates[0] ?? null, totals: undefined }
          : scoreCandidates(input.candidates, scores, keyOf)
        if (best) chosen = { candidate: best, thinkingLevel: thinkingLevelFor(scores.thinking, best.thinkingLevels), reason: "jev", totals }
      }
    } catch (error) {
      input.onJevError?.(error)
    }
  }
  chosen ??= fallbackDecision(input.candidates)
  if (chosen && input.turnKey) {
    remember(input.turnKey, chosen, now)
    await input.shared?.remember(input.turnKey, { routeId: chosen.candidate.routeId, thinking: chosen.thinkingLevel }).catch(() => undefined)
  }
  return chosen
}

/** Test hook: forget every remembered turn. */
export function clearAutoTurnChoices() {
  turnChoices.clear()
}
