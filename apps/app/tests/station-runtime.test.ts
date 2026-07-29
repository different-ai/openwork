import { describe, expect, test } from "bun:test";

import {
  INITIAL_STATION_RUNTIME,
  lifecycleObservation,
  stationPresentationText,
  transitionStationRuntime,
} from "../src/react-app/domains/station/station-runtime";

describe("Station runtime state machine", () => {
  test("distinguishes hearing, transcription, tool choice, research, and publication", () => {
    let state = transitionStationRuntime(INITIAL_STATION_RUNTIME, { type: "start_requested", at: 1 });
    expect(state.phase).toBe("requesting_microphone");
    expect(stationPresentationText(state.presentation)).toBe("Starting Station…");
    state = transitionStationRuntime(state, { type: "secret_requested", at: 2 });
    state = transitionStationRuntime(state, { type: "secret_ready", at: 3 });
    state = transitionStationRuntime(state, { type: "connected", at: 4 });
    state = transitionStationRuntime(state, { type: "speech_started", at: 5 });
    expect(state.phase).toBe("speech_detected");
    state = transitionStationRuntime(state, { type: "transcription_delta", at: 6 });
    state = transitionStationRuntime(state, { type: "transcript_completed", at: 7 });
    expect(state.phase).toBe("deciding");
    state = transitionStationRuntime(state, { type: "tool_requested", at: 8 });
    state = transitionStationRuntime(state, { type: "tool_started", at: 9 });
    state = transitionStationRuntime(state, { type: "mcp_discovery_started", at: 10 });
    expect(stationPresentationText(state.presentation)).toBe("Researching context");
    state = transitionStationRuntime(state, { type: "mcp_discovery_completed", found: true, at: 11 });
    state = transitionStationRuntime(state, { type: "suggestions_published", count: 1, at: 12 });
    expect(state.phase).toBe("suggestion_ready");
    expect(stationPresentationText(state.presentation)).toBe("Context ready");
    state = transitionStationRuntime(state, { type: "tool_completed", at: 13 });
    state = transitionStationRuntime(state, { type: "response_started", at: 14 });
    expect(state.phase).toBe("suggestion_ready");
    expect(stationPresentationText(state.presentation)).toBe("Context ready");
  });

  test("shutdown is terminal for late asynchronous events until a new run starts", () => {
    let state = transitionStationRuntime(INITIAL_STATION_RUNTIME, { type: "start_requested", at: 1 });
    state = transitionStationRuntime(state, { type: "connected", at: 2 });
    state = transitionStationRuntime(state, { type: "stop", at: 3 });
    const stoppedRun = state.runId;
    state = transitionStationRuntime(state, { type: "tool_started", at: 4 });
    expect(state.phase).toBe("stopped");
    state = transitionStationRuntime(state, { type: "start_requested", at: 5 });
    expect(state.phase).toBe("requesting_microphone");
    expect(state.runId).toBe(stoppedRun + 1);
  });

  test("a completed no-tool model decision cannot remain stuck in deciding", () => {
    let state = transitionStationRuntime(INITIAL_STATION_RUNTIME, { type: "start_requested", at: 1 });
    state = transitionStationRuntime(state, { type: "connected", at: 2 });
    state = transitionStationRuntime(state, { type: "transcript_completed", at: 3 });
    expect(state.phase).toBe("deciding");

    state = transitionStationRuntime(state, { type: "decision_completed", at: 4 });
    expect(state.phase).toBe("no_useful_context");
    expect(state.presentation).toBe("nothing_useful");
  });

  test("inspector observations keep only bounded lifecycle metadata", () => {
    const observation = lifecycleObservation("station.realtime.tool_started", 7, {
      at: 42,
      tool: "research_current_context",
      resultCategory: "development-mcp",
      suggestionCount: 2.9,
      sourceCategory: "simulated-connected-data",
    });
    expect(observation).toEqual({
      id: "7:42:station.realtime.tool_started",
      at: 42,
      name: "station.realtime.tool_started",
      runId: 7,
      tool: "research_current_context",
      resultCategory: "development-mcp",
      suggestionCount: 2,
      sourceCategory: "simulated-connected-data",
    });
    expect(JSON.stringify(observation)).not.toContain("transcript");
    expect(JSON.stringify(observation)).not.toContain("secret");
  });
});
