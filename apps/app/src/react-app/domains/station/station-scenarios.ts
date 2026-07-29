import type { StationLifecycleEventName } from "./station-runtime";
import type { StationSuggestion } from "./station-types";

export type StationScenarioStep =
  | {
    atMs: number;
    kind: "connected_data_patch";
    patchId: string;
  }
  | {
    atMs: number;
    kind: "audio_utterance";
    audioFixture: string;
    simulationTranscript: string;
  }
  | {
    atMs: number;
    kind: "pause";
    durationMs: number;
  }
  | {
    atMs: number;
    kind: "expect";
    expectedEvents?: StationLifecycleEventName[];
    expectedSuggestionKinds?: StationSuggestion["kind"][];
  }
  | {
    atMs: number;
    kind: "stop";
  };

export type StationScenario = {
  id: string;
  title: string;
  description: string;
  initialConnectedData: string;
  steps: StationScenarioStep[];
  expectedEvents: StationLifecycleEventName[];
  expectedSuggestionKinds: StationSuggestion["kind"][];
  expectedSourceProviders: string[];
  mustNotCallTools: boolean;
  mustRemainReviewOnly: boolean;
};

const SHARED_REAL_EVENTS: StationLifecycleEventName[] = [
  "station.realtime.secret_requested",
  "station.realtime.connected",
  "station.realtime.speech_started",
  "station.realtime.transcript_completed",
  "station.realtime.response_started",
];

