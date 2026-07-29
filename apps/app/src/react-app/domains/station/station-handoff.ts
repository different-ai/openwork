import type { StationSuggestion } from "./station-types";

export type StationThreadHandoff = {
  prompt: string;
  title: string;
};

function sourceLines(suggestion: StationSuggestion) {
  return suggestion.sources.map((source) => (
    `- ${source.provider}: ${source.label}${source.url ? ` (${source.url})` : ""}`
  ));
}

export function buildStationThreadHandoff(suggestion: StationSuggestion): StationThreadHandoff {
  const sources = sourceLines(suggestion);
  const preparedDraft = suggestion.action.kind === "review_draft" && suggestion.action.draft
    ? [
        "",
        "Prepared draft (not sent or applied):",
        suggestion.action.draft,
      ]
    : [];
  return {
    title: suggestion.title,
    prompt: [
      "Continue from this OpenWork Station context. Expand the useful information, verify what matters, and help me decide or act. Keep every external action under my review and let me steer the conversation.",
      "",
      `Context: ${suggestion.title}`,
      suggestion.summary,
      "",
      `Why Station surfaced it now: ${suggestion.reason}`,
      ...(sources.length ? ["", "Connected evidence:", ...sources] : ["", "Evidence: local context only."]),
      ...preparedDraft,
    ].join("\n"),
  };
}
