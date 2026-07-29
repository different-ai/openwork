import type { OpenworkStationSuggestion } from "@/app/lib/openwork-server";
import {
  INITIAL_STATION_RUNTIME,
  INITIAL_STATION_PROVENANCE,
  type StationLifecycleObservation,
  type StationProvenance,
  type StationRuntimeState,
} from "./station-runtime";

export type StationStatus = "idle" | "connecting" | "listening" | "analyzing" | "error";
export type StationInteractionMode = "active" | "passive";

export type StationSuggestion = OpenworkStationSuggestion & {
  effectiveRelevance: number;
};

export type StationScenarioRuntime = {
  id: string;
  title: string;
  status: "idle" | "starting" | "running" | "completed" | "failed" | "stopped";
  mode: "real-inference" | "simulation";
  timelineMs: number;
  playbackSpeed: number;
  simulator: "development-mcp" | null;
  observedEvents: StationLifecycleObservation[];
  error: string | null;
};

export type StationState = {
  status: StationStatus;
  statusText: string;
  interactionMode: StationInteractionMode;
  runtime: StationRuntimeState;
  provenance: StationProvenance;
  listening: boolean;
  visible: boolean;
  transcript: string;
  partialTranscript: string;
  audioEnergy: number;
  suggestions: StationSuggestion[];
  selectedId: string | null;
  source: "openwork-connect" | "development-mcp" | "local-signal" | "demo" | null;
  scenario: StationScenarioRuntime | null;
  error: string | null;
};

export type StationCommand = {
  type:
    | "activate"
    | "dismiss"
    | "handoff"
    | "hide"
    | "next"
    | "previous"
    | "select"
    | "seed-demo"
    | "set-mode"
    | "start"
    | "stop"
    | "toggle-listening";
  id?: string;
  active?: boolean;
};

export const INITIAL_STATION_STATE: StationState = {
  status: "idle",
  statusText: "Ready when you are.",
  interactionMode: "passive",
  runtime: INITIAL_STATION_RUNTIME,
  provenance: INITIAL_STATION_PROVENANCE,
  listening: false,
  visible: false,
  transcript: "",
  partialTranscript: "",
  audioEnergy: 0,
  suggestions: [],
  selectedId: null,
  source: null,
  scenario: null,
  error: null,
};

export function isStationCommand(value: unknown): value is StationCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const type = Reflect.get(value, "type");
  return type === "activate"
    || type === "dismiss"
    || type === "handoff"
    || type === "hide"
    || type === "next"
    || type === "previous"
    || type === "select"
    || type === "seed-demo"
    || type === "set-mode"
    || type === "start"
    || type === "stop"
    || type === "toggle-listening";
}

export function isStationState(value: unknown): value is StationState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const runtime = Reflect.get(value, "runtime");
  return typeof Reflect.get(value, "status") === "string"
    && (Reflect.get(value, "interactionMode") === "active"
      || Reflect.get(value, "interactionMode") === "passive")
    && typeof Reflect.get(value, "listening") === "boolean"
    && typeof runtime === "object"
    && runtime !== null
    && typeof Reflect.get(runtime, "phase") === "string"
    && Array.isArray(Reflect.get(value, "suggestions"));
}
