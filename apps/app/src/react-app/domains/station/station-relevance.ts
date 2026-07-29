import type { OpenworkStationSuggestion } from "@/app/lib/openwork-server";
import type { StationSuggestion } from "./station-types";

const HALF_LIFE_MS = 4 * 60 * 1_000;
const MAX_SUGGESTIONS = 8;

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function normalizedWords(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4),
  );
}

function contextualBoost(suggestion: OpenworkStationSuggestion, transcript: string) {
  const transcriptWords = normalizedWords(transcript);
  if (!transcriptWords.size) return 0;
  const suggestionWords = normalizedWords(`${suggestion.title} ${suggestion.summary} ${suggestion.reason}`);
  let matches = 0;
  for (const word of suggestionWords) {
    if (transcriptWords.has(word)) matches += 1;
  }
  return Math.min(0.16, matches * 0.025);
}

export function effectiveStationRelevance(
  suggestion: OpenworkStationSuggestion,
  transcript: string,
  now = Date.now(),
): number {
  const age = Math.max(0, now - suggestion.createdAt);
  const decay = Math.pow(0.5, age / HALF_LIFE_MS);
  return clamp(suggestion.relevance * decay + contextualBoost(suggestion, transcript));
}

function suggestionIdentity(suggestion: OpenworkStationSuggestion) {
  const source = suggestion.sources[0]?.url ?? "";
  return `${suggestion.kind}:${suggestion.title.toLowerCase().trim()}:${source}`;
}

export function rankStationSuggestions(
  current: OpenworkStationSuggestion[],
  incoming: OpenworkStationSuggestion[],
  transcript: string,
  now = Date.now(),
): StationSuggestion[] {
  const byIdentity = new Map<string, OpenworkStationSuggestion>();
  for (const suggestion of [...current, ...incoming]) {
    const key = suggestionIdentity(suggestion);
    const previous = byIdentity.get(key);
    if (!previous || suggestion.createdAt >= previous.createdAt || suggestion.relevance > previous.relevance) {
      byIdentity.set(key, suggestion);
    }
  }
  return Array.from(byIdentity.values())
    .map((suggestion) => ({
      ...suggestion,
      effectiveRelevance: effectiveStationRelevance(suggestion, transcript, now),
    }))
    .filter((suggestion) => suggestion.effectiveRelevance >= 0.08)
    .sort((left, right) => (
      right.effectiveRelevance - left.effectiveRelevance
      || right.createdAt - left.createdAt
    ))
    .slice(0, MAX_SUGGESTIONS);
}
