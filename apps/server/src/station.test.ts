import { describe, expect, test } from "bun:test";

import {
  analyzeStationConnectedRecords,
  buildStationSystemPrompt,
  createFallbackStationSuggestions,
  isReadOnlyStationCapability,
  normalizeStationSuggestions,
  selectStationModel,
} from "./station.js";

describe("OpenWork Station passive-agent boundary", () => {
  test("allows clearly read-only capability names and rejects write authority", () => {
    expect(isReadOnlyStationCapability("getCapabilitiesGoogleWorkspaceCalendarEvents")).toBe(true);
    expect(isReadOnlyStationCapability("searchSlackMessages")).toBe(true);
    expect(isReadOnlyStationCapability("postCapabilitiesGoogleWorkspaceGmailDrafts")).toBe(false);
    expect(isReadOnlyStationCapability("createCalendarEvent")).toBe(false);
    expect(isReadOnlyStationCapability("executeCapability")).toBe(false);
  });

  test("makes the no-autonomous-action contract explicit", () => {
    const prompt = buildStationSystemPrompt();
    expect(prompt).toContain("passive AI right hand");
    expect(prompt).toContain("This run is read-only");
    expect(prompt).toContain("must never be executed");
  });

  test("selects a connected text and tool-capable model deterministically", () => {
    expect(selectStationModel({
      connected: ["opencode", "openai"],
      default: {
        opencode: "fallback-model",
        openai: "structured-model",
      },
      all: [
        {
          id: "opencode",
          models: {
            "fallback-model": { capabilities: { toolcall: true, output: { text: true } } },
          },
        },
        {
          id: "openai",
          models: {
            "structured-model": { capabilities: { toolcall: true, output: { text: true } } },
          },
        },
      ],
    })).toEqual({ providerID: "openai", modelID: "structured-model" });
    expect(selectStationModel({
      connected: ["openai"],
      default: { openai: "structured-model" },
      all: [{
        id: "openai",
        models: {
          "structured-model": { capabilities: { toolcall: true, output: { text: true } } },
          "gpt-5.4-mini-fast": { capabilities: { toolcall: true, output: { text: true } } },
        },
      }],
    })).toEqual({ providerID: "openai", modelID: "gpt-5.4-mini-fast" });
    expect(selectStationModel({
      connected: ["openai"],
      default: { openai: "image-only" },
      all: [{
        id: "openai",
        models: {
          "image-only": { capabilities: { toolcall: false, output: { text: false } } },
        },
      }],
    })).toBeUndefined();
  });

  test("drops unsafe source URLs and executable actions", () => {
    const suggestions = normalizeStationSuggestions({
      suggestions: [{
        kind: "memory",
        title: "Earlier context",
        summary: "A useful prior message.",
        reason: "The speaker asked about last week.",
        relevance: 3,
        color: "invalid",
        sources: [
          { label: "Unsafe", provider: "Slack", url: "javascript:alert(1)" },
          { label: "Original", provider: "Slack", url: "https://app.slack.com/client/a/b" },
        ],
        action: { kind: "open_source", label: "Open", url: "javascript:alert(1)" },
      }],
    }, 42);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.relevance).toBe(1);
    expect(suggestions[0]?.color).toBe("#8B7CFF");
    expect(suggestions[0]?.sources).toHaveLength(1);
    expect(suggestions[0]?.action.kind).toBe("none");
  });

  test("turns raw connected records into corrected review-only context", () => {
    const calendarRecord = {
      id: "availability",
      kind: "calendar" as const,
      provider: "Development Calendar",
      title: "Maya and Jalil availability",
      detail: "Both calendars have a thirty-minute opening.",
      url: "https://station.demo.openwork.local/calendar/availability",
    };
    const suggestions = analyzeStationConnectedRecords(
      "Let’s meet Friday at three. No, make that Monday at three, and only thirty minutes.",
      [calendarRecord],
      42,
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.kind).toBe("calendar");
    expect(suggestions[0]?.title).toContain("Monday");
    expect(suggestions[0]?.summary).not.toContain("Friday");
    expect(suggestions[0]?.action.kind).toBe("review_draft");
    expect(suggestions[0]?.sources[0]?.provider).toBe("Development Calendar");
  });

  test("returns no suggestion when raw connected records are irrelevant to the spoken turn", () => {
    const suggestions = analyzeStationConnectedRecords(
      "Good morning. Nice weather today.",
      [{
        id: "message",
        kind: "message",
        provider: "Development Slack",
        title: "Maya’s privacy concern",
        detail: "A prior concern.",
        url: "https://station.demo.openwork.local/slack/42",
      }],
      42,
    );
    expect(suggestions).toEqual([]);
  });
});

describe("OpenWork Station local signals", () => {
  test("prepares review-only calendar and follow-up drafts", () => {
    const suggestions = createFallbackStationSuggestions(
      "Can we meet next week? I am in Denver. I will follow up by email after the call.",
      100,
    );
    expect(suggestions.map((suggestion) => suggestion.kind)).toEqual(["calendar", "follow_up"]);
    expect(suggestions.every((suggestion) => suggestion.action.kind === "review_draft")).toBe(true);
    expect(suggestions.every((suggestion) => suggestion.sources.length === 0)).toBe(true);
  });
});
