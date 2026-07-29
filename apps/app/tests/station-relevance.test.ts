import { describe, expect, test } from "bun:test";

import type { OpenworkStationSuggestion } from "../src/app/lib/openwork-server";
import {
  effectiveStationRelevance,
  rankStationSuggestions,
} from "../src/react-app/domains/station/station-relevance";

function suggestion(overrides: Partial<OpenworkStationSuggestion> = {}): OpenworkStationSuggestion {
  return {
    id: "memory",
    kind: "memory",
    title: "Maya’s launch message",
    summary: "The enterprise launch needs a transcript privacy decision.",
    reason: "Maya asked what she said last week.",
    relevance: 0.9,
    color: "#8B7CFF",
    sources: [],
    action: { kind: "none", label: "Keep in view" },
    createdAt: 1_000,
    ...overrides,
  };
}

describe("Station relevance engine", () => {
  test("decays old context while boosting words active in the conversation", () => {
    const current = suggestion();
    const fresh = effectiveStationRelevance(current, "Maya is asking about the enterprise launch", 1_000);
    const old = effectiveStationRelevance(current, "unrelated topic", 1_000 + 8 * 60 * 1_000);
    expect(fresh).toBeGreaterThan(0.9);
    expect(old).toBeLessThan(0.3);
  });

  test("deduplicates and ranks the newest useful suggestions", () => {
    const older = suggestion({ id: "old", relevance: 0.7, createdAt: 1_000 });
    const newer = suggestion({ id: "new", relevance: 0.92, createdAt: 2_000 });
    const calendar = suggestion({
      id: "calendar",
      kind: "calendar",
      title: "Denver meeting",
      summary: "A time-zone aware meeting draft.",
      reason: "Availability is being discussed.",
      relevance: 0.8,
      color: "#38C6A5",
      createdAt: 2_100,
    });
    const ranked = rankStationSuggestions([older], [newer, calendar], "Maya Denver meeting", 2_100);
    expect(ranked).toHaveLength(2);
    expect(ranked.some((item) => item.id === "old")).toBe(false);
    expect(ranked[0]?.effectiveRelevance).toBeGreaterThanOrEqual(ranked[1]?.effectiveRelevance ?? 0);
  });

  test("replaces a sourced suggestion when a later turn corrects its details", () => {
    const source = [{
      label: "Maya and Jalil availability",
      provider: "Development Calendar",
      url: "https://station.demo.openwork.local/calendar/availability/denver-berlin",
    }];
    const friday = suggestion({
      id: "friday",
      kind: "calendar",
      title: "Friday at three",
      summary: "A sixty-minute meeting on Friday.",
      reason: "Friday was proposed.",
      sources: source,
      createdAt: 1_000,
    });
    const monday = suggestion({
      id: "monday",
      kind: "calendar",
      title: "Monday at three",
      summary: "A corrected thirty-minute meeting on Monday.",
      reason: "The latest turn replaced Friday and shortened the meeting.",
      sources: source,
      createdAt: 2_000,
    });
    const ranked = rankStationSuggestions(
      [friday],
      [monday],
      "No, make that Monday at three, and only thirty minutes.",
      2_000,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.id).toBe("monday");
    expect(ranked[0]?.summary).toContain("thirty-minute");
  });
});