export const STATION_SCENARIOS: StationScenario[] = [
  {
    id: "maya-memory",
    title: "Remember what Maya said",
    description: "Ignore launch small talk, then retrieve Maya’s prior enterprise-pilot privacy concern.",
    initialConnectedData: "maya-memory-ready",
    steps: [
      { atMs: 0, kind: "connected_data_patch", patchId: "maya-memory-ready" },
      {
        atMs: 900,
        kind: "audio_utterance",
        audioFixture: "/station-audio/launch-introduction.mp3",
        simulationTranscript: "Thanks everyone for joining. Let’s talk generally about the launch plan and how the work is progressing.",
      },
      { atMs: 5_200, kind: "pause", durationMs: 900 },
      {
        atMs: 7_000,
        kind: "audio_utterance",
        audioFixture: "/station-audio/maya-memory-question.mp3",
        simulationTranscript: "Maya, do you remember the concern you raised last week about the enterprise pilot?",
      },
      {
        atMs: 13_500,
        kind: "expect",
        expectedEvents: [
          "station.realtime.tool_requested",
          "station.realtime.tool_started",
          "station.mcp.discovery_completed",
          "station.suggestions_published",
        ],
        expectedSuggestionKinds: ["memory"],
      },
    ],
    expectedEvents: [
      ...SHARED_REAL_EVENTS,
      "station.realtime.tool_requested",
      "station.realtime.tool_started",
      "station.mcp.discovery_started",
      "station.mcp.discovery_completed",
      "station.realtime.tool_completed",
      "station.suggestions_published",
    ],
    expectedSuggestionKinds: ["memory"],
    expectedSourceProviders: ["Development Slack"],
    mustNotCallTools: false,
    mustRemainReviewOnly: true,
  },
  {
    id: "denver-berlin",
    title: "Denver and Berlin calendar context",
    description: "Accumulate a corrected thirty-minute cross-time-zone meeting draft without scheduling it.",
    initialConnectedData: "calendar-ready",
    steps: [
      { atMs: 0, kind: "connected_data_patch", patchId: "calendar-ready" },
      {
        atMs: 900,
        kind: "audio_utterance",
        audioFixture: "/station-audio/calendar-tomorrow.mp3",
        simulationTranscript: "Could we review this tomorrow? I can do two in the afternoon in Denver.",
      },
      {
        atMs: 5_300,
        kind: "audio_utterance",
        audioFixture: "/station-audio/calendar-berlin.mp3",
        simulationTranscript: "Jalil is in Berlin. Let’s make it thirty minutes.",
      },
      { atMs: 11_500, kind: "expect", expectedSuggestionKinds: ["calendar"] },
    ],
    expectedEvents: [...SHARED_REAL_EVENTS, "station.realtime.tool_requested", "station.suggestions_published"],
    expectedSuggestionKinds: ["calendar"],
    expectedSourceProviders: ["Development Calendar"],
    mustNotCallTools: false,
    mustRemainReviewOnly: true,
  },
  {
    id: "follow-up",
    title: "Follow up after the call",
    description: "Prepare one reviewable follow-up and refine it when the commitment becomes more specific.",
    initialConnectedData: "maya-memory-ready",
    steps: [
      { atMs: 0, kind: "connected_data_patch", patchId: "maya-memory-ready" },
      {
        atMs: 900,
        kind: "audio_utterance",
        audioFixture: "/station-audio/follow-up-promise.mp3",
        simulationTranscript: "I’ll send Maya the decision after this call.",
      },
      {
        atMs: 5_000,
        kind: "audio_utterance",
        audioFixture: "/station-audio/follow-up-correction.mp3",
        simulationTranscript: "Actually include the transcript-retention boundary and the next review date.",
      },
      { atMs: 11_000, kind: "expect", expectedSuggestionKinds: ["follow_up"] },
    ],
    expectedEvents: [...SHARED_REAL_EVENTS, "station.realtime.tool_requested", "station.suggestions_published"],
    expectedSuggestionKinds: ["follow_up"],
    expectedSourceProviders: ["Development Slack", "Development Calendar"],
    mustNotCallTools: false,
    mustRemainReviewOnly: true,
  },
  {
    id: "ambient-speech",
    title: "Irrelevant ambient speech",
    description: "Keep listening through greetings, filler, and non-work fragments without researching.",
    initialConnectedData: "empty",
    steps: [
      { atMs: 0, kind: "connected_data_patch", patchId: "empty" },
      {
        atMs: 800,
        kind: "audio_utterance",
        audioFixture: "/station-audio/ambient-filler.mp3",
        simulationTranscript: "Hey, good morning. Nice weather. Um, yeah, anyway, one second. Can you hear me?",
      },
      { atMs: 8_200, kind: "expect", expectedSuggestionKinds: [] },
    ],
    expectedEvents: SHARED_REAL_EVENTS,
    expectedSuggestionKinds: [],
    expectedSourceProviders: [],
    mustNotCallTools: true,
    mustRemainReviewOnly: true,
  },
  {
    id: "correction-over-time",
    title: "Correction over time",
    description: "Replace Friday with Monday and retain one thirty-minute calendar draft.",
    initialConnectedData: "calendar-ready",
    steps: [
      { atMs: 0, kind: "connected_data_patch", patchId: "calendar-ready" },
      {
        atMs: 800,
        kind: "audio_utterance",
        audioFixture: "/station-audio/correction-friday.mp3",
        simulationTranscript: "Let’s meet Friday at three.",
      },
      {
        atMs: 4_400,
        kind: "audio_utterance",
        audioFixture: "/station-audio/correction-monday.mp3",
        simulationTranscript: "No, make that Monday at three.",
      },
      {
        atMs: 7_900,
        kind: "audio_utterance",
        audioFixture: "/station-audio/correction-duration.mp3",
        simulationTranscript: "And only thirty minutes.",
      },
      { atMs: 13_500, kind: "expect", expectedSuggestionKinds: ["calendar"] },
    ],
    expectedEvents: [...SHARED_REAL_EVENTS, "station.realtime.tool_requested", "station.suggestions_published"],
    expectedSuggestionKinds: ["calendar"],
    expectedSourceProviders: ["Development Calendar"],
    mustNotCallTools: false,
    mustRemainReviewOnly: true,
  },
  {
    id: "mcp-recovery",
    title: "Connected research failure and recovery",
    description: "Expose an honest recoverable failure, keep listening, then research successfully on a later turn.",
    initialConnectedData: "unavailable",
    steps: [
      { atMs: 0, kind: "connected_data_patch", patchId: "unavailable" },
      {
        atMs: 800,
        kind: "audio_utterance",
        audioFixture: "/station-audio/maya-memory-question.mp3",
        simulationTranscript: "Maya, do you remember the concern you raised last week about the enterprise pilot?",
      },
      { atMs: 8_500, kind: "connected_data_patch", patchId: "maya-memory-ready" },
      {
        atMs: 9_300,
        kind: "audio_utterance",
        audioFixture: "/station-audio/recovery-retry.mp3",
        simulationTranscript: "Connected context is back. Please retry Maya’s enterprise pilot concern now.",
      },
      { atMs: 16_500, kind: "expect", expectedSuggestionKinds: ["memory"] },
    ],
    expectedEvents: [
      ...SHARED_REAL_EVENTS,
      "station.realtime.tool_failed",
      "station.realtime.tool_requested",
      "station.suggestions_published",
    ],
    expectedSuggestionKinds: ["memory"],
    expectedSourceProviders: ["Development Slack"],
    mustNotCallTools: false,
    mustRemainReviewOnly: true,
  },
  {
    id: "immediate-stop",
    title: "Immediate stop",
    description: "Close the live session and media tracks while audio or connected research is active.",
    initialConnectedData: "maya-memory-ready",
    steps: [
      { atMs: 0, kind: "connected_data_patch", patchId: "maya-memory-ready" },
      {
        atMs: 700,
        kind: "audio_utterance",
        audioFixture: "/station-audio/maya-memory-question.mp3",
        simulationTranscript: "Maya, do you remember the concern you raised last week about the enterprise pilot?",
      },
      { atMs: 2_000, kind: "stop" },
    ],
    expectedEvents: [
      "station.realtime.secret_requested",
      "station.realtime.connected",
      "station.realtime.speech_started",
      "station.realtime.stopped",
    ],
    expectedSuggestionKinds: [],
    expectedSourceProviders: [],
    mustNotCallTools: false,
    mustRemainReviewOnly: true,
  },
];

