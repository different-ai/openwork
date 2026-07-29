export type StationRuntimePhase =
  | "idle"
  | "requesting_microphone"
  | "minting_client_secret"
  | "connecting"
  | "listening"
  | "speech_detected"
  | "transcribing"
  | "deciding"
  | "tool_requested"
  | "tool_running"
  | "mcp_discovery_running"
  | "connected_data_found"
  | "suggestion_ready"
  | "no_useful_context"
  | "reconnecting"
  | "stopped"
  | "recoverable_error"
  | "terminal_error";

export type StationPresentation =
  | "ready"
  | "starting"
  | "listening"
  | "understanding"
  | "researching"
  | "context_ready"
  | "nothing_useful"
  | "stopped"
  | "needs_attention";

export type StationRuntimeState = {
  phase: StationRuntimePhase;
  presentation: StationPresentation;
  runId: number;
  updatedAt: number;
};

export type StationRuntimeEvent =
  | { type: "start_requested"; at?: number }
  | { type: "microphone_requested"; at?: number }
  | { type: "microphone_ready"; at?: number }
  | { type: "secret_requested"; at?: number }
  | { type: "secret_ready"; at?: number }
  | { type: "connected"; at?: number }
  | { type: "speech_started"; at?: number }
  | { type: "transcription_delta"; at?: number }
  | { type: "transcript_completed"; at?: number }
  | { type: "response_started"; at?: number }
  | { type: "tool_requested"; at?: number }
  | { type: "tool_started"; at?: number }
  | { type: "mcp_discovery_started"; at?: number }
  | { type: "mcp_discovery_completed"; found: boolean; at?: number }
  | { type: "suggestions_published"; count: number; at?: number }
  | { type: "tool_completed"; at?: number }
  | { type: "recover"; at?: number }
  | { type: "reconnect"; at?: number }
  | { type: "recoverable_error"; at?: number }
  | { type: "terminal_error"; at?: number }
  | { type: "stop"; at?: number }
  | { type: "reset"; at?: number };

export type StationLifecycleEventName =
  | "station.realtime.secret_requested"
  | "station.realtime.connected"
  | "station.realtime.speech_started"
  | "station.realtime.transcript_completed"
  | "station.realtime.response_started"
  | "station.realtime.tool_requested"
  | "station.realtime.tool_started"
  | "station.realtime.tool_completed"
  | "station.realtime.tool_failed"
  | "station.mcp.discovery_started"
  | "station.mcp.discovery_completed"
  | "station.suggestions_published"
  | "station.realtime.stopped";

export type StationLifecycleObservation = {
  id: string;
  at: number;
  name: StationLifecycleEventName;
  runId: number;
  model?: string;
  tool?: string;
  resultCategory?: string;
  suggestionCount?: number;
  sourceCategory?: string;
};

export const INITIAL_STATION_RUNTIME: StationRuntimeState = {
  phase: "idle",
  presentation: "ready",
  runId: 0,
  updatedAt: 0,
};

function presentationForPhase(phase: StationRuntimePhase): StationPresentation {
  if (
    phase === "requesting_microphone"
    || phase === "minting_client_secret"
    || phase === "connecting"
    || phase === "reconnecting"
  ) return "starting";
  if (phase === "listening" || phase === "speech_detected") return "listening";
  if (phase === "transcribing" || phase === "deciding") return "understanding";
  if (phase === "tool_requested" || phase === "tool_running" || phase === "mcp_discovery_running") {
    return "researching";
  }
  if (phase === "connected_data_found" || phase === "suggestion_ready") return "context_ready";
  if (phase === "no_useful_context") return "nothing_useful";
  if (phase === "stopped") return "stopped";
  if (phase === "recoverable_error" || phase === "terminal_error") return "needs_attention";
  return "ready";
}

export function stationPresentationText(presentation: StationPresentation): string {
  if (presentation === "starting") return "Starting Station…";
  if (presentation === "listening") return "Listening";
  if (presentation === "understanding") return "Understanding";
  if (presentation === "researching") return "Researching context";
  if (presentation === "context_ready") return "Context ready";
  if (presentation === "nothing_useful") return "Nothing useful yet";
  if (presentation === "stopped") return "Listening stopped";
  if (presentation === "needs_attention") return "Needs attention";
  return "Ready when you are.";
}

function phaseForEvent(current: StationRuntimeState, event: StationRuntimeEvent): StationRuntimePhase {
  if (event.type === "reset") return "idle";
  if (event.type === "start_requested" || event.type === "microphone_requested") {
    return "requesting_microphone";
  }
  if (event.type === "microphone_ready" || event.type === "secret_requested") {
    return "minting_client_secret";
  }
  if (event.type === "secret_ready") return "connecting";
  if (event.type === "tool_completed") {
    if (current.phase === "suggestion_ready" || current.phase === "no_useful_context") {
      return current.phase;
    }
    return "listening";
  }
  if (event.type === "connected" || event.type === "recover") return "listening";
  if (event.type === "speech_started") return "speech_detected";
  if (event.type === "transcription_delta") return "transcribing";
  if (event.type === "response_started") {
    if (current.phase === "suggestion_ready" || current.phase === "no_useful_context") {
      return current.phase;
    }
    return "deciding";
  }
  if (event.type === "transcript_completed") return "deciding";
  if (event.type === "tool_requested") return "tool_requested";
  if (event.type === "tool_started") return "tool_running";
  if (event.type === "mcp_discovery_started") return "mcp_discovery_running";
  if (event.type === "mcp_discovery_completed") {
    return event.found ? "connected_data_found" : "no_useful_context";
  }
  if (event.type === "suggestions_published") {
    return event.count > 0 ? "suggestion_ready" : "no_useful_context";
  }
  if (event.type === "reconnect") return "reconnecting";
  if (event.type === "recoverable_error") return "recoverable_error";
  if (event.type === "terminal_error") return "terminal_error";
  if (event.type === "stop") return "stopped";
  return current.phase;
}

export function transitionStationRuntime(
  current: StationRuntimeState,
  event: StationRuntimeEvent,
): StationRuntimeState {
  if (
    (current.phase === "stopped" || current.phase === "terminal_error")
    && event.type !== "start_requested"
    && event.type !== "microphone_requested"
    && event.type !== "reset"
  ) return current;
  const phase = phaseForEvent(current, event);
  const startsNewRun = event.type === "start_requested" || event.type === "microphone_requested";
  return {
    phase,
    presentation: presentationForPhase(phase),
    runId: startsNewRun ? current.runId + 1 : current.runId,
    updatedAt: event.at ?? Date.now(),
  };
}

export function lifecycleObservation(
  name: StationLifecycleEventName,
  runId: number,
  input: {
    at?: number;
    id?: string;
    model?: string;
    tool?: string;
    resultCategory?: string;
    suggestionCount?: number;
    sourceCategory?: string;
  } = {},
): StationLifecycleObservation {
  const at = input.at ?? Date.now();
  return {
    id: input.id?.slice(0, 100) || `${runId}:${at}:${name}`,
    at,
    name,
    runId,
    ...(input.model ? { model: input.model.slice(0, 100) } : {}),
    ...(input.tool ? { tool: input.tool.slice(0, 100) } : {}),
    ...(input.resultCategory ? { resultCategory: input.resultCategory.slice(0, 80) } : {}),
    ...(typeof input.suggestionCount === "number"
      ? { suggestionCount: Math.max(0, Math.floor(input.suggestionCount)) }
      : {}),
    ...(input.sourceCategory ? { sourceCategory: input.sourceCategory.slice(0, 80) } : {}),
  };
}
