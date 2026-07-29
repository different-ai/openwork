import { describe, expect, test } from "bun:test";

import type { StationSuggestion } from "../src/react-app/domains/station/station-types";
import { contextualBubbleDiameter } from "../src/station/station-visual-model";

function suggestion(overrides: Partial<StationSuggestion> = {}): StationSuggestion {
  return {
    id: "signal",
    kind: "context",
    title: "Signal",
    summary: "Current context",
    reason: "Relevant now",
    relevance: 0.5,
    effectiveRelevance: 0.5,
    color: "#4EA8FF",
    sources: [],
    action: { kind: "none", label: "Keep in view" },
    createdAt: 1,
    ...overrides,
  };
}

describe("Station contextual bubble mass", () => {
  test("uses a continuous relevance curve instead of size presets", () => {
    const small = contextualBubbleDiameter(suggestion({ effectiveRelevance: 0.31 }));
    const medium = contextualBubbleDiameter(suggestion({ effectiveRelevance: 0.56 }));
    const nearby = contextualBubbleDiameter(suggestion({ effectiveRelevance: 0.57 }));
    const large = contextualBubbleDiameter(suggestion({ effectiveRelevance: 0.91 }));

    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(nearby);
    expect(nearby).toBeLessThan(large);
    expect(nearby - medium).toBeLessThan(1);
  });

  test("adds restrained context and evidence mass while preserving hard bounds", () => {
    const plain = contextualBubbleDiameter(suggestion({ effectiveRelevance: 0.6 }));
    const evidencedMemory = contextualBubbleDiameter(suggestion({
      kind: "memory",
      effectiveRelevance: 0.6,
      sources: [
        { label: "One", provider: "Slack", url: "https://example.com/one" },
        { label: "Two", provider: "Slack", url: "https://example.com/two" },
      ],
    }));

    expect(evidencedMemory).toBeGreaterThan(plain);
    expect(contextualBubbleDiameter(suggestion({ effectiveRelevance: -4 }))).toBe(14);
    const maximum = contextualBubbleDiameter(suggestion({
      kind: "memory",
      effectiveRelevance: 4,
      sources: Array.from({ length: 10 }, (_, index) => ({
        label: String(index),
        provider: "Source",
        url: `https://example.com/${index}`,
      })),
    }));
    expect(maximum).toBeGreaterThan(48);
    expect(maximum).toBeLessThanOrEqual(49);
  });
});