export function stationScenarioById(id: string): StationScenario | undefined {
  return STATION_SCENARIOS.find((scenario) => scenario.id === id);
}

export function scheduledStationScenarioSteps(
  scenario: StationScenario,
  playbackSpeed = 1,
): Array<{ delayMs: number; step: StationScenarioStep }> {
  const speed = Number.isFinite(playbackSpeed) ? Math.min(4, Math.max(0.25, playbackSpeed)) : 1;
  return scenario.steps
    .map((step) => ({ delayMs: Math.max(0, Math.round(step.atMs / speed)), step }))
    .sort((left, right) => left.delayMs - right.delayMs);
}

export function stationScenarioDuration(scenario: StationScenario, playbackSpeed = 1): number {
  return scheduledStationScenarioSteps(scenario, playbackSpeed).at(-1)?.delayMs ?? 0;
}

export function evaluateStationScenario(
  scenario: StationScenario,
  runtime: {
    observedEvents: Array<{ name: StationLifecycleEventName }>;
    suggestions: StationSuggestion[];
    listening: boolean;
  },
): { status: "pending" | "passed" | "failed"; reason?: string } {
  const observedNames = new Set(runtime.observedEvents.map((event) => event.name));
  if (scenario.mustNotCallTools && observedNames.has("station.realtime.tool_requested")) {
    return { status: "failed", reason: "The Realtime model called a tool for irrelevant ambient speech." };
  }
  if (scenario.id === "immediate-stop" && observedNames.has("station.realtime.stopped")) {
    return runtime.listening
      ? { status: "failed", reason: "Station still reports listening after the stop event." }
      : { status: "passed" };
  }
  const missingEvent = scenario.expectedEvents.find((event) => !observedNames.has(event));
  if (missingEvent) return { status: "pending", reason: `Waiting for ${missingEvent}.` };
  const missingKind = scenario.expectedSuggestionKinds.find((kind) => (
    !runtime.suggestions.some((suggestion) => suggestion.kind === kind)
  ));
  if (missingKind) return { status: "pending", reason: `Waiting for a ${missingKind} suggestion.` };
  if (!scenario.expectedSuggestionKinds.length && runtime.suggestions.length) {
    return { status: "failed", reason: "Station published a suggestion when none was expected." };
  }
  const providers = new Set(runtime.suggestions.flatMap((suggestion) => (
    suggestion.sources.map((source) => source.provider)
  )));
  const missingProvider = scenario.expectedSourceProviders.find((provider) => !providers.has(provider));
  if (missingProvider) return { status: "pending", reason: `Waiting for cited ${missingProvider} context.` };
  const unsafeAction = runtime.suggestions.some((suggestion) => (
    suggestion.action.kind !== "none"
    && suggestion.action.kind !== "open_source"
    && suggestion.action.kind !== "review_draft"
  ));
  if (scenario.mustRemainReviewOnly && unsafeAction) {
    return { status: "failed", reason: "A suggestion escaped the review-only action boundary." };
  }
  return { status: "passed" };
}
