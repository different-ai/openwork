// Picks the route and thinking level for one Auto request.
//
// A turn starts with a user message and may continue through many requests
// (tool results). Jev is asked once per turn; continuations reuse the turn's
// choice so the model, its thinking and its prompt cache stay consistent.
import { autoRouterOptionKey, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import type { AskJev, JevOption } from "./jev.js"

export type AutoCandidate = {
  /** Index of the route in the organization's configuration. */
  routeIndex: number
  routeId: string
  modelName: string
  prompt: string
  thinkingLevels: AutoRouterThinkingLevel[]
}

export type AutoDecision = {
  candidate: AutoCandidate
  thinkingLevel: AutoRouterThinkingLevel
  reason: "jev" | "turn" | "fallback"
}

type CachedChoice = { routeId: string; thinkingLevel: AutoRouterThinkingLevel; expires: number }

const TURN_CACHE_MS = 60 * 60_000
const TURN_CACHE_LIMIT = 20_000
const turnChoices = new Map<string, CachedChoice>()

/** The fallback: the first route that allows High thinking, at High; else the first route at its first level. */
export function fallbackDecision(candidates: AutoCandidate[]): AutoDecision | null {
  const high = candidates.find((candidate) => candidate.thinkingLevels.includes("high"))
  if (high) return { candidate: high, thinkingLevel: "high", reason: "fallback" }
  const first = candidates[0]
  const level = first?.thinkingLevels[0]
  return first && level ? { candidate: first, thinkingLevel: level, reason: "fallback" } : null
}

export function jevOptions(candidates: AutoCandidate[]): JevOption[] {
  return candidates.flatMap((candidate) => candidate.thinkingLevels.map((thinkingLevel) => ({
    key: autoRouterOptionKey(candidate.routeIndex, thinkingLevel),
    modelName: candidate.modelName,
    useWhen: candidate.prompt,
    thinkingLevel,
  })))
}

function remember(turnKey: string, decision: AutoDecision, now: number) {
  turnChoices.delete(turnKey)
  turnChoices.set(turnKey, { routeId: decision.candidate.routeId, thinkingLevel: decision.thinkingLevel, expires: now + TURN_CACHE_MS })
  while (turnChoices.size > TURN_CACHE_LIMIT) {
    const oldest = turnChoices.keys().next().value
    if (oldest === undefined) break
    turnChoices.delete(oldest)
  }
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
}): Promise<AutoDecision | null> {
  const now = input.now ?? Date.now()
  if (input.continuation && input.turnKey) {
    const cached = turnChoices.get(input.turnKey)
    const candidate = cached && cached.expires > now ? input.candidates.find((entry) => entry.routeId === cached.routeId) : undefined
    if (cached && candidate && candidate.thinkingLevels.includes(cached.thinkingLevel)) {
      return { candidate, thinkingLevel: cached.thinkingLevel, reason: "turn" }
    }
  }
  let decision: AutoDecision | null = null
  if (input.candidates.length === 1 && input.candidates[0]?.thinkingLevels.length === 1) {
    const only = input.candidates[0]
    const level = only.thinkingLevels[0]
    if (level) decision = { candidate: only, thinkingLevel: level, reason: "jev" }
  } else if (input.prompt.trim()) {
    try {
      const options = jevOptions(input.candidates)
      const choice = await input.askJev({ prompt: input.prompt, context: input.context, options, signal: input.signal })
      if (choice) {
        const candidate = input.candidates.find((entry) => entry.thinkingLevels.some((level) => autoRouterOptionKey(entry.routeIndex, level) === choice.key))
        const thinkingLevel = candidate?.thinkingLevels.find((level) => autoRouterOptionKey(candidate.routeIndex, level) === choice.key)
        if (candidate && thinkingLevel) decision = { candidate, thinkingLevel, reason: "jev" }
      }
    } catch (error) {
      input.onJevError?.(error)
    }
  }
  decision ??= fallbackDecision(input.candidates)
  if (decision && input.turnKey) remember(input.turnKey, decision, now)
  return decision
}

/** Test hook: forget every remembered turn. */
export function clearAutoTurnChoices() {
  turnChoices.clear()
}
