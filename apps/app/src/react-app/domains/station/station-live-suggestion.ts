import type { OpenworkStationSuggestion } from "@/app/lib/openwork-server";

function boundedText(value: string, fallback: string, limit: number) {
  const clean = value.trim().replace(/\s+/g, " ");
  return (clean || fallback).slice(0, limit);
}

export function createLiveConversationSuggestion(
  input: {
    title: string;
    summary: string;
    reason: string;
  },
  now = Date.now(),
): OpenworkStationSuggestion {
  const title = boundedText(input.title, "Continue this conversation", 80);
  return {
    id: `station-live-${now}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32)}`,
    kind: "context",
    title,
    summary: boundedText(
      input.summary,
      "A concrete thought from the live conversation is ready to develop in OpenWork.",
      420,
    ),
    reason: boundedText(
      input.reason,
      "The user explicitly wants to continue this work as an OpenWork thread.",
      220,
    ),
    relevance: 0.94,
    color: "#4EA8FF",
    sources: [],
    action: {
      kind: "none",
      label: "Start thread",
    },
    createdAt: now,
  };
}
