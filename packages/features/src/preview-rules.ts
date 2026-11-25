import { FEATURE_CATEGORIES } from "@openwork/features/define"


/** How far ahead a preview may set its expiry. A later date needs a new decision, not a longer lease. */
export const MAX_PREVIEW_DAYS = 183
/** Days before the expiry at which the check starts to warn. */
export const EXPIRY_WARNING_DAYS = 14

const DAY_MS = 86_400_000

function dayTime(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const time = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(time)) return null
  return new Date(time).toISOString().slice(0, 10) === value ? time : null
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export type PreviewRuleResult = { problems: string[]; warnings: string[] }

/** `today` is a UTC day, "YYYY-MM-DD". */
export function previewRuleProblems(key: string, definition: Readonly<Record<string, unknown>>, today: string): PreviewRuleResult {
  const problems: string[] = []
  const warnings: string[] = []
  const now = dayTime(today)
  if (now === null) throw new Error(`today must be "YYYY-MM-DD", got ${JSON.stringify(today)}`)

  if (!/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)*$/.test(key)) {
    problems.push(`Preview flag key "${key}" must be lowerCamelCase with no consecutive capitals (it becomes a DEN_FEATURE_* variable).`)
  }
  if (!text(definition.label) || !text(definition.description)) problems.push(`Preview flag "${key}" needs a label and a description.`)
  if (typeof definition.category !== "string" || !Object.hasOwn(FEATURE_CATEGORIES, definition.category)) {
    problems.push(`Preview flag "${key}" needs a category, one of: ${Object.keys(FEATURE_CATEGORIES).join(", ")}.`)
  }
  if (!Array.isArray(definition.deployments) || definition.deployments.length === 0) problems.push(`Preview flag "${key}" must exist on at least one deployment.`)

  const added = dayTime(definition.added)
  if (added === null) problems.push(`Preview flag "${key}" added must be the day the flag was added, "YYYY-MM-DD".`)

  const owner = text(definition.owner)
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    problems.push(`Preview flag "${key}" needs an owner: the GitHub handle of the person who decides whether it ships or is cut, e.g. owner: "benjaminshafii".`)
  }

  const expires = dayTime(definition.expiresOn)
  if (expires === null) {
    problems.push(`Preview flag "${key}" needs expiresOn: the day its ship-or-cut decision is due, "YYYY-MM-DD", at most ${MAX_PREVIEW_DAYS} days from today.`)
    return { problems, warnings }
  }
  const mention = owner ? ` (owner @${owner})` : ""
  if (added !== null && expires <= added) problems.push(`Preview flag "${key}" expiresOn ${String(definition.expiresOn)} must be after the day it was added.`)
  const daysLeft = Math.round((expires - now) / DAY_MS)
  if (daysLeft < 0) {
    problems.push(`Preview flag "${key}" expired on ${String(definition.expiresOn)}${mention}. Ship it (move the key to packages/features/src/retired.ts and remove its checks), cut it, or set a new expiresOn and say why in the pull request.`)
  } else if (daysLeft > MAX_PREVIEW_DAYS) {
    problems.push(`Preview flag "${key}" expiresOn ${String(definition.expiresOn)} is more than ${MAX_PREVIEW_DAYS} days away. A preview is unfinished work: set the day you expect to ship or cut it.`)
  } else if (daysLeft <= EXPIRY_WARNING_DAYS) {
    warnings.push(`Preview flag "${key}" expires on ${String(definition.expiresOn)}${mention}: ${daysLeft === 0 ? "today" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`} to ship or cut it.`)
  }
  return { problems, warnings }
}

/** The first export that is out of alphabetical order, or null. Keys sort the way a module lists its exports. */
export function firstUnsortedKey(keys: readonly string[]): { key: string; after: string } | null {
  for (let index = 1; index < keys.length; index++) {
    const previous = keys[index - 1]
    const current = keys[index]
    if (previous !== undefined && current !== undefined && current < previous) return { key: current, after: previous }
  }
  return null
}
