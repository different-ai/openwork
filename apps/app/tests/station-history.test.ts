import { describe, expect, test } from "bun:test";

import {
  stationDismissal,
  stationHistorySelection,
} from "../src/react-app/domains/station/station-history";
import type { StationSuggestion } from "../src/react-app/domains/station/station-types";

function suggestion(id: string): StationSuggestion {
  return {
    id,
    kind: "context",
    title: id,
    summary: "Current context",
    reason: "Relevant now",
    relevance: 0.8,
    effectiveRelevance: 0.8,
    color: "#8B7CFF",
    sources: [],
    action: { kind: "none", label: "Keep in view" },
    createdAt: 1,
  };
}

describe("Station ordered card history", () => {
  const suggestions = ["highest", "middle", "oldest"].map(suggestion);

  test("moves left into older priority history and right toward the latest card", () => {
    expect(stationHistorySelection(suggestions, "highest", "older")).toBe("middle");
    expect(stationHistorySelection(suggestions, "middle", "newer")).toBe("highest");
  });

  test("stops at either end instead of unexpectedly wrapping", () => {
    expect(stationHistorySelection(suggestions, "oldest", "older")).toBe("oldest");
    expect(stationHistorySelection(suggestions, "highest", "newer")).toBe("highest");
  });

  test("dismisses in place while history remains and returns passive after the final card", () => {
    const remaining = stationDismissal(suggestions, "middle", "middle");
    expect(remaining.suggestions.map((item) => item.id)).toEqual(["highest", "oldest"]);
    expect(remaining.selectedId).toBe("highest");
    expect(remaining.returnToPassive).toBe(false);

    const final = stationDismissal([suggestions[0]!], "highest", "highest");
    expect(final.suggestions).toEqual([]);
    expect(final.selectedId).toBeNull();
    expect(final.returnToPassive).toBe(true);
  });
});
