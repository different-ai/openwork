import { describe, expect, test } from "bun:test";

import { createLiveConversationSuggestion } from "../src/react-app/domains/station/station-live-suggestion";

describe("Station live-conversation suggestion", () => {
  test("creates an honest source-free thread card from model-selected live context", () => {
    const suggestion = createLiveConversationSuggestion({
      title: "Continue Station debugging",
      summary: "Work through why passive Realtime decisions do not publish cards.",
      reason: "The user explicitly asked for an action and an OpenWork thread.",
    }, 42);

    expect(suggestion).toMatchObject({
      id: "station-live-42-continue-station-debugging",
      kind: "context",
      title: "Continue Station debugging",
      relevance: 0.94,
      sources: [],
      action: { kind: "none", label: "Start thread" },
      createdAt: 42,
    });
  });

  test("bounds model-authored text before publishing it to the edge UI", () => {
    const suggestion = createLiveConversationSuggestion({
      title: "x".repeat(120),
      summary: "y".repeat(500),
      reason: "z".repeat(300),
    }, 7);

    expect(suggestion.title).toHaveLength(80);
    expect(suggestion.summary).toHaveLength(420);
    expect(suggestion.reason).toHaveLength(220);
  });
});
