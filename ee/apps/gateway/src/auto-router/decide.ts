// Picks the route for one Auto request; the route runs at its own thinking level.
//
// A turn starts with a user message and may continue through many requests
// (tool results). Jev is asked once per turn; continuations reuse the turn's
// choice so the model, its thinking and its prompt cache stay consistent.
import { autoRouterOptionKey, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import type { AskJev, JevOption } from "./jev.js"

export type AutoCandidate = {
  /** Index of the route in the organization's configuration; 0 is the default model. */
  routeIndex: number
  routeId: string
  modelName: string
  prompt: string
  thinkingLevel: AutoRouterThinkingLevel
}

export type AutoDecision = {
  candidate: AutoCandidate
  /** Always the chosen route's own level. */
  thinkingLevel: AutoRouterThinkingLevel
  reason: "jev" | "turn" | "fallback"
}

type CachedChoice = { routeId: string; expires: number }

const TURN_CACHE_MS = 60 * 60_000
const TURN_CACHE_LIMIT = 20_000
const turnChoices = new Map<string, CachedChoice>()

function decision(candidate: AutoCandidate, reason: AutoDecision["reason"]): AutoDecision {
  return { candidate, thinkingLevel: candidate.thinkingLevel, reason }
}

/**
 * The fallback: the default model, meaning the first route the member can use
 * in configured order (the first route itself when the member can use it).
 * Candidates arrive in configured order.
 */
export function fallbackDecision(candidates: AutoCandidate[]): AutoDecision | null {
  const first = [...candidates].sort((a, b) => a.routeIndex - b.routeIndex)[0]
  return first ? decision(first, "fallback") : null
}

/** One Jev option per route, including the default model with its fixed prompt. */
export function jevOptions(candidates: AutoCandidate[]): JevOption[] {
  return candidates.map((candidate) => ({
    key: autoRouterOptionKey(candidate.routeIndex),
    modelName: candidate.modelName,
    useWhen: candidate.prompt,
  }))
}

function remember(turnKey: string, chosen: AutoDecision, now: number) {
  turnChoices.delete(turnKey)
  turnChoices.set(turnKey, { routeId: chosen.candidate.routeId, expires: now + TURN_CACHE_MS })
  while (turnChoices.size > TURN_CACHE_LIMIT) {
    const oldest = turnChoices.keys().next().value
    if (oldest === undefined) break
    turnChoices.delete(oldest)
  }
}

/**
 * The turn's choice shared by every gateway instance, so a continuation that
 * lands on another instance keeps the turn's model (and its replayable
 * reasoning) instead of asking Jev again.
 */
export type SharedTurnChoices = {
  recall(turnKey: string): Promise<string | null>
  remember(turnKey: string, routeId: string): Promise<void>
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
    const routeId = cached && cached.expires > now ? cached.routeId : await input.shared?.recall(input.turnKey).catch(() => null) ?? null
    const candidate = routeId ? input.candidates.find((entry) => entry.routeId === routeId) : undefined
    if (candidate) {
      remember(input.turnKey, decision(candidate, "turn"), now)
      return decision(candidate, "turn")
    }
  }
  let chosen: AutoDecision | null = null
  const only = input.candidates.length === 1 ? input.candidates[0] : undefined
  if (only) {
    chosen = decision(only, "jev")
  } else if (input.prompt.trim()) {
    try {
      const choice = await input.askJev({ prompt: input.prompt, context: input.context, options: jevOptions(input.candidates), signal: input.signal })
      const candidate = choice ? input.candidates.find((entry) => autoRouterOptionKey(entry.routeIndex) === choice.key) : undefined
      if (candidate) chosen = decision(candidate, "jev")
    } catch (error) {
      input.onJevError?.(error)
    }
  }
  chosen ??= fallbackDecision(input.candidates)
  if (chosen && input.turnKey) {
    remember(input.turnKey, chosen, now)
    await input.shared?.remember(input.turnKey, chosen.candidate.routeId).catch(() => undefined)
  }
  return chosen
}

/** Test hook: forget every remembered turn. */
export function clearAutoTurnChoices() {
  turnChoices.clear()
}
