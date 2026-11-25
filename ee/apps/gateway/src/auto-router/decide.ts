import { autoRouterTaskKey, autoRouterTaskQuestionKey, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import type { AskJev, JevScores, JevTask } from "./jev.js"

export type AutoCandidate = {
  modelIndex: number
  routeId: string
  modelName: string
  tasks: string[]
  thinkingLevels: AutoRouterThinkingLevel[]
}

export type AutoDecision = {
  candidate: AutoCandidate
  thinkingLevel: AutoRouterThinkingLevel
  reason: "jev" | "turn" | "fallback"
  totals?: Map<string, number>
}

type CachedChoice = { routeId: string; thinking: AutoRouterThinkingLevel; expires: number }

const TURN_CACHE_MS = 60 * 60_000
const TURN_CACHE_LIMIT = 20_000
const turnChoices = new Map<string, CachedChoice>()

const EFFORT_SCALE: AutoRouterThinkingLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
const JEV_THINKING_TARGETS: AutoRouterThinkingLevel[] = ["none", "low", "medium", "high"]

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

export function fallbackDecision(candidates: AutoCandidate[]): AutoDecision | null {
  const first = [...candidates].sort((a, b) => a.modelIndex - b.modelIndex)[0]
  return first ? { candidate: first, thinkingLevel: "default", reason: "fallback" } : null
}

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

export type SharedTurnChoices = {
  recall(turnKey: string): Promise<TurnChoice | null>
  remember(turnKey: string, choice: TurnChoice): Promise<void>
}

export async function decideAutoRoute(input: {
  candidates: AutoCandidate[]
  prompt: string
  context: string | null
  continuation: boolean
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

export function clearAutoTurnChoices() {
  turnChoices.clear()
}
