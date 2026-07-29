import type { StationSuggestion } from "@/react-app/domains/station/station-types";

export function contextualBubbleDiameter(suggestion: StationSuggestion): number {
  const kindMass = suggestion.kind === "memory"
    ? 3.2
    : suggestion.kind === "follow_up"
      ? 2
      : suggestion.kind === "calendar"
        ? 1
        : 0;
  const evidenceMass = Math.min(2.4, suggestion.sources.length * 1.2);
  const relevance = Math.min(1, Math.max(0, suggestion.effectiveRelevance));
  const relevanceMass = relevance * 19 + Math.pow(relevance, 2) * 11;
  return Math.min(49, Math.max(14, 13 + kindMass + evidenceMass + relevanceMass));
}
