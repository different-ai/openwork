import type { StationSuggestion } from "./station-types";

export type StationHistoryDirection = "older" | "newer";

export function stationDismissal(
  suggestions: StationSuggestion[],
  selectedId: string | null,
  dismissedId: string | null,
) {
  const id = dismissedId ?? selectedId;
  const remaining = suggestions.filter((suggestion) => suggestion.id !== id);
  return {
    suggestions: remaining,
    selectedId: remaining[0]?.id ?? null,
    returnToPassive: remaining.length === 0,
  };
}

export function stationHistorySelection(
  suggestions: StationSuggestion[],
  selectedId: string | null,
  direction: StationHistoryDirection,
) {
  if (!suggestions.length) return null;
  const currentIndex = Math.max(
    0,
    suggestions.findIndex((suggestion) => suggestion.id === selectedId),
  );
  const nextIndex = direction === "older"
    ? Math.min(suggestions.length - 1, currentIndex + 1)
    : Math.max(0, currentIndex - 1);
  return suggestions[nextIndex]?.id ?? null;
}
