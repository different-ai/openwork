import { describe, expect, test } from "bun:test";

import {
  evaluateStationScenario,
  scheduledStationScenarioSteps,
  STATION_SCENARIOS,
  stationScenarioById,
  stationScenarioDuration,
} from "../src/react-app/domains/station/station-scenarios";

describe("Station scenario catalog", () => {
  test("contains all required time-sequenced behaviors", () => {
    expect(STATION_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "maya-memory",
      "denver-berlin",
      "follow-up",
      "ambient-speech",
      "correction-over-time",
      "mcp-recovery",
      "immediate-stop",
    ]);
    expect(STATION_SCENARIOS.every((scenario) => scenario.mustRemainReviewOnly)).toBe(true);
    expect(STATION_SCENARIOS.every((scenario) => (
      scenario.steps.some((step) => step.kind === "audio_utterance")
    ))).toBe(true);
  });

  test("schedules a declarative timeline at bounded playback speeds", () => {
    const scenario = stationScenarioById("maya-memory");
    expect(scenario).toBeDefined();
    if (!scenario) return;
    const normal = scheduledStationScenarioSteps(scenario, 1);
    const fast = scheduledStationScenarioSteps(scenario, 2);
    expect(normal[0]?.delayMs).toBe(0);
    expect(fast.at(-1)?.delayMs).toBe(Math.round((normal.at(-1)?.delayMs ?? 0) / 2));
    expect(stationScenarioDuration(scenario, 10)).toBe(
      Math.round((scenario.steps.at(-1)?.atMs ?? 0) / 4),
    );
  });

  test("keeps simulated transcript injection explicitly separate from audio fixtures", () => {
    const speech = STATION_SCENARIOS.flatMap((scenario) => scenario.steps)
      .filter((step) => step.kind === "audio_utterance");
    expect(speech.every((step) => step.audioFixture.startsWith("/station-audio/"))).toBe(true);
    expect(speech.every((step) => step.simulationTranscript.length > 0)).toBe(true);
  });

  test("fails ambient speech if a tool is called and passes only after required sourced context appears", () => {
    const ambient = stationScenarioById("ambient-speech");
    const memory = stationScenarioById("maya-memory");
    expect(ambient && evaluateStationScenario(ambient, {
      observedEvents: [{ name: "station.realtime.tool_requested" }],
      suggestions: [],
      listening: true,
    }).status).toBe("failed");
    expect(memory && evaluateStationScenario(memory, {
      observedEvents: memory.expectedEvents.map((name) => ({ name })),
      suggestions: [{
        id: "memory",
        kind: "memory",
        title: "Maya’s concern",
        summary: "Privacy boundary",
        reason: "Explicit recall",
        relevance: 0.9,
        effectiveRelevance: 0.9,
        color: "#8B7CFF",
        sources: [{
          label: "Prior discussion",
          provider: "Development Slack",
          url: "https://station.demo.openwork.local/slack/42",
        }],
        action: { kind: "open_source", label: "Open source", url: "https://station.demo.openwork.local/slack/42" },
        createdAt: 1,
      }],
      listening: true,
    }).status).toBe("passed");
  });
});
